import { parseOrgDoc } from "../parser/parse";
import { buildSectionTree } from "../parser/sectionTree";
import type { OrgDoc, OrgSectionNode } from "../model/types";
import { isUnsafeUriScheme } from "../../util/links";
import type {
  TransclusionDirective,
  TransclusionLineRange,
  TransclusionOptions,
  TransclusionSubpath,
} from "./types";

const TRANSCLUDE_KEYWORD_RE = /^\s*#\+TRANSCLUDE:\s*(.*)$/i;
const BRACKET_LINK_RE = /^\[\[([^[\]\n]+)\](?:\[[^[\]\n]*\])?\](.*)$/;
const UNSAFE_OR_EXTERNAL_SCHEME_RE = /^(?:https?|ftp|mailto|obsidian|shell|elisp):/i;
const FILE_URI_RE = /^file:\/\//i;
const FILE_TARGET_HINT_RE =
  /^file:/i;
const PATH_LIKE_HINT_RE =
  /^(?:\.\.?[\\/]|\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)|\.org(?:::|$)/i;

interface ParsedToken {
  raw: string;
  value: string;
  quoted: boolean;
}

/**
 * Return true if a raw Org line starts with the `#+TRANSCLUDE:` keyword.
 * Note: callers scanning full documents should check `line.kind === "keyword"`
 * from `parseOrgDoc` so code/example/comment blocks are excluded.
 */
export function isTransclusionKeywordLine(rawLine: string): boolean {
  return TRANSCLUDE_KEYWORD_RE.test(rawLine);
}

function tokenizeOptions(input: string): ParsedToken[] {
  const tokens: ParsedToken[] = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    if (input[i] === '"') {
      const start = i;
      i++;
      let value = "";
      let closed = false;
      while (i < input.length) {
        const ch = input[i];
        if (ch === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          i++;
          closed = true;
          break;
        }
        value += ch;
        i++;
      }
      const raw = closed ? input.slice(start, i) : input.slice(start);
      tokens.push({ raw, value, quoted: true });
      continue;
    }

    const start = i;
    while (i < input.length && !/\s/.test(input[i])) i++;
    const raw = input.slice(start, i);
    tokens.push({ raw, value: raw, quoted: false });
  }

  return tokens;
}

function parseLinesRange(rawValue: string): TransclusionLineRange | null {
  const trimmed = rawValue.trim();
  const singleMatch = /^(\d+)$/.exec(trimmed);
  if (singleMatch) {
    const n = Number(singleMatch[1]);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return { start: n, end: n };
  }

  const rangeMatch = /^(\d*)-(\d*)$/.exec(trimmed);
  if (!rangeMatch) return null;
  if (!rangeMatch[1] && !rangeMatch[2]) return null;

  const start = rangeMatch[1] ? Number(rangeMatch[1]) : undefined;
  const end = rangeMatch[2] ? Number(rangeMatch[2]) : undefined;
  if (start !== undefined && (!Number.isSafeInteger(start) || start < 1)) return null;
  if (end !== undefined && (!Number.isSafeInteger(end) || end < 1)) return null;
  if (start !== undefined && end !== undefined && start > end) return null;

  return { start, end };
}

function parseOptionTokens(rest: string): TransclusionOptions {
  const tokens = tokenizeOptions(rest);
  const options: TransclusionOptions = {
    unsupportedParams: [],
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.quoted || !token.value.startsWith(":")) {
      options.unsupportedParams.push(token.raw);
      i++;
      continue;
    }

    const key = token.value.toLowerCase();
    const next = tokens[i + 1];

    switch (key) {
      case ":level": {
        if (!next || (!next.quoted && next.value.startsWith(":"))) {
          options.levelAuto = true;
          options.level = undefined;
          i++;
        } else if (next.value.trim().toLowerCase() === "auto") {
          options.levelAuto = true;
          options.level = undefined;
          i += 2;
        } else if (/^\d+$/.test(next.value.trim())) {
          const parsed = Number(next.value.trim());
          if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 8) {
            options.level = parsed;
            options.levelAuto = false;
          } else {
            options.unsupportedParams.push(`${token.raw} ${next.raw}`);
          }
          i += 2;
        } else {
          options.unsupportedParams.push(`${token.raw} ${next.raw}`);
          i += 2;
        }
        break;
      }
      case ":only-contents": {
        if (next && !next.quoted && /^(?:t|nil)$/i.test(next.value.trim())) {
          options.onlyContents = next.value.trim().toLowerCase() === "t";
          i += 2;
        } else {
          options.onlyContents = true;
          i++;
        }
        break;
      }
      case ":exclude-elements": {
        if (next && (next.quoted || !next.value.startsWith(":"))) {
          const items = next.value
            .trim()
            .split(/[\s,]+/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          if (items.length > 0) {
            const existing = options.excludeElements ?? [];
            const merged = new Set([...existing, ...items]);
            options.excludeElements = Array.from(merged);
          } else {
            options.unsupportedParams.push(`${token.raw} ${next.raw}`);
          }
          i += 2;
        } else {
          options.unsupportedParams.push(token.raw);
          i++;
        }
        break;
      }
      case ":lines": {
        if (next && (next.quoted || !next.value.startsWith(":"))) {
          const range = parseLinesRange(next.value);
          if (range) {
            options.lines = range;
          } else {
            options.unsupportedParams.push(`${token.raw} ${next.raw}`);
          }
          i += 2;
        } else {
          options.unsupportedParams.push(token.raw);
          i++;
        }
        break;
      }
      default: {
        if (next && (next.quoted || !next.value.startsWith(":"))) {
          options.unsupportedParams.push(`${token.raw} ${next.raw}`);
          i += 2;
        } else {
          options.unsupportedParams.push(token.raw);
          i++;
        }
        break;
      }
    }
  }

  return options;
}

function classifyBracketTarget(
  rawTarget: string,
  sourcePath: string
): {
  targetType: TransclusionDirective["targetType"];
  target: string;
  subpath?: TransclusionSubpath;
} {
  if (isUnsafeUriScheme(rawTarget)) {
    return { targetType: "unsupported", target: rawTarget };
  }

  const idMatch = /^id:(.+)$/i.exec(rawTarget);
  if (idMatch) {
    const idVal = idMatch[1].trim();
    return idVal
      ? { targetType: "id", target: idVal }
      : { targetType: "unsupported", target: rawTarget };
  }

  if (FILE_URI_RE.test(rawTarget)) {
    return { targetType: "file", target: rawTarget };
  }

  if (UNSAFE_OR_EXTERNAL_SCHEME_RE.test(rawTarget)) {
    return { targetType: "unsupported", target: rawTarget };
  }

  if (rawTarget.startsWith("*")) {
    const heading = rawTarget.slice(1).trim();
    return heading
      ? {
          targetType: "file",
          target: sourcePath,
          subpath: { kind: "heading", value: heading },
        }
      : { targetType: "unsupported", target: rawTarget };
  }

  if (rawTarget.startsWith("#")) {
    const customId = rawTarget.slice(1).trim();
    return customId
      ? {
          targetType: "file",
          target: sourcePath,
          subpath: { kind: "custom-id", value: customId },
        }
      : { targetType: "unsupported", target: rawTarget };
  }

  if (FILE_TARGET_HINT_RE.test(rawTarget) || PATH_LIKE_HINT_RE.test(rawTarget)) {
    const withoutPrefix = FILE_TARGET_HINT_RE.test(rawTarget)
      ? rawTarget.slice(5).trim()
      : rawTarget;
    const searchSep = withoutPrefix.indexOf("::");
    const filePart = (searchSep >= 0 ? withoutPrefix.slice(0, searchSep) : withoutPrefix).trim();
    if (!filePart) {
      return { targetType: "unsupported", target: rawTarget };
    }

    if (searchSep >= 0) {
      const searchPart = withoutPrefix.slice(searchSep + 2).trim();
      if (!searchPart) {
        return { targetType: "unsupported", target: rawTarget };
      }
      if (searchPart.startsWith("*")) {
        const heading = searchPart.slice(1).trim();
        if (!heading) return { targetType: "unsupported", target: rawTarget };
        return {
          targetType: "file",
          target: filePart,
          subpath: { kind: "heading", value: heading },
        };
      }
      if (searchPart.startsWith("#")) {
        const customId = searchPart.slice(1).trim();
        if (!customId) return { targetType: "unsupported", target: rawTarget };
        return {
          targetType: "file",
          target: filePart,
          subpath: { kind: "custom-id", value: customId },
        };
      }
      // Named element / dedicated target (`::name` or `::<<target>>`): rawTarget keeps `::...`.
      return { targetType: "file", target: filePart };
    }

    return { targetType: "file", target: filePart };
  }

  return { targetType: "unsupported", target: rawTarget };
}

/**
 * Parse a single `#+transclude:` keyword line into a structured `TransclusionDirective`.
 * Returns `null` when the line is not a `#+transclude:` directive or has an empty body.
 */
export function parseTransclusionDirective(
  rawLine: string,
  sourcePath: string,
  line: number,
  parentLevel = 0
): TransclusionDirective | null {
  const keywordMatch = TRANSCLUDE_KEYWORD_RE.exec(rawLine);
  if (!keywordMatch) return null;

  const body = keywordMatch[1].trim();
  if (!body) return null;

  const bracketMatch = BRACKET_LINK_RE.exec(body);
  if (!bracketMatch) {
    const firstSpace = body.search(/\s/);
    const rawTarget = (firstSpace >= 0 ? body.slice(0, firstSpace) : body).trim();
    const rest = firstSpace >= 0 ? body.slice(firstSpace + 1).trim() : "";
    return {
      sourcePath,
      line,
      raw: rawLine,
      targetType: "unsupported",
      rawTarget,
      target: rawTarget,
      parentLevel,
      options: parseOptionTokens(rest),
    };
  }

  const rawTarget = bracketMatch[1].trim();
  const rest = bracketMatch[2].trim();
  const classified = classifyBracketTarget(rawTarget, sourcePath);

  return {
    sourcePath,
    line,
    raw: rawLine,
    targetType: classified.targetType,
    rawTarget,
    target: classified.target,
    subpath: classified.subpath,
    parentLevel,
    options: parseOptionTokens(rest),
  };
}

/**
 * Extract the non-subpath search option after `::` when present (e.g. `::named-block`),
 * returning `undefined` when there is no `::` or when `subpath` already covers `*`/`#`.
 */
export function extractRawSearchOption(directive: TransclusionDirective): string | undefined {
  if (directive.subpath || directive.targetType !== "file") return undefined;
  const cleaned = directive.rawTarget.replace(/^file:/i, "").trim();
  const sep = cleaned.indexOf("::");
  if (sep < 0) return undefined;
  const searchPart = cleaned.slice(sep + 2).trim();
  if (!searchPart || searchPart.startsWith("*") || searchPart.startsWith("#")) {
    return undefined;
  }
  return searchPart;
}

/**
 * Scan an Org document using `parseOrgDoc` + `buildSectionTree` and return all genuine
 * `#+transclude:` directives with their enclosing `parentLevel`, ignoring verbatim,
 * src, example, comment, export, drawer, and math blocks.
 */
export function findTransclusionDirectives(
  source: string,
  sourcePath: string
): TransclusionDirective[] {
  const doc = parseOrgDoc(source);
  const tree = buildSectionTree(doc);
  const directives: TransclusionDirective[] = [];

  const scanLines = (indices: number[], parentLevel: number) => {
    for (const idx of indices) {
      const line = doc.lines[idx];
      if (!line || line.kind !== "keyword") continue;
      if (!isTransclusionKeywordLine(line.text)) continue;
      const parsed = parseTransclusionDirective(line.text, sourcePath, line.index, parentLevel);
      if (parsed) directives.push(parsed);
    }
  };

  scanLines(tree.preambleLines, 0);

  const visitSection = (sec: OrgSectionNode) => {
    scanLines(sec.bodyLines, sec.level);
    for (const child of sec.children) {
      visitSection(child);
    }
  };

  for (const sec of tree.sections) {
    visitSection(sec);
  }

  return directives;
}

/**
 * Helper to look up `OrgDoc` line indices and enclosing heading level for every line.
 */
export function computeLineParentLevels(doc: OrgDoc, baseParentLevel = 0): number[] {
  const levels = new Array<number>(doc.lines.length).fill(baseParentLevel);
  let currentLevel = baseParentLevel;

  for (const line of doc.lines) {
    if (line.kind === "heading" && line.heading) {
      currentLevel = line.heading.level;
    }
    levels[line.index] = currentLevel;
  }
  return levels;
}
