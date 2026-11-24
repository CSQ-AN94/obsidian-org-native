import type { OrgDoc, OrgLine, OrgNodeEntry, OrgSectionNode } from "../model/types";
import { parseOrgDoc } from "../parser/parse";
import { buildSectionTree } from "../parser/sectionTree";
import { isTransclusionKeywordLine } from "./parser";
import type { TransclusionOptions, TransclusionSubpath } from "./types";

export const DEFAULT_EXCLUDE_ELEMENTS: readonly string[] = ["property-drawer"];

export const SUPPORTED_EXCLUDE_ELEMENTS: ReadonlySet<string> = new Set([
  "property-drawer",
  "drawer",
  "keyword",
  "planning",
  "comment",
  "comment-block",
  "headline",
  "src-block",
  "quote-block",
  "example-block",
  "verse-block",
  "center-block",
  "export-block",
  "special-block",
  "table",
  "fixed-width",
  "horizontal-rule",
  "latex-environment",
  "plain-list",
  "paragraph",
]);

const FILE_METADATA_KEYWORD_RE =
  /^\s*#\+(?:TITLE|AUTHOR|DATE|EMAIL|DESCRIPTION|KEYWORDS|LANGUAGE|STARTUP|TODO|SEQ_TODO|TYP_TODO|OPTIONS|FILETAGS|PROPERTY|CATEGORY|SUBTITLE|EXPORT_FILE_NAME)(?:\[[^\]]*\])?:/i;
const NAME_KEYWORD_RE = /^\s*#\+NAME:\s*(.+?)\s*$/i;
const ATTR_OR_CAPTION_KEYWORD_RE = /^\s*#\+(?:ATTR_[A-Za-z0-9_-]+|CAPTION|RESULTS)(?:\[[^\]]*\])?:/i;

export type TargetExtractionSpec =
  | { kind: "id-node"; node: OrgNodeEntry }
  | {
      kind: "file";
      filePath: string;
      subpath?: TransclusionSubpath;
      rawSearchOption?: string;
    };

export type ExtractTransformResult =
  | {
      ok: true;
      content: string;
      resolvedLine: number;
      resolvedTitle: string;
      isFileRoot: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      reason: string;
    };

function findSectionByHeadingLine(
  sections: OrgSectionNode[],
  lineIndex: number
): OrgSectionNode | undefined {
  for (const sec of sections) {
    if (sec.headingLineIndex === lineIndex) return sec;
    const child = findSectionByHeadingLine(sec.children, lineIndex);
    if (child) return child;
  }
  return undefined;
}

function findSectionById(sections: OrgSectionNode[], id: string): OrgSectionNode | undefined {
  for (const sec of sections) {
    if (sec.id === id) return sec;
    const child = findSectionById(sec.children, id);
    if (child) return child;
  }
  return undefined;
}

function findSectionByTitle(
  sections: OrgSectionNode[],
  title: string,
  caseInsensitive: boolean
): OrgSectionNode | undefined {
  const needle = caseInsensitive ? title.trim().toLowerCase() : title.trim();
  for (const sec of sections) {
    const candidate = caseInsensitive ? sec.titleText.trim().toLowerCase() : sec.titleText.trim();
    if (candidate === needle) return sec;
    const child = findSectionByTitle(sec.children, title, caseInsensitive);
    if (child) return child;
  }
  return undefined;
}

function findSectionByCustomId(
  sections: OrgSectionNode[],
  customId: string,
  caseInsensitive: boolean
): OrgSectionNode | undefined {
  const needle = caseInsensitive ? customId.trim().toLowerCase() : customId.trim();
  for (const sec of sections) {
    const candidate = sec.customId
      ? caseInsensitive
        ? sec.customId.trim().toLowerCase()
        : sec.customId.trim()
      : undefined;
    if (candidate === needle) return sec;
    const child = findSectionByCustomId(sec.children, customId, caseInsensitive);
    if (child) return child;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractNamedOrDedicatedTarget(
  doc: OrgDoc,
  rawSearchOption: string
): { lines: string[]; resolvedLine: number; resolvedTitle: string } | null {
  const normalizedName = rawSearchOption
    .replace(/^<<(.+)>>$/, "$1")
    .trim();
  if (!normalizedName) return null;

  // 1. Search `#+NAME: <target>` preceding a block, table, math block, or paragraph.
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i];
    if (line.kind !== "keyword") continue;
    const m = NAME_KEYWORD_RE.exec(line.text);
    if (!m) continue;
    if (m[1].trim().toLowerCase() !== normalizedName.toLowerCase()) continue;

    let j = i + 1;
    while (j < doc.lines.length) {
      const next = doc.lines[j];
      if (
        next.kind === "blank" ||
        (next.kind === "keyword" &&
          (ATTR_OR_CAPTION_KEYWORD_RE.test(next.text) || NAME_KEYWORD_RE.test(next.text)))
      ) {
        j++;
        continue;
      }
      break;
    }
    if (j >= doc.lines.length) return null;

    const targetLine = doc.lines[j];
    if (targetLine.kind === "block-start" && targetLine.block) {
      const endLine = targetLine.block.endLine ?? doc.lines.length - 1;
      return {
        lines: doc.lines.slice(targetLine.index, endLine + 1).map((l) => l.text),
        resolvedLine: targetLine.index,
        resolvedTitle: normalizedName,
      };
    }
    if ((targetLine.kind === "table" || targetLine.kind === "table-rule") && targetLine.table) {
      return {
        lines: doc.lines
          .slice(targetLine.table.startLine, targetLine.table.endLine + 1)
          .map((l) => l.text),
        resolvedLine: targetLine.table.startLine,
        resolvedTitle: normalizedName,
      };
    }
    if (targetLine.kind === "math-block" && targetLine.mathBlock) {
      return {
        lines: doc.lines
          .slice(targetLine.mathBlock.startLine, targetLine.mathBlock.endLine + 1)
          .map((l) => l.text),
        resolvedLine: targetLine.mathBlock.startLine,
        resolvedTitle: normalizedName,
      };
    }
    if (targetLine.kind === "text") {
      let end = j;
      while (end + 1 < doc.lines.length && doc.lines[end + 1].kind === "text") {
        end++;
      }
      return {
        lines: doc.lines.slice(j, end + 1).map((l) => l.text),
        resolvedLine: j,
        resolvedTitle: normalizedName,
      };
    }
    return {
      lines: [targetLine.text],
      resolvedLine: targetLine.index,
      resolvedTitle: normalizedName,
    };
  }

  // 2. Search dedicated target `<<name>>` inside regular text paragraphs.
  const dedicatedRe = new RegExp(`<<${escapeRegExp(normalizedName)}>>`, "i");
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i];
    if (line.kind !== "text") continue;
    if (!dedicatedRe.test(line.text)) continue;

    let start = i;
    while (start > 0 && doc.lines[start - 1].kind === "text") {
      start--;
    }
    let end = i;
    while (end + 1 < doc.lines.length && doc.lines[end + 1].kind === "text") {
      end++;
    }
    const strippedRe = new RegExp(`\\s*<<${escapeRegExp(normalizedName)}>>\\s*`, "gi");
    const lines = doc.lines.slice(start, end + 1).map((l) =>
      l.text.replace(strippedRe, (match, offset: number, full: string) => {
        if (offset === 0 || offset + match.length === full.length) return "";
        return " ";
      })
    );
    return {
      lines,
      resolvedLine: start,
      resolvedTitle: normalizedName,
    };
  }

  return null;
}

function extractRawSlice(
  doc: OrgDoc,
  spec: TargetExtractionSpec
):
  | {
      ok: true;
      lines: string[];
      resolvedLine: number;
      resolvedTitle: string;
      isFileRoot: boolean;
    }
  | { ok: false; reason: string } {
  const tree = buildSectionTree(doc);

  if (spec.kind === "id-node") {
    const { node } = spec;
    if (node.level === 0) {
      return {
        ok: true,
        lines: doc.lines.map((l) => l.text),
        resolvedLine: 0,
        resolvedTitle: node.title || doc.title || node.filePath,
        isFileRoot: true,
      };
    }

    const sec =
      findSectionByHeadingLine(tree.sections, node.line) ??
      (node.id ? findSectionById(tree.sections, node.id) : undefined);

    const startLine = sec ? sec.headingLineIndex : Math.max(0, Math.min(node.line, doc.lines.length - 1));
    const endLine = sec
      ? sec.endLineIndex
      : Math.max(startLine, Math.min(node.endLine, doc.lines.length - 1));
    const resolvedTitle = sec?.titleText || node.title;

    return {
      ok: true,
      lines: doc.lines.slice(startLine, endLine + 1).map((l) => l.text),
      resolvedLine: startLine,
      resolvedTitle,
      isFileRoot: false,
    };
  }

  if (spec.subpath?.kind === "heading") {
    const sec =
      findSectionByTitle(tree.sections, spec.subpath.value, false) ??
      findSectionByTitle(tree.sections, spec.subpath.value, true);
    if (!sec) {
      return {
        ok: false,
        reason: `Heading "*${spec.subpath.value}" not found in ${spec.filePath}`,
      };
    }
    return {
      ok: true,
      lines: doc.lines.slice(sec.headingLineIndex, sec.endLineIndex + 1).map((l) => l.text),
      resolvedLine: sec.headingLineIndex,
      resolvedTitle: sec.titleText || spec.subpath.value,
      isFileRoot: false,
    };
  }

  if (spec.subpath?.kind === "custom-id") {
    const needle = spec.subpath.value.trim();
    if (
      tree.fileCustomId &&
      (tree.fileCustomId === needle || tree.fileCustomId.toLowerCase() === needle.toLowerCase())
    ) {
      return {
        ok: true,
        lines: doc.lines.map((l) => l.text),
        resolvedLine: 0,
        resolvedTitle: doc.title || spec.filePath,
        isFileRoot: true,
      };
    }
    const sec =
      findSectionByCustomId(tree.sections, needle, false) ??
      findSectionByCustomId(tree.sections, needle, true);
    if (!sec) {
      return {
        ok: false,
        reason: `CUSTOM_ID "#${spec.subpath.value}" not found in ${spec.filePath}`,
      };
    }
    return {
      ok: true,
      lines: doc.lines.slice(sec.headingLineIndex, sec.endLineIndex + 1).map((l) => l.text),
      resolvedLine: sec.headingLineIndex,
      resolvedTitle: sec.titleText || needle,
      isFileRoot: false,
    };
  }

  if (spec.rawSearchOption) {
    const found = extractNamedOrDedicatedTarget(doc, spec.rawSearchOption);
    if (!found) {
      return {
        ok: false,
        reason: `Target "${spec.rawSearchOption}" not found in ${spec.filePath}`,
      };
    }
    return {
      ok: true,
      lines: found.lines,
      resolvedLine: found.resolvedLine,
      resolvedTitle: found.resolvedTitle,
      isFileRoot: true,
    };
  }

  return {
    ok: true,
    lines: doc.lines.map((l) => l.text),
    resolvedLine: 0,
    resolvedTitle: doc.title || spec.filePath,
    isFileRoot: true,
  };
}

function applyOnlyContents(lines: string[], isFileRoot: boolean): string[] {
  if (lines.length === 0) return lines;
  const doc = parseOrgDoc(lines.join("\n"));

  if (!isFileRoot) {
    const drop = new Set<number>();
    if (doc.lines[0]?.kind === "heading") {
      drop.add(0);
    }

    let pos = drop.has(0) ? 1 : 0;
    while (pos < doc.lines.length) {
      const l = doc.lines[pos];
      if (l.kind === "blank" || l.kind === "planning") {
        pos++;
        continue;
      }
      if (l.kind === "drawer-start" && l.drawer?.name.toUpperCase() === "PROPERTIES") {
        const end = l.drawer.endLine ?? doc.lines.length - 1;
        for (let d = l.index; d <= end; d++) {
          drop.add(d);
        }
      }
      break;
    }

    return doc.lines.filter((l) => !drop.has(l.index)).map((l) => l.text);
  }

  // Whole-file :only-contents strips leading file metadata keywords & file-level PROPERTIES drawer,
  // while leaving any #+TRANSCLUDE: directives and all document body/sections intact.
  const drop = new Set<number>();
  let pos = 0;
  while (pos < doc.lines.length) {
    const l = doc.lines[pos];
    if (l.kind === "blank") {
      pos++;
      continue;
    }
    if (l.kind === "drawer-start" && l.drawer?.name.toUpperCase() === "PROPERTIES") {
      const end = l.drawer.endLine ?? doc.lines.length - 1;
      for (let d = l.index; d <= end; d++) {
        drop.add(d);
      }
      pos = end + 1;
      continue;
    }
    if (l.kind === "keyword" && !isTransclusionKeywordLine(l.text) && FILE_METADATA_KEYWORD_RE.test(l.text)) {
      drop.add(l.index);
      pos++;
      continue;
    }
    break;
  }

  return doc.lines.filter((l) => !drop.has(l.index)).map((l) => l.text);
}

function shouldExcludeLine(line: OrgLine, excluded: ReadonlySet<string>): boolean {
  if (line.drawer) {
    const isProp = line.drawer.name.toUpperCase() === "PROPERTIES";
    if (excluded.has("drawer")) return true;
    if (isProp && excluded.has("property-drawer")) return true;
  }

  if (line.block) {
    switch (line.block.type) {
      case "src":
        if (excluded.has("src-block")) return true;
        break;
      case "quote":
        if (excluded.has("quote-block")) return true;
        break;
      case "example":
        if (excluded.has("example-block")) return true;
        break;
      case "verse":
        if (excluded.has("verse-block")) return true;
        break;
      case "center":
        if (excluded.has("center-block")) return true;
        break;
      case "export":
        if (excluded.has("export-block")) return true;
        break;
      case "comment":
        if (excluded.has("comment-block") || excluded.has("comment")) return true;
        break;
      case "special":
        if (excluded.has("special-block")) return true;
        break;
    }
  }

  switch (line.kind) {
    case "heading":
      return excluded.has("headline");
    case "keyword":
      if (isTransclusionKeywordLine(line.text)) return false;
      return excluded.has("keyword");
    case "planning":
      return excluded.has("planning");
    case "comment":
      return excluded.has("comment");
    case "table":
    case "table-rule":
      return excluded.has("table");
    case "fixed-width":
      return excluded.has("fixed-width");
    case "rule":
      return excluded.has("horizontal-rule");
    case "math-block":
      return excluded.has("latex-environment");
    case "list":
      return excluded.has("plain-list");
    case "text":
      return excluded.has("paragraph");
    default:
      return false;
  }
}

function applyExcludeElements(
  lines: string[],
  excluded: ReadonlySet<string>
): string[] {
  if (lines.length === 0 || excluded.size === 0) return lines;
  const doc = parseOrgDoc(lines.join("\n"));
  return doc.lines.filter((line) => !shouldExcludeLine(line, excluded)).map((line) => line.text);
}

function applyHeadingLevels(lines: string[], desiredLevel: number): string[] {
  if (lines.length === 0) return lines;
  const doc = parseOrgDoc(lines.join("\n"));
  const headingLines = doc.lines.filter((line) => line.kind === "heading" && line.heading);
  if (headingLines.length === 0) return lines;

  let minLevel = Infinity;
  for (const line of headingLines) {
    const level = line.heading!.level;
    if (level < minLevel) minLevel = level;
  }
  const delta = desiredLevel - minLevel;
  if (delta === 0) return lines;

  return doc.lines.map((line) => {
    if (line.kind !== "heading" || !line.heading) return line.text;
    const oldLevel = line.heading.level;
    const nextLevel = Math.max(1, Math.min(8, oldLevel + delta));
    return "*".repeat(nextLevel) + line.text.slice(oldLevel);
  });
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && lines[start].trim() === "") start++;
  while (end >= start && lines[end].trim() === "") end--;
  return start > end ? [] : lines.slice(start, end + 1);
}

/**
 * Pure, read-only extraction and transformation of transcluded Org source content.
 * Applies target extraction, `:lines`, `:only-contents`, `:exclude-elements`, and
 * `:level` headline shifting without mutating any source strings or files on disk.
 */
export function extractAndTransformTransclusion(
  targetSource: string,
  spec: TargetExtractionSpec,
  options: TransclusionOptions,
  parentLevel = 0,
  defaultExcludeElements: readonly string[] = DEFAULT_EXCLUDE_ELEMENTS
): ExtractTransformResult {
  const warnings: string[] = [];
  const doc = parseOrgDoc(targetSource);
  const sliced = extractRawSlice(doc, spec);
  if (!sliced.ok) {
    return sliced;
  }

  let lines = sliced.lines;

  // 1. Apply :lines slice first so 1-based line numbers align with the extracted source.
  if (options.lines) {
    const startIdx = Math.max(0, (options.lines.start ?? 1) - 1);
    const endIdx = Math.min(lines.length - 1, (options.lines.end ?? lines.length) - 1);
    if (startIdx >= lines.length || endIdx < startIdx) {
      const rangeDesc = `${options.lines.start ?? ""}..${options.lines.end ?? ""}`;
      warnings.push(`Line range :lines ${rangeDesc} exceeds target length (${lines.length} lines).`);
      lines = [];
    } else {
      lines = lines.slice(startIdx, endIdx + 1);
    }
  }

  // 2. Apply :only-contents (omit target headline + immediate :PROPERTIES:, keep sub-headings).
  if (options.onlyContents) {
    lines = applyOnlyContents(lines, sliced.isFileRoot);
  }

  // 3. Apply default + per-directive :exclude-elements filtering.
  const excluded = new Set<string>(defaultExcludeElements.map((s) => s.toLowerCase()));
  if (options.excludeElements) {
    for (const item of options.excludeElements) {
      const lower = item.toLowerCase();
      if (!SUPPORTED_EXCLUDE_ELEMENTS.has(lower)) {
        warnings.push(`Unknown :exclude-elements type "${item}" ignored.`);
        continue;
      }
      excluded.add(lower);
    }
  }
  lines = applyExcludeElements(lines, excluded);

  // 4. Adjust heading levels when :level N or bare :level/:level auto is specified.
  let desiredLevel: number | undefined;
  if (options.level !== undefined) {
    desiredLevel = Math.max(1, Math.min(8, options.level));
  } else if (options.levelAuto) {
    desiredLevel = Math.max(1, Math.min(8, parentLevel + 1));
  }
  if (desiredLevel !== undefined) {
    lines = applyHeadingLevels(lines, desiredLevel);
  }

  lines = trimBlankEdges(lines);

  return {
    ok: true,
    content: lines.join("\n"),
    resolvedLine: sliced.resolvedLine,
    resolvedTitle: sliced.resolvedTitle,
    isFileRoot: sliced.isFileRoot,
    warnings,
  };
}

/**
 * Safely truncate oversized transcluded Org content at a line boundary while closing
 * any unclosed Org blocks, drawers, or math environments so rendering stays well-formed.
 */
export function truncateOrgContentSafely(
  content: string,
  maxChars: number
): { content: string; truncated: boolean } {
  if (maxChars <= 0) {
    return { content: "", truncated: content.length > 0 };
  }
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }

  const allLines = content.split("\n");
  const kept: string[] = [];
  let charCount = 0;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const addition = (kept.length > 0 ? 1 : 0) + line.length;
    if (kept.length > 0 && charCount + addition > maxChars) {
      break;
    }
    if (kept.length === 0 && line.length > maxChars) {
      kept.push(line.slice(0, maxChars));
      break;
    }
    kept.push(line);
    charCount += addition;
  }

  const prefixText = kept.join("\n");
  const parsed = parseOrgDoc(prefixText);
  const lastLine = parsed.lines[parsed.lines.length - 1];
  const closingLines: string[] = [];

  if (lastLine?.block && lastLine.block.endLine === undefined) {
    closingLines.push(`#+END_${lastLine.block.rawName}`);
  } else if (lastLine?.drawer && lastLine.drawer.endLine === undefined) {
    closingLines.push(":END:");
  } else if (lastLine?.mathBlock) {
    const mb = lastLine.mathBlock;
    // Check whether the math block was actually closed inside prefixText.
    const rawSpan = parsed.lines
      .slice(mb.startLine, mb.endLine + 1)
      .map((l) => l.text)
      .join("\n");
    if (mb.kind === "dollar" && (rawSpan.match(/\$\$/g)?.length ?? 0) < 2) {
      closingLines.push("$$");
    } else if (mb.kind === "bracket" && !rawSpan.includes("\\]")) {
      closingLines.push("\\]");
    } else if (mb.kind === "paren" && !rawSpan.includes("\\)")) {
      closingLines.push("\\)");
    } else if (mb.kind === "env" && mb.env && !rawSpan.includes(`\\end{${mb.env}}`)) {
      closingLines.push(`\\end{${mb.env}}`);
    }
  }

  const finalContent =
    closingLines.length > 0 ? `${prefixText}\n${closingLines.join("\n")}` : prefixText;
  return { content: finalContent, truncated: true };
}
