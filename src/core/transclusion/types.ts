/**
 * Phase 2 contracts for Org Transclusion (`#+transclude:`).
 *
 * Clean-room interface definitions modeled from public Org Transclusion syntax
 * semantics. Zero GPLv3 source code is derived or included.
 */

import type { OrgNodeEntry } from "../model/types";

export interface TransclusionLineRange {
  /** 1-based inclusive starting line. */
  start?: number;
  /** 1-based inclusive ending line. */
  end?: number;
}

export interface TransclusionOptions {
  /** Explicit `:level N` target heading level (1..8). */
  level?: number;
  /** Bare `:level` flag (shift to parentLevel + 1). */
  levelAuto?: boolean;
  /** `:only-contents` — omit target headline & leading properties, keep body/sub-contents. */
  onlyContents?: boolean;
  /** `:exclude-elements "drawer keyword ..."` — Org element types to strip in read-only output. */
  excludeElements?: string[];
  /** `:lines A-B` / `:lines A-` / `:lines -B` (1-based inclusive line slice). */
  lines?: TransclusionLineRange;
  /** Any unrecognized/unsupported `:flag` or `:param value` tokens, preserved for explicit UI warnings. */
  unsupportedParams: string[];
}

export interface TransclusionSubpath {
  kind: "heading" | "custom-id";
  value: string;
}

export interface TransclusionDirective {
  sourcePath: string;
  line: number;
  raw: string;
  targetType: "id" | "file" | "unsupported";
  /** Raw link target (e.g. `id:abc` or `file:notes/foo.org::*Heading`). */
  rawTarget: string;
  /** Normalized ID (for `id`) or vault-relative file path (for `file`). */
  target: string;
  /** Optional subpath after `::` for file targets (`*Heading` or `#custom-id`). */
  subpath?: TransclusionSubpath;
  /** Enclosing heading level in source file (0 for file preamble). */
  parentLevel?: number;
  options: TransclusionOptions;
}

export type TransclusionIdLookup =
  | { status: "found"; node: OrgNodeEntry }
  | { status: "duplicate"; nodes: OrgNodeEntry[] }
  | { status: "missing" };

export interface TransclusionContentProvider {
  /** Read raw `.org` file contents for a vault-relative path, or `null` if missing/outside vault. */
  readFile(vaultPath: string): Promise<string | null> | string | null;
  /** Resolve an Org `:ID:` to its indexed node status and entry. */
  resolveId(id: string): TransclusionIdLookup;
}

export type TransclusionResolution =
  | {
      status: "ok";
      resolvedPath: string;
      resolvedLine: number;
      resolvedTitle: string;
      /** Canonical key used for cycle tracking (e.g. `id:<id>` or `file:<path>#<subpath>`). */
      canonicalKey: string;
      /** Read-only transformed Org text ready to render (never written back to disk). */
      content: string;
      /** Whether the target ID had duplicates (resolved to first match with warning). */
      duplicateId?: boolean;
      warnings: string[];
      unsupportedParams: string[];
      /** Always true — transcluded views are strictly read-only. */
      readOnly: true;
    }
  | {
      status: "missing" | "cycle" | "depth-exceeded" | "security-blocked" | "unsupported";
      reason: string;
      resolvedPath?: string;
      resolvedLine?: number;
      unsupportedParams: string[];
    };

export interface TransclusionResolveContext {
  visitedKeys?: string[];
  depth?: number;
  maxDepth?: number;
  budget?: { remaining: number };
}

export interface TransclusionResolver {
  resolve(
    directive: TransclusionDirective,
    context?: TransclusionResolveContext
  ): Promise<TransclusionResolution>;
}
