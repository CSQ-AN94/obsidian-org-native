/**
 * Line-oriented structural Org parser.
 *
 * Adapted from zzeitt/obsidian-org-live (MIT) with CRLF offset preservation,
 * #+STARTUP: collection, raw block name preservation, and drawer entry capture.
 * All offsets are exact character indices into the original source string.
 */

import type {
  BlockData,
  BlockType,
  DrawerData,
  HeadingData,
  ListData,
  MathBlockData,
  OrgDoc,
  OrgLine,
  TableCell,
  TableData,
  TableRow,
  TagSpan,
} from "../model/types";
import { createTodoKeywordSets } from "./todoKeywords";

const BLOCK_TYPES: Record<string, BlockType> = {
  SRC: "src",
  QUOTE: "quote",
  EXAMPLE: "example",
  CENTER: "center",
  VERSE: "verse",
  COMMENT: "comment",
  EXPORT: "export",
};

const DRAWER_NAMES = new Set(["PROPERTIES", "LOGBOOK", "END", "CLOCK"]);

function isUpperDrawerName(name: string): boolean {
  return /^[A-Z][A-Z0-9_-]*$/.test(name);
}

const DISPLAY_MATH_ENV =
  /^\s*\\begin\{(align\*?|equation\*?|gather\*?|multline\*?|flalign\*?|alignat\*?|eqnarray\*?|displaymath|math)\}/;

type MathStart = Pick<MathBlockData, "kind" | "env">;

function detectMathBlockStart(raw: string): MathStart | null {
  const env = DISPLAY_MATH_ENV.exec(raw);
  if (env) return { kind: "env", env: env[1] };

  const trimmed = raw.trimStart();
  if (trimmed.startsWith("$$") && !trimmed.slice(2).includes("$$")) {
    return { kind: "dollar" };
  }
  if (trimmed.startsWith("\\[") && !trimmed.slice(2).includes("\\]")) {
    return { kind: "bracket" };
  }
  if (trimmed.startsWith("\\(") && !trimmed.slice(2).includes("\\)")) {
    return { kind: "paren" };
  }
  return null;
}

function mathBlockEnds(raw: string, block: MathBlockData): boolean {
  switch (block.kind) {
    case "env":
      return block.env
        ? new RegExp(`\\\\end\\{${block.env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`).test(raw)
        : false;
    case "dollar":
      return raw.includes("$$");
    case "bracket":
      return raw.includes("\\]");
    case "paren":
      return raw.includes("\\)");
  }
}

export function parseOrgDoc(source: string): OrgDoc {
  const rawLines = source.split("\n");
  const lines: OrgLine[] = [];
  const blocks: BlockData[] = [];
  const tables: TableData[] = [];
  const drawers: DrawerData[] = [];
  const startup: string[] = [];
  let title: string | undefined;

  const fileTodoSpecs: string[] = [];
  for (const rawWithCr of rawLines) {
    const raw = rawWithCr.endsWith("\r") ? rawWithCr.slice(0, -1) : rawWithCr;
    const m = /^\s*#\+(?:SEQ_|TYP_)?TODO:\s*(.*)$/i.exec(raw);
    if (m) fileTodoSpecs.push(m[1]);
  }
  const keywordSets = createTodoKeywordSets(fileTodoSpecs);
  const todoActive = new Set(keywordSets.active);
  const todoDone = new Set(keywordSets.done);

  let offset = 0;
  let block: BlockData | undefined;
  let drawer: DrawerData | undefined;
  let table: TableData | undefined;
  let tableLines: OrgLine[] = [];
  const mathBlocks: MathBlockData[] = [];
  let mathBlock: MathBlockData | undefined;

  const finishTable = () => {
    if (!table) return;
    const currentTable = table;
    const last = tableLines[tableLines.length - 1];
    if (last) currentTable.to = last.to;
    if (currentTable.alignments) {
      for (const row of currentTable.rows) {
        row.cells.forEach((cell, index) => {
          if (!cell.align) cell.align = currentTable.alignments?.[index];
        });
      }
    }
    tables.push(currentTable);
    table = undefined;
    tableLines = [];
  };

  const finishMathBlock = (endLine: number) => {
    if (!mathBlock) return;
    const current = mathBlock;
    current.endLine = endLine;
    const first = lines[current.startLine];
    const last = lines[endLine];
    if (first) current.from = first.from;
    if (last) current.to = last.to;

    const full = lines
      .slice(current.startLine, endLine + 1)
      .map((line) => line.text)
      .join("\n");
    let latex = full.trim();
    if (current.kind === "dollar") {
      const open = full.indexOf("$$");
      const close = full.lastIndexOf("$$");
      if (open >= 0 && close > open) latex = full.slice(open + 2, close).trim();
    } else if (current.kind === "bracket") {
      const open = full.indexOf("\\[");
      const close = full.lastIndexOf("\\]");
      if (open >= 0 && close > open) latex = full.slice(open + 2, close).trim();
    } else if (current.kind === "paren") {
      const open = full.indexOf("\\(");
      const close = full.lastIndexOf("\\)");
      if (open >= 0 && close > open) latex = full.slice(open + 2, close).trim();
    }
    current.latex = latex;
    mathBlocks.push(current);
    mathBlock = undefined;
  };

  for (let index = 0; index < rawLines.length; index++) {
    const rawWithCr = rawLines[index];
    const raw = rawWithCr.endsWith("\r") ? rawWithCr.slice(0, -1) : rawWithCr;
    const from = offset;
    const to = from + raw.length;
    // Preserve exact absolute offsets even on CRLF (\r\n) documents.
    offset = from + rawWithCr.length + 1;

    const line: OrgLine = { index, from, to, text: raw, kind: "text" };

    if (mathBlock) {
      line.kind = "math-block";
      line.mathBlock = mathBlock;
      lines.push(line);
      if (mathBlockEnds(raw, mathBlock)) finishMathBlock(index);
      continue;
    }

    if (block) {
      const endMatch = /^\s*#\+END_([A-Za-z0-9_-]+)\s*$/i.exec(raw);
      if (endMatch && endMatch[1].toUpperCase() === block.rawName) {
        block.endLine = index;
        line.kind = "block-end";
        line.block = block;
        const lastContent = block.endLine - 1;
        if (lastContent >= 0 && lines[lastContent]?.block === block) {
          lines[lastContent].blockLast = true;
        }
        block = undefined;
        lines.push(line);
        continue;
      }

      line.block = block;
      switch (block.type) {
        case "src":
          line.kind = "src";
          break;
        case "quote":
          line.kind = "quote";
          break;
        case "example":
          line.kind = "example";
          break;
        case "center":
          line.kind = "center";
          break;
        case "verse":
          line.kind = "verse";
          break;
        case "comment":
          line.kind = "comment-block";
          break;
        case "export":
          line.kind = "export";
          break;
        default:
          line.kind = "text";
      }
      if (line.kind !== "text" && !lines[lines.length - 1]?.blockFirst) {
        if (block.beginLine === index - 1 || !line.blockFirst) line.blockFirst = true;
      }
      lines.push(line);
      continue;
    }

    const isTableLine = /^\s*\|/.test(raw);
    if (isTableLine) {
      if (!table) {
        table = {
          id: tables.length,
          startLine: index,
          endLine: index,
          from,
          to,
          rows: [],
          ruleAfter: [],
        };
      }
      table.endLine = index;
      const isRule = /^\s*\|[-+|: ]+\|?\s*$/.test(raw) && /-/.test(raw);
      line.kind = isRule ? "table-rule" : "table";
      line.table = table;
      if (!isRule) {
        const row = parseTableRow(raw, from);
        row.line = index;
        const isAlignmentRow =
          row.cells.length > 0 &&
          row.cells.every((cell) => cell.align !== undefined && cell.text === "");
        if (isAlignmentRow) {
          table.alignments = row.cells.map((cell) => cell.align);
        } else {
          table.rows.push(row);
        }
      } else if (table.rows.length > 0) {
        table.ruleAfter.push(table.rows.length - 1);
      }
      tableLines.push(line);
      lines.push(line);
      continue;
    }
    if (table) finishTable();

    {
      const mathStart = detectMathBlockStart(raw);
      if (mathStart) {
        mathBlock = {
          id: mathBlocks.length,
          startLine: index,
          endLine: index,
          from,
          to,
          latex: "",
          display: true,
          kind: mathStart.kind,
          env: mathStart.env,
        };
        line.kind = "math-block";
        line.mathBlock = mathBlock;
        lines.push(line);
        if (mathStart.kind === "env" && mathBlockEnds(raw, mathBlock)) {
          finishMathBlock(index);
        }
        continue;
      }
    }

    if (raw.trim() === "") {
      line.kind = "blank";
      lines.push(line);
      continue;
    }

    const blockStart = /^\s*#\+BEGIN_([A-Za-z0-9_-]+)(?:\s+(.*?))?\s*$/i.exec(raw);
    if (blockStart) {
      const rawName = blockStart[1].toUpperCase();
      const type = BLOCK_TYPES[rawName] ?? "special";
      const lang = type === "src" ? (blockStart[2] ?? "").trim().split(/\s+/)[0] : undefined;
      block = {
        id: blocks.length,
        type,
        rawName,
        beginLine: index,
        lang,
        beginFrom: from,
        beginTo: to,
      };
      blocks.push(block);
      line.kind = "block-start";
      line.block = block;
      lines.push(line);
      continue;
    }

    if (drawer) {
      if (/^\s*:END:\s*$/i.test(raw)) {
        drawer.endLine = index;
        line.kind = "drawer-end";
        line.drawer = drawer;
        drawer = undefined;
      } else {
        line.kind = "drawer";
        line.drawer = drawer;
        drawer.rawLines.push(raw);
        const prop = /^\s*:([^:\s][^:]*):\s*(.*)$/.exec(raw);
        if (prop) {
          drawer.entries.push({ key: prop[1].trim(), value: prop[2].trim(), line: index });
        }
      }
      lines.push(line);
      continue;
    }

    const drawerStart = /^\s*:([A-Za-z][A-Za-z0-9_-]*):\s*$/.exec(raw);
    if (drawerStart) {
      const name = drawerStart[1];
      if (
        name.toUpperCase() !== "END" &&
        (DRAWER_NAMES.has(name.toUpperCase()) || isUpperDrawerName(name))
      ) {
        drawer = {
          id: drawers.length,
          name,
          startLine: index,
          entries: [],
          rawLines: [],
        };
        drawers.push(drawer);
        line.kind = "drawer-start";
        line.drawer = drawer;
        lines.push(line);
        continue;
      }
    }

    const headingMatch = /^(\*+)(?=\s|$)(.*)$/.exec(raw);
    if (headingMatch) {
      line.kind = "heading";
      line.heading = parseHeading(raw, from, headingMatch, todoActive, todoDone);
      lines.push(line);
      continue;
    }

    const listMatch = /^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/.exec(raw);
    if (listMatch) {
      const indent = listMatch[1].length;
      if (!(listMatch[2] === "*" && indent === 0)) {
        line.kind = "list";
        line.list = parseList(listMatch, from);
        lines.push(line);
        continue;
      }
    }

    const planning = /^\s*(SCHEDULED|DEADLINE|CLOSED):(?=\s|$)/.exec(raw);
    if (planning) {
      line.kind = "planning";
      line.planning = {
        keyword: planning[1],
        from: from + raw.indexOf(planning[1]),
        to: from + raw.indexOf(planning[1]) + planning[1].length,
      };
      lines.push(line);
      continue;
    }

    const keyword = /^\s*#\+([A-Za-z0-9_-]+)(?:\[[^\]]*\])?:\s*(.*)$/.exec(raw);
    if (keyword) {
      line.kind = "keyword";
      const upperKey = keyword[1].toUpperCase();
      if (upperKey === "TITLE") title = keyword[2].trim();
      else if (upperKey === "STARTUP") {
        for (const token of keyword[2].trim().split(/\s+/)) {
          if (token) startup.push(token.toLowerCase());
        }
      }
      lines.push(line);
      continue;
    }

    if (/^\s*#(?:\s|$)/.test(raw)) {
      line.kind = "comment";
      lines.push(line);
      continue;
    }

    if (/^\s*-{5,}\s*$/.test(raw)) {
      line.kind = "rule";
      lines.push(line);
      continue;
    }

    if (/^\s*:(?:\s|$)/.test(raw)) {
      line.kind = "fixed-width";
      lines.push(line);
      continue;
    }

    lines.push(line);
  }

  if (block) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].block === block) {
        lines[i].blockLast = true;
        break;
      }
    }
  }
  finishTable();
  if (mathBlock) finishMathBlock(rawLines.length - 1);

  return {
    lines,
    blocks,
    tables,
    drawers,
    mathBlocks,
    todoActive,
    todoDone,
    title,
    startup,
  };
}

function parseHeading(
  raw: string,
  from: number,
  match: RegExpExecArray,
  todoActive: Set<string>,
  todoDone: Set<string>
): HeadingData {
  const stars = match[1];
  const starsFrom = from;
  const starsTo = from + stars.length;
  let cursor = stars.length;
  while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;

  let keyword: HeadingData["keyword"];
  const keywordMatch = /^(\S+)(?=\s|$)/.exec(raw.slice(cursor));
  if (keywordMatch) {
    const word = keywordMatch[1];
    if (todoActive.has(word) || todoDone.has(word)) {
      const kFrom = from + cursor;
      const kTo = kFrom + word.length;
      keyword = { text: word, from: kFrom, to: kTo, done: todoDone.has(word) };
      cursor += word.length;
      while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
    }
  }

  let priority: HeadingData["priority"];
  const priorityMatch = /^\[#([A-Za-z0-9])\]/.exec(raw.slice(cursor));
  if (priorityMatch) {
    priority = {
      text: priorityMatch[1],
      from: from + cursor,
      to: from + cursor + priorityMatch[0].length,
    };
    cursor += priorityMatch[0].length;
    while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
  }

  let titleEnd = raw.length;
  const tags: TagSpan[] = [];
  const tagMatch = /(^|\s)(:[\p{L}\p{N}_@#%]+(?::[\p{L}\p{N}_@#%]+)*:)\s*$/u.exec(raw);
  if (tagMatch) {
    const tagGroup = tagMatch[2];
    const groupStart = from + tagMatch.index + tagMatch[1].length;
    let pos = groupStart;
    const names = tagGroup.slice(1, -1).split(":");
    for (const name of names) {
      if (!name) continue;
      const spanFrom = pos;
      const spanTo = Math.min(from + raw.length, pos + name.length + 2);
      tags.push({ name, from: spanFrom, to: spanTo });
      pos = spanTo - 1;
    }
    titleEnd = tagMatch.index;
    while (titleEnd > cursor && /\s/.test(raw[titleEnd - 1])) titleEnd--;
  }

  let titleFrom = from + cursor;
  if (titleFrom > from + titleEnd) titleFrom = from + titleEnd;

  return {
    level: stars.length,
    starsFrom,
    starsTo,
    keyword,
    priority,
    tags,
    titleFrom,
    titleTo: from + titleEnd,
  };
}

function parseList(match: RegExpExecArray, from: number): ListData {
  const indent = match[1].length;
  const marker = match[2];
  const markerFrom = from + indent;
  const markerTo = markerFrom + marker.length;
  const ordered = /^\d/.test(marker);
  const number = ordered ? parseInt(marker, 10) : 0;

  let contentStart = match.index + match[1].length + marker.length + match[3].length;
  const afterMarker = match[4];
  let checkbox: ListData["checkbox"];
  const cb = /^\[([ Xx-])\]\s+/.exec(afterMarker);
  if (cb) {
    const cbFrom = from + contentStart;
    const cbTo = cbFrom + 3;
    checkbox = { from: cbFrom, to: cbTo, checked: cb[1].toLowerCase() === "x" };
    contentStart += cb[0].length;
  }

  return {
    indent,
    markerFrom,
    markerTo,
    ordered,
    number,
    checkbox,
    contentFrom: from + contentStart,
  };
}

function parseTableRow(raw: string, from: number): TableRow {
  const row: TableRow = { line: 0, cells: [] };
  const pipes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "|" && raw[i - 1] !== "\\") pipes.push(i);
  }
  if (pipes.length === 0) return row;

  const starts = pipes.slice();
  const ends = pipes.slice(1);
  if (raw.slice(pipes[pipes.length - 1] + 1).trim() !== "") {
    ends.push(raw.length);
  }

  for (let i = 0; i < ends.length; i++) {
    const start = starts[i] + 1;
    const end = ends[i];
    let text = raw.slice(start, end);
    let cellFrom = from + start;
    let cellTo = from + end;
    const leading = text.length - text.trimStart().length;
    const trailing = text.length - text.trimEnd().length;
    cellFrom += leading;
    cellTo -= trailing;
    text = raw.slice(start + leading, end - trailing);

    let align: TableCell["align"];
    const alignMatch = /^<([lcr])>\s?/.exec(text);
    if (alignMatch) {
      align = alignMatch[1] === "l" ? "left" : alignMatch[1] === "c" ? "center" : "right";
      cellFrom += alignMatch[0].length;
      text = text.slice(alignMatch[0].length);
    }
    row.cells.push({ from: cellFrom, to: cellTo, text, align });
  }
  return row;
}
