import type { App } from "obsidian";
import type { OrgIdStatus } from "../../core/model/types";
import { parseOrgDoc } from "../../core/parser/parse";
import { buildSectionTree } from "../../core/parser/sectionTree";
import { buildLocationCanonicalKey } from "../../core/transclusion/engine";
import {
  computeLineParentLevels,
  extractRawSearchOption,
  isTransclusionKeywordLine,
  parseTransclusionDirective,
} from "../../core/transclusion/parser";
import { resolveSafeVaultPath } from "../../core/transclusion/pathGuard";
import type {
  TransclusionDirective,
  TransclusionResolution,
  TransclusionResolver,
} from "../../core/transclusion/types";
import { resolveLanguage, translate, type TranslationKey } from "../../i18n";
import type { OrgNativeSettings } from "../../settings";
import { openOrgLink, type LinkCallbacks } from "../../util/links";
import { renderOrgPreview, type PreviewRenderOptions } from "../reading/render";

export interface TransclusionDomRenderOptions {
  app: App;
  sourcePath: string;
  resolver: TransclusionResolver;
  settings: OrgNativeSettings;
  linkCallbacks?: LinkCallbacks;
  resolveIdStatus?: (id: string) => OrgIdStatus;
  onOpenSource?: (
    filePath: string,
    line: number,
    directive: TransclusionDirective
  ) => void;
  t?: (key: TranslationKey) => string;
  signal?: AbortSignal;
  isStale?: () => boolean;
  onDependency?: (dep: {
    filePath?: string;
    status: TransclusionResolution["status"];
  }) => void;
  visitedKeys?: string[];
  depth?: number;
  budget?: { remaining: number };
  charBudget?: { remaining: number };
  maxExpansions?: number;
  maxTotalChars?: number;
}

export interface TransclusionSlotMetadata {
  raw: string;
  line: number;
  parentLevel: number;
}

export interface PreparedTransclusionSlots {
  source: string;
  slots: Map<string, TransclusionSlotMetadata>;
}

const DEFAULT_MAX_EXPANSIONS = 50;
const DEFAULT_MAX_TOTAL_CHARS = 200_000;
let slotBatchSeq = 0;

function clampDepth(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.max(1, Math.min(8, Math.floor(value)));
}

/**
 * Scan Org source via `parseOrgDoc` + `buildSectionTree` and replace genuine
 * `#+transclude:` keyword lines with isolated alphanumeric placeholder paragraphs
 * so `renderOrgPreview` never executes inline/block/metadata rules on them and
 * preserves their exact document positions and enclosing heading levels.
 *
 * Fake `#+transclude:` lines inside `#+BEGIN_SRC`, `#+BEGIN_EXAMPLE`,
 * `#+BEGIN_COMMENT`, drawers, math blocks, or `# comments` are left untouched.
 */
export function prepareTransclusionPlaceholders(
  source: string,
  baseParentLevel = 0
): PreparedTransclusionSlots {
  const slots = new Map<string, TransclusionSlotMetadata>();
  const doc = parseOrgDoc(source);
  // Ensure section tree runs cleanly on the parsed document.
  buildSectionTree(doc);
  const parentLevels = computeLineParentLevels(doc, baseParentLevel);

  const genuineLines = new Set<number>();
  for (const line of doc.lines) {
    if (line.kind === "keyword" && isTransclusionKeywordLine(line.text)) {
      genuineLines.add(line.index);
    }
  }

  if (genuineLines.size === 0) {
    return { source, slots };
  }

  let batchTag = `B${(++slotBatchSeq).toString(36).toUpperCase()}`;
  while (source.includes(`ORGXTRANSCLUDEX${batchTag}`)) {
    batchTag = `B${(++slotBatchSeq).toString(36).toUpperCase()}`;
  }

  let slotIndex = 0;
  const outLines: string[] = [];
  for (const line of doc.lines) {
    if (genuineLines.has(line.index)) {
      const marker = `ORGXTRANSCLUDEX${batchTag}X${slotIndex++}XEND`;
      slots.set(marker, {
        raw: line.text,
        line: line.index,
        parentLevel: parentLevels[line.index] ?? baseParentLevel,
      });
      // Surround with blank lines so each placeholder becomes a standalone <p>
      // and stops `skipInitialKeywords` at the top of the document.
      outLines.push("", marker, "");
    } else {
      outLines.push(line.text);
    }
  }

  return {
    source: outLines.join("\n"),
    slots,
  };
}

/**
 * Replace alphanumeric placeholder `<p>` nodes inside a rendered preview root with
 * `.org-transclude-slot` elements ready for `hydrateTransclusionsInDom`.
 */
export function replacePlaceholdersWithSlots(
  root: HTMLElement,
  slots: Map<string, TransclusionSlotMetadata>
): void {
  if (slots.size === 0) return;

  for (const p of Array.from(root.querySelectorAll("p"))) {
    const marker = (p.textContent ?? "").trim();
    const meta = slots.get(marker);
    if (!meta) continue;

    const slot = document.createElement("div");
    slot.className = "org-transclude-slot";
    slot.dataset.transcludeRaw = meta.raw;
    slot.dataset.line = String(meta.line);
    slot.dataset.parentLevel = String(meta.parentLevel);
    p.replaceWith(slot);
  }
}

function createTranslator(options: TransclusionDomRenderOptions): (key: TranslationKey) => string {
  if (options.t) return options.t;
  const lang = resolveLanguage(options.settings.language);
  return (key) => translate(lang, key);
}

function collectDepthZeroVisitedKeys(
  slot: HTMLElement,
  sourcePath: string,
  baseVisited: string[]
): string[] {
  const keys = new Set<string>(baseVisited);
  const safeCurrent = resolveSafeVaultPath(sourcePath, "");
  const normalizedPath = safeCurrent.ok ? safeCurrent.vaultPath : sourcePath.trim();
  if (normalizedPath) {
    keys.add(`file:${normalizedPath}`);
  }

  let section = slot.closest<HTMLElement>(".org-section");
  while (section) {
    const orgId = section.dataset.orgId?.trim();
    if (orgId) {
      keys.add(`id:${orgId}`);
    }
    const lineNum = Number(section.dataset.line);
    if (normalizedPath && Number.isFinite(lineNum)) {
      keys.add(buildLocationCanonicalKey(normalizedPath, lineNum, false));
    }
    section = section.parentElement?.closest<HTMLElement>(".org-section") ?? null;
  }

  return Array.from(keys);
}

function triggerOpenSource(
  filePath: string,
  line: number,
  directive: TransclusionDirective,
  options: TransclusionDomRenderOptions
): void {
  if (options.onOpenSource) {
    options.onOpenSource(filePath, line, directive);
    return;
  }
  if (directive.targetType === "id" && options.linkCallbacks?.onOpenId) {
    options.linkCallbacks.onOpenId(directive.target);
    return;
  }
  openOrgLink(options.app, filePath, options.sourcePath, options.linkCallbacks);
}

function buildSourceHeader(
  titleText: string,
  resolvedPath: string | undefined,
  resolvedLine: number | undefined,
  directive: TransclusionDirective,
  options: TransclusionDomRenderOptions,
  t: (key: TranslationKey) => string,
  allowSourceLink: boolean
): HTMLElement {
  const header = document.createElement("div");
  header.className = "org-transclusion-header";

  if (allowSourceLink && resolvedPath) {
    const lineDisplay = (resolvedLine ?? 0) + 1;
    const link = document.createElement("a");
    link.className = "org-transclusion-source-link internal-link";
    link.href = `#${resolvedPath}:${lineDisplay}`;
    link.dataset.sourcePath = resolvedPath;
    link.dataset.sourceLine = String(resolvedLine ?? 0);
    link.setAttribute("aria-label", `${t("transclusion.openSource")}: ${resolvedPath}:${lineDisplay}`);
    link.title = `${t("transclusion.openSource")} (${resolvedPath}:${lineDisplay})`;

    const titleSpan = document.createElement("span");
    titleSpan.className = "org-transclusion-source-title";
    titleSpan.textContent = titleText || resolvedPath;

    const locSpan = document.createElement("span");
    locSpan.className = "org-transclusion-source-loc";
    locSpan.textContent = `${resolvedPath}:${lineDisplay}`;

    link.appendChild(titleSpan);
    link.appendChild(locSpan);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      triggerOpenSource(resolvedPath, resolvedLine ?? 0, directive, options);
    });
    header.appendChild(link);
  } else {
    const titleSpan = document.createElement("span");
    titleSpan.className = "org-transclusion-error-title";
    titleSpan.textContent = titleText;
    header.appendChild(titleSpan);
  }

  const badge = document.createElement("span");
  badge.className = "org-transclusion-badge org-transclusion-readonly-badge";
  badge.textContent = t("transclusion.readOnlyBadge");
  header.appendChild(badge);

  return header;
}

function buildWarningsBlock(
  warnings: string[],
  unsupportedParams: string[],
  t: (key: TranslationKey) => string
): HTMLElement | null {
  if (warnings.length === 0 && unsupportedParams.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "org-transclusion-warnings";

  if (unsupportedParams.length > 0) {
    const item = document.createElement("div");
    item.className = "org-transclusion-warning is-unsupported";
    item.textContent = `${t("transclusion.unsupportedParams")}: ${unsupportedParams.join(", ")}`;
    wrap.appendChild(item);
  }

  for (const warning of warnings) {
    const item = document.createElement("div");
    item.className = "org-transclusion-warning";
    item.textContent = warning;
    wrap.appendChild(item);
  }

  return wrap;
}

function errorTitleKeyForStatus(
  status: Exclude<TransclusionResolution["status"], "ok">
): TranslationKey {
  switch (status) {
    case "missing":
      return "transclusion.errorMissing";
    case "cycle":
      return "transclusion.errorCycle";
    case "depth-exceeded":
      return "transclusion.errorDepth";
    case "security-blocked":
      return "transclusion.errorSecurity";
    case "unsupported":
      return "transclusion.errorUnsupported";
  }
}

function buildErrorAside(
  directive: TransclusionDirective,
  resolution: Extract<TransclusionResolution, { status: Exclude<TransclusionResolution["status"], "ok"> }>,
  depth: number,
  options: TransclusionDomRenderOptions,
  t: (key: TranslationKey) => string
): HTMLElement {
  const aside = document.createElement("aside");
  aside.className = `org-transclusion org-transclusion-error org-transclusion-error-${resolution.status}`;
  if (depth > 0) aside.classList.add("org-transclusion-nested");
  aside.setAttribute("role", "alert");
  aside.dataset.transclusionStatus = resolution.status;
  aside.dataset.transclusionDepth = String(depth);
  aside.dataset.rawDirective = directive.raw;
  aside.dataset.readonly = "true";
  if (resolution.resolvedPath) {
    aside.dataset.sourcePath = resolution.resolvedPath;
  }
  if (resolution.resolvedLine !== undefined) {
    aside.dataset.sourceLine = String(resolution.resolvedLine);
  }

  const titleText = t(errorTitleKeyForStatus(resolution.status));
  const allowSourceLink =
    Boolean(resolution.resolvedPath) && resolution.status !== "security-blocked";

  aside.appendChild(
    buildSourceHeader(
      titleText,
      resolution.resolvedPath,
      resolution.resolvedLine,
      directive,
      options,
      t,
      allowSourceLink
    )
  );

  const body = document.createElement("div");
  body.className = "org-transclusion-error-body";

  const reasonEl = document.createElement("div");
  reasonEl.className = "org-transclusion-error-reason";
  reasonEl.textContent = resolution.reason;
  body.appendChild(reasonEl);

  const codeWrap = document.createElement("div");
  codeWrap.className = "org-transclusion-error-raw";
  const code = document.createElement("code");
  code.textContent = directive.raw.trim();
  codeWrap.appendChild(code);
  body.appendChild(codeWrap);

  const warningsEl = buildWarningsBlock([], resolution.unsupportedParams, t);
  if (warningsEl) body.appendChild(warningsEl);

  aside.appendChild(body);
  return aside;
}

function buildInertKeywordFallback(raw: string): HTMLElement {
  const line = document.createElement("div");
  line.className = "org-keyword-line";
  const key = document.createElement("span");
  key.className = "org-keyword-key";
  key.textContent = "TRANSCLUDE";
  const val = document.createElement("span");
  val.className = "org-keyword-value";
  val.textContent = raw.replace(/^\s*#\+TRANSCLUDE:\s*/i, "");
  line.appendChild(key);
  line.appendChild(val);
  return line;
}

function isCancelled(options: TransclusionDomRenderOptions): boolean {
  return Boolean(options.signal?.aborted || options.isStale?.());
}

/**
 * Hydrate all `.org-transclude-slot` elements inside `root` in read-only mode,
 * expanding `#+transclude:` targets recursively with cycle/depth/budget/security
 * guards, source attribution headers, and jump-to-source links.
 */
export async function hydrateTransclusionsInDom(
  root: HTMLElement,
  options: TransclusionDomRenderOptions
): Promise<void> {
  if (!options.settings.enableTransclusion || isCancelled(options)) {
    return;
  }

  const depth = options.depth ?? 0;
  const maxDepth = clampDepth(options.settings.transclusionMaxDepth);
  const budget = options.budget ?? {
    remaining: Math.max(1, options.maxExpansions ?? DEFAULT_MAX_EXPANSIONS),
  };
  const charBudget = options.charBudget ?? {
    remaining: Math.max(1, options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS),
  };
  const t = createTranslator(options);

  const slots = Array.from(root.querySelectorAll<HTMLElement>(".org-transclude-slot"));
  for (const slot of slots) {
    if (isCancelled(options)) return;

    const raw = slot.dataset.transcludeRaw ?? "";
    const line = Number(slot.dataset.line ?? "0");
    const parentLevel = Number(slot.dataset.parentLevel ?? "0");
    const safeLine = Number.isFinite(line) ? line : 0;
    const safeParentLevel = Number.isFinite(parentLevel) ? parentLevel : 0;

    const directive = parseTransclusionDirective(
      raw,
      options.sourcePath,
      safeLine,
      safeParentLevel
    );
    if (!directive) {
      slot.replaceWith(buildInertKeywordFallback(raw));
      continue;
    }

    const branchVisited =
      depth === 0
        ? collectDepthZeroVisitedKeys(slot, options.sourcePath, options.visitedKeys ?? [])
        : [...(options.visitedKeys ?? [])];

    let resolution: TransclusionResolution;
    try {
      resolution = await options.resolver.resolve(directive, {
        visitedKeys: branchVisited,
        depth,
        maxDepth,
        budget,
        charBudget,
      } as Parameters<TransclusionResolver["resolve"]>[1]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolution = {
        status: "unsupported",
        reason: `Transclusion failed unexpectedly: ${message}`,
        unsupportedParams: [...directive.options.unsupportedParams],
      };
    }

    if (isCancelled(options)) return;

    options.onDependency?.({
      filePath: resolution.resolvedPath,
      status: resolution.status,
    });

    if (resolution.status !== "ok") {
      slot.replaceWith(buildErrorAside(directive, resolution, depth, options, t));
      continue;
    }

    const aside = document.createElement("aside");
    aside.className = "org-transclusion";
    if (depth > 0) aside.classList.add("org-transclusion-nested");
    aside.dataset.transclusionStatus = "ok";
    aside.dataset.transclusionDepth = String(depth);
    aside.dataset.sourcePath = resolution.resolvedPath;
    aside.dataset.sourceLine = String(resolution.resolvedLine);
    aside.dataset.canonicalKey = resolution.canonicalKey;
    aside.dataset.rawDirective = directive.raw;
    aside.dataset.readonly = "true";

    aside.appendChild(
      buildSourceHeader(
        resolution.resolvedTitle,
        resolution.resolvedPath,
        resolution.resolvedLine,
        directive,
        options,
        t,
        true
      )
    );

    const warningsEl = buildWarningsBlock(
      resolution.warnings,
      resolution.unsupportedParams,
      t
    );
    if (warningsEl) {
      aside.appendChild(warningsEl);
    }

    const bodyEl = document.createElement("div");
    bodyEl.className = "org-transclusion-body";
    bodyEl.dataset.readonly = "true";

    if (resolution.content.trim().length > 0) {
      const innerBaseLevel =
        directive.options.level ??
        (directive.options.levelAuto ? Math.min(8, safeParentLevel + 1) : safeParentLevel);
      const prepared = prepareTransclusionPlaceholders(resolution.content, innerBaseLevel);
      const innerPreview = renderOrgPreview(
        prepared.source,
        options.app,
        resolution.resolvedPath,
        {
          settings: {
            ...options.settings,
            honorStartup: false,
          },
          fallbackTitle: undefined,
          linkCallbacks: options.linkCallbacks,
          resolveIdStatus: options.resolveIdStatus,
        }
      );

      // Neutralize Reading View's outer scroll/padding classes while keeping
      // `innerPreview` intact so async Prism/MathJax hydration still resolves inside it.
      innerPreview.className = "org-transclusion-rendered";
      const sizer = Array.from(innerPreview.children).find(
        (el): el is HTMLElement =>
          el instanceof HTMLElement && el.classList.contains("markdown-preview-sizer")
      );
      if (sizer) {
        sizer.className = "org-transclusion-sizer";
      }

      innerPreview
        .querySelectorAll<HTMLInputElement>("input.org-task-checkbox, input[type='checkbox']")
        .forEach((input) => {
          input.disabled = true;
          input.setAttribute("aria-readonly", "true");
        });

      replacePlaceholdersWithSlots(innerPreview, prepared.slots);
      bodyEl.appendChild(innerPreview);
    } else {
      const emptyNote = document.createElement("div");
      emptyNote.className = "org-transclusion-empty";
      emptyNote.textContent = `${t("transclusion.readOnlyBadge")} · (empty)`;
      bodyEl.appendChild(emptyNote);
    }

    aside.appendChild(bodyEl);
    slot.replaceWith(aside);

    if (bodyEl.querySelector(".org-transclude-slot")) {
      const isWholeFileDirective =
        directive.targetType === "file" &&
        !directive.subpath &&
        !extractRawSearchOption(directive);
      const locationKey = buildLocationCanonicalKey(
        resolution.resolvedPath,
        resolution.resolvedLine,
        isWholeFileDirective
      );
      const nextVisited = Array.from(
        new Set([...branchVisited, resolution.canonicalKey, locationKey])
      );

      await hydrateTransclusionsInDom(bodyEl, {
        ...options,
        sourcePath: resolution.resolvedPath,
        visitedKeys: nextVisited,
        depth: depth + 1,
        budget,
        charBudget,
      });
    }
  }
}

/**
 * Convenience composition entry point: prepares `#+transclude:` slots before
 * calling `renderOrgPreview`, then hydrates all transclusions in read-only mode.
 * Usable directly in tests or by `OrgView` before or alongside `hydrateTransclusions`.
 */
export async function renderOrgPreviewWithTransclusions(
  source: string,
  app: App,
  sourcePath: string,
  previewOptions: PreviewRenderOptions,
  transclusionOptions: Omit<
    TransclusionDomRenderOptions,
    "app" | "sourcePath" | "settings" | "linkCallbacks" | "resolveIdStatus"
  >
): Promise<HTMLElement> {
  if (!previewOptions.settings.enableTransclusion) {
    return renderOrgPreview(source, app, sourcePath, previewOptions);
  }

  const prepared = prepareTransclusionPlaceholders(source, 0);
  const root = renderOrgPreview(prepared.source, app, sourcePath, previewOptions);
  replacePlaceholdersWithSlots(root, prepared.slots);

  await hydrateTransclusionsInDom(root, {
    ...transclusionOptions,
    app,
    sourcePath,
    settings: previewOptions.settings,
    linkCallbacks: previewOptions.linkCallbacks,
    resolveIdStatus: previewOptions.resolveIdStatus,
  });

  return root;
}
