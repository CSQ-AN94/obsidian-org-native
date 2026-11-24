import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TextFileView, TFile, attachObsidianDomHelpers, createMockApp } from "../mocks/obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { FileSyncGuard } from "../../src/core/safety/fileSyncGuard";
import { extractOrgFileIndexData, OrgIdIndex } from "../../src/core/index/orgIdIndex";
import { VaultIndexService } from "../../src/core/index/vaultIndexService";
import {
  createMemoryTransclusionProvider,
  OrgTransclusionEngine,
} from "../../src/core/transclusion";
import { translate, type TranslationKey } from "../../src/i18n";
import { renderOrgPreview } from "../../src/views/reading/render";
import {
  getReadingFoldSnapshot,
  toggleReadingSection,
} from "../../src/views/reading/folding";
import { registerNodeNavigation } from "../../src/views/nodes";
import { OrgView } from "../../src/views/OrgView";
import { isUnsafeUriScheme, openOrgLink } from "../../src/util/links";
import type OrgNativePlugin from "../../src/main";

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function createOrgViewHarness(filePath = "qa/test.org", initialDisk = "") {
  let diskContent = initialDisk;
  const createdFiles = new Map<string, string>();
  const baseApp = createMockApp();
  const app = {
    ...baseApp,
    vault: {
      ...baseApp.vault,
      getAbstractFileByPath: (p: string) =>
        createdFiles.has(p) ? new TFile(p) : p === filePath ? new TFile(filePath) : null,
      create: vi.fn(async (p: string, data: string) => {
        createdFiles.set(p, data);
        return new TFile(p);
      }),
    },
  };

  const leaf = { app };
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, defaultMode: "reading" as const },
    t: (k: string) => k,
  } as unknown as OrgNativePlugin;

  const view = new OrgView(leaf as unknown as import("obsidian").WorkspaceLeaf, plugin);
  view.file = new TFile(filePath) as unknown as import("obsidian").TFile;
  attachObsidianDomHelpers(view.contentEl);

  const saveSpy = vi.spyOn(TextFileView.prototype, "save").mockImplementation(async function (
    this: OrgView
  ) {
    diskContent = this.getViewData();
  });
  const requestSaveSpy = vi.spyOn(TextFileView.prototype, "_mockRequestSave");

  return {
    view,
    app,
    createdFiles,
    saveSpy,
    requestSaveSpy,
    getDisk: () => diskContent,
    setDisk: (next: string) => {
      diskContent = next;
    },
  };
}

const COMPLEX_FIXTURE_LINES = [
  "#+TITLE: Sprint 02 Data Safety & Unknown Syntax Corpus · 回归测试",
  "#+TODO: 待办(t) 进行中(p@) | 完成(d!) 取消(c)",
  "#+STARTUP: showall",
  "#+MY_CUSTOM_KW: custom-arg=preserve --flag",
  "",
  ":PROPERTIES:",
  ":ID: qa-file-root-001",
  ":CUSTOM_ID: qa-root",
  ":END:",
  "",
  "* 待办 [#A] Primary Research Node :tag1:tag2:",
  ":PROPERTIES:",
  ":ID: qa-primary-node-001",
  ":CUSTOM_ID: primary-node",
  ":ROAM_ALIASES: \"主要研究节点\"",
  ":END:",
  "SCHEDULED: <2026-11-25 Wed 14:00 +1w> CLOSED: [2026-11-24 Tue 15:00]",
  ":LOGBOOK:",
  "- State \"DONE\"       from \"TODO\"       [2026-11-24 Tue 09:00]",
  "CLOCK: [2026-11-24 Tue 09:00]--[2026-11-24 Tue 10:15] =>  1:15",
  ":END:",
  "",
  "中文与 English 混排，引用脚注 [fn:1]，行内公式 $E = mc^2$，链接 [[id:remote-target][远程节点]]。",
  "",
  "- [ ] Editable task item",
  "- [X] Completed task item",
  "",
  "#+TRANSCLUDE: [[id:remote-target]] :level 2 :only-contents :exclude-elements \"drawer\"",
  "#+ATTR_LATEX: :width 0.8\\textwidth :options [frame=single]",
  "| Item | Score | Total |",
  "|------+-------+-------|",
  "| <l>  | <c>   | <r>   |",
  "| A    |    10 |    20 |",
  "#+TBLFM: $3=$1+$2::@>$3=vsum(@I..@II)",
  "",
  "#+BEGIN_TIKZ",
  "\\draw (0,0) -- (1,1);",
  "#+END_TIKZ",
  "",
  "#+BEGIN_EXERCISE",
  "Prove convergence under Lipschitz continuity.",
  "#+END_EXERCISE",
  "",
  "** 进行中 Nested Child Heading :subtag:",
  "Child body with inactive timestamp [2026-11-24 Tue 18:30].",
  "",
  "[fn:1] Footnote body with [[https://example.org][external link]].",
  "",
];

const COMPLEX_LF = COMPLEX_FIXTURE_LINES.join("\n");
const COMPLEX_CRLF = COMPLEX_FIXTURE_LINES.join("\r\n");

describe("Sprint 02 QA Regression — LF & CRLF Byte Integrity", () => {
  it.each([
    { label: "LF (\\n)", content: COMPLEX_LF, eol: "\n" },
    { label: "CRLF (\\r\\n)", content: COMPLEX_CRLF, eol: "\r\n" },
  ])(
    "preserves exact $label bytes, zero save() calls, and Reading fold state across open/fold/modes/jump/close",
    async ({ content, eol }) => {
      const initialHash = sha256(content);
      const h = createOrgViewHarness("qa/integrity.org", content);

      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(content, true);

      // Fold via Reading View API + direct section toggle
      h.view.foldLevel("overview");
      h.view.foldLevel("content");
      h.view.foldLevel("all");

      const previewBefore = h.view.contentEl.querySelector<HTMLElement>(".org-preview");
      expect(previewBefore).toBeTruthy();
      const topSection = previewBefore!.querySelector<HTMLElement>(".org-section");
      expect(topSection).toBeTruthy();
      expect(toggleReadingSection(topSection!)).toBe(true);
      const expectedLine = Number(topSection!.dataset.line);

      // Switch reading -> live -> source -> reading
      h.view.setMode("live");
      h.view.foldLevel("overview");
      h.view.setMode("source");
      h.view.foldLevel("content");
      h.view.foldLevel("all");
      h.view.setMode("reading");

      const previewAfter = h.view.contentEl.querySelector<HTMLElement>(".org-preview");
      expect(previewAfter).toBeTruthy();
      const restoredSnapshot = getReadingFoldSnapshot(previewAfter!);
      expect(restoredSnapshot.folded.has(expectedLine)).toBe(true);

      // Jump to deep line & ephemeral state without modifying buffer
      h.view.jumpToLine(30);
      h.view.setEphemeralState({ line: 10 });

      await (h.view as unknown as { onClose(): Promise<void> }).onClose();

      expect(h.saveSpy).not.toHaveBeenCalled();
      expect(h.requestSaveSpy).not.toHaveBeenCalled();
      expect(h.view.syncGuard.isDirty()).toBe(false);
      expect(sha256(h.getDisk())).toBe(initialHash);
      expect(sha256(h.view.getViewData())).toBe(initialHash);
      expect(h.view.getViewData().includes("\r\n")).toBe(eol === "\r\n");
    }
  );

  it("opens every .org file in test-vault read-only across folds and mode switches with zero byte mutation", async () => {
    const vaultDir = path.resolve(process.cwd(), "test-vault");
    const orgFiles = fs
      .readdirSync(vaultDir)
      .filter((f) => f.endsWith(".org"))
      .sort();
    expect(orgFiles.length).toBeGreaterThanOrEqual(5);

    for (const file of orgFiles) {
      const original = fs.readFileSync(path.join(vaultDir, file), "utf8");
      const originalHash = sha256(original);
      const h = createOrgViewHarness(file, original);

      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(original, true);

      h.view.foldLevel("overview");
      h.view.setMode("live");
      h.view.foldLevel("content");
      h.view.setMode("source");
      h.view.foldLevel("all");
      h.view.setMode("reading");
      h.view.jumpToLine(3);

      await (h.view as unknown as { onClose(): Promise<void> }).onClose();

      expect(h.saveSpy).not.toHaveBeenCalled();
      expect(h.requestSaveSpy).not.toHaveBeenCalled();
      expect(sha256(h.getDisk())).toBe(originalHash);
      expect(sha256(h.view.getViewData())).toBe(originalHash);
    }
  });
});

describe("Sprint 02 QA Regression — Emacs External Edit & Conflict Protection", () => {
  it("silently reloads clean CRLF and LF buffers when Emacs updates disk without calling save()", async () => {
    const initialCrlf = "* Heading\r\nInitial body.\r\n";
    const emacsCrlf = "* Heading\r\nUpdated cleanly from Emacs.\r\n** New Sub\r\n";
    const h = createOrgViewHarness("sync/clean.org", initialCrlf);

    await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
    h.view.setViewData(initialCrlf, true);

    h.setDisk(emacsCrlf);
    h.view.setViewData(emacsCrlf, false);

    expect(h.view.getViewData()).toBe(emacsCrlf);
    expect(h.view.syncGuard.isDirty()).toBe(false);
    expect(h.view.syncGuard.isConflicted()).toBe(false);
    expect(h.view.contentEl.textContent).toContain("Updated cleanly from Emacs.");
    expect(h.requestSaveSpy).not.toHaveBeenCalled();

    await (h.view as unknown as { onClose(): Promise<void> }).onClose();
    expect(h.saveSpy).not.toHaveBeenCalled();
    expect(h.getDisk()).toBe(emacsCrlf);
  });

  it("blocks silent overwrite on dirty conflict, survives onClose(), and resolves via reload / keep / saveCopy", async () => {
    const initial = "* Note\r\n- [ ] Task\r\n";
    const localEdit = "* Note\r\n- [ ] Task\r\nUnsaved Obsidian note.\r\n";
    const emacsEdit = "* Note\r\n- [ ] Task\r\nSaved externally by Emacs.\r\n";

    // 1. Conflicted buffer refuses auto-save, blocks further dirty saves, preserves disk on close
    {
      const h = createOrgViewHarness("notes/dirty-close.org", initial);
      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(initial, true);

      h.view.editor!.dispatch({
        changes: { from: 0, to: h.view.editor!.state.doc.length, insert: localEdit.replace(/\r\n/g, "\n") },
      });
      expect(h.view.syncGuard.isDirty()).toBe(true);
      h.saveSpy.mockClear();
      h.requestSaveSpy.mockClear();

      h.setDisk(emacsEdit);
      h.view.setViewData(emacsEdit, false);

      expect(h.view.syncGuard.isConflicted()).toBe(true);
      expect(h.getDisk()).toBe(emacsEdit);
      const banner = h.view.contentEl.querySelector<HTMLElement>(".org-conflict-banner");
      expect(banner).toBeTruthy();
      expect(banner!.classList.contains("is-hidden")).toBe(false);
      expect(banner!.querySelector(".org-conflict-btn-reload")).toBeTruthy();
      expect(banner!.querySelector(".org-conflict-btn-keep")).toBeTruthy();
      expect(banner!.querySelector(".org-conflict-btn-copy")).toBeTruthy();

      // Additional edit while conflicted must stay blocked from saving
      h.view.editor!.dispatch({
        changes: { from: h.view.editor!.state.doc.length, insert: "More local typing\n" },
      });
      expect(h.requestSaveSpy).not.toHaveBeenCalled();
      expect(h.getDisk()).toBe(emacsEdit);

      // Explicit save() while conflicted must also be blocked
      await h.view.save();
      expect(h.saveSpy).not.toHaveBeenCalled();
      expect(h.getDisk()).toBe(emacsEdit);

      // Closing while conflicted must NOT write over Emacs disk content
      await (h.view as unknown as { onClose(): Promise<void> }).onClose();
      expect(h.saveSpy).not.toHaveBeenCalled();
      expect(h.getDisk()).toBe(emacsEdit);
    }

    // 2. Action: Reload from disk
    {
      const h = createOrgViewHarness("notes/reload.org", initial);
      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(initial, true);

      h.view.editor!.dispatch({
        changes: { from: 0, to: h.view.editor!.state.doc.length, insert: localEdit.replace(/\r\n/g, "\n") },
      });
      h.setDisk(emacsEdit);
      h.view.setViewData(emacsEdit, false);

      h.view.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-reload")!.click();

      expect(h.view.getViewData()).toBe(emacsEdit);
      expect(h.getDisk()).toBe(emacsEdit);
      expect(h.view.syncGuard.isConflicted()).toBe(false);
      expect(h.view.syncGuard.isDirty()).toBe(false);
      expect(
        h.view.contentEl.querySelector(".org-conflict-banner")?.classList.contains("is-hidden")
      ).toBe(true);
      await (h.view as unknown as { onClose(): Promise<void> }).onClose();
    }

    // 3. Action: Keep local & save explicitly (and ignore subsequent Obsidian save echo)
    {
      const h = createOrgViewHarness("notes/keep.org", initial);
      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(initial, true);

      h.view.editor!.dispatch({
        changes: { from: 0, to: h.view.editor!.state.doc.length, insert: localEdit.replace(/\r\n/g, "\n") },
      });
      h.saveSpy.mockClear();

      h.setDisk(emacsEdit);
      h.view.setViewData(emacsEdit, false);

      h.view.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-keep")!.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(h.getDisk()).toBe(localEdit);
      expect(h.view.syncGuard.isConflicted()).toBe(false);
      expect(h.view.syncGuard.isDirty()).toBe(false);
      expect(
        h.view.contentEl.querySelector(".org-conflict-banner")?.classList.contains("is-hidden")
      ).toBe(true);

      // Save echo from Obsidian watcher should be ignored cleanly
      h.view.setViewData(localEdit, false);
      expect(h.view.syncGuard.isConflicted()).toBe(false);
      expect(h.view.getViewData()).toBe(localEdit);
      await (h.view as unknown as { onClose(): Promise<void> }).onClose();
    }

    // 4. Action: Save conflict copy & reload disk (including timestamp collision suffixing)
    {
      const h = createOrgViewHarness("sub/conflict.org", initial);
      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(initial, true);

      h.view.editor!.dispatch({
        changes: { from: 0, to: h.view.editor!.state.doc.length, insert: localEdit.replace(/\r\n/g, "\n") },
      });
      h.setDisk(emacsEdit);
      h.view.setViewData(emacsEdit, false);

      h.view.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-copy")!.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(h.createdFiles.size).toBe(1);
      const [[copyPath, copyContent]] = Array.from(h.createdFiles.entries());
      expect(copyPath).toMatch(/^sub\/conflict\.conflict-\d{8}-\d{6}\.org$/);
      expect(copyContent).toBe(localEdit);
      expect(h.getDisk()).toBe(emacsEdit);
      expect(h.view.getViewData()).toBe(emacsEdit);
      expect(h.view.syncGuard.isConflicted()).toBe(false);
      expect(h.view.syncGuard.isDirty()).toBe(false);
      await (h.view as unknown as { onClose(): Promise<void> }).onClose();
    }
  });

  it("clears dirty state when reverted to disk content and handles post-echo external updates", () => {
    const guard = new FileSyncGuard();
    guard.reset("v1");

    expect(guard.onLocalEdit("v2")).toEqual({ shouldSave: true, blockedByConflict: false });
    expect(guard.isDirty()).toBe(true);

    // User undoes edit back to exact disk content
    expect(guard.onLocalEdit("v1")).toEqual({ shouldSave: false, blockedByConflict: false });
    expect(guard.isDirty()).toBe(false);

    // Subsequent external edit reloads cleanly without conflict
    expect(guard.onDiskUpdate("v-emacs", "v1", false)).toEqual({
      action: "reload-external",
      content: "v-emacs",
    });

    // Save echo followed by later external edit
    expect(guard.onLocalEdit("v-local")).toEqual({ shouldSave: true, blockedByConflict: false });
    expect(guard.prepareSave("v-local")).toEqual({ allowSave: true, content: "v-local" });
    expect(guard.onDiskUpdate("v-local", "v-local", false)).toEqual({ action: "ignore-echo" });
    expect(guard.onDiskUpdate("v-emacs-next", "v-local", false)).toEqual({
      action: "reload-external",
      content: "v-emacs-next",
    });
  });
});

describe("Sprint 02 QA Regression — Unknown Org Syntax Preservation on Edit", () => {
  it("preserves every untouched byte and CRLF line ending when toggling a checkbox", async () => {
    const h = createOrgViewHarness("qa/unknown-checkbox.org", COMPLEX_CRLF);
    await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
    h.view.setViewData(COMPLEX_CRLF, true);

    const checkbox = h.view.contentEl.querySelector<HTMLInputElement>("input.org-task-checkbox");
    expect(checkbox).toBeTruthy();
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event("change"));

    expect(h.requestSaveSpy).toHaveBeenCalledTimes(1);
    await h.view.save();

    const saved = h.getDisk();
    const expected = COMPLEX_CRLF.replace("- [ ] Editable task item", "- [X] Editable task item");
    expect(saved).toBe(expected);

    const origLines = COMPLEX_CRLF.split("\r\n");
    const savedLines = saved.split("\r\n");
    expect(savedLines).toHaveLength(origLines.length);

    let changedCount = 0;
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i] !== savedLines[i]) {
        changedCount++;
        expect(origLines[i]).toBe("- [ ] Editable task item");
        expect(savedLines[i]).toBe("- [X] Editable task item");
      }
    }
    expect(changedCount).toBe(1);

    for (const token of [
      "#+ATTR_LATEX: :width 0.8\\textwidth :options [frame=single]",
      "#+TBLFM: $3=$1+$2::@>$3=vsum(@I..@II)",
      ":LOGBOOK:",
      "CLOCK: [2026-11-24 Tue 09:00]--[2026-11-24 Tue 10:15] =>  1:15",
      "#+BEGIN_TIKZ",
      "#+BEGIN_EXERCISE",
      "#+MY_CUSTOM_KW: custom-arg=preserve --flag",
      ":tag1:tag2:",
      "[fn:1]",
      "<2026-11-25 Wed 14:00 +1w>",
      "[2026-11-24 Tue 15:00]",
      "[2026-11-24 Tue 18:30]",
      "#+TRANSCLUDE: [[id:remote-target]] :level 2 :only-contents :exclude-elements \"drawer\"",
      ":ID: qa-primary-node-001",
    ]) {
      expect(saved).toContain(token);
    }

    await (h.view as unknown as { onClose(): Promise<void> }).onClose();
  });

  it("preserves unknown blocks, drawers, formulas, and CRLF endings when editing a headline in Live Preview", async () => {
    const h = createOrgViewHarness("qa/unknown-heading.org", COMPLEX_CRLF);
    await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
    h.view.setViewData(COMPLEX_CRLF, true);
    h.view.setMode("live");

    const editorText = h.view.editor!.state.doc.toString();
    const target = "Primary Research Node";
    const from = editorText.indexOf(target);
    expect(from).toBeGreaterThan(0);

    h.view.editor!.dispatch({
      changes: { from, to: from + target.length, insert: "Edited Research Node" },
      userEvent: "input",
    });
    expect(h.requestSaveSpy).toHaveBeenCalledTimes(1);
    await h.view.save();

    const saved = h.getDisk();
    expect(saved).toBe(COMPLEX_CRLF.replace(target, "Edited Research Node"));
    expect(saved.match(/\r\n/g)?.length).toBe(COMPLEX_CRLF.match(/\r\n/g)?.length);
    expect(saved).toContain("* 待办 [#A] Edited Research Node :tag1:tag2:");
    expect(saved).toContain("#+BEGIN_TIKZ");
    expect(saved).toContain("#+BEGIN_EXERCISE");
    expect(saved).toContain("#+TBLFM: $3=$1+$2::@>$3=vsum(@I..@II)");
    expect(saved).toContain(":LOGBOOK:");

    await (h.view as unknown as { onClose(): Promise<void> }).onClose();
  });
});

describe("Sprint 02 QA Regression — OrgIdIndex Lifecycle, Moves & Diagnostics", () => {
  it("tracks headingPath, endLine, link vs transclude relations, duplicates, node moves, renames, and deletes", () => {
    const index = new OrgIdIndex();

    const alphaDoc = [
      ":PROPERTIES:",
      ":ID: alpha-file-id",
      ":END:",
      "#+TITLE: Alpha Root",
      "",
      "* Top Pillar",
      "** Sub Pillar",
      "*** Leaf Target",
      ":PROPERTIES:",
      ":ID: leaf-target-id",
      ":CUSTOM_ID: leaf-custom",
      ":END:",
      "Leaf body text.",
      "* Sibling Section",
      "Sibling text.",
    ].join("\n");

    const refDoc = [
      "* References",
      "Standard link [[id:leaf-target-id][Leaf Ref]].",
      "#+TRANSCLUDE: [[id:leaf-target-id]] :level 2 :only-contents",
      "Also broken [[id:ghost-node-999][Ghost]].",
    ].join("\n");

    const dupOne = "* Dup One\n:PROPERTIES:\n:ID: shared-dup-id\n:END:\n";
    const dupTwo = "* Dup Two\n:PROPERTIES:\n:ID: shared-dup-id\n:END:\n";

    index.upsertFile("notes/alpha.org", alphaDoc);
    index.upsertFile("notes/refs.org", refDoc);
    index.upsertFile("z/dup1.org", dupOne);
    index.upsertFile("a/dup2.org", dupTwo);

    // headingPath & endLine bounds
    const fileRes = index.resolveId("alpha-file-id");
    expect(fileRes.status).toBe("found");
    if (fileRes.status === "found") {
      expect(fileRes.node.headingPath).toEqual([]);
      expect(fileRes.node.line).toBe(0);
      expect(fileRes.node.endLine).toBe(alphaDoc.split("\n").length - 1);
    }

    const leafRes = index.resolveId("leaf-target-id");
    expect(leafRes.status).toBe("found");
    if (leafRes.status === "found") {
      expect(leafRes.node.headingPath).toEqual(["Top Pillar", "Sub Pillar", "Leaf Target"]);
      expect(leafRes.node.line).toBe(7);
      expect(leafRes.node.endLine).toBe(12); // Stops cleanly before "* Sibling Section" (line 13)
    }

    // Backlink relations: "link" vs "transclude"
    const backlinks = index.getBacklinks("leaf-target-id");
    expect(backlinks).toHaveLength(2);
    expect(backlinks.map((b) => ({ line: b.line, relation: b.relation }))).toEqual([
      { line: 1, relation: "link" },
      { line: 2, relation: "transclude" },
    ]);

    // Deterministic duplicate ordering (by filePath then line)
    expect(index.getNodeStatus("shared-dup-id")).toBe("duplicate");
    const dupRes = index.resolveId("shared-dup-id");
    expect(dupRes.status).toBe("duplicate");
    if (dupRes.status === "duplicate") {
      expect(dupRes.nodes.map((n) => n.filePath)).toEqual(["a/dup2.org", "z/dup1.org"]);
    }

    // Rename dup file updates duplicate paths and backlink sourcePath
    index.renameFile("z/dup1.org", "b/dup1-renamed.org");
    index.renameFile("notes/refs.org", "notes/refs-renamed.org");
    expect(index.getDuplicateIds()[0].nodes.map((n) => n.filePath)).toEqual([
      "a/dup2.org",
      "b/dup1-renamed.org",
    ]);
    expect(index.getBacklinks("leaf-target-id").every((b) => b.sourcePath === "notes/refs-renamed.org")).toBe(true);

    // Resolve duplicate by modifying b/dup1-renamed.org
    index.upsertFile("b/dup1-renamed.org", "* No Longer Dup\n:PROPERTIES:\n:ID: unique-b-id\n:END:\n");
    expect(index.getDuplicateIds()).toHaveLength(0);
    expect(index.resolveId("shared-dup-id").status).toBe("found");

    // Move Leaf Target from notes/alpha.org into archive/2026.org
    const movedNodeBlock = [
      "** Archived Leaf Target",
      ":PROPERTIES:",
      ":ID: leaf-target-id",
      ":END:",
      "Moved safely.",
    ].join("\n");
    index.upsertFile("notes/alpha.org", "* Top Pillar\nLeaf moved out.\n");
    index.upsertFile("archive/2026.org", `* 2026 Archive\n${movedNodeBlock}\n`);

    const movedRes = index.resolveId("leaf-target-id");
    expect(movedRes.status).toBe("found");
    if (movedRes.status === "found") {
      expect(movedRes.node.filePath).toBe("archive/2026.org");
      expect(movedRes.node.line).toBe(1);
      expect(movedRes.node.headingPath).toEqual(["2026 Archive", "Archived Leaf Target"]);
    }
    expect(index.getBacklinks("leaf-target-id")).toHaveLength(2);
    expect(index.getBrokenIdLinks().map((b) => b.link.targetId)).toEqual(["ghost-node-999"]);

    // Deleting archive/2026.org marks remaining refs as broken; deleting refs file clears stale broken links
    index.removeFile("archive/2026.org");
    expect(index.resolveId("leaf-target-id").status).toBe("missing");
    expect(index.getBrokenIdLinks().map((b) => b.link.targetId)).toEqual([
      "leaf-target-id",
      "leaf-target-id",
      "ghost-node-999",
    ]);

    index.removeFile("notes/refs-renamed.org");
    expect(index.getBacklinks("leaf-target-id")).toHaveLength(0);
    expect(index.getBrokenIdLinks()).toHaveLength(0);
  });
});

describe("Sprint 02 QA Regression — Fake ID & Fake Transclude Immunity", () => {
  it("never indexes fake IDs/links/transcludes and never emits .org-transclude-slot for protected contexts", async () => {
    const immunityDoc = [
      "* Real Section",
      ":PROPERTIES:",
      ":ID: real-immunity-node",
      ":END:",
      "Real body link [[id:real-link-target][Real Link]].",
      "#+TRANSCLUDE: [[id:real-transclude-target]] :level 2",
      "",
      "Inline ~#+transclude: [[id:fake-verbatim-transclude]]~ and =[[id:fake-code-link]]= and ~[[id:fake-verbatim-link]]~.",
      "",
      "Single-line math $$#+transclude: [[id:fake-math-single-transclude]] [[id:fake-math-single-link]]$$.",
      "",
      "$$",
      ":PROPERTIES:",
      ":ID: fake-math-multiline-id",
      ":END:",
      "#+transclude: [[id:fake-math-multiline-transclude]]",
      "[[id:fake-math-multiline-link]]",
      "$$",
      "",
      "#+BEGIN_SRC org",
      "* Fake Heading In Src",
      ":PROPERTIES:",
      ":ID: fake-src-id",
      ":END:",
      "#+transclude: [[id:fake-src-transclude]]",
      "[[id:fake-src-link]]",
      "#+END_SRC",
      "",
      "#+BEGIN_EXAMPLE",
      ":PROPERTIES:",
      ":ID: fake-example-id",
      ":END:",
      "#+transclude: [[id:fake-example-transclude]]",
      "[[id:fake-example-link]]",
      "#+END_EXAMPLE",
      "",
      "#+BEGIN_COMMENT",
      ":PROPERTIES:",
      ":ID: fake-comment-block-id",
      ":END:",
      "#+transclude: [[id:fake-comment-block-transclude]]",
      "[[id:fake-comment-block-link]]",
      "#+END_COMMENT",
      "",
      "# #+transclude: [[id:fake-hash-comment-transclude]] [[id:fake-hash-comment-link]]",
    ].join("\n");

    const extracted = extractOrgFileIndexData("immunity.org", immunityDoc);
    expect(extracted.nodes.map((n) => n.id)).toEqual(["real-immunity-node"]);
    expect(
      extracted.links.map((l) => ({ targetId: l.targetId, relation: l.relation }))
    ).toEqual([
      { targetId: "real-link-target", relation: "link" },
      { targetId: "real-transclude-target", relation: "transclude" },
    ]);

    const index = new OrgIdIndex();
    index.upsertFile("immunity.org", immunityDoc);
    for (const fakeId of [
      "fake-verbatim-transclude",
      "fake-code-link",
      "fake-verbatim-link",
      "fake-math-single-transclude",
      "fake-math-single-link",
      "fake-math-multiline-id",
      "fake-math-multiline-transclude",
      "fake-math-multiline-link",
      "fake-src-id",
      "fake-src-transclude",
      "fake-src-link",
      "fake-example-id",
      "fake-example-transclude",
      "fake-example-link",
      "fake-comment-block-id",
      "fake-comment-block-transclude",
      "fake-comment-block-link",
      "fake-hash-comment-transclude",
      "fake-hash-comment-link",
    ]) {
      expect(index.resolveId(fakeId).status).toBe("missing");
      expect(index.getBacklinks(fakeId)).toHaveLength(0);
    }

    // Also render document with ONLY fake transcludes in Reading View to assert 0 .org-transclude-slot
    const fakeOnlyDoc = immunityDoc
      .split("\n")
      .filter((line) => !line.startsWith("#+TRANSCLUDE: [[id:real-transclude-target]]"))
      .join("\n");
    const app = createMockApp() as unknown as import("obsidian").App;
    const preview = renderOrgPreview(fakeOnlyDoc, app, "immunity.org", {
      settings: DEFAULT_SETTINGS,
      resolveIdStatus: (id) => index.getNodeStatus(id),
    });

    expect(preview.querySelectorAll(".org-transclude-slot")).toHaveLength(0);
    expect(
      Array.from(preview.querySelectorAll<HTMLAnchorElement>("a.org-link-id")).map(
        (a) => a.dataset.orgId
      )
    ).toEqual(["real-link-target"]);

    // Literal source preservation inside code, example, verbatim, and math elements
    expect(preview.querySelector("pre > code.language-org")?.textContent).toContain(
      "#+transclude: [[id:fake-src-transclude]]"
    );
    expect(preview.querySelector("pre.org-example")?.textContent).toContain(
      "#+transclude: [[id:fake-example-transclude]]"
    );
    const verbatimTexts = Array.from(preview.querySelectorAll("code.org-verbatim")).map(
      (el) => el.textContent
    );
    expect(verbatimTexts).toContain("#+transclude: [[id:fake-verbatim-transclude]]");
    expect(verbatimTexts).toContain("[[id:fake-code-link]]");
    expect(verbatimTexts).toContain("[[id:fake-verbatim-link]]");
    const mathLatex = Array.from(preview.querySelectorAll<HTMLElement>(".org-math")).map(
      (el) => el.dataset.latex ?? ""
    );
    expect(mathLatex.some((s) => s.includes("fake-math-single-transclude"))).toBe(true);
    expect(mathLatex.some((s) => s.includes("fake-math-multiline-transclude"))).toBe(true);

    // Comment lines/blocks remain preserved byte-for-byte in OrgView
    const h = createOrgViewHarness("immunity.org", immunityDoc);
    await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
    h.view.setViewData(immunityDoc, true);
    await (h.view as unknown as { onClose(): Promise<void> }).onClose();
    expect(h.view.getViewData()).toBe(immunityDoc);
  });
});

describe("Sprint 02 QA Regression — Untrusted HTML, XSS & URI Hardening", () => {
  it("neutralizes script/iframe/img/svg/raw-anchor payloads and obfuscated URI schemes in Reading View", () => {
    const hostileDoc = [
      "* Unsafe <script>alert(0)</script> Heading",
      "",
      '<script>alert("xss")</script>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<img src=x onerror="alert(1)">',
      '<svg onload="alert(1)"><circle cx="10" cy="10" r="5" /></svg>',
      '<a href="javascript:alert(1)">Raw JS Anchor</a>',
      '<object data="javascript:alert(1)"></object>',
      '<embed src="data:text/html,<script>alert(1)</script>">',
      "",
      "| Col | Payload |",
      "|-----+---------|",
      '| X   | <img src=x onerror="alert(2)"> [[java\tscript:alert(1)][Table Tab JS]] |',
      "",
      "- [[javascript:alert(1)][Direct JS]]",
      "- [[java\tscript:alert(1)][Tab Obfuscated JS]]",
      "- [[ \u0001j\u0000avascript:alert(1)][Control Char JS]]",
      "- [[vbscript:msgbox(1)][VBScript]]",
      "- [[data:text/html,<script>alert(1)</script>][Data HTML]]",
      "- [[data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==][Data Base64]]",
      "- [[https://example.org/docs][Safe External Link]]",
    ].join("\n");

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(hostileDoc, app, "xss.org", { settings: DEFAULT_SETTINGS });

    expect(root.querySelectorAll("script, iframe, object, embed, style, svg")).toHaveLength(0);

    // Zero inline event handler attributes anywhere in rendered DOM
    const allElements = Array.from(root.querySelectorAll("*"));
    for (const el of allElements) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
      }
    }

    // Zero dangerous href/src values (even ignoring control characters / whitespace)
    for (const el of root.querySelectorAll("a[href], img[src]")) {
      const rawUrl = el.getAttribute("href") ?? el.getAttribute("src") ?? "";
      const normalized = rawUrl.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
      expect(normalized.startsWith("javascript:")).toBe(false);
      expect(normalized.startsWith("vbscript:")).toBe(false);
      expect(normalized.startsWith("data:")).toBe(false);
    }

    // All 7 unsafe Org links (1 in table + 6 in list) rendered as .org-link-unsafe
    expect(root.querySelectorAll(".org-link-unsafe")).toHaveLength(7);

    // Safe external link remains intact
    const safeLinks = Array.from(root.querySelectorAll<HTMLAnchorElement>("a.external-link"));
    expect(safeLinks.map((a) => a.getAttribute("href"))).toEqual(["https://example.org/docs"]);
  });

  it("blocks obfuscated unsafe URI schemes in isUnsafeUriScheme and openOrgLink", () => {
    const unsafePayloads = [
      "javascript:alert(1)",
      "java\tscript:alert(1)",
      " \u0000j\u0001avascript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "\nDATA:text/html;base64,AAAA",
    ];

    const baseApp = createMockApp();
    const openLinkTextSpy = vi.spyOn(baseApp.workspace, "openLinkText");
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    try {
      for (const payload of unsafePayloads) {
        expect(isUnsafeUriScheme(payload)).toBe(true);
        openOrgLink(
          baseApp as unknown as import("obsidian").App,
          payload,
          "xss.org"
        );
      }
      expect(openLinkTextSpy).not.toHaveBeenCalled();
      expect(windowOpenSpy).not.toHaveBeenCalled();
    } finally {
      windowOpenSpy.mockRestore();
    }
  });
});

describe("Sprint 02 Integrated End-to-End (OrgView + VaultIndex + Transclusion + Node Navigation)", () => {
  const flushAsync = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

  function createIntegratedHarness(
    initialFiles: Record<string, string>,
    hostPath: string
  ) {
    const files = new Map<string, string>(Object.entries(initialFiles));
    const vaultHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const registeredViews = new Map<string, unknown>();
    const registeredCommands: Array<{ id: string; name: string }> = [];

    const baseApp = createMockApp();
    const app = {
      ...baseApp,
      workspace: {
        ...baseApp.workspace,
        on: vi.fn(() => ({})),
        offref: vi.fn(),
        detachLeavesOfType: vi.fn(),
      },
      vault: {
        ...baseApp.vault,
        getFiles: () => Array.from(files.keys()).map((p) => new TFile(p)),
        getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p) : null),
        cachedRead: vi.fn(async (file: TFile) => files.get(file.path) ?? ""),
        create: vi.fn(async (p: string, data: string) => {
          files.set(p, data);
          return new TFile(p);
        }),
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          const list = vaultHandlers.get(event) ?? [];
          list.push(cb);
          vaultHandlers.set(event, list);
          return { event, cb };
        }),
      },
    };

    const plugin = {
      app,
      settings: {
        ...DEFAULT_SETTINGS,
        defaultMode: "reading" as const,
        enableTransclusion: true,
        transclusionMaxDepth: 4,
      },
      uiLanguage: "en" as const,
      t: (k: TranslationKey) => translate("en", k),
      registerEvent: vi.fn(),
      registerView: vi.fn((type: string, factory: unknown) => {
        registeredViews.set(type, factory);
      }),
      addCommand: vi.fn((cmd: { id: string; name: string }) => {
        registeredCommands.push({ id: cmd.id, name: cmd.name });
      }),
    } as unknown as OrgNativePlugin;

    const vaultIndex = new VaultIndexService(
      app as unknown as import("obsidian").App,
      plugin,
      { debounceMs: 5 }
    );
    for (const [p, content] of files.entries()) {
      vaultIndex.index.upsertFile(p, content);
    }
    plugin.vaultIndex = vaultIndex;
    plugin.transclusionEngine = new OrgTransclusionEngine(
      createMemoryTransclusionProvider(files, vaultIndex.index),
      { defaultMaxDepth: plugin.settings.transclusionMaxDepth }
    );
    plugin.nodeNavigation = registerNodeNavigation({
      plugin: plugin as unknown as Parameters<typeof registerNodeNavigation>[0]["plugin"],
      vaultIndex,
    });

    const leaf = { app };
    const view = new OrgView(leaf as unknown as import("obsidian").WorkspaceLeaf, plugin);
    view.file = new TFile(hostPath) as unknown as import("obsidian").TFile;
    attachObsidianDomHelpers(view.contentEl);

    const saveSpy = vi.spyOn(TextFileView.prototype, "save").mockResolvedValue();

    const triggerVaultEvent = (event: string, ...args: unknown[]) => {
      for (const cb of vaultHandlers.get(event) ?? []) {
        cb(...args);
      }
    };

    return {
      app,
      plugin,
      vaultIndex,
      view,
      files,
      registeredViews,
      registeredCommands,
      saveSpy,
      triggerVaultEvent,
    };
  }

  it("hydrates nested, cycle-guarded, read-only, XSS-sanitized transclusions inside OrgView without mutating any source", async () => {
    const initialFiles: Record<string, string> = {
      "host.org": [
        "#+TITLE: Host Composition",
        "",
        "* Section A",
        "#+TRANSCLUDE: [[id:nested-parent]] :level 2",
        "#+TRANSCLUDE: [[id:cycle-a]]",
        "#+TRANSCLUDE: [[id:xss-node]]",
      ].join("\n"),
      "nodes.org": [
        "* Nested Parent",
        ":PROPERTIES:",
        ":ID: nested-parent",
        ":END:",
        "- [ ] Transcluded task must be read-only",
        "#+TRANSCLUDE: [[id:leaf-node]] :level 3",
        "",
        "* Leaf Node",
        ":PROPERTIES:",
        ":ID: leaf-node",
        ":END:",
        "Deep leaf knowledge with [[id:nested-parent][back link]].",
        "",
        "* Cycle A",
        ":PROPERTIES:",
        ":ID: cycle-a",
        ":END:",
        "#+TRANSCLUDE: [[id:cycle-b]]",
        "",
        "* Cycle B",
        ":PROPERTIES:",
        ":ID: cycle-b",
        ":END:",
        "#+TRANSCLUDE: [[id:cycle-a]]",
        "",
        "* XSS Hostile Node",
        ":PROPERTIES:",
        ":ID: xss-node",
        ":END:",
        '<script>alert("xss")</script>',
        '<img src="x" onerror="alert(1)">',
        "[[javascript:alert(1)][Unsafe Transcluded Link]]",
      ].join("\n"),
    };

    const hostHash = sha256(initialFiles["host.org"]);
    const nodesHash = sha256(initialFiles["nodes.org"]);
    const h = createIntegratedHarness(initialFiles, "host.org");

    await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
    h.view.setViewData(initialFiles["host.org"], true);
    await flushAsync();

    const preview = h.view.contentEl.querySelector<HTMLElement>(".org-preview");
    expect(preview).toBeTruthy();

    // Nested expansion succeeded
    expect(preview!.textContent).toContain("Deep leaf knowledge");
    // Read-only checkbox enforcement inside transcluded DOM
    const transcludedCheckboxes = Array.from(
      preview!.querySelectorAll<HTMLInputElement>(".org-transclusion input[type='checkbox']")
    );
    expect(transcludedCheckboxes.length).toBeGreaterThanOrEqual(1);
    for (const cb of transcludedCheckboxes) {
      expect(cb.disabled).toBe(true);
    }

    // Cycle A <-> Cycle B stopped safely with cycle status callout
    const cycleError = preview!.querySelector<HTMLElement>(
      ".org-transclusion-error[data-transclusion-status='cycle']"
    );
    expect(cycleError).toBeTruthy();

    // XSS stripped inside transcluded body
    expect(preview!.querySelectorAll("script")).toHaveLength(0);
    expect(preview!.querySelectorAll("[onerror]")).toHaveLength(0);
    expect(preview!.querySelectorAll(".org-transclusion .org-link-unsafe")).toHaveLength(1);

    await (h.view as unknown as { onClose(): Promise<void> }).onClose();
    h.plugin.nodeNavigation.dispose();

    // Source files remained completely unmutated
    expect(h.saveSpy).not.toHaveBeenCalled();
    expect(sha256(h.files.get("host.org")!)).toBe(hostHash);
    expect(sha256(h.files.get("nodes.org")!)).toBe(nodesHash);
    expect(sha256(h.view.getViewData())).toBe(hostHash);
  });

  it("refreshes OrgView transclusions automatically when a referenced source file changes externally", async () => {
    const initialFiles: Record<string, string> = {
      "consumer.org": "#+TITLE: Consumer\n\n#+TRANSCLUDE: [[id:source-atom]] :level 1\n",
      "source.org": [
        "* Atomic Knowledge",
        ":PROPERTIES:",
        ":ID: source-atom",
        ":END:",
        "Original transcluded version v1.",
      ].join("\n"),
    };

    const h = createIntegratedHarness(initialFiles, "consumer.org");
    await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
    h.view.setViewData(initialFiles["consumer.org"], true);
    await flushAsync();

    expect(h.view.contentEl.textContent).toContain("Original transcluded version v1.");

    // Simulate external Emacs edit to source.org
    const updatedSource = initialFiles["source.org"].replace(
      "Original transcluded version v1.",
      "Updated externally in Emacs v2."
    );
    h.files.set("source.org", updatedSource);
    h.vaultIndex.upsertContent("source.org", updatedSource);
    h.triggerVaultEvent("modify", new TFile("source.org"));
    await flushAsync();

    expect(h.view.contentEl.textContent).toContain("Updated externally in Emacs v2.");
    expect(h.view.syncGuard.isDirty()).toBe(false);
    expect(h.saveSpy).not.toHaveBeenCalled();

    await (h.view as unknown as { onClose(): Promise<void> }).onClose();
    h.plugin.nodeNavigation.dispose();
  });

  it("wires registerNodeNavigation commands, views, and hover preview inside OrgView cleanly", async () => {
    const initialFiles: Record<string, string> = {
      "viewer.org": "* Viewer\nSee [[id:hover-target][Hover Target]].\n",
      "target.org": "* Hover Target\n:PROPERTIES:\n:ID: hover-target\n:END:\nPreview body line.\n",
    };

    const h = createIntegratedHarness(initialFiles, "viewer.org");
    expect(h.registeredViews.has("org-native-backlinks")).toBe(true);
    expect(h.registeredCommands.map((c) => c.id)).toEqual(
      expect.arrayContaining(["quick-open-node", "open-backlinks"])
    );

    await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
    h.view.setViewData(initialFiles["viewer.org"], true);
    await flushAsync();

    const preview = h.view.contentEl.querySelector<HTMLElement>(".org-preview");
    expect(preview).toBeTruthy();

    // Verify immediate hover preview works against rendered preview links and disposes cleanly
    const popoverHost = document.createElement("div");
    const disposeHover = h.plugin.nodeNavigation.attachHoverPreview(preview!, {
      hoverDelayMs: 0,
      container: popoverHost,
    });
    const link = preview!.querySelector<HTMLAnchorElement>("a.org-link-id[data-org-id='hover-target']");
    expect(link).toBeTruthy();
    link!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await flushAsync();

    const popover = popoverHost.querySelector<HTMLElement>(".org-node-hover-popover");
    expect(popover).toBeTruthy();
    expect(popover?.textContent).toContain("Preview body line.");

    disposeHover();
    expect(popoverHost.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);

    await (h.view as unknown as { onClose(): Promise<void> }).onClose();
    h.plugin.nodeNavigation.dispose();
  });
});
