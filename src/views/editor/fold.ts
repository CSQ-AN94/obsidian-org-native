import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldable, foldEffect, foldedRanges, unfoldAll, unfoldEffect } from "@codemirror/language";
import type { BlockType, DrawerData, FoldLevelMode, OrgDoc } from "../../core/model/types";
import { parseOrgDoc } from "../../core/parser/parse";
import { buildSectionTree } from "../../core/parser/sectionTree";
import { getTodoKeywordVersion } from "../../core/parser/todoKeywords";

const docCache = new WeakMap<Text, { version: number; doc: OrgDoc }>();
const cycleState = new WeakMap<EditorView, FoldLevelMode>();

export function orgDocForText(text: Text): OrgDoc {
  const version = getTodoKeywordVersion();
  const cached = docCache.get(text);
  if (cached && cached.version === version) return cached.doc;
  const doc = parseOrgDoc(text.toString());
  docCache.set(text, { version, doc });
  return doc;
}

export type OrgFoldKind = "heading" | "block" | "drawer";

export interface OrgFoldInfo {
  kind: OrgFoldKind;
  from: number;
  to: number;
  indicatorLine: number;
  blockType?: BlockType;
  folded: boolean;
}

function isRangeFolded(state: EditorState, from: number, to: number): boolean {
  const iterator = foldedRanges(state).iter();
  while (iterator.value) {
    if (iterator.from <= from && iterator.to >= to) return true;
    iterator.next();
  }
  return false;
}

export function computeHeadingFoldRange(
  doc: OrgDoc,
  headingLineIndex: number
): { from: number; to: number } | null {
  const headingLine = doc.lines[headingLineIndex];
  if (!headingLine || headingLine.kind !== "heading" || !headingLine.heading) return null;
  const level = headingLine.heading.level;

  let lastNonBlank: number | null = null;
  for (let i = headingLineIndex + 1; i < doc.lines.length; i++) {
    const line = doc.lines[i];
    if (line.kind === "heading" && line.heading && line.heading.level <= level) {
      break;
    }
    if (line.text.trim() !== "") {
      lastNonBlank = i;
    }
  }
  if (lastNonBlank == null) return null;
  const to = doc.lines[lastNonBlank].to;
  if (to <= headingLine.to) return null;
  return { from: headingLine.to, to };
}

function computeDrawerFoldRange(
  doc: OrgDoc,
  drawer: DrawerData
): { from: number; to: number } | null {
  if (drawer.endLine == null || drawer.endLine <= drawer.startLine) return null;
  const start = doc.lines[drawer.startLine];
  const end = doc.lines[drawer.endLine];
  if (!start || !end || end.to <= start.to) return null;
  return { from: start.to, to: end.to };
}

function infoForBlock(
  state: EditorState,
  doc: OrgDoc,
  block: OrgDoc["blocks"][number]
): OrgFoldInfo | null {
  if (block.endLine == null) return null;
  const begin = doc.lines[block.beginLine];
  const end = doc.lines[block.endLine];
  if (!begin || !end) return null;

  const isSrc = block.type === "src";
  const indicatorLine = isSrc ? block.beginLine : block.beginLine + 1;
  if (indicatorLine > block.endLine) return null;
  const indicator = doc.lines[indicatorLine];
  if (!indicator) return null;

  const from = isSrc ? begin.to : indicator.from;
  const to = end.to;
  if (to <= from) return null;

  return {
    kind: "block",
    from,
    to,
    indicatorLine,
    blockType: block.type,
    folded: isRangeFolded(state, from, to),
  };
}

export function orgFoldableItems(state: EditorState): OrgFoldInfo[] {
  const doc = orgDocForText(state.doc);
  const result: OrgFoldInfo[] = [];

  for (const line of doc.lines) {
    if (line.kind !== "heading") continue;
    const range = computeHeadingFoldRange(doc, line.index);
    if (!range) continue;
    result.push({
      kind: "heading",
      from: range.from,
      to: range.to,
      indicatorLine: line.index,
      folded: isRangeFolded(state, range.from, range.to),
    });
  }

  for (const drawer of doc.drawers) {
    const range = computeDrawerFoldRange(doc, drawer);
    if (!range) continue;
    result.push({
      kind: "drawer",
      from: range.from,
      to: range.to,
      indicatorLine: drawer.startLine,
      folded: isRangeFolded(state, range.from, range.to),
    });
  }

  for (const block of doc.blocks) {
    const info = infoForBlock(state, doc, block);
    if (info) result.push(info);
  }

  return result;
}

export function orgFoldableBlocks(state: EditorState): OrgFoldInfo[] {
  return orgFoldableItems(state).filter((item) => item.kind === "block");
}

export function orgFoldForLine(state: EditorState, lineNumber: number): OrgFoldInfo | null {
  const doc = orgDocForText(state.doc);
  const line = doc.lines[lineNumber];
  if (!line) return null;

  if (line.kind === "heading") {
    const range = computeHeadingFoldRange(doc, lineNumber);
    if (!range) return null;
    return {
      kind: "heading",
      from: range.from,
      to: range.to,
      indicatorLine: lineNumber,
      folded: isRangeFolded(state, range.from, range.to),
    };
  }

  if (line.kind === "drawer-start" && line.drawer) {
    const range = computeDrawerFoldRange(doc, line.drawer);
    if (!range) return null;
    return {
      kind: "drawer",
      from: range.from,
      to: range.to,
      indicatorLine: line.drawer.startLine,
      folded: isRangeFolded(state, range.from, range.to),
    };
  }

  for (const block of doc.blocks) {
    if (block.endLine == null) continue;
    if (lineNumber < block.beginLine || lineNumber > block.endLine) continue;
    return infoForBlock(state, doc, block);
  }

  return null;
}

export function toggleFoldAtCursor(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const range = foldable(view.state, line.from, line.to);
  if (!range) return false;
  const folded = isRangeFolded(view.state, range.from, range.to);
  const touchesFoldBody =
    !folded &&
    view.state.selection.ranges.some((sel) => sel.to > range.from && sel.from <= range.to);
  view.dispatch({
    effects: (folded ? unfoldEffect : foldEffect).of(range),
    ...(touchesFoldBody ? { selection: { anchor: range.from } } : {}),
  });
  return true;
}

export function setEditorFoldLevel(view: EditorView, mode: FoldLevelMode): void {
  cycleState.set(view, mode);
  unfoldAll(view);
  if (mode === "all") return;

  const doc = orgDocForText(view.state.doc);
  const effects = [];

  if (mode === "overview") {
    const tree = buildSectionTree(doc);
    for (const top of tree.sections) {
      const range = computeHeadingFoldRange(doc, top.headingLineIndex);
      if (range) effects.push(foldEffect.of(range));
    }
  } else if (mode === "content") {
    for (const line of doc.lines) {
      if (line.kind !== "heading") continue;
      let lastBodyNonBlank: number | null = null;
      for (let i = line.index + 1; i < doc.lines.length; i++) {
        const next = doc.lines[i];
        if (next.kind === "heading") break;
        if (next.text.trim() !== "") lastBodyNonBlank = i;
      }
      if (lastBodyNonBlank != null) {
        const to = doc.lines[lastBodyNonBlank].to;
        if (to > line.to) effects.push(foldEffect.of({ from: line.to, to }));
      }
    }
  }

  if (effects.length > 0) {
    view.dispatch({ effects });
  }
}

export function cycleEditorFold(view: EditorView): boolean {
  const current = cycleState.get(view) ?? "all";
  const next: FoldLevelMode =
    current === "all" ? "overview" : current === "overview" ? "content" : "all";
  setEditorFoldLevel(view, next);
  return true;
}

export function unfoldPos(view: EditorView, pos: number): void {
  const effects = [];
  const iter = foldedRanges(view.state).iter();
  while (iter.value) {
    if (iter.from <= pos && iter.to >= pos) {
      effects.push(unfoldEffect.of({ from: iter.from, to: iter.to }));
    }
    iter.next();
  }
  if (effects.length > 0) {
    view.dispatch({ effects });
  }
}
