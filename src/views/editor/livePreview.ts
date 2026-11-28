import {
  EditorState,
  Extension,
  Range,
  SelectionRange,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { App, finishRenderMath, loadMathJax, renderMath } from "obsidian";
import { foldEffect, unfoldEffect } from "@codemirror/language";
import type {
  InlineToken,
  OrgDoc,
  OrgIdStatus,
  PropertiesDisplayMode,
  TableData,
} from "../../core/model/types";
import { parseInline } from "../../core/parser/inline";
import { hydrateMath, renderInlineHtml } from "../../core/parser/inlineRender";
import {
  computeAlignedTextLineSet,
  findVerticalArrowBlocks,
  type VerticalArrowBlock,
} from "../../core/parser/parse";
import { OrgNativeSettings } from "../../settings";
import { appendSanitizedHtml, createDetachedEl } from "../../util/dom";
import {
  isUnsafeUriScheme,
  LinkCallbacks,
  openOrgLink,
  openTagSearch,
  parseOrgIdTarget,
  resolveResourcePath,
  wireLinks,
} from "../../util/links";
import { OrgFoldInfo, orgDocForText, orgFoldForLine } from "./fold";
import { getPrismVersion, highlightCode } from "./highlight";

export interface LivePreviewOptions {
  app: App;
  sourcePath: string;
  settings: OrgNativeSettings;
  displayTitle: string;
  linkCallbacks?: LinkCallbacks;
  resolveIdStatus?: (id: string) => OrgIdStatus;
}

export const refreshOrgPreview = StateEffect.define<null>();

const TRANSCLUDE_KEYWORD_RE = /^\s*#\+TRANSCLUDE(?:\[[^\]]*\])?:/i;
const DOC_METADATA_KEYWORD_RE =
  /^(?:TITLE|SUBTITLE|AUTHOR|EMAIL|DATE|DESCRIPTION|KEYWORDS|LANGUAGE|FILETAGS|TAGS|CATEGORY|STARTUP|OPTIONS|TODO|SEQ_TODO|TYP_TODO|SETUPFILE|INCLUDE|PROPERTY|EXPORT_[A-Z0-9_]+|ROAM_[A-Z0-9_]+)$/;
const SAFE_UNIT_SCALE_MIN = 0.85;
const SAFE_UNIT_SCALE_MAX = 1.25;

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.round(Math.min(SAFE_UNIT_SCALE_MAX, Math.max(SAFE_UNIT_SCALE_MIN, scale)) * 100) / 100;
}

function isTranscludeKeywordLine(text: string): boolean {
  return TRANSCLUDE_KEYWORD_RE.test(text);
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

function parseListDescriptionOffsets(
  content: string
): { termEnd: number; sepStart: number; sepEnd: number } | null {
  const tagShort = /^(\s*)(tag)(\s*::?\s*)(\[\[.+)$/i.exec(content);
  if (tagShort) {
    const termEnd = tagShort[1].length + tagShort[2].length;
    const sepStart = termEnd;
    const sepEnd = termEnd + tagShort[3].length;
    return { termEnd, sepStart, sepEnd };
  }

  const protectedRanges: { from: number; to: number }[] = [];
  const protectRe = /\[\[[^[\]\n]*(?:\]\[[^[\]\n]*)?\]\]|([=~])\S(?:[^\n]*?\S)?\1/g;
  let pm: RegExpExecArray | null;
  while ((pm = protectRe.exec(content))) {
    protectedRanges.push({ from: pm.index, to: pm.index + pm[0].length });
  }

  const sepRe = /(\s*)(::)(\s+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = sepRe.exec(content))) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[1].length === 0) continue;
    if (protectedRanges.some((r) => start < r.to && end > r.from)) continue;
    if (!content.slice(0, start).trim()) return null;
    return {
      termEnd: start,
      sepStart: start + m[1].length,
      sepEnd: start + m[1].length + 2,
    };
  }
  return null;
}

let mathJaxPromise: Promise<void> | null = null;
let mathJaxReady = false;
function ensureMathJax(view: EditorView): void {
  if (mathJaxPromise) return;
  mathJaxPromise = loadMathJax()
    .then(() => {
      mathJaxReady = true;
      if (view.dom.isConnected) {
        view.dispatch({ effects: refreshOrgPreview.of(null) });
      }
    })
    .catch((error) => console.warn("Org Native: unable to load MathJax", error));
}

const EMPTY_REPLACE = Decoration.replace({});

function selectionTouches(selection: readonly SelectionRange[], from: number, to: number): boolean {
  return selection.some((range) => {
    if (range.from === range.to) return range.from >= from && range.from <= to;
    return range.from < to && range.to > from;
  });
}

function selectionTouchesListMarker(
  selection: readonly SelectionRange[],
  markerFrom: number,
  contentFrom: number
): boolean {
  return selection.some((range) => {
    if (range.from === range.to) {
      return range.from >= markerFrom && range.from < contentFrom;
    }
    return range.from < contentFrom && range.to > markerFrom;
  });
}

function safePosAtDOM(view: EditorView, el: HTMLElement, fallback: number): number {
  try {
    if (!view.contentDOM.contains(el)) return fallback;
    const pos = view.posAtDOM(el);
    if (Number.isFinite(pos) && pos >= 0 && pos <= view.state.doc.length) {
      return pos;
    }
  } catch {
    // Fallback when DOM node isn't mapped in headless environments.
  }
  return Math.max(0, Math.min(view.state.doc.length, fallback));
}

function listLevel(indent: number): number {
  return Math.max(1, Math.min(8, Math.floor(indent / 2) + 1));
}

class BulletWidget extends WidgetType {
  constructor(readonly ordered: boolean, readonly label: string, readonly level: number) {
    super();
  }

  eq(other: BulletWidget): boolean {
    return (
      other.ordered === this.ordered &&
      other.label === this.label &&
      other.level === this.level
    );
  }

  toDOM(): HTMLElement {
    const outer = createDetachedEl("span");
    outer.className = `cm-formatting cm-formatting-list cm-formatting-list-${
      this.ordered ? "ol" : "ul"
    } cm-list-${this.level}`;
    const inner = createDetachedEl("span");
    inner.className = this.ordered ? "list-number" : "list-bullet";
    inner.textContent = this.label;
    outer.appendChild(inner);
    outer.append(" ");
    return outer;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly partial: boolean,
    readonly fallbackFrom: number
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.partial === this.partial;
  }

  toDOM(view: EditorView): HTMLElement {
    const label = createDetachedEl("label");
    label.className = "task-list-label";
    const input = createDetachedEl("input");
    input.type = "checkbox";
    input.className = "task-list-item-checkbox org-checkbox";
    input.checked = this.checked;
    input.indeterminate = this.partial;
    input.dataset.task = this.checked ? "x" : this.partial ? "-" : " ";
    label.appendChild(input);
    label.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const domPos = safePosAtDOM(view, label, this.fallbackFrom);
      const line = view.state.doc.lineAt(domPos);
      const boxMatch = /\[[ Xx-]\]/.exec(line.text);
      const from = boxMatch ? line.from + boxMatch.index : this.fallbackFrom;
      const to = from + 3;
      if (to <= view.state.doc.length) {
        view.dispatch({
          changes: { from, to, insert: this.checked ? "[ ]" : "[X]" },
        });
      }
      view.focus();
    });
    return label;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class TagWidget extends WidgetType {
  constructor(readonly names: string[], readonly app: App) {
    super();
  }

  eq(other: TagWidget): boolean {
    return other.names.join("\u0000") === this.names.join("\u0000");
  }

  toDOM(): HTMLElement {
    const wrapper = createDetachedEl("span");
    wrapper.className = "org-tag";
    wrapper.title = this.names.map((name) => `:${name}:`).join(" ");
    for (const name of this.names) {
      const chip = createDetachedEl("span");
      chip.className = "org-tag-chip";
      const begin = createDetachedEl("span");
      begin.className = "cm-hashtag cm-hashtag-begin cm-meta cm-tag-tag";
      begin.textContent = "#";
      begin.setAttribute("spellcheck", "false");
      const end = createDetachedEl("span");
      end.className = "cm-hashtag cm-hashtag-end cm-meta cm-tag-tag";
      end.textContent = name;
      end.setAttribute("spellcheck", "false");
      chip.appendChild(begin);
      chip.appendChild(end);
      chip.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openTagSearch(this.app, name);
      });
      wrapper.appendChild(chip);
    }
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class LinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string,
    readonly external: boolean,
    readonly app: App,
    readonly sourcePath: string,
    readonly linkCallbacks?: LinkCallbacks,
    readonly idStatus?: OrgIdStatus,
    readonly fallbackFrom = 0
  ) {
    super();
  }

  eq(other: LinkWidget): boolean {
    return (
      other.target === this.target &&
      other.label === this.label &&
      other.external === this.external &&
      other.idStatus === this.idStatus
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const outer = createDetachedEl("span");
    const isId = !!parseOrgIdTarget(this.target);
    const statusClass =
      isId && this.idStatus === "missing"
        ? " org-link-id org-link-broken"
        : isId && this.idStatus === "duplicate"
        ? " org-link-id org-link-duplicate"
        : isId
        ? " org-link-id"
        : "";
    outer.className = `${
      this.external ? "cm-link org-link" : "cm-hmd-internal-link org-link"
    }${statusClass}`;
    outer.title =
      isId && this.idStatus === "missing"
        ? `Missing Org ID: ${this.target} (Alt+Click to edit)`
        : isId && this.idStatus === "duplicate"
        ? `Duplicate Org ID: ${this.target} (Alt+Click to edit)`
        : `${this.target} (Alt+Click to edit)`;
    outer.setAttribute("role", "link");
    outer.setAttribute("tabindex", "-1");
    const inner = createDetachedEl("span");
    inner.className = "cm-underline";
    inner.textContent = this.label;
    outer.appendChild(inner);
    outer.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.altKey) {
        const pos = safePosAtDOM(view, outer, this.fallbackFrom);
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        view.focus();
        return;
      }
      openOrgLink(this.app, this.target, this.sourcePath, this.linkCallbacks);
    });
    return outer;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly rawLength: number,
    readonly fallbackFrom: number
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.rawLength === this.rawLength;
  }

  toDOM(view: EditorView): HTMLElement {
    const img = createDetachedEl("img");
    img.className = "org-inline-image";
    img.src = this.src;
    img.alt = this.alt;
    img.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const from = safePosAtDOM(view, img, this.fallbackFrom);
      const to = Math.min(view.state.doc.length, from + this.rawLength);
      view.dispatch({ selection: { anchor: from, head: to } });
      view.focus();
    });
    return img;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly display: boolean,
    readonly fallbackFrom = 0
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.latex === this.latex && other.display === this.display;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = createDetachedEl("span");
    span.className = this.display ? "math org-math org-math-display" : "math org-math";
    span.setAttribute("contenteditable", "false");
    try {
      span.appendChild(renderMath(this.latex, this.display));
      void finishRenderMath();
    } catch (error) {
      span.textContent = this.display ? `$$${this.latex}$$` : `$${this.latex}$`;
      if (mathJaxReady) console.warn("Org Native: math render failed", error);
      ensureMathJax(view);
    }
    if (this.display) {
      span.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const pos = safePosAtDOM(view, span, this.fallbackFrom);
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        view.focus();
      });
    }
    return span;
  }

  ignoreEvent(): boolean {
    return this.display;
  }
}

class MathPreviewWidget extends WidgetType {
  constructor(readonly latex: string) {
    super();
  }

  eq(other: MathPreviewWidget): boolean {
    return other.latex === this.latex;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = createDetachedEl("div");
    wrap.className = "org-math-live-preview";
    wrap.setAttribute("contenteditable", "false");
    wrap.setAttribute("aria-label", "Live math preview");

    const label = createDetachedEl("span");
    label.className = "org-math-live-preview-label";
    label.textContent = "Preview";
    wrap.appendChild(label);

    const body = createDetachedEl("div");
    body.className = "math org-math org-math-display";
    try {
      body.appendChild(renderMath(this.latex, true));
      void finishRenderMath();
    } catch {
      body.textContent = `$$${this.latex}$$`;
      ensureMathJax(view);
    }
    wrap.appendChild(body);
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    return createDetachedEl("hr");
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class EntityWidget extends WidgetType {
  constructor(readonly symbol: string, readonly raw: string, readonly name = "") {
    super();
  }

  eq(other: EntityWidget): boolean {
    return other.symbol === this.symbol && other.raw === this.raw && other.name === this.name;
  }

  toDOM(): HTMLElement {
    const span = createDetachedEl("span");
    span.className = "org-entity";
    if (this.name) span.dataset.entity = this.name;
    span.textContent = this.symbol;
    span.title = this.raw;
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildFlowArrowSignature(
  block: VerticalArrowBlock,
  renderMathFlag: boolean,
  resolveIdStatus?: (id: string) => OrgIdStatus
): string {
  const labelStr = block.labels
    .map((label) => {
      let extra = "";
      if (resolveIdStatus && label.text.includes("id:")) {
        const m = /\[\[id:([^\]\n]+?)(?:\]\[|\])/i.exec(label.text);
        if (m) extra = `:${resolveIdStatus(m[1].trim())}`;
      }
      return `${label.text}${extra}`;
    })
    .join("\u0001");
  return `${renderMathFlag ? "1" : "0"}\u0002${labelStr}`;
}

class FlowArrowWidget extends WidgetType {
  readonly signature: string;

  constructor(
    readonly block: VerticalArrowBlock,
    readonly app: App,
    readonly sourcePath: string,
    readonly renderMath: boolean,
    readonly linkCallbacks?: LinkCallbacks,
    readonly resolveIdStatus?: (id: string) => OrgIdStatus
  ) {
    super();
    this.signature = buildFlowArrowSignature(block, renderMath, resolveIdStatus);
  }

  eq(other: FlowArrowWidget): boolean {
    return other.signature === this.signature;
  }

  toDOM(view: EditorView): HTMLElement {
    const outer = createDetachedEl("div");
    outer.className = "org-flow-arrow-widget";
    outer.setAttribute("contenteditable", "false");
    outer.title = "Click to edit vertical flow arrow";

    const wrapper = createDetachedEl("div");
    wrapper.className = "org-flow-arrow";
    wrapper.setAttribute("role", "figure");
    wrapper.setAttribute("aria-label", "Flow arrow");

    const rail = createDetachedEl("span");
    rail.className = "org-flow-arrow-rail";
    rail.setAttribute("aria-hidden", "true");
    const stem = createDetachedEl("span");
    stem.className = "org-flow-arrow-stem";
    const head = createDetachedEl("span");
    head.className = "org-flow-arrow-head";
    rail.appendChild(stem);
    rail.appendChild(head);
    wrapper.appendChild(rail);

    if (this.block.labels.length > 0) {
      const body = createDetachedEl("div");
      body.className = "org-flow-arrow-body";
      for (const label of this.block.labels) {
        const labelEl = createDetachedEl("div");
        labelEl.className = "org-flow-arrow-label";
        appendSanitizedHtml(
          labelEl,
          renderInlineHtml(label.text, label.from, {
            app: this.app,
            sourcePath: this.sourcePath,
            math: this.renderMath,
            resolveIdStatus: this.resolveIdStatus,
          })
        );
        body.appendChild(labelEl);
      }
      wrapper.appendChild(body);
      wireLinks(wrapper, this.app, this.sourcePath, this.linkCallbacks);
      if (this.renderMath) hydrateMath(wrapper);
    }

    outer.appendChild(wrapper);
    outer.addEventListener("click", (event) => {
      const targetEl = event.target as HTMLElement | null;
      if (targetEl?.closest("a[data-href]")) return;
      event.preventDefault();
      event.stopPropagation();
      const pos = safePosAtDOM(view, outer, this.block.from);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    });
    return outer;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class CodeFlairWidget extends WidgetType {
  constructor(
    readonly lang: string | undefined,
    readonly fallbackLineFrom: number,
    readonly fold?: OrgFoldInfo
  ) {
    super();
  }

  eq(other: CodeFlairWidget): boolean {
    return (
      other.lang === this.lang &&
      other.fold?.from === this.fold?.from &&
      other.fold?.to === this.fold?.to &&
      other.fold?.folded === this.fold?.folded
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = createDetachedEl("span");
    wrapper.className = "org-src-header";

    if (this.fold) {
      const toggle = createDetachedEl("span");
      toggle.className = `org-fold-indicator org-fold-indicator-src${
        this.fold.folded ? " is-folded" : ""
      }`;
      toggle.title = this.fold.folded ? "Unfold code block" : "Fold code block";
      toggle.setAttribute("role", "button");
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", this.fold.folded ? "false" : "true");

      const chevron = createDetachedEl("span");
      chevron.className = "org-fold-chevron";
      chevron.setAttribute("aria-hidden", "true");
      toggle.appendChild(chevron);

      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const foldRange = { from: this.fold!.from, to: this.fold!.to };
        const effect = this.fold?.folded
          ? unfoldEffect.of(foldRange)
          : foldEffect.of(foldRange);
        const touchesFoldBody =
          !this.fold?.folded &&
          view.state.selection.ranges.some(
            (sel) => sel.to > foldRange.from && sel.from <= foldRange.to
          );
        view.dispatch({
          effects: effect,
          ...(touchesFoldBody ? { selection: { anchor: foldRange.from } } : {}),
        });
        view.focus();
      });
      wrapper.appendChild(toggle);
    }

    const actions = createDetachedEl("span");
    actions.className = "org-src-header-actions";

    const copyBtn = createDetachedEl("button");
    copyBtn.type = "button";
    copyBtn.className = "org-src-copy-btn clickable-icon";
    copyBtn.textContent = "Copy";
    copyBtn.setAttribute("aria-label", "Copy code block");
    copyBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const pos = safePosAtDOM(view, wrapper, this.fallbackLineFrom);
      const lineIdx = view.state.doc.lineAt(pos).number - 1;
      const doc = orgDocForText(view.state.doc);
      const block = doc.blocks.find((b) => b.beginLine === lineIdx);
      const endLine = block
        ? block.endLine !== undefined
          ? block.endLine
          : (block.contentEndLine ?? doc.lines.length - 1) + 1
        : doc.lines.length - 1;
      const code = block
        ? doc.lines
            .slice(block.beginLine + 1, endLine)
            .map((l) => l.text.replace(/^(\s*),(\*+|#\+)/, "$1$2"))
            .join("\n")
        : "";
      const copyPromise = navigator.clipboard?.writeText?.(code);
      if (copyPromise && typeof copyPromise.catch === "function") {
        void copyPromise.catch(() => {});
      }
      copyBtn.textContent = "Copied";
      copyBtn.classList.add("is-copied");
      window.setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("is-copied");
      }, 1500);
    });
    actions.appendChild(copyBtn);

    const flair = createDetachedEl("span");
    flair.className = "code-block-flair";
    flair.textContent = this.lang || "SRC";
    flair.title = "Show Org block markers";
    actions.appendChild(flair);
    wrapper.appendChild(actions);

    wrapper.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const linePos = safePosAtDOM(view, wrapper, this.fallbackLineFrom);
      view.dispatch({ selection: { anchor: linePos } });
      view.focus();
    });
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildTableSignature(
  table: TableData,
  renderMathFlag: boolean,
  resolveIdStatus?: (id: string) => OrgIdStatus
): string {
  const rowStr = table.rows
    .map((row) =>
      row.cells
        .map((c) => {
          let extra = "";
          if (resolveIdStatus && c.text.includes("id:")) {
            const m = /\[\[id:([^\]\n]+?)(?:\]\[|\])/i.exec(c.text);
            if (m) extra = `:${resolveIdStatus(m[1].trim())}`;
          }
          return `${c.align ?? ""}:${c.text}${extra}`;
        })
        .join("\u0001")
    )
    .join("\u0002");
  return `${renderMathFlag ? "1" : "0"}\u0003${table.ruleAfter.join(",")}\u0003${rowStr}`;
}

class TableWidget extends WidgetType {
  readonly signature: string;

  constructor(
    readonly table: TableData,
    readonly app: App,
    readonly sourcePath: string,
    readonly renderMath: boolean,
    readonly linkCallbacks?: LinkCallbacks,
    readonly resolveIdStatus?: (id: string) => OrgIdStatus
  ) {
    super();
    this.signature = buildTableSignature(table, renderMath, resolveIdStatus);
  }

  eq(other: TableWidget): boolean {
    return other.signature === this.signature;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = createDetachedEl("div");
    wrapper.className = "org-table-widget cm-embed-block cm-table-widget markdown-rendered";
    wrapper.setAttribute("contenteditable", "false");
    const tableEl = createDetachedEl("table");
    tableEl.className = "org-table";
    const headerRule = this.table.ruleAfter.length > 0 ? this.table.ruleAfter[0] + 1 : 0;
    let currentSection: HTMLTableSectionElement | null = null;

    this.table.rows.forEach((row, rowIndex) => {
      const inHead = rowIndex < headerRule;
      const wanted = inHead ? "thead" : "tbody";
      if (!currentSection || currentSection.tagName.toLowerCase() !== wanted) {
        currentSection = createDetachedEl(wanted);
        tableEl.appendChild(currentSection);
      }
      const tr = createDetachedEl("tr");
      row.cells.forEach((cell) => {
        const td = createDetachedEl(inHead ? "th" : "td");
        if (cell.align) td.style.textAlign = cell.align;
        appendSanitizedHtml(
          td,
          renderInlineHtml(cell.text, cell.from, {
            app: this.app,
            sourcePath: this.sourcePath,
            math: this.renderMath,
            resolveIdStatus: this.resolveIdStatus,
          })
        );
        const relOffset = cell.from - this.table.from;
        td.addEventListener("click", (event) => {
          const targetEl = event.target as HTMLElement | null;
          if (targetEl?.closest("a[data-href]")) return;
          event.preventDefault();
          event.stopPropagation();
          const liveTableStart = safePosAtDOM(view, wrapper, this.table.from);
          const anchor = Math.min(view.state.doc.length, liveTableStart + Math.max(0, relOffset));
          view.dispatch({ selection: { anchor }, scrollIntoView: true });
          view.focus();
        });
        tr.appendChild(td);
      });
      currentSection.appendChild(tr);
    });

    wrapper.appendChild(tableEl);
    wireLinks(wrapper, this.app, this.sourcePath, this.linkCallbacks);
    if (this.renderMath) hydrateMath(wrapper);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class PropertiesWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly entries: { key: string; value: string }[],
    readonly raw: string,
    readonly fallbackLineFrom: number,
    readonly displayMode: PropertiesDisplayMode
  ) {
    super();
  }

  eq(other: PropertiesWidget): boolean {
    return (
      other.raw === this.raw &&
      other.name === this.name &&
      other.displayMode === this.displayMode
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = createDetachedEl("div");

    if (this.displayMode === "hidden") {
      wrapper.className = "org-properties org-properties-minimal";
      const label = createDetachedEl("span");
      label.className = "org-properties-name";
      label.textContent = `:${this.name.toUpperCase()}:`;
      wrapper.appendChild(label);
      if (this.entries.length > 0) {
        const count = createDetachedEl("span");
        count.className = "org-properties-count";
        count.textContent = String(this.entries.length);
        wrapper.appendChild(count);
      }
      wrapper.title = "Click to edit drawer";
      wrapper.addEventListener("click", (event) => {
        event.preventDefault();
        const pos = safePosAtDOM(view, wrapper, this.fallbackLineFrom);
        view.dispatch({ selection: { anchor: pos } });
        view.focus();
      });
      return wrapper;
    }

    const startExpanded = this.displayMode === "expanded";
    wrapper.className = `org-properties org-properties-live${
      startExpanded ? " is-expanded" : " is-collapsed"
    }`;

    const header = createDetachedEl("div");
    header.className = "org-properties-title";

    const chevron = createDetachedEl("span");
    chevron.className = "org-properties-chevron";
    chevron.setAttribute("aria-hidden", "true");
    header.appendChild(chevron);

    const title = createDetachedEl("span");
    title.className = "org-properties-name";
    title.textContent = this.name.toLowerCase();
    header.appendChild(title);

    if (this.entries.length > 0) {
      const count = createDetachedEl("span");
      count.className = "org-properties-count";
      count.textContent = String(this.entries.length);
      header.appendChild(count);
    }

    const hintEntry = this.entries[0];
    if (!startExpanded && hintEntry) {
      const hint = createDetachedEl("span");
      hint.className = "org-properties-hint";
      hint.textContent = `${hintEntry.key}: ${hintEntry.value}`;
      header.appendChild(hint);
    }

    wrapper.appendChild(header);

    if (startExpanded) {
      const body = createDetachedEl("div");
      body.className = "org-properties-body";
      if (this.entries.length > 0) {
        for (const entry of this.entries) {
          const row = createDetachedEl("div");
          row.className = "org-property";
          const key = createDetachedEl("span");
          key.className = "org-property-key";
          key.textContent = entry.key;
          const value = createDetachedEl("span");
          value.className = "org-property-value";
          value.textContent = entry.value;
          row.appendChild(key);
          row.appendChild(value);
          body.appendChild(row);
        }
      } else {
        const pre = createDetachedEl("pre");
        pre.className = "org-logbook";
        pre.textContent = this.raw;
        body.appendChild(pre);
      }
      wrapper.appendChild(body);
    }

    wrapper.title = "Click to edit drawer";
    wrapper.addEventListener("click", (event) => {
      event.preventDefault();
      const pos = safePosAtDOM(view, wrapper, this.fallbackLineFrom);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class MetadataWidget extends WidgetType {
  constructor(
    readonly title: string | undefined,
    readonly fileTags: string[],
    readonly entries: { key: string; value: string }[],
    readonly raw: string,
    readonly fallbackLineFrom: number,
    readonly displayMode: PropertiesDisplayMode,
    readonly app: App,
    readonly propDrawer?: {
      name: string;
      entries: { key: string; value: string }[];
      raw: string;
      fallbackFrom: number;
    }
  ) {
    super();
  }

  eq(other: MetadataWidget): boolean {
    return (
      other.raw === this.raw &&
      other.title === this.title &&
      other.displayMode === this.displayMode &&
      other.fileTags.join("\u0000") === this.fileTags.join("\u0000") &&
      (other.propDrawer?.raw ?? "") === (this.propDrawer?.raw ?? "")
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const outer = createDetachedEl("div");
    outer.className = "org-metadata";

    if (this.title) {
      const title = createDetachedEl("div");
      title.className = "inline-title";
      title.textContent = this.title;
      outer.appendChild(title);
    }

    if (this.fileTags.length > 0) {
      const tagRow = createDetachedEl("div");
      tagRow.className = "org-filetags";
      for (const name of this.fileTags) {
        const chip = createDetachedEl("a");
        chip.className = "tag org-tag org-filetag";
        chip.href = `#${name}`;
        chip.textContent = `#${name}`;
        chip.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openTagSearch(this.app, name);
        });
        tagRow.appendChild(chip);
      }
      outer.appendChild(tagRow);
    }

    if (this.propDrawer) {
      const propEl = new PropertiesWidget(
        this.propDrawer.name,
        this.propDrawer.entries,
        this.propDrawer.raw,
        this.propDrawer.fallbackFrom,
        this.displayMode
      ).toDOM(view);
      outer.appendChild(propEl);
    }

    if (this.entries.length > 0 && this.displayMode !== "hidden") {
      const expanded = this.displayMode === "expanded";
      const card = createDetachedEl("div");
      card.className = `org-properties org-properties-live${
        expanded ? " is-expanded" : " is-collapsed"
      }`;

      const header = createDetachedEl("div");
      header.className = "org-properties-title";

      const chevron = createDetachedEl("span");
      chevron.className = "org-properties-chevron";
      chevron.setAttribute("aria-hidden", "true");
      header.appendChild(chevron);

      const name = createDetachedEl("span");
      name.className = "org-properties-name";
      name.textContent = "metadata";
      header.appendChild(name);

      const count = createDetachedEl("span");
      count.className = "org-properties-count";
      count.textContent = String(this.entries.length);
      header.appendChild(count);

      if (!expanded) {
        const hint = createDetachedEl("span");
        hint.className = "org-properties-hint";
        hint.textContent = this.entries.map((e) => `${e.key}: ${e.value}`).join(" · ");
        header.appendChild(hint);
      }
      card.appendChild(header);

      if (expanded) {
        const body = createDetachedEl("div");
        body.className = "org-properties-body";
        for (const entry of this.entries) {
          const row = createDetachedEl("div");
          row.className = "org-property";
          const key = createDetachedEl("span");
          key.className = "org-property-key";
          key.textContent = entry.key;
          const value = createDetachedEl("span");
          value.className = "org-property-value";
          value.textContent = entry.value;
          row.appendChild(key);
          row.appendChild(value);
          body.appendChild(row);
        }
        card.appendChild(body);
      }
      outer.appendChild(card);
    }

    outer.addEventListener("click", (event) => {
      event.preventDefault();
      const pos = safePosAtDOM(view, outer, this.fallbackLineFrom);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return outer;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class InlineTitleWidget extends WidgetType {
  constructor(readonly title: string, readonly from: number) {
    super();
  }

  eq(other: InlineTitleWidget): boolean {
    return other.title === this.title;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = createDetachedEl("div");
    el.className = "inline-title org-inline-title";
    el.textContent = this.title;
    el.setAttribute("contenteditable", "false");
    el.addEventListener("click", () => {
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const codeMarksCache = new WeakMap<
  OrgDoc,
  { prismVersion: number; marks: Map<number, { from: number; to: number; cls: string }[]> }
>();

function getCodeMarks(doc: OrgDoc): Map<number, { from: number; to: number; cls: string }[]> {
  const version = getPrismVersion();
  const cached = codeMarksCache.get(doc);
  if (cached && cached.prismVersion === version) return cached.marks;

  const codeMarks = new Map<number, { from: number; to: number; cls: string }[]>();
  for (const block of doc.blocks) {
    if (block.type !== "src") continue;
    const last =
      block.endLine !== undefined
        ? block.endLine - 1
        : block.contentEndLine;
    if (last == null) continue;
    const first = block.beginLine + 1;
    if (first > last) continue;
    const firstLine = doc.lines[first];
    const lastLine = doc.lines[last];
    if (!firstLine || !lastLine) continue;
    const base = firstLine.from;
    const content = doc.lines
      .slice(first, last + 1)
      .map((line) => line.text)
      .join("\n");
    for (const range of highlightCode(content, block.lang)) {
      const absFrom = base + range.from;
      const absTo = base + range.to;
      for (let i = first; i <= last; i++) {
        const line = doc.lines[i];
        const from = Math.max(absFrom, line.from);
        const to = Math.min(absTo, line.to);
        if (to <= from) continue;
        const list = codeMarks.get(i) ?? [];
        list.push({ from, to, cls: range.cls });
        codeMarks.set(i, list);
      }
    }
  }

  codeMarksCache.set(doc, { prismVersion: version, marks: codeMarks });
  return codeMarks;
}

function getMathDelimiterLen(raw: string): number {
  if (raw.length >= 4) {
    if (
      (raw.startsWith("$$") && raw.endsWith("$$")) ||
      (raw.startsWith("\\(") && raw.endsWith("\\)")) ||
      (raw.startsWith("\\[") && raw.endsWith("\\]"))
    ) {
      return 2;
    }
  }
  if (raw.length >= 2 && raw.startsWith("$") && raw.endsWith("$")) {
    return 1;
  }
  return 0;
}

function decorateInlineTokens(
  state: EditorState,
  tokens: InlineToken[],
  ranges: Range<Decoration>[],
  selection: readonly SelectionRange[],
  options: LivePreviewOptions
): void {
  for (const token of tokens) {
    const touched = selectionTouches(selection, token.from, token.to);

    switch (token.type) {
      case "emphasis": {
        const styleClass =
          token.style === "bold"
            ? "cm-strong org-bold"
            : token.style === "italic"
            ? "cm-em org-italic"
            : token.style === "underline"
            ? "cm-underline org-underline"
            : "cm-strikethrough org-strike";
        if (token.contentTo > token.contentFrom) {
          ranges.push(
            Decoration.mark({ class: `org-emphasis ${styleClass}` }).range(
              token.contentFrom,
              token.contentTo
            )
          );
        }
        if (touched) {
          ranges.push(
            Decoration.mark({ class: "cm-formatting cm-formatting-em org-formatting-delim" }).range(
              token.from,
              token.contentFrom
            )
          );
          ranges.push(
            Decoration.mark({ class: "cm-formatting cm-formatting-em org-formatting-delim" }).range(
              token.contentTo,
              token.to
            )
          );
        } else {
          ranges.push(EMPTY_REPLACE.range(token.from, token.contentFrom));
          ranges.push(EMPTY_REPLACE.range(token.contentTo, token.to));
        }
        break;
      }
      case "verbatim": {
        if (token.contentTo > token.contentFrom) {
          ranges.push(
            Decoration.mark({
              class: `cm-inline-code org-verbatim org-${token.style}`,
              attributes: { spellcheck: "false" },
            }).range(token.contentFrom, token.contentTo)
          );
        }
        if (touched) {
          ranges.push(
            Decoration.mark({
              class: "cm-formatting cm-formatting-code org-formatting-delim",
              attributes: { spellcheck: "false" },
            }).range(token.from, token.contentFrom)
          );
          ranges.push(
            Decoration.mark({
              class: "cm-formatting cm-formatting-code org-formatting-delim",
              attributes: { spellcheck: "false" },
            }).range(token.contentTo, token.to)
          );
        } else {
          ranges.push(EMPTY_REPLACE.range(token.from, token.contentFrom));
          ranges.push(EMPTY_REPLACE.range(token.contentTo, token.to));
        }
        break;
      }
      case "link": {
        if (isUnsafeUriScheme(token.target)) {
          ranges.push(Decoration.mark({ class: "org-link-unsafe" }).range(token.from, token.to));
          break;
        }
        const idTarget = parseOrgIdTarget(token.target);
        const idStatus = idTarget ? options.resolveIdStatus?.(idTarget) : undefined;
        const statusCls =
          idTarget && idStatus === "missing"
            ? " org-link-id org-link-broken"
            : idTarget && idStatus === "duplicate"
            ? " org-link-id org-link-duplicate"
            : idTarget
            ? " org-link-id"
            : "";

        if (touched) {
          if (token.to - token.from >= 4) {
            ranges.push(
              Decoration.mark({
                class: "cm-formatting cm-formatting-link org-formatting-delim",
              }).range(token.from, token.from + 2)
            );
            if (token.desc !== undefined) {
              const descEnd = token.to - 2;
              const descStart = descEnd - token.desc.length;
              const sepStart = descStart - 2;
              if (sepStart >= token.from + 2 && descStart >= sepStart) {
                if (sepStart > token.from + 2) {
                  ranges.push(
                    Decoration.mark({ class: `cm-url org-link-target-raw${statusCls}` }).range(
                      token.from + 2,
                      sepStart
                    )
                  );
                }
                ranges.push(
                  Decoration.mark({
                    class: "cm-formatting cm-formatting-link org-formatting-delim",
                  }).range(sepStart, descStart)
                );
                if (descEnd > descStart) {
                  ranges.push(
                    Decoration.mark({ class: "cm-link org-link-desc-raw" }).range(
                      descStart,
                      descEnd
                    )
                  );
                }
                ranges.push(
                  Decoration.mark({
                    class: "cm-formatting cm-formatting-link org-formatting-delim",
                  }).range(descEnd, token.to)
                );
              }
            } else {
              if (token.to - 2 > token.from + 2) {
                ranges.push(
                  Decoration.mark({ class: `cm-url org-link-target-raw${statusCls}` }).range(
                    token.from + 2,
                    token.to - 2
                  )
                );
              }
              ranges.push(
                Decoration.mark({
                  class: "cm-formatting cm-formatting-link org-formatting-delim",
                }).range(token.to - 2, token.to)
              );
            }
          }
          break;
        }

        const external = /^(https?|ftp|mailto):/i.test(token.target);
        const label = token.desc ?? token.target;
        if (token.image) {
          const src = resolveResourcePath(options.app, token.target, options.sourcePath);
          if (src) {
            ranges.push(
              Decoration.replace({
                widget: new ImageWidget(src, label, token.to - token.from, token.from),
              }).range(token.from, token.to)
            );
            break;
          }
        }
        ranges.push(
          Decoration.replace({
            widget: new LinkWidget(
              token.target,
              label,
              external,
              options.app,
              options.sourcePath,
              options.linkCallbacks,
              idStatus,
              token.from
            ),
          }).range(token.from, token.to)
        );
        break;
      }
      case "timestamp":
        ranges.push(
          Decoration.mark({ class: `org-timestamp${token.active ? " is-active" : ""}` }).range(
            token.from,
            token.to
          )
        );
        break;
      case "footnote":
        ranges.push(Decoration.mark({ class: "org-footnote" }).range(token.from, token.to));
        break;
      case "cookie":
        ranges.push(Decoration.mark({ class: "org-cookie" }).range(token.from, token.to));
        break;
      case "url":
        if (isUnsafeUriScheme(token.url)) break;
        if (touched) {
          ranges.push(
            Decoration.mark({ class: "cm-url org-link-target-raw" }).range(token.from, token.to)
          );
          break;
        }
        ranges.push(
          Decoration.replace({
            widget: new LinkWidget(
              token.url,
              token.url,
              true,
              options.app,
              options.sourcePath,
              options.linkCallbacks,
              undefined,
              token.from
            ),
          }).range(token.from, token.to)
        );
        break;
      case "tag":
        if (touched) {
          ranges.push(
            Decoration.mark({ class: "cm-hashtag org-formatting-tag" }).range(token.from, token.to)
          );
          break;
        }
        ranges.push(
          Decoration.replace({ widget: new TagWidget([token.name], options.app) }).range(
            token.from,
            token.to
          )
        );
        break;
      case "math":
        if (touched) {
          const raw = state.sliceDoc(token.from, token.to);
          const delimLen = getMathDelimiterLen(raw);
          if (delimLen > 0 && token.to - token.from > delimLen * 2) {
            ranges.push(
              Decoration.mark({
                class: "cm-formatting cm-formatting-math org-formatting-delim",
              }).range(token.from, token.from + delimLen)
            );
            ranges.push(
              Decoration.mark({ class: "cm-math org-math-source" }).range(
                token.from + delimLen,
                token.to - delimLen
              )
            );
            ranges.push(
              Decoration.mark({
                class: "cm-formatting cm-formatting-math org-formatting-delim",
              }).range(token.to - delimLen, token.to)
            );
          } else {
            ranges.push(
              Decoration.mark({ class: "cm-math org-math-source" }).range(token.from, token.to)
            );
          }
          break;
        }
        if (options.settings.renderMath) {
          ranges.push(
            Decoration.replace({ widget: new MathWidget(token.latex, token.display, token.from) }).range(
              token.from,
              token.to
            )
          );
        } else {
          ranges.push(Decoration.mark({ class: "org-math-source" }).range(token.from, token.to));
        }
        break;
      case "entity": {
        const raw = state.sliceDoc(token.from, token.to);
        if (touched) {
          ranges.push(
            Decoration.mark({ class: "cm-formatting org-formatting-delim" }).range(
              token.from,
              token.to
            )
          );
        } else {
          ranges.push(
            Decoration.replace({ widget: new EntityWidget(token.symbol, raw, token.name) }).range(
              token.from,
              token.to
            )
          );
        }
        break;
      }
      case "linebreak":
        if (touched) {
          ranges.push(
            Decoration.mark({ class: "cm-formatting org-formatting-delim" }).range(
              token.from,
              token.to
            )
          );
        } else {
          ranges.push(
            Decoration.mark({ class: "org-formatting-delim org-linebreak-delim" }).range(
              token.from,
              token.to
            )
          );
        }
        break;
    }
  }
}

interface InitialMetadataRange {
  /** First line index covered by combined preamble (drawer + keywords) when drawer precedes keywords, else keyword start. */
  blockStart: number;
  /** Keyword range start/end (inclusive start, exclusive end). */
  kwStart: number;
  kwEnd: number;
  /** Optional leading top-level PROPERTIES drawer right before keywords. */
  leadingDrawerIndex?: number;
}

function findInitialMetadataRange(doc: OrgDoc): InitialMetadataRange | null {
  let cursor = 0;
  while (
    cursor < doc.lines.length &&
    (doc.lines[cursor].kind === "blank" || doc.lines[cursor].kind === "comment")
  ) {
    cursor++;
  }

  let leadingDrawerIndex: number | undefined;
  let blockStart = cursor;
  const firstLine = doc.lines[cursor];
  if (
    firstLine &&
    firstLine.kind === "drawer-start" &&
    firstLine.drawer?.name.toUpperCase() === "PROPERTIES" &&
    firstLine.drawer.endLine !== undefined
  ) {
    leadingDrawerIndex = firstLine.drawer.id;
    cursor = firstLine.drawer.endLine + 1;
    while (
      cursor < doc.lines.length &&
      (doc.lines[cursor].kind === "blank" || doc.lines[cursor].kind === "comment")
    ) {
      cursor++;
    }
  }

  const kwStart = cursor;
  let kwEnd = kwStart;
  while (
    kwEnd < doc.lines.length &&
    doc.lines[kwEnd].kind === "keyword" &&
    !isTranscludeKeywordLine(doc.lines[kwEnd].text)
  ) {
    const km = /^\s*#\+([A-Za-z0-9_-]+)(?:\[[^\]]*\])?:\s*(.*)$/.exec(doc.lines[kwEnd].text);
    const upper = km?.[1].toUpperCase() ?? "";
    if (!upper || !DOC_METADATA_KEYWORD_RE.test(upper)) break;
    kwEnd++;
  }
  if (kwEnd <= kwStart) return null;
  if (leadingDrawerIndex === undefined) blockStart = kwStart;
  return { blockStart, kwStart, kwEnd, leadingDrawerIndex };
}

function decoratePlanningKeywords(
  text: string,
  lineFrom: number,
  ranges: Range<Decoration>[]
): void {
  const re = /\b(SCHEDULED|DEADLINE|CLOSED):(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const kwFrom = lineFrom + m.index;
    const kwTo = kwFrom + m[0].length;
    ranges.push(
      Decoration.mark({
        class: `org-planning-keyword org-planning-${m[1].toLowerCase()}`,
      }).range(kwFrom, kwTo)
    );
  }
}

function decorateTablePipes(text: string, lineFrom: number, ranges: Range<Decoration>[]): void {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && text[i - 1] !== "\\") {
      ranges.push(
        Decoration.mark({ class: "org-table-pipe" }).range(lineFrom + i, lineFrom + i + 1)
      );
    }
  }
}

function activeTokensKey(
  sliceText: string,
  base: number,
  selection: readonly SelectionRange[]
): string {
  const parts: string[] = [];
  for (const token of parseInline(sliceText, base, { tags: false })) {
    if (token.type === "timestamp" || token.type === "footnote" || token.type === "cookie") {
      continue;
    }
    if (selectionTouches(selection, token.from, token.to)) {
      parts.push(`${token.from}-${token.to}`);
    }
  }
  return parts.join(",");
}

function computeActiveSignature(
  state: EditorState,
  doc: OrgDoc,
  options: LivePreviewOptions
): string {
  const selection = state.selection.ranges;
  const activeLines = new Set<number>();
  for (const range of selection) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number++) activeLines.add(number - 1);
  }
  const sortedLines = [...activeLines].sort((a, b) => a - b);

  const metaRange = findInitialMetadataRange(doc);
  const metaTouched =
    metaRange !== null &&
    selectionTouches(
      selection,
      doc.lines[metaRange.blockStart].from,
      doc.lines[metaRange.kwEnd - 1].to
    );

  const touchedMath: number[] = [];
  if (options.settings.renderMath) {
    for (const block of doc.mathBlocks) {
      if (selectionTouches(selection, block.from, block.to)) touchedMath.push(block.id);
    }
  }

  const touchedTables: number[] = [];
  if (options.settings.renderTables) {
    for (const table of doc.tables) {
      if (selectionTouches(selection, table.from, table.to)) touchedTables.push(table.id);
    }
  }

  const touchedDrawers: number[] = [];
  for (const drawer of doc.drawers) {
    if (drawer.endLine == null) continue;
    const first = doc.lines[drawer.startLine];
    const last = doc.lines[drawer.endLine];
    if (first && last && selectionTouches(selection, first.from, last.to)) {
      touchedDrawers.push(drawer.id);
    }
  }

  const touchedFlowArrows: number[] = [];
  for (const flow of findVerticalArrowBlocks(doc)) {
    if (selectionTouches(selection, flow.from, flow.to)) {
      touchedFlowArrows.push(flow.startLine);
    }
  }

  const lineDetails: string[] = [];
  for (const idx of sortedLines) {
    const line = doc.lines[idx];
    if (!line) continue;
    let detail = String(idx);
    if (line.kind === "heading" && line.heading) {
      const h = line.heading;
      if (h.tags.length > 0) {
        const tagsTouched = selectionTouches(
          selection,
          h.tags[0].from,
          h.tags[h.tags.length - 1].to
        );
        if (tagsTouched) detail += "T";
      }
      const titleSlice = line.text.slice(h.titleFrom - line.from, h.titleTo - line.from);
      const tok = titleSlice ? activeTokensKey(titleSlice, h.titleFrom, selection) : "";
      if (tok) detail += `(${tok})`;
    } else if (line.kind === "list" && line.list) {
      if (selectionTouchesListMarker(selection, line.list.markerFrom, line.list.contentFrom)) {
        detail += "M";
      }
      const contentSlice = line.text.slice(line.list.contentFrom - line.from);
      const tok = contentSlice ? activeTokensKey(contentSlice, line.list.contentFrom, selection) : "";
      if (tok) detail += `(${tok})`;
      if (!line.list.ordered && !line.list.checkbox && contentSlice) {
        const desc = parseListDescriptionOffsets(contentSlice);
        if (
          desc &&
          selectionTouches(
            selection,
            line.list.contentFrom + desc.sepStart,
            line.list.contentFrom + desc.sepEnd
          )
        ) {
          detail += `D(${desc.sepStart}-${desc.sepEnd})`;
        }
      }
    } else if (
      line.kind === "text" ||
      line.kind === "quote" ||
      line.kind === "center" ||
      line.kind === "planning"
    ) {
      const tok = line.text ? activeTokensKey(line.text, line.from, selection) : "";
      if (tok) detail += `(${tok})`;
    } else if (line.kind === "keyword" && isTranscludeKeywordLine(line.text)) {
      const tok = activeTokensKey(line.text, line.from, selection);
      if (tok) detail += `(${tok})`;
    }
    lineDetails.push(detail);
  }

  return [
    lineDetails.join(","),
    metaTouched ? "M1" : "M0",
    touchedMath.join(","),
    touchedTables.join(","),
    touchedDrawers.join(","),
    touchedFlowArrows.join(","),
  ].join("|");
}

function buildDecorations(
  state: EditorState,
  options: LivePreviewOptions,
  doc: OrgDoc
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const selection = state.selection.ranges;
  const settings = options.settings;
  const activeLines = new Set<number>();
  for (const range of selection) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number++) activeLines.add(number - 1);
  }

  const title = doc.title ?? options.displayTitle;
  const skipped = new Set<number>();
  let titleInMetadataCard = false;
  const codeMarks = getCodeMarks(doc);

  const metaRange = findInitialMetadataRange(doc);
  if (metaRange && settings.propertiesDisplay !== "hidden") {
    const first = doc.lines[metaRange.blockStart];
    const last = doc.lines[metaRange.kwEnd - 1];
    if (!selectionTouches(selection, first.from, last.to)) {
      const entries: { key: string; value: string }[] = [];
      const rawLines: string[] = [];
      const fileTags: string[] = [];
      for (let i = metaRange.kwStart; i < metaRange.kwEnd; i++) {
        const text = doc.lines[i].text;
        rawLines.push(text);
        const match = /^\s*#\+([A-Za-z0-9_-]+)(?:\[[^\]]*\])?:\s*(.*)$/.exec(text);
        if (match) {
          const upper = match[1].toUpperCase();
          if (upper === "FILETAGS") {
            for (const tag of parseFileTags(match[2])) {
              if (!fileTags.includes(tag)) fileTags.push(tag);
            }
          } else if (upper !== "TITLE") {
            entries.push({ key: upper, value: match[2] });
          }
        }
      }
      const leadingDrawer =
        metaRange.leadingDrawerIndex !== undefined
          ? doc.drawers[metaRange.leadingDrawerIndex]
          : undefined;
      const propDrawer = leadingDrawer
        ? {
            name: leadingDrawer.name,
            entries: leadingDrawer.entries.map((e) => ({ key: e.key, value: e.value })),
            raw: leadingDrawer.rawLines.join("\n"),
            fallbackFrom: doc.lines[leadingDrawer.startLine]?.from ?? first.from,
          }
        : undefined;
      if (title || entries.length > 0 || fileTags.length > 0 || propDrawer) {
        ranges.push(
          Decoration.replace({
            widget: new MetadataWidget(
              title,
              fileTags,
              entries,
              rawLines.join("\n"),
              first.from,
              settings.propertiesDisplay,
              options.app,
              propDrawer
            ),
            block: true,
          }).range(first.from, last.to)
        );
        for (let i = metaRange.blockStart; i < metaRange.kwEnd; i++) skipped.add(i);
        titleInMetadataCard = true;
      }
    }
  }

  const flowBlocks = findVerticalArrowBlocks(doc);
  const alignedLines = computeAlignedTextLineSet(doc.lines);

  const startsWithBlockWidget =
    doc.mathBlocks.some((block) => block.startLine === 0) ||
    doc.tables.some((table) => table.startLine === 0) ||
    doc.drawers.some((drawer) => drawer.startLine === 0) ||
    flowBlocks.some((flow) => flow.startLine === 0);

  if (title && !titleInMetadataCard && !startsWithBlockWidget) {
    ranges.push(
      Decoration.widget({
        widget: new InlineTitleWidget(title, 0),
        block: true,
        side: -1,
      }).range(0)
    );
  }

  if (settings.renderMath) {
    for (const block of doc.mathBlocks) {
      const first = doc.lines[block.startLine];
      const last = doc.lines[block.endLine];
      if (!first || !last) continue;
      if (selectionTouches(selection, block.from, block.to)) {
        for (let i = block.startLine; i <= block.endLine; i++) {
          const line = doc.lines[i];
          if (!line) continue;
          const cls = [
            "org-line",
            "org-math-block-source",
            i === block.startLine ? "org-math-block-source-first" : "",
            i === block.endLine ? "org-math-block-source-last" : "",
          ]
            .filter(Boolean)
            .join(" ");
          ranges.push(Decoration.line({ class: cls }).range(line.from));
          skipped.add(i);
        }
        if (block.latex.trim()) {
          ranges.push(
            Decoration.widget({
              widget: new MathPreviewWidget(block.latex),
              block: true,
              side: 1,
            }).range(last.to)
          );
        }
        continue;
      }
      ranges.push(
        Decoration.replace({
          widget: new MathWidget(block.latex, true, first.from),
          block: true,
        }).range(first.from, last.to)
      );
      for (let i = block.startLine; i <= block.endLine; i++) skipped.add(i);
    }
  }

  if (settings.renderTables) {
    for (const table of doc.tables) {
      const first = doc.lines[table.startLine];
      const last = doc.lines[table.endLine];
      if (!first || !last) continue;
      if (selectionTouches(selection, table.from, table.to)) continue;
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(
            table,
            options.app,
            options.sourcePath,
            settings.renderMath,
            options.linkCallbacks,
            options.resolveIdStatus
          ),
          block: true,
        }).range(first.from, last.to)
      );
      for (let i = table.startLine; i <= table.endLine; i++) skipped.add(i);
    }
  }

  for (const drawer of doc.drawers) {
    if (drawer.endLine == null) continue;
    if (skipped.has(drawer.startLine)) continue;
    const first = doc.lines[drawer.startLine];
    const last = doc.lines[drawer.endLine];
    if (!first || !last) continue;
    if (selectionTouches(selection, first.from, last.to)) continue;

    const entries = drawer.entries.map((e) => ({ key: e.key, value: e.value }));
    ranges.push(
      Decoration.replace({
        widget: new PropertiesWidget(
          drawer.name,
          entries,
          drawer.rawLines.join("\n"),
          first.from,
          settings.propertiesDisplay
        ),
        block: true,
      }).range(first.from, last.to)
    );
    for (let i = drawer.startLine; i <= drawer.endLine; i++) skipped.add(i);
  }

  for (const flow of flowBlocks) {
    if (skipped.has(flow.startLine)) continue;
    const first = doc.lines[flow.startLine];
    const last = doc.lines[flow.endLine];
    if (!first || !last) continue;
    if (selectionTouches(selection, first.from, last.to)) continue;
    ranges.push(
      Decoration.replace({
        widget: new FlowArrowWidget(
          flow,
          options.app,
          options.sourcePath,
          settings.renderMath,
          options.linkCallbacks,
          options.resolveIdStatus
        ),
        block: true,
      }).range(first.from, last.to)
    );
    for (let i = flow.startLine; i <= flow.endLine; i++) skipped.add(i);
  }

  for (const line of doc.lines) {
    if (skipped.has(line.index)) continue;
    const active = activeLines.has(line.index);

    switch (line.kind) {
      case "heading": {
        const heading = line.heading;
        if (!heading) break;
        const orgLevel = Math.min(heading.level, 9);
        const mdLevel = Math.min(heading.level, 6);
        ranges.push(
          Decoration.line({
            class: `org-line org-heading org-level-${orgLevel} HyperMD-header HyperMD-header-${mdLevel}`,
          }).range(line.from)
        );
        if (heading.titleTo > heading.titleFrom) {
          ranges.push(
            Decoration.mark({ class: `cm-header cm-header-${mdLevel}` }).range(
              heading.titleFrom,
              heading.titleTo
            )
          );
        }

        const hideTo = heading.keyword?.from ?? heading.priority?.from ?? heading.titleFrom;
        if (active) {
          if (hideTo > line.from) {
            ranges.push(
              Decoration.mark({
                class: `cm-formatting cm-formatting-header cm-formatting-header-${mdLevel} cm-header cm-header-${mdLevel} org-formatting-delim`,
              }).range(line.from, hideTo)
            );
          }
        } else if (hideTo > line.from) {
          ranges.push(EMPTY_REPLACE.range(line.from, hideTo));
        }

        if (heading.tags.length > 0) {
          const firstTag = heading.tags[0];
          const lastTag = heading.tags[heading.tags.length - 1];
          const tagsTouched = selectionTouches(selection, firstTag.from, lastTag.to);
          if (tagsTouched) {
            ranges.push(
              Decoration.mark({ class: "cm-hashtag org-formatting-tag" }).range(
                firstTag.from,
                lastTag.to
              )
            );
          } else {
            ranges.push(
              Decoration.replace({
                widget: new TagWidget(
                  heading.tags.map((tag) => tag.name),
                  options.app
                ),
              }).range(firstTag.from, lastTag.to)
            );
          }
        }

        if (heading.keyword) {
          const safeKey = heading.keyword.text.toLowerCase().replace(/[^a-z0-9_-]/g, "");
          const keyCls = safeKey ? ` org-todo-${safeKey}` : "";
          ranges.push(
            Decoration.mark({
              class: `org-todo ${
                heading.keyword.done ? "org-todo-done" : "org-todo-active"
              }${keyCls}`,
            }).range(heading.keyword.from, heading.keyword.to)
          );
        }
        if (heading.priority) {
          ranges.push(
            Decoration.mark({
              class: `org-priority org-priority-${heading.priority.text.toLowerCase()}`,
            }).range(heading.priority.from, heading.priority.to)
          );
        }

        const titleText = line.text.slice(
          heading.titleFrom - line.from,
          heading.titleTo - line.from
        );
        if (titleText) {
          decorateInlineTokens(
            state,
            parseInline(titleText, heading.titleFrom, { tags: false }),
            ranges,
            selection,
            options
          );
        }
        break;
      }

      case "list": {
        const list = line.list;
        if (!list) break;
        const level = listLevel(list.indent);
        const rawBox = list.checkbox
          ? line.text.slice(list.checkbox.from - line.from, list.checkbox.to - line.from)
          : "";
        const partial = rawBox === "[-]";
        const classes = [
          "org-line",
          "org-list-line",
          "HyperMD-list-line",
          `HyperMD-list-line-${level}`,
        ];
        if (list.checkbox) {
          classes.push("HyperMD-task-line");
          if (list.checkbox.checked) classes.push("org-task-done");
          else if (partial) classes.push("org-task-partial");
        }
        if (alignedLines.has(line.index)) {
          classes.push("org-aligned-line");
        }
        ranges.push(Decoration.line({ class: classes.join(" ") }).range(line.from));

        const markerActive = selectionTouchesListMarker(
          selection,
          list.markerFrom,
          list.contentFrom
        );
        if (markerActive) {
          if (list.contentFrom > list.markerFrom) {
            ranges.push(
              Decoration.mark({
                class: "cm-formatting cm-formatting-list org-formatting-delim",
              }).range(list.markerFrom, list.contentFrom)
            );
          }
        } else if (list.checkbox) {
          ranges.push(
            Decoration.replace({
              widget: new CheckboxWidget(list.checkbox.checked, partial, list.checkbox.from),
            }).range(list.markerFrom, list.contentFrom)
          );
        } else {
          const markerText = list.ordered ? `${list.number}.` : "-";
          ranges.push(
            Decoration.replace({
              widget: new BulletWidget(list.ordered, markerText, level),
            }).range(list.markerFrom, list.contentFrom)
          );
        }

        if (line.to > list.contentFrom) {
          const contentCls = list.checkbox?.checked
            ? `cm-list-${level} org-task-text-done`
            : `cm-list-${level}`;
          ranges.push(Decoration.mark({ class: contentCls }).range(list.contentFrom, line.to));
          const contentText = line.text.slice(list.contentFrom - line.from);
          if (contentText) {
            const desc =
              !list.ordered && !list.checkbox ? parseListDescriptionOffsets(contentText) : null;
            if (desc && desc.termEnd > 0) {
              ranges.push(
                Decoration.mark({ class: "org-desc-term" }).range(
                  list.contentFrom,
                  list.contentFrom + desc.termEnd
                )
              );
              const sepFrom = list.contentFrom + desc.sepStart;
              const sepTo = list.contentFrom + desc.sepEnd;
              const sepTouched = selectionTouches(selection, sepFrom, sepTo);
              if (sepTo > sepFrom) {
                if (sepTouched) {
                  ranges.push(
                    Decoration.mark({ class: "cm-formatting org-formatting-delim org-desc-sep" }).range(
                      sepFrom,
                      sepTo
                    )
                  );
                } else {
                  ranges.push(
                    Decoration.mark({ class: "org-desc-sep" }).range(sepFrom, sepTo)
                  );
                }
              }
            }
            decorateInlineTokens(
              state,
              parseInline(contentText, list.contentFrom, { tags: false }),
              ranges,
              selection,
              options
            );
          }
        }
        break;
      }

      case "math-block":
        ranges.push(
          Decoration.line({ class: "org-line org-math-block-source" }).range(line.from)
        );
        break;

      case "table":
      case "table-rule":
        ranges.push(
          Decoration.line({
            class:
              line.kind === "table-rule"
                ? "org-line org-table-rule"
                : "org-line org-table-line",
          }).range(line.from)
        );
        if (line.text) {
          decorateTablePipes(line.text, line.from, ranges);
        }
        break;

      case "block-start": {
        const block = line.block;
        if (!block) break;
        if (block.type === "src") {
          ranges.push(
            Decoration.line({
              class:
                "org-line org-block-marker HyperMD-codeblock HyperMD-codeblock-begin HyperMD-codeblock-begin-bg HyperMD-codeblock-bg",
            }).range(line.from)
          );
          if (!active) {
            ranges.push(
              Decoration.replace({
                widget: new CodeFlairWidget(
                  block.lang,
                  line.from,
                  orgFoldForLine(state, line.index) ?? undefined
                ),
              }).range(line.from, line.to)
            );
          }
        } else {
          ranges.push(
            Decoration.line({
              class: active
                ? "org-line org-block-marker"
                : "org-line org-block-marker org-block-marker-hidden",
            }).range(line.from)
          );
          if (!active) ranges.push(EMPTY_REPLACE.range(line.from, line.to));
        }
        break;
      }

      case "block-end": {
        const block = line.block;
        if (block?.type === "src") {
          ranges.push(
            Decoration.line({
              class:
                "org-line HyperMD-codeblock HyperMD-codeblock-end HyperMD-codeblock-end-bg HyperMD-codeblock-bg",
            }).range(line.from)
          );
          if (!active) ranges.push(EMPTY_REPLACE.range(line.from, line.to));
        } else {
          ranges.push(
            Decoration.line({
              class: active
                ? "org-line org-block-marker"
                : "org-line org-block-marker org-block-marker-hidden",
            }).range(line.from)
          );
          if (!active) ranges.push(EMPTY_REPLACE.range(line.from, line.to));
        }
        break;
      }

      case "src": {
        ranges.push(
          Decoration.line({
            class: "org-line org-src-body HyperMD-codeblock HyperMD-codeblock-bg",
          }).range(line.from)
        );
        if (line.text) {
          let markMinFrom = line.from;
          if (!active) {
            const commaEscape = /^(\s*),(\*+|#\+)/.exec(line.text);
            if (commaEscape) {
              const commaAt = line.from + commaEscape[1].length;
              ranges.push(EMPTY_REPLACE.range(commaAt, commaAt + 1));
              markMinFrom = commaAt + 1;
            }
          }
          if (line.to > markMinFrom) {
            ranges.push(
              Decoration.mark({
                class: "cm-hmd-codeblock",
                attributes: { spellcheck: "false" },
              }).range(markMinFrom, line.to)
            );
          }
          for (const mark of codeMarks.get(line.index) ?? []) {
            const mFrom = Math.max(mark.from, markMinFrom);
            if (mark.to <= mFrom) continue;
            ranges.push(
              Decoration.mark({
                class: `cm-hmd-codeblock ${mark.cls}`,
                attributes: { spellcheck: "false" },
              }).range(mFrom, mark.to)
            );
          }
        }
        break;
      }

      case "quote":
        ranges.push(
          Decoration.line({
            class: "org-line org-quote-body HyperMD-quote HyperMD-quote-1",
          }).range(line.from)
        );
        if (line.text) {
          ranges.push(
            Decoration.mark({ class: "cm-quote cm-quote-1" }).range(line.from, line.to)
          );
          decorateInlineTokens(
            state,
            parseInline(line.text, line.from, { tags: false }),
            ranges,
            selection,
            options
          );
        }
        break;

      case "example":
      case "verse":
      case "export":
        ranges.push(
          Decoration.line({
            class: "org-line HyperMD-codeblock HyperMD-codeblock-bg",
          }).range(line.from)
        );
        if (line.text) {
          let markMinFrom = line.from;
          if (!active && line.kind === "example") {
            const commaEscape = /^(\s*),(\*+|#\+)/.exec(line.text);
            if (commaEscape) {
              const commaAt = line.from + commaEscape[1].length;
              ranges.push(EMPTY_REPLACE.range(commaAt, commaAt + 1));
              markMinFrom = commaAt + 1;
            }
          }
          if (line.to > markMinFrom) {
            ranges.push(
              Decoration.mark({
                class: "cm-hmd-codeblock",
                attributes: { spellcheck: "false" },
              }).range(markMinFrom, line.to)
            );
          }
        }
        break;

      case "center":
        ranges.push(
          Decoration.line({ class: "org-line org-center-body" }).range(line.from)
        );
        if (line.text) {
          decorateInlineTokens(
            state,
            parseInline(line.text, line.from, { tags: false }),
            ranges,
            selection,
            options
          );
        }
        break;

      case "comment-block":
        ranges.push(
          Decoration.line({ class: "org-line org-comment-block" }).range(line.from)
        );
        break;

      case "drawer-start":
      case "drawer-end":
      case "drawer": {
        const hideMarker = !active && (line.kind === "drawer-start" || line.kind === "drawer-end");
        ranges.push(
          Decoration.line({
            class: hideMarker
              ? "org-line org-drawer-line org-drawer-marker-hidden"
              : "org-line org-drawer-line",
          }).range(line.from)
        );
        if (hideMarker) ranges.push(EMPTY_REPLACE.range(line.from, line.to));
        break;
      }

      case "planning":
        ranges.push(Decoration.line({ class: "org-line org-planning-line" }).range(line.from));
        decoratePlanningKeywords(line.text, line.from, ranges);
        decorateInlineTokens(
          state,
          parseInline(line.text, line.from, { tags: false }),
          ranges,
          selection,
          options
        );
        break;

      case "keyword": {
        const isTransclude = isTranscludeKeywordLine(line.text);
        ranges.push(
          Decoration.line({
            class: isTransclude
              ? "org-line org-keyword-line org-keyword-transclude"
              : "org-line org-keyword-line",
          }).range(line.from)
        );
        const keyword = /^(\s*)(#\+([A-Za-z0-9_-]+)(?:\[[^\]]*\])?:)(.*)$/.exec(line.text);
        if (keyword) {
          const from = line.from + keyword[1].length;
          const to = from + keyword[2].length;
          if (to > from) {
            ranges.push(Decoration.mark({ class: "org-keyword-key" }).range(from, to));
          }
          if (isTransclude && keyword[4]) {
            decorateInlineTokens(
              state,
              parseInline(keyword[4], to, { tags: false }),
              ranges,
              selection,
              options
            );
          }
        }
        break;
      }

      case "comment":
        ranges.push(Decoration.line({ class: "org-line org-comment-line" }).range(line.from));
        break;

      case "fixed-width":
        ranges.push(Decoration.line({ class: "org-line org-fixed-width" }).range(line.from));
        if (!active) {
          const fw = /^(\s*)(: ?)/.exec(line.text);
          if (fw) {
            const colonFrom = line.from + fw[1].length;
            const colonTo = colonFrom + fw[2].length;
            if (colonTo > colonFrom) {
              ranges.push(EMPTY_REPLACE.range(colonFrom, colonTo));
            }
          }
        }
        break;

      case "rule":
        ranges.push(Decoration.line({ class: "org-line hr" }).range(line.from));
        if (active) {
          ranges.push(
            Decoration.mark({ class: "cm-formatting org-formatting-delim" }).range(
              line.from,
              line.to
            )
          );
        } else {
          ranges.push(Decoration.replace({ widget: new RuleWidget() }).range(line.from, line.to));
        }
        break;

      case "text":
        if (alignedLines.has(line.index)) {
          ranges.push(Decoration.line({ class: "org-line org-aligned-line" }).range(line.from));
        }
        if (!line.text) break;
        decorateInlineTokens(
          state,
          parseInline(line.text, line.from, { tags: false }),
          ranges,
          selection,
          options
        );
        break;

      default:
        break;
    }
  }

  return Decoration.set(ranges, true);
}

interface LivePreviewState {
  decorations: DecorationSet;
  activeSig: string;
}

export function orgLivePreview(options: LivePreviewOptions): Extension {
  const scale = clampScale(options.settings.readingFontScale);
  const editorAttrs = EditorView.editorAttributes.of({
    "data-reading-width": options.settings.readingWidth ?? "normal",
    "data-reading-line-height": options.settings.readingLineHeight ?? "comfortable",
    "data-cjk-typography": (options.settings.cjkTypography ?? true) ? "true" : "false",
    style: `--org-reading-font-scale: ${scale}`,
  });

  const field = StateField.define<LivePreviewState>({
    create(state) {
      const doc = orgDocForText(state.doc);
      return {
        decorations: buildDecorations(state, options, doc),
        activeSig: computeActiveSignature(state, doc, options),
      };
    },
    update(value, transaction) {
      const forced = transaction.effects.some((effect) => effect.is(refreshOrgPreview));
      const foldChanged = transaction.effects.some(
        (effect) => effect.is(foldEffect) || effect.is(unfoldEffect)
      );

      if (transaction.docChanged || !transaction.changes.empty || forced || foldChanged) {
        const doc = orgDocForText(transaction.state.doc);
        return {
          decorations: buildDecorations(transaction.state, options, doc),
          activeSig: computeActiveSignature(transaction.state, doc, options),
        };
      }

      if (transaction.selection !== undefined) {
        const doc = orgDocForText(transaction.state.doc);
        const nextSig = computeActiveSignature(transaction.state, doc, options);
        if (nextSig === value.activeSig) {
          return value;
        }
        return {
          decorations: buildDecorations(transaction.state, options, doc),
          activeSig: nextSig,
        };
      }

      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });

  return [editorAttrs, field];
}
