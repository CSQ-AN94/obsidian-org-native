import { isUnsafeUriScheme } from "../../util/links";
import { extractRawSearchOption } from "./parser";
import { resolveSafeVaultPath } from "./pathGuard";
import {
  DEFAULT_EXCLUDE_ELEMENTS,
  extractAndTransformTransclusion,
  truncateOrgContentSafely,
  type TargetExtractionSpec,
} from "./transform";
import type {
  TransclusionContentProvider,
  TransclusionDirective,
  TransclusionResolveContext,
  TransclusionResolution,
  TransclusionResolver,
} from "./types";

export interface OrgTransclusionEngineOptions {
  /** Default maximum nesting depth if `context.maxDepth` is omitted (clamped 1..8). */
  defaultMaxDepth?: number;
  /** Default expansion count cap when no shared `budget` is passed. */
  maxExpansions?: number;
  /** Default total expanded character cap across a document. */
  maxTotalChars?: number;
  /** Maximum characters allowed for any single transcluded fragment. */
  maxSingleExpansionChars?: number;
  /** Org element types excluded by default (defaults to `["property-drawer"]`). */
  defaultExcludeElements?: readonly string[];
}

export interface OrgTransclusionResolveContext extends TransclusionResolveContext {
  charBudget?: { remaining: number };
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_EXPANSIONS = 50;
const DEFAULT_MAX_TOTAL_CHARS = 200_000;
const DEFAULT_MAX_SINGLE_EXPANSION_CHARS = 50_000;

function clampDepth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_DEPTH;
  return Math.max(1, Math.min(8, Math.floor(value)));
}

/**
 * Canonical location identifier used alongside `id:...` keys so mixed cycles
 * (e.g. `[[id:a]]` -> `[[file:notes.org::*Heading A]]` -> `[[id:a]]`) are detected.
 */
export function buildLocationCanonicalKey(
  filePath: string,
  line: number,
  isFileRoot = false
): string {
  return isFileRoot ? `file:${filePath}` : `file:${filePath}#L${line}`;
}

/**
 * Clean-room read-only resolver for Org `#+transclude:` directives.
 * Resolves `[[id:...]]` via the existing `OrgIdIndex` provider and in-vault
 * `[[file:...]]` links via `resolveSafeVaultPath`, enforcing cycle, depth,
 * expansion-budget, path-traversal, and size-cap guards.
 */
export class OrgTransclusionEngine implements TransclusionResolver {
  private readonly defaultMaxDepth: number;
  private readonly maxExpansions: number;
  private readonly maxTotalChars: number;
  private readonly maxSingleExpansionChars: number;
  private readonly defaultExcludeElements: readonly string[];

  constructor(
    private readonly provider: TransclusionContentProvider,
    options: OrgTransclusionEngineOptions = {}
  ) {
    this.defaultMaxDepth = clampDepth(options.defaultMaxDepth ?? DEFAULT_MAX_DEPTH);
    this.maxExpansions = Math.max(1, options.maxExpansions ?? DEFAULT_MAX_EXPANSIONS);
    this.maxTotalChars = Math.max(1, options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS);
    this.maxSingleExpansionChars = Math.max(
      1,
      options.maxSingleExpansionChars ?? DEFAULT_MAX_SINGLE_EXPANSION_CHARS
    );
    this.defaultExcludeElements =
      options.defaultExcludeElements ?? DEFAULT_EXCLUDE_ELEMENTS;
  }

  getDefaultLimits(): {
    maxDepth: number;
    maxExpansions: number;
    maxTotalChars: number;
    maxSingleExpansionChars: number;
  } {
    return {
      maxDepth: this.defaultMaxDepth,
      maxExpansions: this.maxExpansions,
      maxTotalChars: this.maxTotalChars,
      maxSingleExpansionChars: this.maxSingleExpansionChars,
    };
  }

  async resolve(
    directive: TransclusionDirective,
    context: OrgTransclusionResolveContext = {}
  ): Promise<TransclusionResolution> {
    const unsupportedParams = [...directive.options.unsupportedParams];

    if (isUnsafeUriScheme(directive.rawTarget)) {
      return {
        status: "security-blocked",
        reason: `Blocked unsafe URI scheme in transclusion target: ${directive.rawTarget}`,
        unsupportedParams,
      };
    }

    if (directive.targetType === "unsupported") {
      return {
        status: "unsupported",
        reason: `Unsupported transclusion target syntax: ${directive.rawTarget}`,
        unsupportedParams,
      };
    }

    const depth = context.depth ?? 0;
    const maxDepth = clampDepth(context.maxDepth ?? this.defaultMaxDepth);
    if (depth >= maxDepth) {
      return {
        status: "depth-exceeded",
        reason: `Transclusion nesting depth ${depth + 1} exceeds limit of ${maxDepth}.`,
        unsupportedParams,
      };
    }

    if (context.budget && context.budget.remaining <= 0) {
      return {
        status: "depth-exceeded",
        reason: "Transclusion expansion count budget exhausted for this document.",
        unsupportedParams,
      };
    }

    if (context.charBudget && context.charBudget.remaining <= 0) {
      return {
        status: "depth-exceeded",
        reason: "Transclusion expanded character budget exhausted for this document.",
        unsupportedParams,
      };
    }

    const visitedKeys = context.visitedKeys ?? [];
    const visitedSet = new Set(visitedKeys);
    const warnings: string[] = [];

    let resolvedPath = "";
    let targetSource: string | null = null;
    let duplicateId = false;
    let spec: TargetExtractionSpec;
    let canonicalKey = "";

    if (directive.targetType === "id") {
      canonicalKey = `id:${directive.target}`;
      if (visitedSet.has(canonicalKey)) {
        return {
          status: "cycle",
          reason: `Circular transclusion detected: ${[...visitedKeys, canonicalKey].join(" -> ")}`,
          unsupportedParams,
        };
      }

      const lookup = this.provider.resolveId(directive.target);
      if (lookup.status === "missing") {
        return {
          status: "missing",
          reason: `Org ID "${directive.target}" not found in vault index.`,
          unsupportedParams,
        };
      }

      const node = lookup.status === "duplicate" ? lookup.nodes[0] : lookup.node;
      if (lookup.status === "duplicate") {
        duplicateId = true;
        warnings.push(
          `Duplicate Org ID "${directive.target}" found in ${lookup.nodes.length} locations; using ${node.filePath}:${node.line + 1}.`
        );
      }

      const safePath = resolveSafeVaultPath(node.filePath, "");
      if (!safePath.ok) {
        return {
          status: "security-blocked",
          reason: safePath.reason,
          unsupportedParams,
        };
      }

      resolvedPath = safePath.vaultPath;
      targetSource = await this.provider.readFile(resolvedPath);
      if (targetSource === null) {
        return {
          status: "missing",
          reason: `Source file "${resolvedPath}" for Org ID "${directive.target}" could not be read.`,
          resolvedPath,
          resolvedLine: node.line,
          unsupportedParams,
        };
      }

      spec = { kind: "id-node", node };
    } else {
      const safePath = resolveSafeVaultPath(directive.target, directive.sourcePath);
      if (!safePath.ok) {
        return {
          status: "security-blocked",
          reason: safePath.reason,
          unsupportedParams,
        };
      }

      resolvedPath = safePath.vaultPath;
      targetSource = await this.provider.readFile(resolvedPath);

      const isExplicitRelative =
        directive.target.startsWith("./") ||
        directive.target.startsWith("../") ||
        directive.target.startsWith(".\\") ||
        directive.target.startsWith("..\\");

      if (
        targetSource === null &&
        !isExplicitRelative &&
        directive.sourcePath.includes("/")
      ) {
        const rootCandidate = resolveSafeVaultPath(directive.target, "");
        if (rootCandidate.ok && rootCandidate.vaultPath !== resolvedPath) {
          const rootSource = await this.provider.readFile(rootCandidate.vaultPath);
          if (rootSource !== null) {
            resolvedPath = rootCandidate.vaultPath;
            targetSource = rootSource;
          }
        }
      }

      if (targetSource === null) {
        return {
          status: "missing",
          reason: `Target file not found in vault: ${resolvedPath}`,
          resolvedPath,
          unsupportedParams,
        };
      }

      const rawSearchOption = extractRawSearchOption(directive);
      if (directive.subpath) {
        canonicalKey = `file:${resolvedPath}::${directive.subpath.kind}:${directive.subpath.value}`;
      } else if (rawSearchOption) {
        canonicalKey = `file:${resolvedPath}::${rawSearchOption}`;
      } else {
        canonicalKey = `file:${resolvedPath}`;
      }

      spec = {
        kind: "file",
        filePath: resolvedPath,
        subpath: directive.subpath,
        rawSearchOption,
      };
    }

    const extracted = extractAndTransformTransclusion(
      targetSource,
      spec,
      directive.options,
      directive.parentLevel ?? 0,
      this.defaultExcludeElements
    );

    if (!extracted.ok) {
      return {
        status: "missing",
        reason: extracted.reason,
        resolvedPath,
        unsupportedParams,
      };
    }

    const locationKey = buildLocationCanonicalKey(
      resolvedPath,
      extracted.resolvedLine,
      extracted.isFileRoot
    );

    if (visitedSet.has(canonicalKey) || visitedSet.has(locationKey)) {
      return {
        status: "cycle",
        reason: `Circular transclusion detected: ${[...visitedKeys, canonicalKey].join(" -> ")}`,
        resolvedPath,
        resolvedLine: extracted.resolvedLine,
        unsupportedParams,
      };
    }

    if (context.budget) {
      context.budget.remaining = Math.max(0, context.budget.remaining - 1);
    }

    const effectiveCap = Math.min(
      this.maxSingleExpansionChars,
      context.charBudget ? context.charBudget.remaining : this.maxSingleExpansionChars
    );
    const bounded = truncateOrgContentSafely(extracted.content, effectiveCap);

    warnings.push(...extracted.warnings);
    if (bounded.truncated) {
      warnings.push(
        `Transcluded content truncated at ${effectiveCap} characters for performance.`
      );
    }

    if (context.charBudget) {
      context.charBudget.remaining = Math.max(
        0,
        context.charBudget.remaining - bounded.content.length
      );
    }

    return {
      status: "ok",
      resolvedPath,
      resolvedLine: extracted.resolvedLine,
      resolvedTitle: extracted.resolvedTitle,
      canonicalKey,
      content: bounded.content,
      duplicateId: duplicateId || undefined,
      warnings,
      unsupportedParams,
      readOnly: true,
    };
  }
}
