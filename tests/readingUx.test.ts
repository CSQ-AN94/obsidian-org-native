import { describe, expect, it, vi } from "vitest";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { foldedRanges } from "@codemirror/language";
import { attachObsidianDomHelpers, createMockApp } from "./mocks/obsidian";
import { DEFAULT_SETTINGS, OrgNativeSettings } from "../src/settings";
import { renderOrgPreview } from "../src/views/reading/render";
import {
  getReadingFoldSnapshot,
  restoreReadingFoldSnapshot,
  toggleReadingSection,
} from "../src/views/reading/folding";
import { createOrgEditorState } from "../src/views/editor/orgEditor";
import { toggleFoldAtCursor } from "../src/views/editor/fold";

function makeApp() {
  return createMockApp() as unknown as import("obsidian").App;
}

function createLiveView(
  doc: string,
  settings: Partial<OrgNativeSettings> = {},
  mode: "live" | "source" = "live"
) {
  const app = makeApp();
  const parent = attachObsidianDomHelpers(document.createElement("div"));
  const compartment = new Compartment();
  const state = createOrgEditorState(doc, {
    app,
    sourcePath: "reading-ux.org",
    displayTitle: "reading-ux",
    settings: { ...DEFAULT_SETTINGS, ...settings },
    mode,
    livePreviewCompartment: compartment,
    onDocChanged: () => {},
  });
  const view = new EditorView({ state, parent });
  return { view, parent };
}

describe("Reading View UX, typography, and contracts", () => {
  it("applies typography attributes and clamps readingFontScale on .org-preview", () => {
    const app = makeApp();
    const low = renderOrgPreview("* Heading\nBody", app, "a.org", {
      settings: {
        ...DEFAULT_SETTINGS,
        readingWidth: "narrow",
        readingLineHeight: "compact",
        readingFontScale: 0.4,
        cjkTypography: false,
      },
    });
    expect(low.dataset.readingWidth).toBe("narrow");
    expect(low.dataset.readingLineHeight).toBe("compact");
    expect(low.dataset.cjkTypography).toBe("false");
    expect(low.style.getPropertyValue("--org-reading-font-scale")).toBe("0.85");

    const high = renderOrgPreview("* Heading\nBody", app, "b.org", {
      settings: {
        ...DEFAULT_SETTINGS,
        readingWidth: "wide",
        readingLineHeight: "relaxed",
        readingFontScale: 2.0,
        cjkTypography: true,
      },
    });
    expect(high.dataset.readingWidth).toBe("wide");
    expect(high.dataset.readingLineHeight).toBe("relaxed");
    expect(high.dataset.cjkTypography).toBe("true");
    expect(high.style.getPropertyValue("--org-reading-font-scale")).toBe("1.25");
  });

  it("emits .org-transclude-slot in document order, stops skipInitialKeywords early, and calls hydrateTransclusions", () => {
    const app = makeApp();
    const doc = [
      "#+TITLE: Transclude Order Test",
      "#+AUTHOR: Tester",
      "#+TRANSCLUDE: [[id:top-node]] :only-contents",
      "",
      "** Subheading",
      "#+TRANSCLUDE: [[id:sub-node]] :level 3",
      "",
      "#+BEGIN_SRC org",
      "#+TRANSCLUDE: [[id:inside-src]]",
      "#+END_SRC",
    ].join("\n");

    const hydrateSpy = vi.fn();
    const root = renderOrgPreview(doc, app, "notes/order.org", {
      settings: { ...DEFAULT_SETTINGS, enableTransclusion: true },
      hydrateTransclusions: hydrateSpy,
    });

    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    expect(hydrateSpy).toHaveBeenCalledWith(root, "notes/order.org");

    const meta = root.querySelector<HTMLDetailsElement>("details.org-properties");
    expect(meta).toBeTruthy();
    expect(meta!.textContent).not.toContain("top-node");

    const slots = Array.from(root.querySelectorAll<HTMLElement>(".org-transclude-slot"));
    expect(slots).toHaveLength(2);
    expect(slots[0].dataset.transcludeRaw).toBe("#+TRANSCLUDE: [[id:top-node]] :only-contents");
    expect(slots[0].dataset.line).toBe("2");
    expect(slots[0].dataset.parentLevel).toBe("0");

    expect(slots[1].dataset.transcludeRaw).toBe("#+TRANSCLUDE: [[id:sub-node]] :level 3");
    expect(slots[1].dataset.line).toBe("5");
    expect(slots[1].dataset.parentLevel).toBe("2");

    // Disabled transclusion falls back to inert keyword lines without invoking hydration.
    const disabledSpy = vi.fn();
    const disabledRoot = renderOrgPreview(doc, app, "notes/order.org", {
      settings: { ...DEFAULT_SETTINGS, enableTransclusion: false },
      hydrateTransclusions: disabledSpy,
    });
    expect(disabledSpy).not.toHaveBeenCalled();
    expect(disabledRoot.querySelectorAll(".org-transclude-slot")).toHaveLength(0);
    expect(disabledRoot.querySelectorAll(".org-keyword-transclude")).toHaveLength(2);
  });

  it("renders mixed CJK/English prose, lists, checkboxes, planning keywords, code headers, figures, and footnotes cleanly", () => {
    const app = makeApp();
    const src = [
      "#+TITLE: 混合排版测试",
      "#+FILETAGS: :research:vla:",
      "",
      "* WAITING [#A] 论文阅读 :paper:中英文:",
      "DEADLINE: <2026-11-30 Mon> SCHEDULED: <2026-11-25 Wed>",
      "中文段落第一行",
      "第二行无缝衔接。",
      "English line one",
      "line two keeps space.",
      "",
      "- bullet item",
      "1. switched to ordered at same indent",
      "- [X] finished task",
      "- [-] partial task",
      "- [ ] open task",
      "",
      "#+BEGIN_SRC python",
      "print('hello')",
      "#+END_SRC",
      "",
      "#+CAPTION: 架构示意图",
      "#+ATTR_HTML: :width 480px",
      "[[file:diagram.png]]",
      "",
      "#+ATTR_HTML: :width expression(alert(1))",
      "[[file:unsafe-width.png]]",
      "",
      "[fn:1] 脚注定义内容。",
    ].join("\n");

    const root = renderOrgPreview(src, app, "notes/mix.org", {
      settings: { ...DEFAULT_SETTINGS, cjkTypography: true, strictLineBreaks: true },
      onToggleTask: () => {},
    });

    // Also verify default strictLineBreaks: false preserves explicit line breaks as <br>
    const defaultBreaksRoot = renderOrgPreview(src, app, "notes/mix.org", {
      settings: { ...DEFAULT_SETTINGS, cjkTypography: true },
    });
    expect(defaultBreaksRoot.querySelector("p br")).toBeTruthy();

    // No empty metadata drawer when only TITLE + FILETAGS exist -> entries has FILETAGS (1), wait:
    // Verify filetags chips exist cleanly.
    const filetags = root.querySelectorAll(".org-filetags .org-filetag");
    expect(filetags.length).toBe(2);

    // Title-only doc should not render an empty metadata drawer.
    const titleOnlyRoot = renderOrgPreview("#+TITLE: Only Title\nBody", app, "only.org", {
      settings: DEFAULT_SETTINGS,
    });
    expect(titleOnlyRoot.querySelector("details.org-properties")).toBeNull();

    // Planning keywords
    expect(root.querySelector(".org-planning-deadline")?.textContent).toBe("DEADLINE:");
    expect(root.querySelector(".org-planning-scheduled")?.textContent).toBe("SCHEDULED:");

    // CJK soft-break joining vs English soft-break joining
    const paragraphs = Array.from(root.querySelectorAll("p")).map((p) => p.textContent);
    expect(paragraphs[0]).toContain("中文段落第一行第二行无缝衔接。");
    expect(paragraphs[0]).toContain("English line one line two keeps space.");

    // Same-indent ul -> ol switch produces sibling <ul> and <ol> rather than invalid nesting
    const sectionBody = root.querySelector(".org-section-body")!;
    const uls = Array.from(sectionBody.children).filter((el) => el.tagName === "UL");
    const ols = Array.from(sectionBody.children).filter((el) => el.tagName === "OL");
    expect(uls.length).toBe(2);
    expect(ols.length).toBe(1);

    // Checkboxes & partial state
    const taskItems = Array.from(root.querySelectorAll<HTMLElement>("li.task-list-item"));
    expect(taskItems).toHaveLength(3);
    expect(taskItems[0].classList.contains("is-checked")).toBe(true);
    expect(taskItems[1].classList.contains("is-partial")).toBe(true);
    expect(taskItems[2].classList.contains("is-checked")).toBe(false);

    // Toggling task updates li.is-checked immediately
    const openInput = taskItems[2].querySelector<HTMLInputElement>("input.org-task-checkbox")!;
    openInput.checked = true;
    openInput.dispatchEvent(new Event("change"));
    expect(taskItems[2].classList.contains("is-checked")).toBe(true);

    // Code block wrapper + copy button
    const codeWrap = root.querySelector(".org-code-block[data-lang='python']");
    expect(codeWrap).toBeTruthy();
    expect(codeWrap!.querySelector(".org-code-lang")?.textContent).toBe("python");
    expect(codeWrap!.querySelector(".org-code-copy-btn")).toBeTruthy();

    // Standalone image figure + caption + sanitized width
    const figures = Array.from(root.querySelectorAll<HTMLElement>("figure.org-figure"));
    expect(figures).toHaveLength(2);
    const img1 = figures[0].querySelector<HTMLImageElement>("img")!;
    expect(img1.style.width).toBe("480px");
    expect(figures[0].querySelector("figcaption.org-figcaption")?.textContent).toBe("架构示意图");
    const img2 = figures[1].querySelector<HTMLImageElement>("img")!;
    expect(img2.style.width).toBe("");

    // Footnote definition
    const fnDef = root.querySelector(".org-footnote-def[data-footnote='1']");
    expect(fnDef?.textContent).toContain("脚注定义内容");
  });

  it("persists Reading View fold state by stable ID/slug across line shifts and preserves drawer open state", () => {
    const app = makeApp();
    const v1 = [
      "* Section Alpha",
      ":PROPERTIES:",
      ":ID: alpha-stable-id",
      ":END:",
      "Alpha body.",
      "",
      "* Section Beta",
      "Beta body.",
    ].join("\n");

    const root1 = renderOrgPreview(v1, app, "shift.org", {
      settings: { ...DEFAULT_SETTINGS, propertiesDisplay: "collapsed" },
    });
    const secs1 = Array.from(root1.querySelectorAll<HTMLElement>(".org-section"));
    toggleReadingSection(secs1[0]);
    expect(secs1[0].classList.contains("is-folded")).toBe(true);

    // Open the property drawer
    const drawer1 = root1.querySelector<HTMLDetailsElement>("details[data-drawer-key]")!;
    drawer1.open = true;

    const snapshot = getReadingFoldSnapshot(root1);

    // Shift Section Alpha down by inserting preamble paragraphs
    const v2 = ["Inserted preamble 1.", "", "Inserted preamble 2.", "", v1].join("\n");
    const root2 = renderOrgPreview(v2, app, "shift.org", {
      settings: { ...DEFAULT_SETTINGS, propertiesDisplay: "collapsed" },
    });
    restoreReadingFoldSnapshot(root2, snapshot);

    const secs2 = Array.from(root2.querySelectorAll<HTMLElement>(".org-section"));
    expect(secs2[0].classList.contains("is-folded")).toBe(true);
    expect(secs2[1].classList.contains("is-folded")).toBe(false);

    // Clicking the fold ellipsis unfolds the section cleanly
    const ellipsis = secs2[0].querySelector<HTMLButtonElement>(".org-fold-ellipsis")!;
    expect(ellipsis).toBeTruthy();
    ellipsis.click();
    expect(secs2[0].classList.contains("is-folded")).toBe(false);

    // Drawer open state restored
    const drawer2 = root2.querySelector<HTMLDetailsElement>("details[data-drawer-key]")!;
    expect(drawer2.open).toBe(true);
  });
});

describe("Live Preview UX, cursor syntax reveal, stability & folding", () => {
  it("applies reading attributes in live mode and omits them in source mode", () => {
    const live = createLiveView("* Hello\nWorld", {
      readingWidth: "wide",
      readingLineHeight: "relaxed",
      readingFontScale: 1.1,
      cjkTypography: true,
    });
    expect(live.view.dom.getAttribute("data-reading-width")).toBe("wide");
    expect(live.view.dom.getAttribute("data-reading-line-height")).toBe("relaxed");
    expect(live.view.dom.getAttribute("data-cjk-typography")).toBe("true");
    expect(live.view.dom.getAttribute("style")).toContain("--org-reading-font-scale: 1.1");
    live.view.destroy();

    const src = createLiveView("* Hello\nWorld", { readingWidth: "wide" }, "source");
    expect(src.view.dom.getAttribute("data-reading-width")).toBeNull();
    src.view.destroy();
  });

  it("reveals syntax delimiters while keeping inline styles when cursor enters, and hides them when away", () => {
    const doc = "Plain text and *bold words* plus ~code~ and [[id:node-1][Target Link]].";
    const { view } = createLiveView(doc);

    // Cursor at 0 (away from emphasis/code/link)
    expect(view.dom.querySelectorAll(".org-formatting-delim")).toHaveLength(0);
    expect(view.dom.querySelector(".cm-strong.org-bold")?.textContent).toBe("bold words");
    expect(view.dom.querySelector(".cm-inline-code.org-verbatim")?.textContent).toBe("code");
    expect(view.dom.querySelector(".org-link-id")?.textContent).toBe("Target Link");

    // Move cursor into *bold words*
    const boldPos = doc.indexOf("bold");
    view.dispatch({ selection: { anchor: boldPos } });
    expect(view.dom.querySelector(".cm-strong.org-bold")?.textContent).toBe("bold words");
    const delims = Array.from(view.dom.querySelectorAll(".org-formatting-delim")).map(
      (el) => el.textContent
    );
    expect(delims).toEqual(["*", "*"]);

    // Move cursor into link [[id:node-1][Target Link]]
    const linkPos = doc.indexOf("node-1");
    view.dispatch({ selection: { anchor: linkPos } });
    expect(view.dom.querySelector(".org-link-target-raw")?.textContent).toBe("id:node-1");
    expect(view.dom.querySelector(".org-link-desc-raw")?.textContent).toBe("Target Link");

    view.destroy();
  });

  it("keeps heading tags as TagWidget while editing title, and reveals raw tags only when cursor touches tags", () => {
    const doc = "* Heading Title :alpha:beta:\nBody line.";
    const { view } = createLiveView(doc);

    // Cursor at line 1 -> stars hidden, tags rendered as widget
    view.dispatch({ selection: { anchor: doc.indexOf("Body") } });
    expect(view.dom.querySelector(".org-heading .org-tag")).toBeTruthy();

    // Cursor inside heading title -> stars revealed, tags STILL rendered as TagWidget!
    view.dispatch({ selection: { anchor: doc.indexOf("Title") } });
    expect(view.dom.querySelector(".org-heading .cm-formatting-header")?.textContent).toContain("*");
    expect(view.dom.querySelector(".org-heading .org-tag")).toBeTruthy();

    // Cursor inside :alpha:beta: -> raw tags revealed
    view.dispatch({ selection: { anchor: doc.indexOf("alpha") } });
    expect(view.dom.querySelector(".org-formatting-tag")?.textContent).toBe(":alpha:beta:");

    view.destroy();
  });

  it("shows live math preview while editing math block and updates TableWidget on same-length edits", () => {
    const doc = [
      "Intro line",
      "",
      "\\begin{align}",
      "x &= 1",
      "\\end{align}",
      "",
      "| Key | Val |",
      "|-----+-----|",
      "| A   | ABC |",
    ].join("\n");

    const { view } = createLiveView(doc);

    // Cursor on Intro line -> block math rendered as widget, table rendered as TableWidget
    expect(view.dom.querySelector(".org-math-live-preview")).toBeNull();
    expect(view.dom.querySelector(".org-table-widget")?.textContent).toContain("ABC");

    // Move cursor into align block -> live math preview widget appears below source
    view.dispatch({ selection: { anchor: doc.indexOf("x &= 1") } });
    const livePreview = view.dom.querySelector(".org-math-live-preview");
    expect(livePreview).toBeTruthy();
    expect(livePreview!.textContent).toContain("x &= 1");

    // Edit ABC -> XYZ (same length!) while cursor is in table, then move cursor back to Intro
    const abcPos = doc.indexOf("ABC");
    view.dispatch({
      changes: { from: abcPos, to: abcPos + 3, insert: "XYZ" },
      selection: { anchor: 0 },
    });
    const updatedTable = view.dom.querySelector(".org-table-widget");
    expect(updatedTable?.textContent).toContain("XYZ");
    expect(updatedTable?.textContent).not.toContain("ABC");

    view.destroy();
  });

  it("keeps list marker as widget at contentFrom, reveals at marker, renders quote inline, and handles indented keywords", () => {
    const doc = [
      "#+TITLE: Demo",
      "#+TRANSCLUDE: [[id:top-node]]",
      "  #+AUTHOR: Indented",
      "",
      "- [ ] Task item",
      "#+BEGIN_QUOTE",
      "Quote with *emphasis*",
      "#+END_QUOTE",
      "-----",
    ].join("\n");

    const { view } = createLiveView(doc);

    // Move cursor to end (past rule) -> check top-level MetadataWidget stopped before #+TRANSCLUDE:
    view.dispatch({ selection: { anchor: doc.length } });
    const metadataEl = view.dom.querySelector(".org-metadata");
    expect(metadataEl).toBeTruthy();
    expect(metadataEl!.textContent).toContain("Demo");
    expect(metadataEl!.textContent).not.toContain("top-node");
    expect(view.dom.querySelector(".org-keyword-transclude")).toBeTruthy();
    expect(view.dom.querySelector(".org-quote-body .cm-strong.org-bold")?.textContent).toBe(
      "emphasis"
    );

    // Cursor at contentFrom of `- [ ] Task item` ("T" of Task item) -> CheckboxWidget stays rendered!
    const taskContentFrom = doc.indexOf("Task item");
    view.dispatch({ selection: { anchor: taskContentFrom } });
    expect(view.dom.querySelector(".org-checkbox")).toBeTruthy();

    // Cursor inside `[ ]` marker -> raw `- [ ] ` revealed
    const markerPos = doc.indexOf("[ ]");
    view.dispatch({ selection: { anchor: markerPos } });
    expect(view.dom.querySelector(".org-checkbox")).toBeNull();
    expect(view.dom.querySelector(".cm-formatting-list")?.textContent).toBe("- [ ] ");

    // Cursor on ----- rule reveals raw dashes
    view.dispatch({ selection: { anchor: doc.indexOf("-----") } });
    expect(view.dom.querySelector(".hr .org-formatting-delim")?.textContent).toBe("-----");

    view.destroy();
  });

  it("avoids rebuilding decorations on plain-text cursor moves and keeps undo/redo + fold cursor clamping stable", () => {
    const doc = [
      "* Section",
      "First plain sentence without syntax tokens.",
      "Second plain sentence.",
      "",
      "#+BEGIN_SRC ts",
      "const x = 1;",
      "#+END_SRC",
    ].join("\n");

    const { view } = createLiveView(doc);
    const decorationsFacet = view.state.facet(EditorView.decorations);

    // Cursor move inside First plain sentence -> exact same DecorationSet reference
    const p1 = doc.indexOf("plain sentence");
    view.dispatch({ selection: { anchor: p1 } });
    const deco1 = decorationsFacet[0];
    const decoRef1 = typeof deco1 === "function" ? deco1(view) : deco1;

    view.dispatch({ selection: { anchor: p1 + 5 } });
    const deco2 = view.state.facet(EditorView.decorations)[0];
    const decoRef2 = typeof deco2 === "function" ? deco2(view) : deco2;
    expect(decoRef2).toBe(decoRef1);

    // Typing, deleting, undo, redo
    const insertAt = doc.indexOf("Second");
    view.dispatch({
      changes: { from: insertAt, insert: "*added* " },
      selection: { anchor: insertAt + 8 },
    });
    expect(view.state.doc.toString()).toContain("*added* Second");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toContain("*added* Second");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);

    // Folding heading while cursor is on heading vs body clamping via fold at header
    const headingLinePos = doc.indexOf("* Section");
    view.dispatch({ selection: { anchor: headingLinePos } });
    expect(toggleFoldAtCursor(view)).toBe(true);
    let foldCount = 0;
    const iter = foldedRanges(view.state).iter();
    while (iter.value) {
      foldCount++;
      iter.next();
    }
    expect(foldCount).toBe(1);
    expect(view.state.doc.toString()).toBe(doc);

    // Fold SRC block via cursor on #+BEGIN_SRC line
    expect(toggleFoldAtCursor(view)).toBe(true);
    const srcStart = doc.indexOf("#+BEGIN_SRC");
    view.dispatch({ selection: { anchor: srcStart } });
    expect(toggleFoldAtCursor(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);

    view.destroy();
  });

  it("supports PropertiesWidget modes, inline math delimiter reveal, and clamps cursor on fold indicator click", () => {
    const doc = [
      "* Section",
      ":PROPERTIES:",
      ":ID: prop-live-1",
      ":END:",
      "Math $E=mc^2$ and \\(\\alpha + \\beta\\).",
    ].join("\n");

    // Collapsed mode
    const collapsed = createLiveView(doc, { propertiesDisplay: "collapsed" });
    expect(collapsed.view.dom.querySelector(".org-properties-live.is-collapsed")).toBeTruthy();
    expect(collapsed.view.dom.querySelector(".org-properties-hint")?.textContent).toContain(
      "ID: prop-live-1"
    );
    collapsed.view.destroy();

    // Expanded mode
    const expanded = createLiveView(doc, { propertiesDisplay: "expanded" });
    expect(expanded.view.dom.querySelector(".org-properties-live.is-expanded")).toBeTruthy();
    expect(expanded.view.dom.querySelector(".org-property-value")?.textContent).toBe("prop-live-1");
    expanded.view.destroy();

    // Hidden mode renders minimal chip until cursor enters
    const hidden = createLiveView(doc, { propertiesDisplay: "hidden" });
    expect(hidden.view.dom.querySelector(".org-properties-minimal")).toBeTruthy();
    hidden.view.dispatch({ selection: { anchor: doc.indexOf(":ID:") } });
    expect(hidden.view.dom.querySelector(".org-properties-minimal")).toBeNull();
    expect(hidden.view.dom.querySelector(".org-drawer-line")).toBeTruthy();

    // Inline math delimiter reveal on $...$ and \(...\)
    hidden.view.dispatch({ selection: { anchor: doc.indexOf("E=mc^2") } });
    let mathDelims = Array.from(hidden.view.dom.querySelectorAll(".org-formatting-delim")).map(
      (el) => el.textContent
    );
    expect(mathDelims).toEqual(["$", "$"]);

    hidden.view.dispatch({ selection: { anchor: doc.indexOf("\\alpha") } });
    mathDelims = Array.from(hidden.view.dom.querySelectorAll(".org-formatting-delim")).map(
      (el) => el.textContent
    );
    expect(mathDelims).toEqual(["\\(", "\\)"]);

    // Clicking heading fold indicator while cursor is inside body folds & clamps cursor to heading end
    const headingFoldBtn = hidden.view.dom.querySelector<HTMLElement>(".org-fold-indicator-heading");
    expect(headingFoldBtn).toBeTruthy();
    headingFoldBtn!.click();
    expect(hidden.view.state.selection.main.head).toBe(doc.indexOf("* Section") + "* Section".length);
    expect(hidden.view.state.doc.toString()).toBe(doc);

    hidden.view.destroy();
  });
});
