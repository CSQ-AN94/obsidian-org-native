import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TextFileView, TFile, attachObsidianDomHelpers, createMockApp } from "./mocks/obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FileSyncGuard } from "../src/core/safety/fileSyncGuard";
import { renderOrgPreview } from "../src/views/reading/render";
import { setReadingFoldLevel } from "../src/views/reading/folding";
import { OrgView } from "../src/views/OrgView";
import type OrgNativePlugin from "../src/main";

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function createHarness(filePath = "notes/test.org", initialDisk = "") {
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

const COMPLEX_ORG = [
  "#+TITLE: Data Safety Corpus · 数据安全测试",
  "#+TODO: 待办 | 完成",
  "#+TRANSCLUDE: [[id:remote-node-1]] :level 2 :only-contents",
  "",
  "* 待办 主章节 :研究:",
  ":PROPERTIES:",
  ":ID: safety-node-001",
  ":CUSTOM_ID: main-sec",
  ":CREATED: [2026-11-24 Tue 15:00]",
  ":END:",
  "SCHEDULED: <2026-11-25 Wed>",
  "",
  "中文与 English 混排，$E = mc^2$，以及 [[id:other-node][跨文件节点]]。",
  "",
  "- [ ] 未完成任务",
  "- [X] 已完成任务",
  "",
  "#+ATTR_HTML: :align center",
  "| Col1 | Col2 |",
  "|------+------|",
  "| <l>  | <r>  |",
  "| A    | 100  |",
  "",
  "#+BEGIN_SRC python",
  "def keep_intact():",
  "    return '* not a heading'",
  "#+END_SRC",
  "",
  "#+BEGIN_MY_CUSTOM_BLOCK",
  "must stay untouched",
  "#+END_MY_CUSTOM_BLOCK",
].join("\r\n");

describe("Data integrity, Emacs external-edit conflict safety, and XSS hardening", () => {
  it("never modifies bytes or calls save() during read-only open, fold, mode switches, and close", async () => {
    const initialHash = sha256(COMPLEX_ORG);
    const h = createHarness("corpus.org", COMPLEX_ORG);

    await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
    h.view.setViewData(COMPLEX_ORG, true);

    // Fold and unfold in reading mode, then switch reading -> live -> source -> reading
    h.view.foldLevel("overview");
    h.view.foldLevel("content");
    h.view.foldLevel("all");

    const preview = h.view.contentEl.querySelector<HTMLElement>(".org-preview");
    expect(preview).toBeTruthy();
    setReadingFoldLevel(preview!, "overview");

    h.view.setMode("live");
    h.view.foldLevel("overview");
    h.view.setMode("source");
    h.view.foldLevel("all");
    h.view.setMode("reading");

    await (h.view as unknown as { onClose(): Promise<void> }).onClose();

    expect(h.saveSpy).not.toHaveBeenCalled();
    expect(h.requestSaveSpy).not.toHaveBeenCalled();
    expect(sha256(h.getDisk())).toBe(initialHash);
    expect(sha256(h.view.getViewData())).toBe(initialHash);
  });

  it("preserves IDs, properties, timestamps, links, and unknown blocks when editing a checkbox", async () => {
    const h = createHarness("edit.org", COMPLEX_ORG);
    await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
    h.view.setViewData(COMPLEX_ORG, true);

    const checkbox = h.view.contentEl.querySelector<HTMLInputElement>("input.org-task-checkbox");
    expect(checkbox).toBeTruthy();
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event("change"));

    expect(h.requestSaveSpy).toHaveBeenCalledTimes(1);
    await h.view.save();

    const saved = h.getDisk();
    expect(saved).not.toBe(COMPLEX_ORG);
    expect(saved).toBe(COMPLEX_ORG.replace("- [ ] 未完成任务", "- [X] 未完成任务"));
    expect(saved).toContain(":ID: safety-node-001");
    expect(saved).toContain(":CUSTOM_ID: main-sec");
    expect(saved).toContain("SCHEDULED: <2026-11-25 Wed>");
    expect(saved).toContain("[[id:other-node][跨文件节点]]");
    expect(saved).toContain("#+TRANSCLUDE: [[id:remote-node-1]] :level 2 :only-contents");
    expect(saved).toContain("#+BEGIN_MY_CUSTOM_BLOCK");
    await (h.view as unknown as { onClose(): Promise<void> }).onClose();
  });

  it("reloads external Emacs changes cleanly when buffer is clean without saving back", async () => {
    const h = createHarness("sync.org", "* Title\nOriginal text.\n");
    await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
    h.view.setViewData("* Title\nOriginal text.\n", true);

    const emacsUpdated = "* Title\nEdited in Emacs externally.\n";
    h.setDisk(emacsUpdated);
    h.view.setViewData(emacsUpdated, false);

    expect(h.view.getViewData()).toBe(emacsUpdated);
    expect(h.view.syncGuard.isConflicted()).toBe(false);
    expect(h.view.syncGuard.isDirty()).toBe(false);
    expect(h.requestSaveSpy).not.toHaveBeenCalled();

    await (h.view as unknown as { onClose(): Promise<void> }).onClose();
    expect(h.saveSpy).not.toHaveBeenCalled();
  });

  it("blocks silent overwrite on external Emacs edit when Obsidian has unsaved edits and supports all 3 resolutions", async () => {
    const initial = "* Note\nInitial.\n";
    const localEdit = "* Note\nUnsaved Obsidian edit.\n";
    const emacsEdit = "* Note\nSaved by Emacs on disk.\n";

    // Case 1: Save local conflict copy & reload disk
    {
      const h = createHarness("folder/conflict.org", initial);
      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(initial, true);

      // Simulate unsaved local edit in CM6
      h.view.editor!.dispatch({ changes: { from: 0, to: initial.length, insert: localEdit } });
      expect(h.view.syncGuard.isDirty()).toBe(true);
      h.saveSpy.mockClear();
      h.requestSaveSpy.mockClear();

      // Emacs modifies disk
      h.setDisk(emacsEdit);
      h.view.setViewData(emacsEdit, false);

      expect(h.view.syncGuard.isConflicted()).toBe(true);
      expect(h.getDisk()).toBe(emacsEdit); // Never silently overwritten!
      const banner = h.view.contentEl.querySelector<HTMLElement>(".org-conflict-banner");
      expect(banner?.classList.contains("is-hidden")).toBe(false);

      // Closing while conflicted must NOT overwrite disk
      await (h.view as unknown as { onClose(): Promise<void> }).onClose();
      expect(h.saveSpy).not.toHaveBeenCalled();
      expect(h.getDisk()).toBe(emacsEdit);

      // Re-open or click "Save conflict copy"
      const h2 = createHarness("folder/conflict.org", initial);
      await (h2.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h2.view.setViewData(initial, true);
      h2.view.editor!.dispatch({ changes: { from: 0, to: initial.length, insert: localEdit } });
      h2.setDisk(emacsEdit);
      h2.view.setViewData(emacsEdit, false);

      const copyBtn = h2.view.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-copy");
      expect(copyBtn).toBeTruthy();
      copyBtn!.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(h2.createdFiles.size).toBe(1);
      const [copyPath, copyContent] = Array.from(h2.createdFiles.entries())[0];
      expect(copyPath).toMatch(/^folder\/conflict\.conflict-.*\.org$/);
      expect(copyContent).toBe(localEdit);
      expect(h2.view.getViewData()).toBe(emacsEdit);
      expect(h2.view.syncGuard.isConflicted()).toBe(false);
    }

    // Case 2: Reload from disk
    {
      const h = createHarness("reload.org", initial);
      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(initial, true);
      h.view.editor!.dispatch({ changes: { from: 0, to: initial.length, insert: localEdit } });
      h.setDisk(emacsEdit);
      h.view.setViewData(emacsEdit, false);

      h.view.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-reload")!.click();
      expect(h.view.getViewData()).toBe(emacsEdit);
      expect(h.view.syncGuard.isConflicted()).toBe(false);
    }

    // Case 3: Keep local & save explicitly
    {
      const h = createHarness("keep.org", initial);
      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(initial, true);
      h.view.editor!.dispatch({ changes: { from: 0, to: initial.length, insert: localEdit } });
      h.setDisk(emacsEdit);
      h.view.setViewData(emacsEdit, false);

      h.view.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-keep")!.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.getDisk()).toBe(localEdit);
      expect(h.view.syncGuard.isConflicted()).toBe(false);
    }
  });

  it("ignores save echoes cleanly in FileSyncGuard", () => {
    const guard = new FileSyncGuard();
    guard.reset("v1");
    expect(guard.onLocalEdit("v2").shouldSave).toBe(true);
    expect(guard.prepareSave("v2")).toEqual({ allowSave: true, content: "v2" });
    expect(guard.onDiskUpdate("v2", "v2", false)).toEqual({ action: "ignore-echo" });
    expect(guard.isDirty()).toBe(false);
    expect(guard.isConflicted()).toBe(false);
  });

  it("blocks script injection, inline event handlers, and javascript:/data: links", () => {
    const hostile = [
      "* Unsafe Content",
      '<script>alert("xss")</script>',
      '<img src="x" onerror="alert(1)">',
      "[[javascript:alert(1)][Click me]]",
      "[[data:text/html,<script>alert(1)</script>][Data XSS]]",
    ].join("\n");

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(hostile, app, "xss.org", { settings: DEFAULT_SETTINGS });

    expect(root.querySelectorAll("script")).toHaveLength(0);
    expect(root.querySelectorAll("[onerror]")).toHaveLength(0);
    const links = Array.from(root.querySelectorAll("a"));
    for (const a of links) {
      const href = (a.getAttribute("href") ?? "").toLowerCase();
      expect(href.startsWith("javascript:")).toBe(false);
      expect(href.startsWith("data:")).toBe(false);
    }
    expect(root.querySelectorAll(".org-link-unsafe")).toHaveLength(2);
  });
});
