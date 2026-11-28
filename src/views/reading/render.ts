import { App, loadPrism } from "obsidian";
import type {
  DrawerData,
  OrgDoc,
  OrgIdStatus,
  OrgLine,
  OrgSectionNode,
  TableData,
} from "../../core/model/types";
import { escapeHtml, hydrateMath, renderInlineHtml } from "../../core/parser/inlineRender";
import {
  computeAlignedTextLineSet,
  matchVerticalArrowBlock,
  parseOrgDoc,
  type VerticalArrowBlock,
} from "../../core/parser/parse";
import { buildSectionTree } from "../../core/parser/sectionTree";
import { OrgNativeSettings } from "../../settings";
import { appendSanitizedHtml, createDetachedEl, replaceWithSanitizedHtml } from "../../util/dom";
import { LinkCallbacks, wireLinks } from "../../util/links";
import type { PrismLike } from "../editor/highlight";
import { applyStartupFolding, toggleReadingSection, unfoldReadingSection } from "./folding";

export interface PreviewRenderOptions {
  settings: OrgNativeSettings;
  fallbackTitle?: string;
  linkCallbacks?: LinkCallbacks;
  resolveIdStatus?: (id: string) => OrgIdStatus;
  onToggleTask?: (from: number, to: number, checked: boolean) => void;
  /** Optional hook called after DOM tree creation to expand read-only #+transclude slots. */
  hydrateTransclusions?: (root: HTMLElement, sourcePath: string) => Promise<void> | void;
}

const TRANSCLUDE_KEYWORD_RE = /^\s*#\+TRANSCLUDE(?:\[[^\]]*\])?:/i;
const FOOTNOTE_DEF_RE = /^\s*\[fn:([^\]\n]+)\]\s*(.*)$/;
const CJK_BOUNDARY_CHAR_RE =
  /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const DOC_METADATA_KEYWORD_RE =
  /^(?:TITLE|SUBTITLE|AUTHOR|EMAIL|DATE|DESCRIPTION|KEYWORDS|LANGUAGE|FILETAGS|TAGS|CATEGORY|STARTUP|OPTIONS|TODO|SEQ_TODO|TYP_TODO|SETUPFILE|INCLUDE|PROPERTY|EXPORT_[A-Z0-9_]+|ROAM_[A-Z0-9_]+)$/;

function isDocumentMetadataKeyword(keyUpper: string): boolean {
  return DOC_METADATA_KEYWORD_RE.test(keyUpper);
}

const SAFE_WIDTH_RE = /^\d+(?:\.\d+)?(?:px|%|em|rem|vw)$/;

function normalizeImageWidth(rawWidth: string): string | undefined {
  const trimmed = rawWidth.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return `${trimmed}px`;
  if (SAFE_WIDTH_RE.test(trimmed)) return trimmed;
  return undefined;
}

function unescapeOrgBlockLine(raw: string): string {
  return raw.replace(/^(\s*),(\*+|#\+)/, "$1$2");
}

function stripFixedWidthPrefix(raw: string): string {
  return raw.replace(/^\s*:(?: |$)/, "");
}

function leadingIndent(raw: string): number {
  let count = 0;
  while (count < raw.length && (raw[count] === " " || raw[count] === "\t")) {
    count += raw[count] === "\t" ? 4 : 1;
    count++;
  }
  return count;
}

function formatAlignedLineHtml(rendered: string, raw: string): { html: string; aligned: boolean } {
  const aligned = /(?:^\s{2,}|\S(?: {2,}|\t)\S)/.test(raw);
  if (!aligned) return { html: rendered, aligned: false };
  return { html: `<span class="org-aligned-line">${rendered}</span>`, aligned: true };
}

function parseDescriptionListContent(
  content: string
): { term: string; termLen: number; desc: string; descOffset: number } | null {
  const tagShort = /^(\s*)(tag)(\s*::?\s*)(\[\[.+)$/i.exec(content);
  if (tagShort) {
    const term = tagShort[2];
    const descOffset = tagShort[1].length + tagShort[2].length + tagShort[3].length;
    return { term, termLen: term.length, desc: tagShort[4], descOffset };
  }

  // Only inspect "::" outside links, verbatim, code, or math spans.
  const protectedRanges: { from: number; to: number }[] = [];
  const protectRe = /\[\[[^[\]\n]*(?:\]\[[^[\]\n]*)?\]\]|([=~])\S(?:[^\n]*?\S)?\1/g;
  let pm: RegExpExecArray | null;
  while ((pm = protectRe.exec(content))) {
    protectedRanges.push({ from: pm.index, to: pm.index + pm[0].length });
  }

  const sepRe = /\s+::(?:\s+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = sepRe.exec(content))) {
    const start = m.index;
    const end = start + m[0].length;
    if (protectedRanges.some((r) => start < r.to && end > r.from)) continue;
    const term = content.slice(0, start);
    if (!term.trim()) return null;
    return {
      term,
      termLen: term.length,
      desc: content.slice(end),
      descOffset: end,
    };
  }
  return null;
}

function parseInlineTableRowFallback(raw: string, from: number, lineIndex: number): TableData | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("|")) return null;
  const pipes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "|" && raw[i - 1] !== "\\") pipes.push(i);
  }
  if (pipes.length < 2) return null;
  const starts = pipes.slice();
  const ends = pipes.slice(1);
  if (raw.slice(pipes[pipes.length - 1] + 1).trim() !== "") ends.push(raw.length);
  const cells = ends.map((end, idx) => {
    const start = starts[idx] + 1;
    const slice = raw.slice(start, end);
    const leading = slice.length - slice.trimStart().length;
    const trailing = slice.length - slice.trimEnd().length;
    return {
      from: from + start + leading,
      to: from + end - trailing,
      text: raw.slice(start + leading, end - trailing),
    };
  });
  return {
    id: -1,
    startLine: lineIndex,
    endLine: lineIndex,
    from,
    to: from + raw.length,
    rows: [{ line: lineIndex, cells }],
    ruleAfter: [],
  };
}

function isTranscludeKeywordLine(text: string): boolean {
  return TRANSCLUDE_KEYWORD_RE.test(text);
}

function clampReadingFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.round(Math.min(1.25, Math.max(0.85, scale)) * 100) / 100;
}

function parseFileTags(raw: string): string[] {
  const tags: string[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return tags;
  const parts = trimmed.includes(":")
    ? trimmed.split(":").map((s) => s.trim())
    : trimmed.split(/\s+/);
  for (const p of parts) {
    if (p && !tags.includes(p)) tags.push(p);
  }
  return tags;
}

function endsWithCjk(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  return CJK_BOUNDARY_CHAR_RE.test(trimmed[trimmed.length - 1]);
}

function startsWithCjk(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  return CJK_BOUNDARY_CHAR_RE.test(trimmed[0]);
}

interface InlineOpts {
  app: App;
  sourcePath: string;
  math: boolean;
  resolveIdStatus?: (id: string) => OrgIdStatus;
}

function inline(text: string, base: number, opts: InlineOpts): string {
  return renderInlineHtml(text, base, {
    app: opts.app,
    sourcePath: opts.sourcePath,
    math: opts.math,
    tags: false,
    resolveIdStatus: opts.resolveIdStatus,
  });
}

function headingHtml(
  line: OrgLine,
  opts: InlineOpts,
  id: string,
  hasContent: boolean
): string {
  const h = line.heading;
  if (!h) return "";
  const level = Math.min(h.level, 6);
  const levelClass = Math.min(h.level, 9);
  const title = line.text.slice(h.titleFrom - line.from, h.titleTo - line.from);
  const isEmptyHeading = !title.trim() && !h.keyword && !h.priority && h.tags.length === 0;
  const mainParts: string[] = [];
  if (h.keyword) {
    const safeKey = h.keyword.text.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const keyCls = safeKey ? ` org-todo-${safeKey}` : "";
    mainParts.push(
      `<span class="org-todo ${
        h.keyword.done ? "org-todo-done" : "org-todo-active"
      }${keyCls}" data-todo="${escapeHtml(h.keyword.text)}">${escapeHtml(h.keyword.text)}</span>`
    );
  }
  if (h.priority) {
    mainParts.push(
      `<span class="org-priority org-priority-${h.priority.text.toLowerCase()}">[#${escapeHtml(
        h.priority.text
      )}]</span>`
    );
  }
  mainParts.push(`<span class="org-heading-title">${inline(title, h.titleFrom, opts)}</span>`);

  const tagParts = h.tags.map(
    (tag) =>
      `<a href="#${escapeHtml(tag.name)}" class="tag org-tag" data-tag="${escapeHtml(
        tag.name
      )}" target="_blank" rel="noopener nofollow">#${escapeHtml(tag.name)}</a>`
  );
  const tagsHtml =
    tagParts.length > 0 ? `<span class="org-heading-tags">${tagParts.join("")}</span>` : "";
  const ellipsisSlot = hasContent
    ? `<span class="org-fold-ellipsis-slot" data-fold-ellipsis="true"></span>`
    : "";

  const plainHeading = title.replace(/[*_/+=~[\]]/g, "").trim();
  const foldSlot = hasContent
    ? `<span class="org-fold-slot" data-foldable="true"></span>`
    : `<span class="org-fold-spacer" aria-hidden="true"></span>`;
  return `<h${level} id="${escapeHtml(id)}" data-heading="${escapeHtml(
    plainHeading
  )}" class="org-heading-preview org-level-${levelClass}${
    isEmptyHeading ? " is-empty-heading" : ""
  }" data-level="${
    h.level
  }">${foldSlot}<span class="org-heading-content"><span class="org-heading-main">${mainParts.join(
    " "
  )}</span>${tagsHtml ? ` ${tagsHtml}` : ""}${ellipsisSlot}</span></h${level}>`;
}

function taskCheckbox(line: OrgLine, opts: PreviewRenderOptions, partial: boolean): string {
  const checkbox = line.list?.checkbox;
  if (!checkbox) return "";
  const interactive = !!opts.onToggleTask;
  const state = checkbox.checked ? "x" : partial ? "-" : " ";
  return `<input type="checkbox" class="task-list-item-checkbox org-task-checkbox" data-from="${
    checkbox.from
  }" data-to="${checkbox.to}" data-task="${state}" ${checkbox.checked ? "checked" : ""} ${
    interactive ? "" : "disabled"
  }>`;
}

function renderListBlock(
  doc: OrgDoc,
  lineIndices: number[],
  startPos: number,
  opts: InlineOpts,
  previewOpts: PreviewRenderOptions,
  parentLevel = 0,
  sectionKey = "list",
  alignedLines?: Set<number>
): { html: string; nextPos: number } {
  type StackEntry = { indent: number; tag: "ul" | "ol" };
  const stack: StackEntry[] = [];
  let html = "";
  let pos = startPos;

  while (pos < lineIndices.length) {
    let scan = pos;
    let blanksBefore = 0;
    while (scan < lineIndices.length && doc.lines[lineIndices[scan]]?.kind === "blank") {
      blanksBefore++;
      scan++;
    }
    if (blanksBefore > 1) break;
    const line = doc.lines[lineIndices[scan]];
    if (!line || line.kind !== "list" || !line.list) break;
    pos = scan;
    const list = line.list;
    const tag: "ul" | "ol" = list.ordered ? "ol" : "ul";

    while (stack.length > 0 && list.indent < stack[stack.length - 1].indent) {
      const top = stack.pop()!;
      html += `</li></${top.tag}>`;
    }

    if (
      stack.length > 0 &&
      list.indent === stack[stack.length - 1].indent &&
      stack[stack.length - 1].tag !== tag
    ) {
      const top = stack.pop()!;
      html += `</li></${top.tag}>`;
    }

    if (stack.length === 0 || list.indent > stack[stack.length - 1].indent) {
      const startAttr = list.ordered && list.number > 1 ? ` start="${list.number}"` : "";
      html += `<${tag}${startAttr}>`;
      stack.push({ indent: list.indent, tag });
    } else {
      html += "</li>";
    }

    const content = line.text.slice(list.contentFrom - line.from);
    const descMatch = !list.ordered && !list.checkbox ? parseDescriptionListContent(content) : null;
    const body = descMatch
      ? `<span class="org-desc-term">${inline(
          descMatch.term,
          list.contentFrom,
          opts
        )}</span>${
          descMatch.desc
            ? `<span class="org-desc-body">${inline(
                descMatch.desc,
                list.contentFrom + descMatch.descOffset,
                opts
              )}</span>`
            : ""
        }`
      : inline(content, list.contentFrom, opts);

    const rawBox = list.checkbox
      ? line.text.slice(list.checkbox.from - line.from, list.checkbox.to - line.from)
      : "";
    const partial = rawBox === "[-]";
    const taskState = list.checkbox ? (list.checkbox.checked ? "x" : partial ? "-" : " ") : "";
    const liClassParts: string[] = [];
    if (list.checkbox) {
      liClassParts.push("task-list-item");
      if (list.checkbox.checked) liClassParts.push("is-checked");
      else if (partial) liClassParts.push("is-partial");
    }
    if (descMatch) {
      liClassParts.push("org-desc-item");
    }
    if (alignedLines?.has(line.index)) {
      liClassParts.push("org-aligned-list-item");
    }
    const liAttrs =
      (liClassParts.length > 0 ? ` class="${liClassParts.join(" ")}"` : "") +
      (list.checkbox ? ` data-task="${taskState}"` : "");
    const itemContent = list.checkbox
      ? `${taskCheckbox(line, previewOpts, partial)}<span class="org-task-text">${body}</span>`
      : body;
    html += `<li${liAttrs}>${itemContent}`;
    pos++;

    // Consume indented continuation content (prose, code/example blocks, images, tables) under this <li>.
    const contLines: number[] = [];
    while (pos < lineIndices.length) {
      let look = pos;
      let contBlanks = 0;
      while (look < lineIndices.length && doc.lines[lineIndices[look]]?.kind === "blank") {
        contBlanks++;
        look++;
      }
      if (contBlanks > 1 || look >= lineIndices.length) break;
      const nextLine = doc.lines[lineIndices[look]];
      if (
        !nextLine ||
        nextLine.kind === "list" ||
        nextLine.kind === "heading" ||
        nextLine.kind === "drawer-start" ||
        nextLine.kind === "rule"
      ) {
        break;
      }
      if (leadingIndent(nextLine.text) <= list.indent) break;

      while (pos < look) {
        contLines.push(lineIndices[pos]);
        pos++;
      }
      if (nextLine.kind === "block-start" && nextLine.block) {
        const endLine =
          nextLine.block.endLine ?? nextLine.block.contentEndLine ?? nextLine.index;
        while (pos < lineIndices.length && lineIndices[pos] <= endLine) {
          contLines.push(lineIndices[pos]);
          pos++;
        }
      } else if (nextLine.kind === "table" || nextLine.kind === "table-rule") {
        const endLine = nextLine.table?.endLine ?? nextLine.index;
        while (pos < lineIndices.length && lineIndices[pos] <= endLine) {
          contLines.push(lineIndices[pos]);
          pos++;
        }
      } else if (nextLine.kind === "math-block" && nextLine.mathBlock) {
        const endLine = nextLine.mathBlock.endLine;
        while (pos < lineIndices.length && lineIndices[pos] <= endLine) {
          contLines.push(lineIndices[pos]);
          pos++;
        }
      } else {
        contLines.push(lineIndices[pos]);
        pos++;
      }
    }

    if (contLines.length > 0) {
      const contHtml = renderLineSequence(
        doc,
        contLines,
        opts,
        previewOpts,
        false,
        parentLevel,
        `${sectionKey}:li:${line.index}`
      ).trim();
      if (contHtml) {
        html += `<div class="org-list-continuation">${contHtml}</div>`;
      }
    }
  }

  while (stack.length > 0) {
    const top = stack.pop()!;
    html += `</li></${top.tag}>`;
  }
  return { html, nextPos: pos };
}

function renderTable(table: TableData, opts: InlineOpts): string {
  const headerRows = table.ruleAfter.length > 0 ? table.ruleAfter[0] + 1 : 0;
  let head = "";
  let body = "";
  table.rows.forEach((row, index) => {
    const target = index < headerRows ? "th" : "td";
    const cells = row.cells
      .map((cell) => {
        const style = cell.align ? ` style="text-align:${cell.align}"` : "";
        return `<${target}${style}>${inline(cell.text, cell.from, opts)}</${target}>`;
      })
      .join("");
    const tr = `<tr>${cells}</tr>`;
    if (index < headerRows) head += tr;
    else body += tr;
  });
  return `<div class="el-table org-table-container"><table class="org-table">${
    head ? `<thead>${head}</thead>` : ""
  }${body ? `<tbody>${body}</tbody>` : ""}</table></div>`;
}

function propertiesCard(
  entries: { key: string; value: string }[],
  rawText: string,
  title: string,
  expanded: boolean,
  drawerKey?: string
): string {
  if (entries.length === 0 && !rawText.trim()) return "";
  const rows =
    entries.length > 0
      ? entries
          .map(
            (entry) =>
              `<div class="org-property"><span class="org-property-key">${escapeHtml(
                entry.key
              )}</span><span class="org-property-value">${escapeHtml(entry.value)}</span></div>`
          )
          .join("")
      : `<pre class="org-logbook">${escapeHtml(rawText)}</pre>`;
  const rawSection = rawText
    ? `<details class="org-drawer-raw-toggle"><summary>Raw</summary><pre class="org-drawer-raw">${escapeHtml(
        rawText
      )}</pre></details>`
    : "";
  const countHtml =
    entries.length > 0 ? `<span class="org-properties-count">${entries.length}</span>` : "";
  const keyAttr = drawerKey ? ` data-drawer-key="${escapeHtml(drawerKey)}"` : "";
  return `<details class="org-properties org-properties-preview org-drawer-details"${keyAttr}${
    expanded ? " open" : ""
  }><summary class="org-properties-title"><span class="org-properties-chevron" aria-hidden="true"></span><span class="org-properties-name">${escapeHtml(
    title
  )}</span>${countHtml}</summary><div class="org-properties-body">${rows}${rawSection}</div></details>`;
}

function renderDrawer(
  doc: OrgDoc,
  drawer: DrawerData | undefined,
  settings: OrgNativeSettings,
  drawerKey: string
): string {
  if (!drawer || settings.propertiesDisplay === "hidden") return "";
  const endLine = drawer.endLine ?? drawer.startLine;
  const rawBlock = doc.lines
    .slice(drawer.startLine, endLine + 1)
    .map((l) => l.text)
    .join("\n");
  return propertiesCard(
    drawer.entries.map((e) => ({ key: e.key, value: e.value })),
    rawBlock,
    drawer.name.toLowerCase(),
    settings.propertiesDisplay === "expanded",
    drawerKey
  );
}

function renderPlanningLine(line: OrgLine, opts: InlineOpts): string {
  const re = /\b(SCHEDULED|DEADLINE|CLOSED):(?=\s|$)/g;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    if (m.index > cursor) {
      out += inline(line.text.slice(cursor, m.index), line.from + cursor, opts);
    }
    const kw = m[1];
    out += `<span class="org-planning-keyword org-planning-${kw.toLowerCase()}">${escapeHtml(
      kw
    )}:</span>`;
    cursor = m.index + m[0].length;
  }
  if (cursor < line.text.length) {
    out += inline(line.text.slice(cursor), line.from + cursor, opts);
  }
  return `<div class="org-planning-line">${out}</div>`;
}

function renderBlock(doc: OrgDoc, line: OrgLine, opts: InlineOpts): { html: string; endLine: number } {
  const block = line.block;
  if (!block) return { html: "", endLine: line.index };
  const returnEndLine = block.endLine ?? block.contentEndLine ?? doc.lines.length - 1;
  const sliceEndExclusive =
    block.endLine !== undefined
      ? block.endLine
      : (block.contentEndLine ?? doc.lines.length - 1) + 1;
  const contentLines = doc.lines.slice(block.beginLine + 1, sliceEndExclusive);
  const rawLinesText = contentLines.map((l) => l.text);
  const raw = rawLinesText.join("\n");
  const unescapedRaw =
    block.type === "src" || block.type === "example"
      ? rawLinesText.map(unescapeOrgBlockLine).join("\n")
      : raw;

  switch (block.type) {
    case "src": {
      const lang = block.lang?.trim() || "";
      const language = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      const headerLabel = lang || "plain";
      return {
        html: `<div class="org-code-block" data-lang="${escapeHtml(
          headerLabel
        )}"><div class="org-code-header"><span class="org-code-lang">${escapeHtml(
          headerLabel
        )}</span><span class="org-code-copy-slot"></span></div><pre${language}${langAttr}><code${language}>${escapeHtml(
          unescapedRaw
        )}</code></pre></div>`,
        endLine: returnEndLine,
      };
    }
    case "quote": {
      const paragraphs = raw
        .split(/\n\s*\n/)
        .map((paragraph) => {
          const lines = paragraph.split("\n");
          return lines
            .map((l, idx) => inline(l, 0, opts) + (idx < lines.length - 1 ? "<br>" : ""))
            .join("");
        })
        .filter(Boolean)
        .map((p) => `<p>${p}</p>`)
        .join("");
      return { html: `<blockquote>${paragraphs}</blockquote>`, endLine: returnEndLine };
    }
    case "example":
      return { html: `<pre class="org-example">${escapeHtml(unescapedRaw)}</pre>`, endLine: returnEndLine };
    case "center": {
      const content = raw
        .split(/\n\s*\n/)
        .map((p) => `<p>${inline(p, 0, opts)}</p>`)
        .join("");
      return { html: `<div class="org-center">${content}</div>`, endLine: returnEndLine };
    }
    case "verse":
      return { html: `<pre class="org-verse">${escapeHtml(raw)}</pre>`, endLine: returnEndLine };
    case "comment":
      return { html: "", endLine: returnEndLine };
    case "export":
      return { html: `<pre class="org-export">${escapeHtml(raw)}</pre>`, endLine: returnEndLine };
    default:
      return {
        html: `<div class="org-special-block-wrap"><div class="org-special-block-label">${escapeHtml(
          block.rawName
        )}</div><pre class="org-special-block">${escapeHtml(raw)}</pre></div>`,
        endLine: returnEndLine,
      };
  }
}

function advancePastLineIndex(lineIndices: number[], pos: number, targetEndLine: number): number {
  let nextPos = pos;
  while (nextPos < lineIndices.length && lineIndices[nextPos] <= targetEndLine) {
    nextPos++;
  }
  return nextPos;
}

function tryConsumeImageFigure(
  doc: OrgDoc,
  lineIndices: number[],
  startPos: number,
  inlineOpts: InlineOpts
): { html: string; nextPos: number } | null {
  let pos = startPos;
  let caption: string | undefined;
  let width: string | undefined;
  let seenDirective = false;

  while (pos < lineIndices.length) {
    const line = doc.lines[lineIndices[pos]];
    if (!line || line.kind !== "keyword") break;
    const m = /^\s*#\+([A-Za-z0-9_-]+)(?:\[[^\]]*\])?:\s*(.*)$/.exec(line.text);
    if (!m) break;
    const key = m[1].toUpperCase();
    if (key === "CAPTION") {
      caption = m[2].trim();
      seenDirective = true;
      pos++;
    } else if (key === "ATTR_HTML" || key === "ATTR_ORG") {
      const wMatch = /:width\s+([^\s]+)/i.exec(m[2]);
      if (wMatch) {
        const normalized = normalizeImageWidth(wMatch[1]);
        if (normalized) width = normalized;
      }
      seenDirective = true;
      pos++;
    } else if (key === "NAME" || key === "SRCNAME") {
      seenDirective = true;
      pos++;
    } else {
      break;
    }
  }

  if (!seenDirective || pos >= lineIndices.length) return null;
  const nextLine = doc.lines[lineIndices[pos]];
  if (!nextLine || nextLine.kind !== "text" || nextLine.text.trim() === "") return null;

  const afterLine = pos + 1 < lineIndices.length ? doc.lines[lineIndices[pos + 1]] : undefined;
  if (afterLine && afterLine.kind === "text" && afterLine.text.trim() !== "") return null;

  const rendered = inline(nextLine.text, nextLine.from, inlineOpts).trim();
  if (!/^<img\b[^>]*>$/i.test(rendered)) return null;

  const imgHtml = width
    ? rendered.replace(/^<img\b/, `<img style="width:${escapeHtml(width)}"`)
    : rendered;
  const captionHtml = caption
    ? `<figcaption class="org-figcaption">${inline(caption, 0, inlineOpts)}</figcaption>`
    : "";
  return {
    html: `<figure class="org-figure">${imgHtml}${captionHtml}</figure>`,
    nextPos: pos + 1,
  };
}

function renderVerticalFlowArrow(block: VerticalArrowBlock, opts: InlineOpts): string {
  const bodyHtml =
    block.labels.length > 0
      ? `<div class="org-flow-arrow-body">${block.labels
          .map(
            (label) =>
              `<div class="org-flow-arrow-label">${inline(label.text, label.from, opts)}</div>`
          )
          .join("")}</div>`
      : "";
  return `<div class="org-flow-arrow" role="figure" aria-label="Flow arrow"><span class="org-flow-arrow-rail" aria-hidden="true"><span class="org-flow-arrow-stem"></span><span class="org-flow-arrow-head"></span></span>${bodyHtml}</div>`;
}

function renderProseParagraph(
  paragraph: OrgLine[],
  inlineOpts: InlineOpts,
  previewOpts: PreviewRenderOptions,
  cjkMode: boolean
): string {
  if (paragraph.length === 1) {
    const single = paragraph[0];
    const renderedSingle = inline(single.text, single.from, inlineOpts).trim();
    if (/^<img\b[^>]*>$/i.test(renderedSingle)) {
      return `<figure class="org-figure">${renderedSingle}</figure>`;
    }
    const formatted = formatAlignedLineHtml(renderedSingle, single.text);
    return `<p>${formatted.html}</p>`;
  }
  const preserveBreaks = previewOpts.settings.strictLineBreaks === false;
  const content = paragraph
    .map((l, idx) => {
      const rendered = inline(l.text, l.from, inlineOpts);
      const formatted = formatAlignedLineHtml(rendered, l.text);
      if (idx >= paragraph.length - 1) return formatted.html;
      if (/<br class="org-linebreak">$/.test(rendered)) {
        return formatted.html;
      }
      const nextLine = paragraph[idx + 1];
      const nextAligned = /(?:^\s{2,}|\S(?: {2,}|\t)\S)/.test(nextLine.text);
      if (preserveBreaks || formatted.aligned || nextAligned) {
        return formatted.html + "<br>";
      }
      const joiner =
        cjkMode && endsWithCjk(l.text) && startsWithCjk(nextLine.text) ? "" : " ";
      return formatted.html + joiner;
    })
    .join("");
  return `<p>${content}</p>`;
}

function renderLineSequence(
  doc: OrgDoc,
  lineIndices: number[],
  inlineOpts: InlineOpts,
  previewOpts: PreviewRenderOptions,
  skipInitialKeywords = false,
  parentLevel = 0,
  sectionKey = "preamble"
): string {
  let html = "";
  let pos = 0;
  let drawerCount = 0;
  const cjkMode = previewOpts.settings.cjkTypography !== false;
  const alignedLines = computeAlignedTextLineSet(
    lineIndices.map((idx) => doc.lines[idx]).filter((l): l is OrgLine => !!l)
  );

  if (skipInitialKeywords) {
    let cursor = 0;
    const entries: { key: string; value: string }[] = [];
    const rawKeywordLines: string[] = [];
    const fileTags: string[] = [];
    const preambleDrawersHtml: string[] = [];

    while (cursor < lineIndices.length) {
      const l = doc.lines[lineIndices[cursor]];
      if (!l) {
        cursor++;
        continue;
      }
      if (l.kind === "blank" || l.kind === "comment") {
        cursor++;
        continue;
      }
      if (l.kind === "keyword" && !isTranscludeKeywordLine(l.text)) {
        const match = /^\s*#\+([A-Za-z0-9_-]+)(?:\[[^\]]*\])?:\s*(.*)$/.exec(l.text);
        const upper = match?.[1].toUpperCase() ?? "";
        if (!upper || !isDocumentMetadataKeyword(upper)) {
          break;
        }
        rawKeywordLines.push(l.text);
        if (upper === "FILETAGS") {
          for (const tag of parseFileTags(match![2])) {
            if (!fileTags.includes(tag)) fileTags.push(tag);
          }
        } else if (upper !== "TITLE") {
          entries.push({ key: upper, value: match![2] });
        }
        cursor++;
        continue;
      }
      if (l.kind === "drawer-start" && l.drawer?.name.toUpperCase() === "PROPERTIES") {
        const key = `${sectionKey}:properties:${drawerCount++}`;
        preambleDrawersHtml.push(renderDrawer(doc, l.drawer, previewOpts.settings, key));
        const endLine = l.drawer.endLine ?? l.index;
        cursor = advancePastLineIndex(lineIndices, cursor, endLine);
        continue;
      }
      break;
    }

    if (fileTags.length > 0) {
      const chips = fileTags
        .map(
          (name) =>
            `<a href="#${escapeHtml(name)}" class="tag org-tag org-filetag" data-tag="${escapeHtml(
              name
            )}" target="_blank" rel="noopener nofollow">#${escapeHtml(name)}</a>`
        )
        .join("");
      html += `<div class="org-filetags">${chips}</div>`;
    }
    html += preambleDrawersHtml.join("");
    if (previewOpts.settings.propertiesDisplay !== "hidden" && entries.length > 0) {
      html += propertiesCard(
        entries,
        rawKeywordLines.join("\n"),
        "metadata",
        previewOpts.settings.propertiesDisplay === "expanded",
        "metadata"
      );
    }
    pos = cursor;
  }

  while (pos < lineIndices.length) {
    const line = doc.lines[lineIndices[pos]];
    if (!line) {
      pos++;
      continue;
    }

    switch (line.kind) {
      case "blank":
      case "comment":
      case "block-end":
      case "drawer-end":
        pos++;
        break;
      case "list": {
        const res = renderListBlock(
          doc,
          lineIndices,
          pos,
          inlineOpts,
          previewOpts,
          parentLevel,
          sectionKey,
          alignedLines
        );
        html += res.html;
        pos = res.nextPos;
        break;
      }
      case "table":
      case "table-rule": {
        const table = line.table;
        if (table && table.startLine === line.index) {
          html += renderTable(table, inlineOpts);
          pos = advancePastLineIndex(lineIndices, pos, table.endLine);
        } else {
          pos++;
        }
        break;
      }
      case "block-start": {
        const res = renderBlock(doc, line, inlineOpts);
        html += res.html;
        pos = advancePastLineIndex(lineIndices, pos, res.endLine);
        break;
      }
      case "drawer-start":
      case "drawer": {
        const dName = line.drawer?.name.toLowerCase() ?? "drawer";
        const key = `${sectionKey}:${dName}:${drawerCount++}`;
        html += renderDrawer(doc, line.drawer, previewOpts.settings, key);
        const endLine = line.drawer?.endLine ?? line.index;
        pos = advancePastLineIndex(lineIndices, pos, endLine);
        break;
      }
      case "math-block": {
        const block = line.mathBlock;
        if (block && block.startLine === line.index) {
          if (previewOpts.settings.renderMath) {
            html += `<div class="org-math-block"><span class="math org-math org-math-display" data-latex="${escapeHtml(
              block.latex
            )}" data-display="true"></span></div>`;
          } else {
            html += `<pre class="org-math-source-block">${escapeHtml(block.latex)}</pre>`;
          }
          pos = advancePastLineIndex(lineIndices, pos, block.endLine);
        } else {
          pos++;
        }
        break;
      }
      case "planning":
        html += renderPlanningLine(line, inlineOpts);
        pos++;
        break;
      case "keyword": {
        const fig = tryConsumeImageFigure(doc, lineIndices, pos, inlineOpts);
        if (fig) {
          html += fig.html;
          pos = fig.nextPos;
          break;
        }
        const m = /^\s*#\+([A-Za-z0-9_-]+)(?:\[[^\]]*\])?:\s*(.*)$/.exec(line.text);
        if (m) {
          const key = m[1].toUpperCase();
          if (key === "TRANSCLUDE") {
            const val = m[2].trim();
            if (previewOpts.settings.enableTransclusion && val) {
              html += `<div class="org-transclude-slot" data-transclude-raw="${escapeHtml(
                line.text
              )}" data-line="${line.index}" data-parent-level="${parentLevel}"><div class="org-keyword-line org-transclude-fallback"><span class="org-keyword-key">TRANSCLUDE</span> <span class="org-keyword-value">${escapeHtml(
                m[2]
              )}</span></div></div>`;
            } else {
              html += `<div class="org-keyword-line org-keyword-transclude${
                val ? "" : " org-keyword-empty"
              }"><span class="org-keyword-key">TRANSCLUDE</span>${
                val ? ` <span class="org-keyword-value">${escapeHtml(m[2])}</span>` : ""
              }</div>`;
            }
            pos++;
            break;
          }
          if (
            key === "TITLE" ||
            /^(OPTIONS|STARTUP|TODO|SEQ_TODO|TYP_TODO|FILETAGS|SETUPFILE|INCLUDE|CAPTION)$/.test(
              key
            )
          ) {
            pos++;
            break;
          }
          if (key === "SRCNAME" || key === "NAME") {
            pos++;
            break;
          }
          if (key === "RESULTS" || key === "RESULT") {
            const val = m[2].trim();
            if (val) {
              html += `<div class="org-results-block"><span class="org-results-label">Result</span><code class="org-results-inline">${escapeHtml(
                val
              )}</code></div>`;
            }
            pos++;
            break;
          }
          html += `<div class="org-keyword-line"><span class="org-keyword-key">${escapeHtml(
            key
          )}</span> <span class="org-keyword-value">${escapeHtml(m[2])}</span></div>`;
        }
        pos++;
        break;
      }
      case "fixed-width": {
        const parts: string[] = [];
        while (
          pos < lineIndices.length &&
          doc.lines[lineIndices[pos]]?.kind === "fixed-width"
        ) {
          parts.push(stripFixedWidthPrefix(doc.lines[lineIndices[pos]].text));
          pos++;
        }
        html += `<pre class="org-fixed-width">${escapeHtml(parts.join("\n"))}</pre>`;
        break;
      }
      case "rule":
        html += "<hr>";
        pos++;
        break;
      case "text": {
        const flowMatch = matchVerticalArrowBlock(doc, lineIndices, pos);
        if (flowMatch) {
          html += renderVerticalFlowArrow(flowMatch.block, inlineOpts);
          pos = flowMatch.nextPos;
          break;
        }

        const firstTextLine = doc.lines[lineIndices[pos]];
        if (firstTextLine) {
          const fnMatch = FOOTNOTE_DEF_RE.exec(firstTextLine.text);
          if (fnMatch) {
            const name = fnMatch[1];
            const rawBody = fnMatch[2];
            const bodyOffset = rawBody ? firstTextLine.text.indexOf(rawBody) : 0;
            const nextLine =
              pos + 1 < lineIndices.length ? doc.lines[lineIndices[pos + 1]] : undefined;
            if (
              rawBody.trimStart().startsWith("|") &&
              nextLine &&
              (nextLine.kind === "table" || nextLine.kind === "table-rule")
            ) {
              const firstRowTable = parseInlineTableRowFallback(
                rawBody,
                firstTextLine.from + Math.max(0, bodyOffset),
                firstTextLine.index
              );
              const targetTable = nextLine.table;
              if (firstRowTable && targetTable) {
                const combined: TableData = {
                  ...targetTable,
                  rows: [...firstRowTable.rows, ...targetTable.rows],
                  ruleAfter:
                    nextLine.kind === "table-rule"
                      ? [0, ...targetTable.ruleAfter.map((r) => r + 1)]
                      : targetTable.ruleAfter.map((r) => r + 1),
                };
                html += `<div class="org-footnote-def" id="fn-def-${escapeHtml(
                  name
                )}" data-footnote="${escapeHtml(name)}"><span class="org-footnote-def-label">[${escapeHtml(
                  name
                )}]</span><span class="org-footnote-def-body">${renderTable(
                  combined,
                  inlineOpts
                )}</span></div>`;
                pos = advancePastLineIndex(lineIndices, pos + 1, targetTable.endLine);
                break;
              }
            }
            html += `<div class="org-footnote-def" id="fn-def-${escapeHtml(
              name
            )}" data-footnote="${escapeHtml(name)}"><span class="org-footnote-def-label">[${escapeHtml(
              name
            )}]</span><span class="org-footnote-def-body">${inline(
              rawBody,
              firstTextLine.from + Math.max(0, bodyOffset),
              inlineOpts
            )}</span></div>`;
            pos++;
            break;
          }
        }

        const paragraphs: OrgLine[][] = [];
        let current: OrgLine[] = [];
        while (pos < lineIndices.length && doc.lines[lineIndices[pos]]?.kind === "text") {
          const textLine = doc.lines[lineIndices[pos]];
          if (textLine.text.trim() !== "" && FOOTNOTE_DEF_RE.test(textLine.text)) {
            break;
          }
          if (matchVerticalArrowBlock(doc, lineIndices, pos)) {
            break;
          }
          if (textLine.text.trim() === "") {
            if (current.length > 0) paragraphs.push(current);
            current = [];
          } else {
            current.push(textLine);
          }
          pos++;
        }
        if (current.length > 0) paragraphs.push(current);
        for (const paragraph of paragraphs) {
          const paraAligned = computeAlignedTextLineSet(paragraph);
          if (paraAligned.size === 0) {
            html += renderProseParagraph(paragraph, inlineOpts, previewOpts, cjkMode);
            continue;
          }
          const runs: { aligned: boolean; lines: OrgLine[] }[] = [];
          for (const l of paragraph) {
            const isAligned = paraAligned.has(l.index);
            const prevRun = runs[runs.length - 1];
            if (prevRun && prevRun.aligned === isAligned) {
              prevRun.lines.push(l);
            } else {
              runs.push({ aligned: isAligned, lines: [l] });
            }
          }
          for (const run of runs) {
            if (run.aligned) {
              const rowsHtml = run.lines
                .map((l) => `<div class="org-aligned-row">${inline(l.text, l.from, inlineOpts)}</div>`)
                .join("");
              html += `<div class="org-aligned-block">${rowsHtml}</div>`;
            } else {
              html += renderProseParagraph(run.lines, inlineOpts, previewOpts, cjkMode);
            }
          }
        }
        break;
      }
      default:
        pos++;
        break;
    }
  }

  return html;
}

function renderSectionHtml(
  doc: OrgDoc,
  node: OrgSectionNode,
  inlineOpts: InlineOpts,
  previewOpts: PreviewRenderOptions
): string {
  const line = doc.lines[node.headingLineIndex];
  const sectionStable = node.id
    ? `id:${node.id}`
    : node.customId
    ? `custom:${node.customId}`
    : `slug:${node.slug}`;
  const bodyHtml = renderLineSequence(
    doc,
    node.bodyLines,
    inlineOpts,
    previewOpts,
    false,
    node.level,
    sectionStable
  );
  const childrenHtml = node.children
    .map((child) => renderSectionHtml(doc, child, inlineOpts, previewOpts))
    .join("");
  const hasContent = bodyHtml.trim().length > 0 || node.children.length > 0;
  const heading = headingHtml(
    line,
    inlineOpts,
    `org-${node.slug}`,
    hasContent
  );

  const idAttr = node.id ? ` data-org-id="${escapeHtml(node.id)}"` : "";
  const customIdAttr = node.customId ? ` data-custom-id="${escapeHtml(node.customId)}"` : "";
  const bodyWrap = bodyHtml ? `<div class="org-section-body">${bodyHtml}</div>` : "";
  const childrenWrap = childrenHtml
    ? `<div class="org-section-children">${childrenHtml}</div>`
    : "";

  return `<section class="org-section org-level-${Math.min(
    node.level,
    9
  )}" data-line="${node.headingLineIndex}" data-end-line="${
    node.endLineIndex
  }" data-slug="${escapeHtml(node.slug)}" data-title="${escapeHtml(
    node.titleText.toLowerCase()
  )}"${idAttr}${customIdAttr}>${heading}${bodyWrap}${childrenWrap}</section>`;
}

const PRISM_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  "shell-script": "bash",
  yml: "yaml",
  html: "markup",
  xml: "markup",
  svg: "markup",
  md: "markdown",
  tex: "latex",
  elisp: "lisp",
  "emacs-lisp": "lisp",
  rs: "rust",
  rb: "ruby",
  kt: "kotlin",
  dockerfile: "docker",
  "c++": "cpp",
  "c#": "csharp",
  objc: "objectivec",
  h: "c",
  hpp: "cpp",
};

async function hydrateCodeBlocks(root: HTMLElement): Promise<void> {
  try {
    const Prism = (await loadPrism()) as PrismLike;
    root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
      if (code.classList.contains("is-loaded")) return;
      const languageClass = Array.from(code.classList).find((name) =>
        name.startsWith("language-")
      );
      const language = languageClass?.slice("language-".length);
      if (!language) return;
      const normLang = language.trim().toLowerCase();
      const grammar =
        Prism.languages[normLang] ?? Prism.languages[PRISM_ALIASES[normLang] ?? ""];
      if (!grammar) return;
      const source = code.textContent ?? "";
      replaceWithSanitizedHtml(code, Prism.highlight(source, grammar, normLang));
      code.classList.add("is-loaded");
    });
  } catch (error) {
    console.warn("Org Native: Prism highlighting failed", error);
  }
}

export function renderOrgPreview(
  source: string,
  app: App,
  sourcePath: string,
  options: PreviewRenderOptions
): HTMLElement {
  const doc = parseOrgDoc(source);
  const tree = buildSectionTree(doc);
  const inlineOpts: InlineOpts = {
    app,
    sourcePath,
    math: options.settings.renderMath,
    resolveIdStatus: options.resolveIdStatus,
  };

  let html = "";
  const title = doc.title ?? options.fallbackTitle;
  if (title) {
    html += `<div class="inline-title">${escapeHtml(title)}</div>`;
  }

  html += renderLineSequence(doc, tree.preambleLines, inlineOpts, options, true, 0);
  for (const section of tree.sections) {
    html += renderSectionHtml(doc, section, inlineOpts, options);
  }

  const root = createDetachedEl("div");
  root.className =
    "markdown-preview-view markdown-rendered node-insert-event is-readable-line-width " +
    "allow-fold-headings allow-fold-lists show-properties org-preview";
  root.dataset.readingWidth = options.settings.readingWidth ?? "normal";
  root.dataset.readingLineHeight = options.settings.readingLineHeight ?? "comfortable";
  root.dataset.cjkTypography = (options.settings.cjkTypography ?? true) ? "true" : "false";
  root.style.setProperty(
    "--org-reading-font-scale",
    String(clampReadingFontScale(options.settings.readingFontScale))
  );

  const sizer = createDetachedEl("div");
  sizer.className = "markdown-preview-sizer";
  appendSanitizedHtml(sizer, html);
  root.appendChild(sizer);

  root.querySelectorAll<HTMLElement>(".org-fold-slot[data-foldable=\"true\"]").forEach((slot) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "org-fold-btn clickable-icon";
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "Toggle section");
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const sectionEl = btn.closest<HTMLElement>(".org-section");
      if (sectionEl) toggleReadingSection(sectionEl);
    });
    slot.replaceWith(btn);
  });

  root
    .querySelectorAll<HTMLElement>(".org-fold-ellipsis-slot[data-fold-ellipsis=\"true\"]")
    .forEach((slot) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "org-fold-ellipsis";
      btn.setAttribute("aria-label", "Expand folded section");
      btn.setAttribute("aria-hidden", "true");
      btn.tabIndex = -1;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const sectionEl = btn.closest<HTMLElement>(".org-section");
        if (sectionEl) unfoldReadingSection(sectionEl);
      });
      slot.replaceWith(btn);
    });

  root.querySelectorAll<HTMLElement>(".org-code-copy-slot").forEach((slot) => {
    const blockEl = slot.closest<HTMLElement>(".org-code-block");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "org-code-copy-btn clickable-icon";
    btn.setAttribute("aria-label", "Copy code");
    btn.textContent = "Copy";
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const code = blockEl?.querySelector("pre > code")?.textContent ?? "";
      const copyPromise = navigator.clipboard?.writeText?.(code);
      if (copyPromise && typeof copyPromise.catch === "function") {
        void copyPromise.catch(() => {});
      }
      btn.textContent = "Copied";
      btn.classList.add("is-copied");
      window.setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("is-copied");
      }, 1500);
    });
    slot.replaceWith(btn);
  });

  if (options.settings.honorStartup && doc.startup.length > 0) {
    applyStartupFolding(root, doc.startup);
  }

  wireLinks(root, app, sourcePath, options.linkCallbacks);
  root.querySelectorAll<HTMLElement>("sup.org-footnote[data-footnote]").forEach((sup) => {
    sup.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const name = sup.dataset.footnote;
      if (!name) return;
      const target = Array.from(root.querySelectorAll<HTMLElement>(".org-footnote-def[data-footnote]")).find(
        (el) => el.dataset.footnote === name
      );
      if (!target) return;
      const foldedSection = target.closest<HTMLElement>(".org-section.is-folded, .org-section.is-body-folded");
      if (foldedSection) unfoldReadingSection(foldedSection);
      target.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
  });
  if (options.settings.renderMath) hydrateMath(root);
  void hydrateCodeBlocks(root);

  if (options.onToggleTask) {
    root.querySelectorAll<HTMLInputElement>("input.org-task-checkbox[data-from]").forEach((input) => {
      input.addEventListener("change", () => {
        const from = Number(input.dataset.from);
        const to = Number(input.dataset.to);
        const li = input.closest<HTMLElement>("li.task-list-item");
        if (li) {
          li.classList.remove("is-partial");
          li.classList.toggle("is-checked", input.checked);
          li.dataset.task = input.checked ? "x" : " ";
        }
        input.dataset.task = input.checked ? "x" : " ";
        if (Number.isFinite(from) && Number.isFinite(to)) {
          options.onToggleTask?.(from, to, input.checked);
        }
      });
    });
  }

  if (options.settings.enableTransclusion && options.hydrateTransclusions) {
    try {
      const res = options.hydrateTransclusions(root, sourcePath);
      if (res && typeof (res as Promise<void>).catch === "function") {
        void (res as Promise<void>).catch((error) =>
          console.warn("Org Native: transclusion hydration failed", error)
        );
      }
    } catch (error) {
      console.warn("Org Native: transclusion hydration failed", error);
    }
  }

  return root;
}
