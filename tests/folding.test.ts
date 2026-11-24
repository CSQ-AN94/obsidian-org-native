import { describe, expect, it } from "vitest";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";
import { createMockApp, attachObsidianDomHelpers } from "./mocks/obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";
import { parseOrgDoc } from "../src/core/parser/parse";
import { buildSectionTree } from "../src/core/parser/sectionTree";
import { renderOrgPreview } from "../src/views/reading/render";
import {
  revealReadingLine,
  setReadingFoldLevel,
  toggleReadingSection,
} from "../src/views/reading/folding";
import {
  computeHeadingFoldRange,
  cycleEditorFold,
  setEditorFoldLevel,
  toggleFoldAtCursor,
  unfoldPos,
} from "../src/views/editor/fold";
import { createOrgEditorState } from "../src/views/editor/orgEditor";

const SAMPLE_DOC = [
  "#+TITLE: Folding Test",
  "#+STARTUP: showall",
  "",
  ":PROPERTIES:",
  ":ID: file-root-001",
  ":END:",
  "",
  "* Top Section A :alpha:",
  ":PROPERTIES:",
  ":ID: node-a-1",
  ":CUSTOM_ID: sec-a",
  ":END:",
  "Body under A with math $E = mc^2$.",
  "",
  "#+BEGIN_SRC org",
  "* Fake heading inside src",
  ":PROPERTIES:",
  ":ID: fake-id-in-src",
  ":END:",
  "#+END_SRC",
  "",
  "** Child A1",
  "Child body line.",
  "",
  "*** Grandchild A1a",
  "Deep content.",
  "",
  "* Top Section B",
  "Body under B.",
].join("\n");

function countFoldedRanges(view: EditorView): number {
  let count = 0;
  const iter = foldedRanges(view.state).iter();
  while (iter.value) {
    count++;
    iter.next();
  }
  return count;
}

describe("Section tree & Reading View folding", () => {
  it("builds nested sections, ignores fake headings in src, and extracts IDs", () => {
    const doc = parseOrgDoc(SAMPLE_DOC);
    const tree = buildSectionTree(doc);

    expect(tree.fileId).toBe("file-root-001");
    expect(tree.sections).toHaveLength(2);
    expect(tree.sections[0].titleText).toBe("Top Section A");
    expect(tree.sections[0].id).toBe("node-a-1");
    expect(tree.sections[0].customId).toBe("sec-a");
    expect(tree.sections[0].children).toHaveLength(1);
    expect(tree.sections[0].children[0].titleText).toBe("Child A1");
    expect(tree.sections[0].children[0].children[0].titleText).toBe("Grandchild A1a");
    expect(tree.sections[1].titleText).toBe("Top Section B");
  });

  it("renders collapsed property drawers with inspectable raw text and folds sections on click", () => {
    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(SAMPLE_DOC, app, "test.org", {
      settings: { ...DEFAULT_SETTINGS, propertiesDisplay: "collapsed" },
    });

    const drawers = root.querySelectorAll<HTMLDetailsElement>("details.org-properties");
    expect(drawers.length).toBeGreaterThanOrEqual(2);
    expect(drawers[0].open).toBe(false);
    expect(root.textContent).toContain(":ID:");
    expect(root.textContent).toContain("node-a-1");

    const topSections = Array.from(
      root.querySelectorAll<HTMLElement>(".markdown-preview-sizer > .org-section")
    );
    expect(topSections).toHaveLength(2);
    const foldBtn = topSections[0].querySelector<HTMLButtonElement>(".org-fold-btn");
    expect(foldBtn).toBeTruthy();

    foldBtn!.click();
    expect(topSections[0].classList.contains("is-folded")).toBe(true);
    expect(foldBtn!.getAttribute("aria-expanded")).toBe("false");

    // Math and code inside folded section remain intact in DOM.
    expect(topSections[0].querySelector(".org-math")?.getAttribute("data-latex")).toBe("E = mc^2");
    expect(topSections[0].querySelector("pre > code.language-org")?.textContent).toContain(
      "* Fake heading inside src"
    );

    foldBtn!.click();
    expect(topSections[0].classList.contains("is-folded")).toBe(false);
    expect(foldBtn!.getAttribute("aria-expanded")).toBe("true");
  });

  it("supports overview, content, all, #+STARTUP, and ancestor reveal", () => {
    const app = createMockApp() as unknown as import("obsidian").App;
    const startupDoc = "#+STARTUP: overview\n* One\nText\n** Sub\nDeep\n* Two\nMore";
    const root = renderOrgPreview(startupDoc, app, "startup.org", {
      settings: { ...DEFAULT_SETTINGS, honorStartup: true },
    });

    const secs = Array.from(root.querySelectorAll<HTMLElement>(".org-section"));
    expect(secs[0].classList.contains("is-folded")).toBe(true);
    expect(secs[2].classList.contains("is-folded")).toBe(true);

    // Reveal deep child line (line 4 -> ** Sub / Deep)
    const revealed = revealReadingLine(root, 4);
    expect(revealed).toBeTruthy();
    expect(secs[0].classList.contains("is-folded")).toBe(false);
    expect(secs[1].classList.contains("is-folded")).toBe(false);

    setReadingFoldLevel(root, "content");
    expect(secs.every((s) => s.classList.contains("is-body-folded"))).toBe(true);

    toggleReadingSection(secs[0]);
    expect(secs[0].classList.contains("is-body-folded")).toBe(false);

    setReadingFoldLevel(root, "all");
    expect(secs.every((s) => !s.classList.contains("is-folded") && !s.classList.contains("is-body-folded"))).toBe(true);
  });
});

describe("CodeMirror 6 heading & subtree folding", () => {
  it("computes heading fold ranges without splitting on * inside src blocks", () => {
    const doc = parseOrgDoc(SAMPLE_DOC);
    const headingLineA = doc.lines.find((l) => l.kind === "heading" && l.text.includes("Top Section A"));
    const headingLineB = doc.lines.find((l) => l.kind === "heading" && l.text.includes("Top Section B"));
    expect(headingLineA).toBeTruthy();
    expect(headingLineB).toBeTruthy();

    const rangeA = computeHeadingFoldRange(doc, headingLineA!.index);
    expect(rangeA).toBeTruthy();
    // Should span all the way to the line before Top Section B (ignoring fake heading inside src).
    expect(rangeA!.to).toBeLessThan(headingLineB!.from);
    expect(SAMPLE_DOC.slice(rangeA!.from, rangeA!.to)).toContain("Deep content.");
    expect(SAMPLE_DOC.slice(rangeA!.from, rangeA!.to)).not.toContain("Top Section B");
  });

  it("folds and unfolds in live and source modes without altering document bytes", () => {
    const app = createMockApp() as unknown as import("obsidian").App;
    const parent = attachObsidianDomHelpers(document.createElement("div"));

    for (const mode of ["live", "source"] as const) {
      const compartment = new Compartment();
      const state = createOrgEditorState(SAMPLE_DOC, {
        app,
        sourcePath: "fold.org",
        displayTitle: "fold",
        settings: DEFAULT_SETTINGS,
        mode,
        livePreviewCompartment: compartment,
        onDocChanged: () => {},
      });
      const view = new EditorView({ state, parent });

      const doc = parseOrgDoc(SAMPLE_DOC);
      const headingLineA = doc.lines.find((l) => l.kind === "heading" && l.text.includes("Top Section A"))!;
      view.dispatch({ selection: { anchor: headingLineA.from } });

      expect(toggleFoldAtCursor(view)).toBe(true);
      expect(countFoldedRanges(view)).toBe(1);
      expect(view.state.doc.toString()).toBe(SAMPLE_DOC);

      expect(toggleFoldAtCursor(view)).toBe(true);
      expect(countFoldedRanges(view)).toBe(0);
      expect(view.state.doc.toString()).toBe(SAMPLE_DOC);

      // Cycle: all -> overview -> content -> all
      expect(cycleEditorFold(view)).toBe(true);
      expect(countFoldedRanges(view)).toBe(2);
      expect(view.state.doc.toString()).toBe(SAMPLE_DOC);

      // Reveal grandchild position inside Top Section A
      const grandchildLine = doc.lines.find((l) => l.text.includes("Grandchild A1a"))!;
      unfoldPos(view, grandchildLine.from + 2);
      expect(countFoldedRanges(view)).toBe(1); // Only Section B stays folded

      expect(cycleEditorFold(view)).toBe(true); // content
      expect(countFoldedRanges(view)).toBeGreaterThanOrEqual(2);
      expect(view.state.doc.toString()).toBe(SAMPLE_DOC);

      setEditorFoldLevel(view, "all");
      expect(countFoldedRanges(view)).toBe(0);
      expect(view.state.doc.toString()).toBe(SAMPLE_DOC);

      view.destroy();
    }
  });
});
