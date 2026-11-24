import type {
  OrgGraphColorGroup,
  OrgGraphColorSchemeMode,
  OrgGraphNode,
} from "./types";

/**
 * Accessible mid-tone palette designed for legible contrast on both Light and Dark canvases.
 */
export const ORG_GRAPH_PALETTE: readonly string[] = [
  "#3b82f6", // Blue
  "#16a34a", // Emerald
  "#d97706", // Amber
  "#e11d48", // Rose
  "#8b5cf6", // Violet
  "#0891b2", // Cyan
  "#ea580c", // Orange
  "#0d9488", // Teal
  "#6366f1", // Indigo
  "#db2777", // Pink
  "#65a30d", // Lime
  "#a855f7", // Purple
] as const;

export interface ParsedGraphQuery {
  raw: string;
  tags: string[];
  files: string[];
  paths: string[];
  ids: string[];
  terms: string[];
  isEmpty: boolean;
}

function tokenizeQuery(rawQuery: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoteChar: string | null = null;

  for (let i = 0; i < rawQuery.length; i++) {
    const ch = rawQuery[i];
    if (quoteChar) {
      if (ch === quoteChar) {
        quoteChar = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Parse a structured graph search query supporting `tag:#foo` / `tag:foo`,
 * `file:substr`, `path:substr`, `id:substr`, and case-insensitive free-text terms.
 */
export function parseGraphQuery(rawQuery: string): ParsedGraphQuery {
  const raw = rawQuery ?? "";
  const tags: string[] = [];
  const files: string[] = [];
  const paths: string[] = [];
  const ids: string[] = [];
  const terms: string[] = [];

  for (const token of tokenizeQuery(raw)) {
    const m = /^(tag|file|path|id):(.*)$/i.exec(token);
    if (m) {
      const prefix = m[1].toLowerCase();
      const value = m[2].trim().toLowerCase();
      if (prefix === "tag") {
        const cleanTag = value.replace(/^#+/, "");
        if (cleanTag) tags.push(cleanTag);
      } else if (prefix === "file") {
        if (value) files.push(value);
      } else if (prefix === "path") {
        if (value) paths.push(value);
      } else if (prefix === "id") {
        if (value) ids.push(value);
      }
      continue;
    }

    const lower = token.trim().toLowerCase();
    if (lower) {
      terms.push(lower);
    }
  }

  const isEmpty =
    tags.length === 0 &&
    files.length === 0 &&
    paths.length === 0 &&
    ids.length === 0 &&
    terms.length === 0;

  return { raw, tags, files, paths, ids, terms, isEmpty };
}

function matchesTagFilter(nodeTags: string[], expectedTag: string): boolean {
  for (const rawTag of nodeTags) {
    const clean = rawTag.replace(/^#+/, "").toLowerCase();
    if (clean === expectedTag || clean.startsWith(`${expectedTag}/`)) {
      return true;
    }
  }
  return false;
}

function matchesFreeTextTerm(node: OrgGraphNode, term: string): boolean {
  if (node.title.toLowerCase().includes(term)) return true;
  if (node.orgId && node.orgId.toLowerCase().includes(term)) return true;
  if (node.customId && node.customId.toLowerCase().includes(term)) return true;
  if (node.filePath.toLowerCase().includes(term)) return true;
  for (const segment of node.headingPath) {
    if (segment.toLowerCase().includes(term)) return true;
  }
  const tagTerm = term.startsWith("#") && term.length > 1 ? term.slice(1) : null;
  for (const rawTag of node.tags) {
    const tagLower = rawTag.toLowerCase();
    if (tagLower.includes(term) || (tagTerm !== null && tagLower.includes(tagTerm))) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluate whether `node` satisfies all clauses in `query` (AND semantics across terms).
 */
export function matchesGraphQuery(
  node: OrgGraphNode,
  query: string | ParsedGraphQuery
): boolean {
  const parsed = typeof query === "string" ? parseGraphQuery(query) : query;
  if (parsed.isEmpty) return true;

  for (const tag of parsed.tags) {
    if (!matchesTagFilter(node.tags, tag)) return false;
  }

  const fileLower = node.filePath.toLowerCase();
  for (const fileSubstr of parsed.files) {
    if (!fileLower.includes(fileSubstr)) return false;
  }

  for (const pathSubstr of parsed.paths) {
    if (!fileLower.includes(pathSubstr)) return false;
  }

  if (parsed.ids.length > 0) {
    const orgIdLower = (node.orgId ?? "").toLowerCase();
    const customIdLower = (node.customId ?? "").toLowerCase();
    for (const idSubstr of parsed.ids) {
      if (!orgIdLower.includes(idSubstr) && !customIdLower.includes(idSubstr)) {
        return false;
      }
    }
  }

  for (const term of parsed.terms) {
    if (!matchesFreeTextTerm(node, term)) return false;
  }

  return true;
}

function hashStringFnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function getPaletteColorForKey(categoryKey: string): string {
  const idx = hashStringFnv1a(categoryKey) % ORG_GRAPH_PALETTE.length;
  return ORG_GRAPH_PALETTE[idx];
}

export function resolveNodeFolder(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "(root)";
  return normalized.slice(0, lastSlash);
}

function resolveModeColor(
  node: OrgGraphNode,
  colorMode: OrgGraphColorSchemeMode
): { groupColor?: string; groupId?: string } {
  if (colorMode === "none" || colorMode === "custom") {
    return {};
  }

  if (node.kind === "unresolved") {
    return {};
  }

  if (colorMode === "file") {
    if (!node.filePath) return {};
    const key = `file:${node.filePath}`;
    return { groupColor: getPaletteColorForKey(key), groupId: key };
  }

  if (colorMode === "folder") {
    if (!node.filePath) return {};
    const folder = resolveNodeFolder(node.filePath);
    const key = `folder:${folder}`;
    return { groupColor: getPaletteColorForKey(key), groupId: key };
  }

  if (colorMode === "tag") {
    if (node.tags.length === 0) return {};
    const primaryTag = node.tags[0].replace(/^#+/, "").toLowerCase();
    if (!primaryTag) return {};
    const key = `tag:${primaryTag}`;
    return { groupColor: getPaletteColorForKey(key), groupId: key };
  }

  if (colorMode === "level") {
    const level = Math.max(0, node.level);
    return {
      groupColor: ORG_GRAPH_PALETTE[level % ORG_GRAPH_PALETTE.length],
      groupId: `level:${level}`,
    };
  }

  return {};
}

interface CompiledColorGroup {
  id: string;
  color: string;
  parsed: ParsedGraphQuery;
}

/**
 * Assign deterministic `groupColor` and `groupId` to graph nodes.
 * Ordered custom `groups` always take precedence when a rule matches; otherwise
 * falls back to the selected `colorMode` scheme (`none` leaves uncolored).
 */
export function assignNodeColors(
  nodes: OrgGraphNode[],
  colorMode: OrgGraphColorSchemeMode,
  groups: OrgGraphColorGroup[] = []
): OrgGraphNode[] {
  const compiledGroups: CompiledColorGroup[] = [];
  for (const group of groups) {
    const color = group.color.trim();
    if (!color) continue;
    const parsed = parseGraphQuery(group.query);
    if (parsed.isEmpty) continue;
    compiledGroups.push({ id: group.id, color, parsed });
  }

  for (const node of nodes) {
    let matchedGroup: CompiledColorGroup | undefined;
    for (const group of compiledGroups) {
      if (matchesGraphQuery(node, group.parsed)) {
        matchedGroup = group;
        break;
      }
    }

    if (matchedGroup) {
      node.groupColor = matchedGroup.color;
      node.groupId = matchedGroup.id;
      continue;
    }

    const fallback = resolveModeColor(node, colorMode);
    node.groupColor = fallback.groupColor;
    node.groupId = fallback.groupId;
  }

  return nodes;
}
