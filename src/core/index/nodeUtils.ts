import type { OrgDoc, OrgNodeEntry, OrgSectionNode } from "../model/types";
import { parseOrgDoc } from "../parser/parse";
import { buildSectionTree } from "../parser/sectionTree";

export interface NodePreviewDetail {
  text: string;
  lines: string[];
  truncated: boolean;
}

export interface NodePreviewOptions {
  maxLines?: number;
  maxChars?: number;
  includeHeading?: boolean;
}

/**
 * Format an indexed node's vault location as a readable breadcrumb,
 * e.g. `notes/a.org › H1 › H2` (or just `notes/a.org` for file-level nodes).
 */
export function formatNodeBreadcrumb(node: OrgNodeEntry): string {
  const headings = node.headingPath.map((part) => part.trim()).filter(Boolean);
  return headings.length > 0 ? [node.filePath, ...headings].join(" › ") : node.filePath;
}

/**
 * Format a node's heading hierarchy without the file path,
 * e.g. `H1 › H2` (or `"File"` for level-0 file nodes).
 */
export function formatHeadingHierarchy(node: OrgNodeEntry): string {
  const headings = node.headingPath.map((part) => part.trim()).filter(Boolean);
  return headings.length > 0 ? headings.join(" › ") : "File";
}

/**
 * Format a compact badge representing the node's outline level (`"File"` or `"H1"`..`"Hn"`).
 */
export function formatNodeLevelBadge(node: OrgNodeEntry): string {
  return node.level <= 0 ? "File" : `H${node.level}`;
}

/**
 * Clean an Org source line into a concise, plain-text context summary.
 * Zero HTML rendering or code execution occurs here.
 */
export function formatContextExcerpt(rawLine: string, maxChars = 160): string {
  const cleaned = rawLine
    .replace(/\r?\n/g, " ")
    .replace(/\[\[([^[\]]*?)\]\[([^[\]]*?)\]\]/g, "$2")
    .replace(/\[\[([^[\]]*?)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";
  if (maxChars > 0 && cleaned.length > maxChars) {
    return `${cleaned.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  }
  return cleaned;
}

function findSectionById(sections: OrgSectionNode[], id: string): OrgSectionNode | undefined {
  for (const sec of sections) {
    if (sec.id === id) return sec;
    const nested = findSectionById(sec.children, id);
    if (nested) return nested;
  }
  return undefined;
}

function shouldSkipLineForPreview(doc: OrgDoc, lineIndex: number, inDrawerState: { active: boolean }): boolean {
  const line = doc.lines[lineIndex];
  if (!line) return true;

  if (line.kind === "drawer-start" || line.kind === "drawer" || line.kind === "drawer-end") {
    const drawerName = line.drawer?.name.toUpperCase() ?? "";
    if (!drawerName || drawerName === "PROPERTIES" || drawerName === "LOGBOOK") {
      inDrawerState.active = line.kind !== "drawer-end";
      return true;
    }
  }

  if (inDrawerState.active) {
    if (/^\s*:END:\s*$/i.test(line.text)) {
      inDrawerState.active = false;
    }
    return true;
  }

  if (line.kind === "comment" || line.kind === "comment-block") {
    return true;
  }

  if (line.kind === "block-start" || line.kind === "block-end") {
    if (line.block?.type === "comment") return true;
  }

  return false;
}

function applyCharBudget(lines: string[], maxChars: number): { lines: string[]; truncated: boolean } {
  if (maxChars <= 0) return { lines: [], truncated: lines.length > 0 };

  const kept: string[] = [];
  let used = 0;
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const separator = kept.length > 0 ? 1 : 0;
    if (used + separator + line.length <= maxChars) {
      kept.push(line);
      used += separator + line.length;
      continue;
    }

    const remaining = maxChars - used - separator;
    if (remaining > 1) {
      kept.push(`${line.slice(0, remaining - 1).trimEnd()}…`);
    } else if (kept.length > 0) {
      const last = kept[kept.length - 1];
      if (!last.endsWith("…")) {
        kept[kept.length - 1] = `${last.slice(0, Math.max(0, last.length - 1)).trimEnd()}…`;
      }
    } else {
      kept.push("…");
    }
    truncated = true;
    break;
  }

  return { lines: kept, truncated };
}

/**
 * Extract a clean read-only text excerpt for `node` from `source` (`node.line .. node.endLine`),
 * omitting `:PROPERTIES:`/`:LOGBOOK:` drawers and comments while preserving safe inert plain text.
 */
export function extractNodePreviewDetail(
  source: string,
  node: OrgNodeEntry,
  options: NodePreviewOptions = {}
): NodePreviewDetail {
  const maxLines = options.maxLines ?? 8;
  const maxChars = options.maxChars ?? 480;
  const includeHeading = options.includeHeading ?? false;

  if (!source || maxLines <= 0 || maxChars <= 0) {
    return { text: "", lines: [], truncated: false };
  }

  const doc = parseOrgDoc(source);
  if (doc.lines.length === 0) {
    return { text: "", lines: [], truncated: false };
  }

  let start = Math.max(0, node.line);
  let end = Math.min(doc.lines.length - 1, node.endLine);

  const tree = buildSectionTree(doc);
  if (node.id && node.level > 0) {
    const lineAtNode = doc.lines[start];
    const matchesDirectHeading = lineAtNode?.kind === "heading";
    const resolvedSection = findSectionById(tree.sections, node.id);
    if (resolvedSection && (!matchesDirectHeading || resolvedSection.headingLineIndex !== start)) {
      start = Math.max(0, resolvedSection.headingLineIndex);
      end = Math.min(doc.lines.length - 1, resolvedSection.endLineIndex);
    }
  }

  if (start > end) {
    return { text: "", lines: [], truncated: false };
  }

  const startLine = doc.lines[start];
  const startsAtHeading = startLine?.kind === "heading";
  const bodyScanStart = !includeHeading && startsAtHeading ? start + 1 : start;

  const collected: string[] = [];
  const childHeadingOutlines: string[] = [];
  const drawerState = { active: false };
  let sawDirectContent = false;
  let hitLineLimit = false;
  let justSkippedLeadingNoise = true;

  for (let i = bodyScanStart; i <= end; i++) {
    const line = doc.lines[i];
    if (!line) continue;

    if (shouldSkipLineForPreview(doc, i, drawerState)) {
      justSkippedLeadingNoise = true;
      continue;
    }

    if (node.level === 0 && line.kind === "keyword") {
      const m = /^\s*#\+([A-Za-z0-9_-]+)(?:\[[^\]]*\])?:/i.exec(line.text);
      if (m && /^(TITLE|STARTUP|TODO|SEQ_TODO|TYP_TODO|FILETAGS|OPTIONS|SETUPFILE)$/i.test(m[1])) {
        justSkippedLeadingNoise = true;
        continue;
      }
    }

    if (line.kind === "heading") {
      if (i > start) {
        if (sawDirectContent) {
          break;
        }
        childHeadingOutlines.push(line.text.trimEnd());
        if (childHeadingOutlines.length >= maxLines) {
          hitLineLimit = i < end;
          break;
        }
        continue;
      }
    }

    if (line.kind === "blank" || line.text.trim() === "") {
      if (
        collected.length === 0 ||
        justSkippedLeadingNoise ||
        collected[collected.length - 1] === ""
      ) {
        continue;
      }
      collected.push("");
      if (collected.length >= maxLines) {
        hitLineLimit = i < end;
        break;
      }
      continue;
    }

    justSkippedLeadingNoise = false;
    if (line.kind !== "planning") {
      sawDirectContent = true;
    }
    collected.push(line.text.trimEnd());
    if (collected.length >= maxLines) {
      hitLineLimit = i < end;
      break;
    }
  }

  let candidateLines = collected.length > 0 ? collected : childHeadingOutlines;
  while (candidateLines.length > 0 && candidateLines[candidateLines.length - 1] === "") {
    candidateLines = candidateLines.slice(0, -1);
  }

  const budgeted = applyCharBudget(candidateLines, maxChars);
  let text = budgeted.lines.join("\n");
  const truncated = budgeted.truncated || hitLineLimit;

  if (!budgeted.truncated && hitLineLimit && text && !text.endsWith("…")) {
    text = `${text}\n…`;
  }

  return {
    text,
    lines: budgeted.lines,
    truncated,
  };
}

/**
 * Extract a clean read-only text excerpt for `node` from `source`.
 */
export function extractNodePreview(
  source: string,
  node: OrgNodeEntry,
  maxLines = 8,
  maxChars = 480
): string {
  return extractNodePreviewDetail(source, node, {
    maxLines,
    maxChars,
    includeHeading: true,
  }).text;
}
