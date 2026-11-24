import crypto from "node:crypto";
import { undo } from "@codemirror/commands";
import { foldedRanges } from "@codemirror/language";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachObsidianDomHelpers,
  createMockApp,
  TextFileView,
  TFile,
} from "../mocks/obsidian";
import { VIEW_TYPE_ORG, VIEW_TYPE_ORG_BACKLINKS } from "../../src/constants";
import { OrgIdIndex } from "../../src/core/index/orgIdIndex";
import { VaultIndexService } from "../../src/core/index/vaultIndexService";
import { FileSyncGuard } from "../../src/core/safety/fileSyncGuard";
import {
  createMemoryTransclusionProvider,
  createVaultTransclusionProvider,
  OrgTransclusionEngine,
} from "../../src/core/transclusion";
import { translate, type TranslationKey } from "../../src/i18n";
import type OrgNativePlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { OrgBacklinksView, registerNodeNavigation } from "../../src/views/nodes";
import { OrgView } from "../../src/views/OrgView";
import {
  getReadingFoldSnapshot,
  toggleReadingSection,
} from "../../src/views/reading/folding";
import {
  renderOrgPreviewWithTransclusions,
  TransclusionRefreshController,
} from "../../src/views/transclusion";

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

const flushAsync = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

function createSingleViewHarness(
  filePath = "qa/test.org",
  initialDisk = "",
  defaultMode: "reading" | "live" | "source" = "reading"
) {
  let diskContent = initialDisk;
  const createdFiles = new Map<string, string>();
  const baseApp = createMockApp();
  const app = {
    ...baseApp,
    vault: {
      ...baseApp.vault,
      getFiles: () => [
        new TFile(filePath),
        ...Array.from(createdFiles.keys()).map((p) => new TFile(p)),
      ],
      getAbstractFileByPath: (p: string) =>
        createdFiles.has(p)
          ? new TFile(p)
          : p === filePath
            ? new TFile(filePath)
            : null,
      cachedRead: vi.fn(async (f: TFile) =>
        f.path === filePath ? diskContent : (createdFiles.get(f.path) ?? "")
      ),
      create: vi.fn(async (p: string, data: string) => {
        createdFiles.set(p, data);
        return new TFile(p);
      }),
    },
  };

  const leaf = { app };
  const plugin = {
    app,
    settings: { ...DEFAULT_SETTINGS, defaultMode },
    uiLanguage: "en" as const,
    t: (k: TranslationKey) => translate("en", k),
  } as unknown as OrgNativePlugin;

  const view = new OrgView(leaf as unknown as import("obsidian").WorkspaceLeaf, plugin);
  view.file = new TFile(filePath) as unknown as import("obsidian").TFile;
  attachObsidianDomHelpers(view.contentEl);

  const saveSpy = vi
    .spyOn(TextFileView.prototype, "save")
    .mockImplementation(async function (this: OrgView) {
      if (this === view) {
        diskContent = this.getViewData();
      }
    });
  const requestSaveSpy = vi.spyOn(TextFileView.prototype, "_mockRequestSave");

  return {
    view,
    app,
    plugin,
    createdFiles,
    saveSpy,
    requestSaveSpy,
    getDisk: () => diskContent,
    setDisk: (next: string) => {
      diskContent = next;
    },
  };
}

interface MockLeafEntry {
  view: OrgView | null;
  openFile: (file: TFile) => Promise<void>;
}

function createWorkspaceHarness(
  initialFiles: Record<string, { content: string; mtime?: number }>,
  options: {
    defaultMode?: "reading" | "live" | "source";
    transclusionMaxDepth?: number;
    debounceMs?: number;
  } = {}
) {
  const files = new Map<string, { file: TFile; content: string; mtime: number }>();
  const vaultHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const workspaceHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const registeredViews = new Map<string, (leaf: unknown) => unknown>();
  const registeredCommands = new Map<string, { id: string; name: string; callback?: () => void }>();
  const openLeaves: MockLeafEntry[] = [];
  let activeLeaf: MockLeafEntry | null = null;
  let clockMtime = 1000;

  const makeTFile = (p: string, content: string, mtime: number): TFile => {
    const tf = new TFile(p);
    (tf as TFile & { stat: { mtime: number; size: number } }).stat = {
      mtime,
      size: content.length,
    };
    return tf;
  };

  for (const [p, entry] of Object.entries(initialFiles)) {
    const mtime = entry.mtime ?? ++clockMtime;
    files.set(p, {
      file: makeTFile(p, entry.content, mtime),
      content: entry.content,
      mtime,
    });
  }

  const triggerVault = (event: string, ...args: unknown[]) => {
    for (const cb of [...(vaultHandlers.get(event) ?? [])]) {
      cb(...args);
    }
  };

  const triggerWorkspace = (event: string, ...args: unknown[]) => {
    for (const cb of [...(workspaceHandlers.get(event) ?? [])]) {
      cb(...args);
    }
  };

  const baseApp = createMockApp();
  const app = {
    ...baseApp,
    workspace: {
      ...baseApp.workspace,
      getLeavesOfType: (type: string) =>
        type === VIEW_TYPE_ORG
          ? openLeaves.filter((l) => l.view?.getViewType() === VIEW_TYPE_ORG)
          : [],
      getActiveViewOfType: () => activeLeaf?.view ?? null,
      getActiveFile: () => activeLeaf?.view?.file ?? null,
      setActiveLeaf: (leaf: unknown) => {
        activeLeaf = leaf as MockLeafEntry;
      },
      getLeaf: () => {
        const entry: MockLeafEntry = {
          view: null,
          openFile: async (file: TFile) => {
            const view = new OrgView(
              entry as unknown as import("obsidian").WorkspaceLeaf,
              plugin
            );
            view.file = file as unknown as import("obsidian").TFile;
            attachObsidianDomHelpers(view.contentEl);
            entry.view = view;
            await (view as unknown as { onOpen(): Promise<void> }).onOpen();
            const disk = files.get(file.path)?.content ?? "";
            view.setViewData(disk, true);
          },
        };
        (entry as unknown as { app: unknown }).app = app;
        openLeaves.push(entry);
        return entry;
      },
      getRightLeaf: () => ({
        setViewState: async () => {},
        openFile: async () => {},
      }),
      revealLeaf: vi.fn(),
      detachLeavesOfType: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = workspaceHandlers.get(event) ?? [];
        list.push(cb);
        workspaceHandlers.set(event, list);
        return { event, cb };
      }),
      offref: vi.fn((ref: { event?: string; cb?: (...args: unknown[]) => void }) => {
        if (!ref?.event || !ref.cb) return;
        const list = workspaceHandlers.get(ref.event);
        if (!list) return;
        workspaceHandlers.set(
          ref.event,
          list.filter((fn) => fn !== ref.cb)
        );
      }),
    },
    vault: {
      ...baseApp.vault,
      getFiles: () => Array.from(files.values()).map((e) => e.file),
      getAbstractFileByPath: (p: string) => files.get(p)?.file ?? null,
      cachedRead: vi.fn(async (file: TFile) => files.get(file.path)?.content ?? ""),
      create: vi.fn(async (p: string, data: string) => {
        const mtime = ++clockMtime;
        const tf = makeTFile(p, data, mtime);
        files.set(p, { file: tf, content: data, mtime });
        triggerVault("create", tf);
        return tf;
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
      defaultMode: options.defaultMode ?? "reading",
      enableTransclusion: true,
      transclusionMaxDepth: options.transclusionMaxDepth ?? 4,
    },
    uiLanguage: "en" as const,
    t: (k: TranslationKey) => translate("en", k),
    registerEvent: vi.fn(),
    registerView: vi.fn((type: string, creator: (leaf: unknown) => unknown) => {
      registeredViews.set(type, creator);
    }),
    addCommand: vi.fn((cmd: { id: string; name: string; callback?: () => void }) => {
      registeredCommands.set(cmd.id, cmd);
    }),
  } as unknown as OrgNativePlugin;

  const vaultIndex = new VaultIndexService(
    app as unknown as import("obsidian").App,
    plugin,
    { debounceMs: options.debounceMs ?? 5 }
  );
  vaultIndex.start();
  plugin.vaultIndex = vaultIndex;
  plugin.transclusionEngine = new OrgTransclusionEngine(
    createVaultTransclusionProvider(
      app as unknown as import("obsidian").App,
      vaultIndex.index
    ),
    { defaultMaxDepth: plugin.settings.transclusionMaxDepth }
  );
  plugin.nodeNavigation = registerNodeNavigation({
    plugin: plugin as unknown as Parameters<typeof registerNodeNavigation>[0]["plugin"],
    vaultIndex,
  });

  // Simulate Obsidian TextFileView disk write + sibling view propagation on save
  const saveSpy = vi
    .spyOn(TextFileView.prototype, "save")
    .mockImplementation(async function (this: OrgView) {
      const targetPath = this.file?.path;
      if (!targetPath) return;
      const next = this.getViewData();
      const mtime = ++clockMtime;
      const existing = files.get(targetPath);
      const tf = existing?.file ?? makeTFile(targetPath, next, mtime);
      (tf as TFile & { stat: { mtime: number; size: number } }).stat = {
        mtime,
        size: next.length,
      };
      files.set(targetPath, { file: tf, content: next, mtime });

      // Propagate disk change to every open OrgView bound to this file
      for (const leaf of openLeaves) {
        if (leaf.view && leaf.view.file?.path === targetPath) {
          leaf.view.setViewData(next, false);
        }
      }
      triggerVault("modify", tf);
    });
  const requestSaveSpy = vi.spyOn(TextFileView.prototype, "_mockRequestSave");

  const openOrgLeaf = async (
    filePath: string,
    modeOverride?: "reading" | "live" | "source"
  ) => {
    const entry: MockLeafEntry = {
      view: null,
      openFile: async (f: TFile) => {
        const view = new OrgView(
          entry as unknown as import("obsidian").WorkspaceLeaf,
          plugin
        );
        view.file = f as unknown as import("obsidian").TFile;
        attachObsidianDomHelpers(view.contentEl);
        entry.view = view;
        await (view as unknown as { onOpen(): Promise<void> }).onOpen();
        const disk = files.get(f.path)?.content ?? "";
        view.setViewData(disk, true);
        if (modeOverride) {
          view.setMode(modeOverride);
        }
      },
    };
    (entry as unknown as { app: unknown }).app = app;
    openLeaves.push(entry);
    const tf = files.get(filePath)?.file ?? makeTFile(filePath, "", ++clockMtime);
    await entry.openFile(tf);
    activeLeaf = entry;
    return { leaf: entry, view: entry.view! };
  };

  const closeOrgLeaf = async (leaf: MockLeafEntry) => {
    if (leaf.view) {
      await (leaf.view as unknown as { onClose(): Promise<void> }).onClose();
    }
    const idx = openLeaves.indexOf(leaf);
    if (idx >= 0) openLeaves.splice(idx, 1);
    if (activeLeaf === leaf) {
      activeLeaf = openLeaves[0] ?? null;
    }
  };

  const renameDiskFile = (oldPath: string, newPath: string) => {
    const entry = files.get(oldPath);
    if (!entry) return;
    files.delete(oldPath);
    entry.file.path = newPath;
    files.set(newPath, entry);
    triggerVault("rename", entry.file, oldPath);
  };

  const updateDiskFile = (filePath: string, nextContent: string, fireModify = true) => {
    const mtime = ++clockMtime;
    const existing = files.get(filePath);
    const tf = existing?.file ?? makeTFile(filePath, nextContent, mtime);
    (tf as TFile & { stat: { mtime: number; size: number } }).stat = {
      mtime,
      size: nextContent.length,
    };
    files.set(filePath, { file: tf, content: nextContent, mtime });
    if (fireModify) {
      triggerVault("modify", tf);
    }
  };

  const deleteDiskFile = (filePath: string) => {
    const entry = files.get(filePath);
    if (!entry) return;
    files.delete(filePath);
    triggerVault("delete", entry.file);
  };

  return {
    app,
    plugin,
    vaultIndex,
    files,
    openLeaves,
    registeredViews,
    registeredCommands,
    saveSpy,
    requestSaveSpy,
    openOrgLeaf,
    closeOrgLeaf,
    renameDiskFile,
    updateDiskFile,
    deleteDiskFile,
    triggerVault,
    triggerWorkspace,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Sprint 03 Reliability & Data Integrity", () => {
  describe("1. Simultaneous external Emacs modification + unsaved Obsidian conflict", () => {
    it("survives rapid consecutive external updates while conflicted, blocks silent overwrites, and resolves via Reload and Keep Local", async () => {
      const initial = "* Meeting Notes\r\n- [ ] Draft agenda\r\n";
      const localEdit = "* Meeting Notes\r\n- [ ] Draft agenda\r\nObsidian unsaved paragraph.\r\n";
      const emacsV1 = "* Meeting Notes\r\n- [ ] Draft agenda\r\nEmacs write #1.\r\n";
      const emacsV2 = "* Meeting Notes\r\n- [ ] Draft agenda\r\nEmacs write #2.\r\n";
      const emacsV3 = "* Meeting Notes\r\n- [ ] Draft agenda\r\nEmacs write #3 (final).\r\n";

      const h = createSingleViewHarness("sync/rapid.org", initial, "live");
      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(initial, true);

      // Unsaved local edit in CM6
      h.view.editor!.dispatch({
        changes: {
          from: 0,
          to: h.view.editor!.state.doc.length,
          insert: localEdit.replace(/\r\n/g, "\n"),
        },
        userEvent: "input",
      });
      expect(h.view.syncGuard.isDirty()).toBe(true);
      h.saveSpy.mockClear();
      h.requestSaveSpy.mockClear();

      // Rapid consecutive external Emacs modifications while already conflicted
      for (const diskVer of [emacsV1, emacsV2, emacsV3]) {
        h.setDisk(diskVer);
        h.view.setViewData(diskVer, false);
        expect(h.view.syncGuard.isConflicted()).toBe(true);
        expect(h.view.syncGuard.getExternalDiskContent()).toBe(diskVer);
        expect(h.getDisk()).toBe(diskVer);
      }

      // Additional local typing while conflicted MUST stay blocked
      h.view.editor!.dispatch({
        changes: { from: h.view.editor!.state.doc.length, insert: "Extra local line.\n" },
        userEvent: "input",
      });
      expect(h.requestSaveSpy).not.toHaveBeenCalled();
      await h.view.save();
      expect(h.saveSpy).not.toHaveBeenCalled();
      expect(h.getDisk()).toBe(emacsV3);

      // Reload resolution accepts the LATEST external disk content (emacsV3) byte-for-byte
      const reloadBtn = h.view.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-reload");
      expect(reloadBtn).toBeTruthy();
      reloadBtn!.click();

      expect(h.view.syncGuard.isConflicted()).toBe(false);
      expect(h.view.syncGuard.isDirty()).toBe(false);
      expect(sha256(h.view.getViewData())).toBe(sha256(emacsV3));
      expect(h.getDisk()).toBe(emacsV3);
      expect(
        h.view.contentEl.querySelector(".org-conflict-banner")?.classList.contains("is-hidden")
      ).toBe(true);

      // Second cycle: trigger conflict again and resolve via Keep Local & Save
      const localKeep = "* Meeting Notes\r\n- [ ] Draft agenda\r\nObsidian kept version.\r\n";
      const emacsV4 = "* Meeting Notes\r\n- [ ] Draft agenda\r\nEmacs write #4.\r\n";
      h.view.editor!.dispatch({
        changes: {
          from: 0,
          to: h.view.editor!.state.doc.length,
          insert: localKeep.replace(/\r\n/g, "\n"),
        },
        userEvent: "input",
      });
      h.setDisk(emacsV4);
      h.view.setViewData(emacsV4, false);
      expect(h.view.syncGuard.isConflicted()).toBe(true);

      h.view.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-keep")!.click();
      await flushAsync(5);

      expect(h.view.syncGuard.isConflicted()).toBe(false);
      expect(h.view.syncGuard.isDirty()).toBe(false);
      expect(sha256(h.getDisk())).toBe(sha256(localKeep));

      // Save echo from Obsidian watcher must be ignored cleanly
      h.view.setViewData(localKeep, false);
      expect(h.view.syncGuard.isConflicted()).toBe(false);
      expect(h.view.getViewData()).toBe(localKeep);

      await (h.view as unknown as { onClose(): Promise<void> }).onClose();
    });

    it("generates unique .conflict-*.org suffixes without clobbering pre-existing conflict files in the same second", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 10, 25, 14, 35, 9)); // 20261125-143509

      const initial = "* Draft\nBase content.\n";
      const localA = "* Draft\nLocal edit A.\n";
      const emacsA = "* Draft\nEmacs edit A.\n";
      const localB = "* Draft\nLocal edit B.\n";
      const emacsB = "* Draft\nEmacs edit B.\n";

      const h = createSingleViewHarness("projects/draft.org", initial, "live");
      // Pre-existing conflict copies sharing the exact timestamp
      h.createdFiles.set("projects/draft.conflict-20261125-143509.org", "pre-existing-0");
      h.createdFiles.set("projects/draft.conflict-20261125-143509-1.org", "pre-existing-1");

      await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
      h.view.setViewData(initial, true);

      // First conflict -> should select -2.org
      h.view.editor!.dispatch({
        changes: { from: 0, to: h.view.editor!.state.doc.length, insert: localA },
        userEvent: "input",
      });
      h.setDisk(emacsA);
      h.view.setViewData(emacsA, false);
      expect(h.view.syncGuard.isConflicted()).toBe(true);

      h.view.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-copy")!.click();
      await flushAsync(5);

      expect(h.createdFiles.get("projects/draft.conflict-20261125-143509.org")).toBe(
        "pre-existing-0"
      );
      expect(h.createdFiles.get("projects/draft.conflict-20261125-143509-1.org")).toBe(
        "pre-existing-1"
      );
      expect(h.createdFiles.get("projects/draft.conflict-20261125-143509-2.org")).toBe(localA);
      expect(h.view.getViewData()).toBe(emacsA);
      expect(h.getDisk()).toBe(emacsA);
      expect(h.view.syncGuard.isConflicted()).toBe(false);

      // Second conflict in the same second -> should select -3.org
      h.view.editor!.dispatch({
        changes: { from: 0, to: h.view.editor!.state.doc.length, insert: localB },
        userEvent: "input",
      });
      h.setDisk(emacsB);
      h.view.setViewData(emacsB, false);
      expect(h.view.syncGuard.isConflicted()).toBe(true);

      h.view.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-copy")!.click();
      await flushAsync(5);

      expect(h.createdFiles.get("projects/draft.conflict-20261125-143509-2.org")).toBe(localA);
      expect(h.createdFiles.get("projects/draft.conflict-20261125-143509-3.org")).toBe(localB);
      expect(h.view.getViewData()).toBe(emacsB);
      expect(h.getDisk()).toBe(emacsB);

      await (h.view as unknown as { onClose(): Promise<void> }).onClose();

      // Also verify root-level path without directory prefix
      const rootHarness = createSingleViewHarness("root-note.org", initial, "live");
      await (rootHarness.view as unknown as { onOpen(): Promise<void> }).onOpen();
      rootHarness.view.setViewData(initial, true);
      rootHarness.view.editor!.dispatch({
        changes: { from: 0, to: rootHarness.view.editor!.state.doc.length, insert: localA },
        userEvent: "input",
      });
      rootHarness.setDisk(emacsA);
      rootHarness.view.setViewData(emacsA, false);
      const copyPath = await rootHarness.view.saveConflictCopyAndReload();
      expect(copyPath).toBe("root-note.conflict-20261125-143509.org");
      expect(rootHarness.createdFiles.get(copyPath!)).toBe(localA);
      await (rootHarness.view as unknown as { onClose(): Promise<void> }).onClose();
    });
  });

  describe("2. Multi-pane / multi-leaf same-file concurrency", () => {
    it("syncs clean edits from Leaf A to Leaf B, blocks silent overwrite when Leaf B is dirty, maintains independent fold snapshots, and survives closing Leaf A", async () => {
      const sharedDoc = [
        "#+TITLE: Concurrent Workspace Note",
        "",
        "* Section Alpha",
        ":PROPERTIES:",
        ":ID: sec-alpha",
        ":END:",
        "Alpha body paragraph.",
        "",
        "* Section Beta",
        ":PROPERTIES:",
        ":ID: sec-beta",
        ":END:",
        "Beta body paragraph.",
        "",
      ].join("\n");

      const h = createWorkspaceHarness({
        "shared/multi.org": { content: sharedDoc },
      });
      await h.vaultIndex.initialize();

      const { leaf: leafA, view: viewA } = await h.openOrgLeaf("shared/multi.org", "live");
      const { leaf: leafB, view: viewB } = await h.openOrgLeaf("shared/multi.org", "reading");

      expect(viewA.getMode()).toBe("live");
      expect(viewB.getMode()).toBe("reading");

      // Independent fold state: fold Section Alpha in Leaf B (Reading), fold Section Beta in Leaf A (Live)
      const previewB = viewB.contentEl.querySelector<HTMLElement>(".org-preview");
      expect(previewB).toBeTruthy();
      const secAlphaB = Array.from(previewB!.querySelectorAll<HTMLElement>(".org-section")).find(
        (s) => s.dataset.orgId === "sec-alpha"
      );
      expect(secAlphaB).toBeTruthy();
      expect(toggleReadingSection(secAlphaB!)).toBe(true);
      expect(getReadingFoldSnapshot(previewB!).foldedKeys?.has("id:sec-alpha")).toBe(true);

      // Fold Section Beta in Leaf A's CM6 editor
      const betaLine = sharedDoc.split("\n").indexOf("* Section Beta");
      viewA.jumpToLine(betaLine);
      expect(viewA.toggleFold()).toBe(true);
      expect(foldedRanges(viewA.editor!.state).size).toBeGreaterThan(0);
      // Leaf B's Reading View Section Beta remains unfolded
      const secBetaB = Array.from(previewB!.querySelectorAll<HTMLElement>(".org-section")).find(
        (s) => s.dataset.orgId === "sec-beta"
      );
      expect(secBetaB!.classList.contains("is-folded")).toBe(false);

      // Leaf A makes a clean edit and saves -> Leaf B (clean) reloads seamlessly preserving its fold snapshot
      const updatedByA = sharedDoc.replace("Beta body paragraph.", "Beta updated from Leaf A.");
      const idxBeta = viewA.editor!.state.doc.toString().indexOf("Beta body paragraph.");
      viewA.editor!.dispatch({
        changes: {
          from: idxBeta,
          to: idxBeta + "Beta body paragraph.".length,
          insert: "Beta updated from Leaf A.",
        },
        userEvent: "input",
      });
      h.saveSpy.mockClear();
      await viewA.save();

      expect(h.saveSpy).toHaveBeenCalledTimes(1);
      expect(h.files.get("shared/multi.org")!.content).toBe(updatedByA);
      expect(viewB.getViewData()).toBe(updatedByA);
      expect(viewB.syncGuard.isDirty()).toBe(false);
      expect(viewB.syncGuard.isConflicted()).toBe(false);

      const previewBAfter = viewB.contentEl.querySelector<HTMLElement>(".org-preview")!;
      expect(previewBAfter.textContent).toContain("Beta updated from Leaf A.");
      // Leaf B's fold snapshot for Section Alpha survived reload
      expect(getReadingFoldSnapshot(previewBAfter).foldedKeys?.has("id:sec-alpha")).toBe(true);

      // Now Leaf B ALSO makes an unsaved local edit BEFORE Leaf A saves again -> Leaf B must conflict
      const dirtyLocalB = updatedByA.replace("Alpha body paragraph.", "Unsaved Leaf B edit.");
      const idxAlphaB = viewB.editor!.state.doc.toString().indexOf("Alpha body paragraph.");
      viewB.editor!.dispatch({
        changes: {
          from: idxAlphaB,
          to: idxAlphaB + "Alpha body paragraph.".length,
          insert: "Unsaved Leaf B edit.",
        },
        userEvent: "input",
      });
      expect(viewB.syncGuard.isDirty()).toBe(true);

      // Leaf A saves another edit
      const secondEditA = updatedByA.replace(
        "Beta updated from Leaf A.",
        "Beta v2 saved by Leaf A."
      );
      const idxBeta2 = viewA.editor!.state.doc.toString().indexOf("Beta updated from Leaf A.");
      viewA.editor!.dispatch({
        changes: {
          from: idxBeta2,
          to: idxBeta2 + "Beta updated from Leaf A.".length,
          insert: "Beta v2 saved by Leaf A.",
        },
        userEvent: "input",
      });
      await viewA.save();

      // Leaf B must be conflicted, Leaf A must remain clean, disk must retain secondEditA
      expect(h.files.get("shared/multi.org")!.content).toBe(secondEditA);
      expect(viewA.syncGuard.isConflicted()).toBe(false);
      expect(viewB.syncGuard.isConflicted()).toBe(true);
      expect(viewB.getViewData()).toBe(dirtyLocalB);
      expect(
        viewB.contentEl.querySelector(".org-conflict-banner")?.classList.contains("is-hidden")
      ).toBe(false);

      // Explicit save on conflicted Leaf B must NOT overwrite Leaf A's disk content
      await viewB.save();
      expect(h.files.get("shared/multi.org")!.content).toBe(secondEditA);

      // Closing Leaf A leaves Leaf B open and functional
      await h.closeOrgLeaf(leafA);
      expect(viewA.editor).toBeNull();
      expect(viewB.editor).not.toBeNull();
      expect(h.files.get("shared/multi.org")!.content).toBe(secondEditA);

      // Leaf B resolves by keeping local and saving, then switching modes
      viewB.contentEl.querySelector<HTMLButtonElement>(".org-conflict-btn-keep")!.click();
      await flushAsync(5);
      expect(viewB.syncGuard.isConflicted()).toBe(false);
      expect(h.files.get("shared/multi.org")!.content).toBe(dirtyLocalB);

      viewB.setMode("live");
      expect(viewB.getMode()).toBe("live");
      expect(viewB.getViewData()).toBe(dirtyLocalB);

      await h.closeOrgLeaf(leafB);
      h.vaultIndex.destroy();
      h.plugin.nodeNavigation.dispose();
    });
  });

  describe("3. LF and CRLF byte-exact preservation through edit, CM6 undo, save, external reload, and reopen", () => {
    const FIXTURE_LINES = [
      "#+TITLE: Byte Integrity Lifecycle · 行尾测试",
      "#+TODO: TODO NEXT | DONE",
      "",
      "* TODO Heading One :tag:",
      ":PROPERTIES:",
      ":ID: eol-node-001",
      ":END:",
      "Initial body line.",
      "- [ ] Task A",
      "- [X] Task B",
      "",
      "#+BEGIN_SRC python",
      "print('preserve me')",
      "#+END_SRC",
      "",
    ];

    it.each([
      { label: "LF (\\n)", eol: "\n" as const },
      { label: "CRLF (\\r\\n)", eol: "\r\n" as const },
    ])(
      "preserves exact $label bytes through CM6 edit, undo, checkbox/text save, external reload, and close/reopen",
      async ({ eol }) => {
        const initial = FIXTURE_LINES.join(eol);
        const initialHash = sha256(initial);

        const h = createSingleViewHarness("eol/lifecycle.org", initial, "live");
        await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
        h.view.setViewData(initial, true);

        expect(sha256(h.view.getViewData())).toBe(initialHash);

        // 1. CM6 edit
        const marker = "Initial body line.";
        const from = h.view.editor!.state.doc.toString().indexOf(marker);
        expect(from).toBeGreaterThan(0);
        h.view.editor!.dispatch({
          changes: { from, to: from + marker.length, insert: "Edited body line." },
          userEvent: "input",
        });
        expect(h.view.syncGuard.isDirty()).toBe(true);
        expect(h.view.getViewData()).toBe(initial.replace(marker, "Edited body line."));
        expect(h.view.getViewData().includes("\r\n")).toBe(eol === "\r\n");

        // 2. CM6 undo reverts buffer byte-exact and clears dirty flag
        expect(undo(h.view.editor!)).toBe(true);
        expect(sha256(h.view.getViewData())).toBe(initialHash);
        expect(h.view.syncGuard.isDirty()).toBe(false);
        expect(h.getDisk()).toBe(initial);

        // 3. Edit again + toggle checkbox in Reading View + save
        h.view.editor!.dispatch({
          changes: { from, to: from + marker.length, insert: "Persisted edit line." },
          userEvent: "input",
        });
        h.view.setMode("reading");
        const cb = h.view.contentEl.querySelector<HTMLInputElement>("input.org-task-checkbox");
        expect(cb).toBeTruthy();
        cb!.checked = true;
        cb!.dispatchEvent(new Event("change"));

        await h.view.save();
        const expectedSaved = initial
          .replace(marker, "Persisted edit line.")
          .replace("- [ ] Task A", "- [X] Task A");
        expect(sha256(h.getDisk())).toBe(sha256(expectedSaved));
        expect(h.getDisk().match(/\r\n/g)?.length ?? 0).toBe(
          eol === "\r\n" ? FIXTURE_LINES.length - 1 : 0
        );

        // 4. External reload via setViewData(next, false)
        const emacsNext = expectedSaved + `** Added in Emacs${eol}Emacs line.${eol}`;
        h.setDisk(emacsNext);
        h.view.setViewData(emacsNext, false);
        expect(sha256(h.view.getViewData())).toBe(sha256(emacsNext));
        expect(h.view.syncGuard.isDirty()).toBe(false);

        // 5. Clean close and fresh reopen restores byte-exact content
        h.saveSpy.mockClear();
        await (h.view as unknown as { onClose(): Promise<void> }).onClose();
        expect(h.saveSpy).not.toHaveBeenCalled();

        const reopened = createSingleViewHarness("eol/lifecycle.org", h.getDisk(), "live");
        await (reopened.view as unknown as { onOpen(): Promise<void> }).onOpen();
        reopened.view.setViewData(h.getDisk(), true);
        expect(sha256(reopened.view.getViewData())).toBe(sha256(emacsNext));
        expect(reopened.view.syncGuard.isDirty()).toBe(false);
        expect(reopened.view.syncGuard.isConflicted()).toBe(false);
        await (reopened.view as unknown as { onClose(): Promise<void> }).onClose();
      }
    );
  });

  describe("4. Large .org file incremental OrgIdIndex & VaultIndexService updates", () => {
    function buildLargeOrgDocument(nodeCount = 100): string {
      const lines: string[] = [
        "#+TITLE: Large Knowledge Corpus",
        "#+TODO: TODO | DONE",
        "",
      ];
      for (let i = 0; i < nodeCount; i++) {
        const id = `large-id-${String(i).padStart(3, "0")}`;
        const nextId = `large-id-${String((i + 1) % nodeCount).padStart(3, "0")}`;
        lines.push(
          `* Node Heading ${i}`,
          ":PROPERTIES:",
          `:ID: ${id}`,
          `:CUSTOM_ID: custom-${i}`,
          ":END:",
          `Body paragraph one for node ${i}.`,
          `Body paragraph two linking [[id:${nextId}][Next ${i}]].`,
          "#+BEGIN_SRC text",
          `line_a_${i}`,
          `line_b_${i}`,
          "#+END_SRC",
          "Trailing note line.",
          ""
        );
      }
      return lines.join("\n");
    }

    it("handles 1,200+ lines & 100 ID headings with accurate add/move/modify/delete updates and contentHash/stat skipping", async () => {
      const largeContent = buildLargeOrgDocument(100);
      expect(largeContent.split("\n").length).toBeGreaterThan(1200);

      const unchangedA = "* Unchanged A\n:PROPERTIES:\n:ID: unchanged-a\n:END:\nBody A.\n";
      const unchangedB = "* Unchanged B\n:PROPERTIES:\n:ID: unchanged-b\n:END:\nBody B.\n";
      const refsContent = [
        "* References",
        "Watch [[id:large-id-070][Node 70]].",
        "Watch [[id:large-id-071][Node 71]].",
      ].join("\n");

      const h = createWorkspaceHarness({
        "corpus/large.org": { content: largeContent },
        "corpus/unchanged-a.org": { content: unchangedA },
        "corpus/unchanged-b.org": { content: unchangedB },
        "corpus/refs.org": { content: refsContent },
      });

      await h.vaultIndex.initialize();
      const readSpy = h.app.vault.cachedRead;

      expect(h.vaultIndex.index.getMetrics().fullScans).toBe(1);
      expect(h.vaultIndex.index.getDiagnostics().nodeCount).toBe(102);
      expect(h.vaultIndex.index.getNodesInFile("corpus/large.org")).toHaveLength(100);

      // Unchanged content upsert is skipped via contentHash
      const skipsBefore = h.vaultIndex.index.getMetrics().skippedUnchanged;
      const upsertsBefore = h.vaultIndex.index.getMetrics().incrementalUpserts;
      const verBefore = h.vaultIndex.index.getVersion();
      const unchangedRes = h.vaultIndex.index.upsertFile("corpus/large.org", largeContent);
      expect(unchangedRes.changed).toBe(false);
      expect(h.vaultIndex.index.getMetrics().skippedUnchanged).toBe(skipsBefore + 1);
      expect(h.vaultIndex.index.getMetrics().incrementalUpserts).toBe(upsertsBefore);
      expect(h.vaultIndex.index.getVersion()).toBe(verBefore);

      // Update ONLY corpus/large.org on disk without firing vault modify -> refreshOutdatedFiles skips unchanged files via stats
      const withAdded =
        largeContent +
        [
          "* Added Tail Node 1",
          ":PROPERTIES:",
          ":ID: large-added-1",
          ":END:",
          "Links back to [[id:large-id-010][Node 10]].",
          "",
          "* Added Tail Node 2",
          ":PROPERTIES:",
          ":ID: large-added-2",
          ":END:",
          "Tail 2 body.",
        ].join("\n");
      h.updateDiskFile("corpus/large.org", withAdded, false);

      const outdated = h.vaultIndex.getExtendedDiagnostics().indexOutdated.outdatedFiles;
      expect(outdated.map((e) => e.filePath)).toEqual(["corpus/large.org"]);

      readSpy.mockClear();
      const refreshedCount = await h.vaultIndex.refreshOutdatedFiles();
      expect(refreshedCount).toBe(1);
      expect(readSpy.mock.calls.map((c) => c[0].path)).toEqual(["corpus/large.org"]);
      expect(h.vaultIndex.index.getMetrics().fullScans).toBe(1);
      expect(h.vaultIndex.index.getDiagnostics().nodeCount).toBe(104);
      expect(h.vaultIndex.index.resolveId("large-added-1").status).toBe("found");
      expect(h.vaultIndex.index.resolveId("large-added-2").status).toBe("found");
      // large-id-010 now has 2 incoming links (from node 009 + large-added-1)
      expect(h.vaultIndex.index.getBacklinks("large-id-010")).toHaveLength(2);

      // Move large-id-025 from early in file to end under a new parent, modify large-id-050, and delete large-id-070 & large-id-071
      const lines = withAdded.split("\n");
      const removeNodeBlock = (idToRemove: string) => {
        const propLine = lines.findIndex((l) => l.trim() === `:ID: ${idToRemove}`);
        expect(propLine).toBeGreaterThan(0);
        // Heading is 2 lines before :ID:
        const startHeading = propLine - 2;
        let endHeading = lines.length;
        for (let k = startHeading + 1; k < lines.length; k++) {
          if (lines[k].startsWith("* ")) {
            endHeading = k;
            break;
          }
        }
        return lines.splice(startHeading, endHeading - startHeading);
      };

      const movedBlock = removeNodeBlock("large-id-025");
      removeNodeBlock("large-id-070");
      removeNodeBlock("large-id-071");

      // Modify large-id-050 heading title and its link target
      const line50 = lines.findIndex((l) => l === "* Node Heading 50");
      expect(line50).toBeGreaterThan(0);
      lines[line50] = "* Node Heading 50 Updated";
      const linkLine50 = lines.findIndex((l) => l.includes("[[id:large-id-051]"));
      expect(linkLine50).toBeGreaterThan(0);
      lines[linkLine50] = "Retargeted link to [[id:large-added-2][Tail 2]].";

      // Append moved block under a level-1 parent at end of large.org
      lines.push(
        "* Relocated Container",
        movedBlock[0].replace(/^\*\s+/, "** "),
        ...movedBlock.slice(1)
      );

      const mutatedLarge = lines.join("\n");
      const mutateRes = h.vaultIndex.index.upsertFile("corpus/large.org", mutatedLarge);
      expect(mutateRes.changed).toBe(true);
      expect(mutateRes.affectedNodeIds.has("large-id-025")).toBe(true);
      expect(mutateRes.affectedNodeIds.has("large-id-070")).toBe(true);

      // Verify all index queries after add/move/modify/delete
      expect(h.vaultIndex.index.getDiagnostics().nodeCount).toBe(102); // 104 - 2 deleted
      expect(h.vaultIndex.index.getNodesInFile("corpus/large.org")).toHaveLength(100);
      expect(h.vaultIndex.index.getAllNodes()).toHaveLength(102);

      const movedRes = h.vaultIndex.index.resolveId("large-id-025");
      expect(movedRes.status).toBe("found");
      if (movedRes.status === "found") {
        expect(movedRes.node.headingPath).toEqual(["Relocated Container", "Node Heading 25"]);
        expect(movedRes.node.level).toBe(2);
        expect(movedRes.node.line).toBeGreaterThan(1100);
      }
      expect(h.vaultIndex.index.getBacklinks("large-id-025")).toHaveLength(1);

      const modRes = h.vaultIndex.index.resolveId("large-id-050");
      expect(modRes.status).toBe("found");
      if (modRes.status === "found") {
        expect(modRes.node.title).toBe("Node Heading 50 Updated");
      }
      expect(
        h.vaultIndex.index
          .getBacklinkEntries("large-id-051")
          .some((b) => b.sourceNode?.id === "large-id-050")
      ).toBe(false);
      expect(
        h.vaultIndex.index
          .getBacklinkEntries("large-added-2")
          .some((b) => b.sourceNode?.id === "large-id-050")
      ).toBe(true);

      expect(h.vaultIndex.index.resolveId("large-id-070").status).toBe("missing");
      expect(h.vaultIndex.index.resolveId("large-id-071").status).toBe("missing");
      expect(
        h.vaultIndex.index
          .getBrokenIdLinks()
          .map((b) => ({ targetId: b.link.targetId, sourcePath: b.link.sourcePath }))
      ).toEqual([
        { targetId: "large-id-070", sourcePath: "corpus/large.org" },
        { targetId: "large-id-070", sourcePath: "corpus/refs.org" },
        { targetId: "large-id-071", sourcePath: "corpus/refs.org" },
      ]);
      expect(h.vaultIndex.index.getMetrics().fullScans).toBe(1);

      h.vaultIndex.destroy();
      h.plugin.nodeNavigation.dispose();
    });
  });

  describe("5. File move (renameFile) & node migration across files", () => {
    it("keeps resolveId, getBacklinks, and navigateToId accurate across multi-hop renames and cross-file node migration", async () => {
      const draftDoc = [
        ":PROPERTIES:",
        ":ID: file-draft-root",
        ":END:",
        "",
        "* Alpha Topic",
        ":PROPERTIES:",
        ":ID: node-alpha-nav",
        ":END:",
        "Original alpha content.",
      ].join("\n");

      const refsDoc = [
        "* References Hub",
        ":PROPERTIES:",
        ":ID: refs-hub-id",
        ":END:",
        "See [[id:node-alpha-nav][Alpha]].",
        "#+TRANSCLUDE: [[id:node-alpha-nav]] :level 2",
      ].join("\n");

      const destDoc = [
        "#+TITLE: Destination Knowledge Base",
        "",
        "* Permanent Section",
        "Existing paragraph.",
      ].join("\n");

      const h = createWorkspaceHarness(
        {
          "inbox/draft.org": { content: draftDoc },
          "refs/index.org": { content: refsDoc },
          "kb/destination.org": { content: destDoc },
        },
        { defaultMode: "live" }
      );
      await h.vaultIndex.initialize();

      // Multi-hop rename of target file AND referencing file
      h.renameDiskFile("inbox/draft.org", "staging/alpha-v1.org");
      h.renameDiskFile("staging/alpha-v1.org", "projects/2026/alpha-v2.org");
      h.renameDiskFile("projects/2026/alpha-v2.org", "archive/alpha-final.org");

      h.renameDiskFile("refs/index.org", "refs/hop1.org");
      h.renameDiskFile("refs/hop1.org", "refs/final-refs.org");

      const fileRootRes = h.vaultIndex.index.resolveId("file-draft-root");
      expect(fileRootRes.status).toBe("found");
      if (fileRootRes.status === "found") {
        expect(fileRootRes.node.filePath).toBe("archive/alpha-final.org");
        expect(fileRootRes.node.title).toBe("archive/alpha-final.org");
      }

      const alphaRes = h.vaultIndex.index.resolveId("node-alpha-nav");
      expect(alphaRes.status).toBe("found");
      if (alphaRes.status === "found") {
        expect(alphaRes.node.filePath).toBe("archive/alpha-final.org");
        expect(alphaRes.node.line).toBe(4);
      }

      const backlinksAfterRename = h.vaultIndex.index.getBacklinkEntries("node-alpha-nav");
      expect(backlinksAfterRename).toHaveLength(2);
      expect(backlinksAfterRename.map((e) => e.link.sourcePath)).toEqual([
        "refs/final-refs.org",
        "refs/final-refs.org",
      ]);
      expect(backlinksAfterRename.map((e) => e.link.relation)).toEqual(["link", "transclude"]);
      expect(backlinksAfterRename[0].sourceNode?.filePath).toBe("refs/final-refs.org");

      // Navigate to ID opens the final renamed file at exact line
      expect(await h.vaultIndex.navigateToId("node-alpha-nav", "live")).toBe(true);
      const activeLeaf = h.app.workspace.getLeavesOfType(VIEW_TYPE_ORG).find(
        (l) => l.view?.file?.path === "archive/alpha-final.org"
      );
      expect(activeLeaf).toBeTruthy();
      expect(activeLeaf!.view!.getEphemeralState().line).toBe(4);

      // Migrate node-alpha-nav out of archive/alpha-final.org into kb/destination.org, then rename destination
      h.updateDiskFile(
        "archive/alpha-final.org",
        ":PROPERTIES:\n:ID: file-draft-root\n:END:\n\n* Empty Archive\nMoved out.\n"
      );
      const migratedDest = [
        destDoc,
        "",
        "** Migrated Alpha Topic",
        ":PROPERTIES:",
        ":ID: node-alpha-nav",
        ":END:",
        "Migrated safely across files.",
      ].join("\n");
      h.updateDiskFile("kb/destination.org", migratedDest);
      await flushAsync(25);
      h.renameDiskFile("kb/destination.org", "kb/destination-v2.org");

      const migratedRes = h.vaultIndex.index.resolveId("node-alpha-nav");
      expect(migratedRes.status).toBe("found");
      if (migratedRes.status === "found") {
        expect(migratedRes.node.filePath).toBe("kb/destination-v2.org");
        expect(migratedRes.node.line).toBe(5);
        expect(migratedRes.node.headingPath).toEqual([
          "Permanent Section",
          "Migrated Alpha Topic",
        ]);
      }

      expect(h.vaultIndex.index.getBacklinks("node-alpha-nav")).toHaveLength(2);
      expect(await h.vaultIndex.navigateToId("node-alpha-nav", "reading")).toBe(true);
      const destLeaf = h.app.workspace.getLeavesOfType(VIEW_TYPE_ORG).find(
        (l) => l.view?.file?.path === "kb/destination-v2.org"
      );
      expect(destLeaf).toBeTruthy();
      expect(destLeaf!.view!.getMode()).toBe("reading");

      for (const leaf of [...h.openLeaves]) {
        await h.closeOrgLeaf(leaf);
      }
      h.vaultIndex.destroy();
      h.plugin.nodeNavigation.dispose();
    });
  });

  describe("6. Transclusion source update / rename / delete -> TransclusionRefreshController selective re-hydration", () => {
    it("refreshes ONLY on dependent file updates/renames/deletes, ignores unrelated .org files, and re-hydrates id: and file: slices", async () => {
      const files = new Map<string, string>([
        [
          "host.org",
          [
            "#+TITLE: Host Article",
            "",
            "* Embedded ID",
            "#+TRANSCLUDE: [[id:atom-node]] :level 2 :only-contents",
            "",
            "* Embedded File Slice",
            "#+TRANSCLUDE: [[file:slices/source-b.org::*Metrics]] :lines 1-3",
          ].join("\n"),
        ],
        [
          "atoms/source-a.org",
          [
            "* Atom Title",
            ":PROPERTIES:",
            ":ID: atom-node",
            ":END:",
            "Atom payload v1.",
          ].join("\n"),
        ],
        [
          "slices/source-b.org",
          [
            "* Metrics",
            "Metric line 1: v1",
            "Metric line 2: v1",
            "Metric line 3: ignored beyond slice",
          ].join("\n"),
        ],
        ["unrelated/other.org", "* Unrelated\nNot transcluded anywhere.\n"],
      ]);

      const index = new OrgIdIndex();
      for (const [p, content] of files) index.upsertFile(p, content);

      const baseApp = createMockApp();
      const tfiles = new Map<string, TFile>();
      for (const p of files.keys()) tfiles.set(p, new TFile(p));
      const app = {
        ...baseApp,
        vault: {
          ...baseApp.vault,
          getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
          getFiles: () => Array.from(tfiles.values()),
          cachedRead: async (f: TFile) => files.get(f.path) ?? "",
        },
      } as unknown as import("obsidian").App;

      const engine = new OrgTransclusionEngine(createVaultTransclusionProvider(app, index));
      let renderedRoot!: HTMLElement;
      const refreshSpy = vi.fn(async () => {
        const session = controller.beginHydration();
        renderedRoot = await renderOrgPreviewWithTransclusions(
          files.get("host.org")!,
          app,
          "host.org",
          { settings: { ...DEFAULT_SETTINGS, enableTransclusion: true } },
          {
            resolver: engine,
            signal: session.signal,
            isStale: session.isStale,
            onDependency: session.onDependency,
          }
        );
      });
      const controller = new TransclusionRefreshController(refreshSpy);

      await refreshSpy();
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(renderedRoot.textContent).toContain("Atom payload v1.");
      expect(renderedRoot.textContent).toContain("Metric line 2: v1");
      expect(renderedRoot.textContent).not.toContain("Metric line 3: ignored beyond slice");
      expect(controller.getTrackedDependencies().sort()).toEqual([
        "atoms/source-a.org",
        "slices/source-b.org",
      ]);

      // Unrelated .org changes MUST NOT trigger refresh
      expect(controller.notifyFileChanged("unrelated/other.org")).toBe(false);
      expect(controller.notifyFileChanged("random/new-note.org")).toBe(false);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      // 1. Update dependent id: source node
      const sourceAV2 = files
        .get("atoms/source-a.org")!
        .replace("Atom payload v1.", "Atom payload v2 (Emacs).");
      files.set("atoms/source-a.org", sourceAV2);
      index.upsertFile("atoms/source-a.org", sourceAV2);
      expect(controller.notifyFileChanged("atoms/source-a.org")).toBe(true);
      await vi.waitFor(() => {
        expect(renderedRoot.textContent).toContain("Atom payload v2 (Emacs).");
      });
      expect(refreshSpy).toHaveBeenCalledTimes(2);

      // 2. Update dependent file: slice
      const sourceBV2 = files
        .get("slices/source-b.org")!
        .replace("Metric line 2: v1", "Metric line 2: v2");
      files.set("slices/source-b.org", sourceBV2);
      index.upsertFile("slices/source-b.org", sourceBV2);
      expect(controller.notifyFileChanged("slices/source-b.org")).toBe(true);
      await vi.waitFor(() => {
        expect(renderedRoot.textContent).toContain("Metric line 2: v2");
      });
      expect(refreshSpy).toHaveBeenCalledTimes(3);

      // 3. Rename id: source file -> id: transclusion follows rename to new path!
      files.delete("atoms/source-a.org");
      files.set("atoms/source-a-renamed.org", sourceAV2);
      tfiles.delete("atoms/source-a.org");
      tfiles.set("atoms/source-a-renamed.org", new TFile("atoms/source-a-renamed.org"));
      index.renameFile("atoms/source-a.org", "atoms/source-a-renamed.org");

      expect(controller.notifyFileChanged("atoms/source-a.org")).toBe(true);
      await vi.waitFor(() => {
        expect(controller.getTrackedDependencies()).toContain("atoms/source-a-renamed.org");
      });
      expect(renderedRoot.textContent).toContain("Atom payload v2 (Emacs).");
      expect(controller.notifyFileChanged("atoms/source-a.org")).toBe(false); // Old path no longer tracked
      expect(controller.notifyFileChanged("unrelated/other.org")).toBe(false);

      // 4. Delete dependent source file -> renders missing callout & tracks unresolved targets
      files.delete("atoms/source-a-renamed.org");
      tfiles.delete("atoms/source-a-renamed.org");
      index.removeFile("atoms/source-a-renamed.org");

      expect(controller.notifyFileChanged("atoms/source-a-renamed.org")).toBe(true);
      await vi.waitFor(() => {
        expect(renderedRoot.querySelector(".org-transclusion-error-missing")).toBeTruthy();
      });
      expect(controller.tracksUnresolvedTargets()).toBe(true);

      // 5. Recreate atom-node in a new file -> unresolved tracker catches creation & re-hydrates
      const restoredA = sourceAV2.replace("Atom payload v2 (Emacs).", "Atom payload v3 (Restored).");
      files.set("atoms/restored.org", restoredA);
      tfiles.set("atoms/restored.org", new TFile("atoms/restored.org"));
      index.upsertFile("atoms/restored.org", restoredA);

      expect(controller.notifyFileChanged("atoms/restored.org")).toBe(true);
      await vi.waitFor(() => {
        expect(renderedRoot.textContent).toContain("Atom payload v3 (Restored).");
      });
      expect(controller.tracksUnresolvedTargets()).toBe(false);

      controller.dispose();
    });

    it("refreshes OrgView Reading View automatically when dependent source is modified, renamed, or deleted while ignoring unrelated vault.modify", async () => {
      const h = createWorkspaceHarness(
        {
          "host.org": {
            content: [
              "#+TITLE: Host",
              "",
              "#+TRANSCLUDE: [[id:dep-node]] :level 1",
              "#+TRANSCLUDE: [[file:dep-slice.org::*Slice]]",
            ].join("\n"),
          },
          "dep-id.org": {
            content: "* Dep Node\n:PROPERTIES:\n:ID: dep-node\n:END:\nDep ID v1.\n",
          },
          "dep-slice.org": {
            content: "* Slice\nSlice body v1.\n",
          },
          "unrelated.org": {
            content: "* Unrelated\nUnchanged.\n",
          },
        },
        { defaultMode: "reading" }
      );
      await h.vaultIndex.initialize();

      const { leaf, view } = await h.openOrgLeaf("host.org", "reading");
      await flushAsync();
      const renderSpy = vi.spyOn(view, "renderPreview");

      expect(view.contentEl.textContent).toContain("Dep ID v1.");
      expect(view.contentEl.textContent).toContain("Slice body v1.");

      // Firing vault modify for unrelated file does NOT trigger TransclusionRefreshController
      renderSpy.mockClear();
      h.triggerVault("modify", h.files.get("unrelated.org")!.file);
      expect(renderSpy).not.toHaveBeenCalled();

      // Modifying dep-slice.org triggers refresh immediately and renders Slice body v2
      h.updateDiskFile("dep-slice.org", "* Slice\nSlice body v2.\n");
      await flushAsync();
      expect(renderSpy).toHaveBeenCalled();
      expect(view.contentEl.textContent).toContain("Slice body v2.");

      // Renaming dep-id.org -> moved/dep-id.org preserves id: expansion
      h.renameDiskFile("dep-id.org", "moved/dep-id.org");
      await flushAsync();
      expect(view.contentEl.textContent).toContain("Dep ID v1.");

      // Deleting moved/dep-id.org transitions id: slot to missing callout without mutating host.org
      h.deleteDiskFile("moved/dep-id.org");
      await flushAsync();
      expect(view.contentEl.querySelector(".org-transclusion-error-missing")).toBeTruthy();
      expect(h.saveSpy).not.toHaveBeenCalled();

      await h.closeOrgLeaf(leaf);
      h.vaultIndex.destroy();
      h.plugin.nodeNavigation.dispose();
    });
  });

  describe("7. Deep nesting (depth 8 allowed, depth 9 blocked), diamond DAG reuse, and 3-node cycle", () => {
    it("allows depth 8 when transclusionMaxDepth=8 and blocks depth 9 cleanly", async () => {
      const files = new Map<string, string>();
      const index = new OrgIdIndex();

      const lines: string[] = [];
      for (let i = 1; i <= 9; i++) {
        const nextDirective =
          i < 9 ? `#+TRANSCLUDE: [[id:chain-${i + 1}]] :only-contents` : "Terminal node 9.";
        lines.push(
          `* Chain ${i}`,
          ":PROPERTIES:",
          `:ID: chain-${i}`,
          ":END:",
          `MARKER_DEPTH_${i}`,
          nextDirective,
          ""
        );
      }
      files.set("chain.org", lines.join("\n"));
      index.upsertFile("chain.org", lines.join("\n"));

      const engine = new OrgTransclusionEngine(createMemoryTransclusionProvider(files, index), {
        defaultMaxDepth: 8,
      });
      const app = createMockApp() as unknown as import("obsidian").App;

      // Exact depth-8 chain (chain-1 .. chain-8) with no 9th hop succeeds with zero errors
      const exact8Lines = lines
        .join("\n")
        .replace("#+TRANSCLUDE: [[id:chain-9]] :only-contents", "Stop cleanly at 8.");
      const files8 = new Map<string, string>([["chain8.org", exact8Lines]]);
      const index8 = new OrgIdIndex();
      index8.upsertFile("chain8.org", exact8Lines);
      const engine8 = new OrgTransclusionEngine(createMemoryTransclusionProvider(files8, index8), {
        defaultMaxDepth: 8,
      });

      const exact8Root = await renderOrgPreviewWithTransclusions(
        "* Host 8\n#+TRANSCLUDE: [[id:chain-1]] :only-contents\n",
        app,
        "host8.org",
        { settings: { ...DEFAULT_SETTINGS, enableTransclusion: true, transclusionMaxDepth: 8 } },
        { resolver: engine8 }
      );
      expect(exact8Root.querySelectorAll(".org-transclusion-error")).toHaveLength(0);
      for (let i = 1; i <= 8; i++) {
        expect(exact8Root.textContent).toContain(`MARKER_DEPTH_${i}`);
      }

      // 9-hop chain allows 1..8 (depth 0..7) and blocks 9th hop (depth 8) as depth-exceeded
      const depth9Root = await renderOrgPreviewWithTransclusions(
        "* Host 9\n#+TRANSCLUDE: [[id:chain-1]] :only-contents\n",
        app,
        "host9.org",
        { settings: { ...DEFAULT_SETTINGS, enableTransclusion: true, transclusionMaxDepth: 8 } },
        { resolver: engine }
      );
      for (let i = 1; i <= 8; i++) {
        expect(depth9Root.textContent).toContain(`MARKER_DEPTH_${i}`);
        expect(
          depth9Root.querySelector(
            `.org-transclusion[data-transclusion-status="ok"][data-transclusion-depth="${i - 1}"]`
          )
        ).toBeTruthy();
      }
      expect(depth9Root.textContent).not.toContain("MARKER_DEPTH_9");
      const exceeded = depth9Root.querySelector<HTMLElement>(
        '.org-transclusion-error-depth-exceeded[data-transclusion-depth="8"]'
      );
      expect(exceeded).toBeTruthy();
      expect(exceeded!.textContent).toContain("exceeds limit of 8");
    });

    it("expands diamond DAG reuse cleanly without false-positive cycle errors and blocks 3-node cycles", async () => {
      const dagDoc = [
        "* Branch One",
        ":PROPERTIES:",
        ":ID: node-branch-1",
        ":END:",
        "Branch 1 intro.",
        "#+TRANSCLUDE: [[id:shared-leaf]] :only-contents",
        "",
        "* Branch Two",
        ":PROPERTIES:",
        ":ID: node-branch-2",
        ":END:",
        "Branch 2 intro.",
        "#+TRANSCLUDE: [[id:shared-leaf]] :only-contents",
        "",
        "* Shared Leaf",
        ":PROPERTIES:",
        ":ID: shared-leaf",
        ":END:",
        "SHARED_LEAF_PAYLOAD: reused across diamond branches.",
        "",
        "* Cycle Node A",
        ":PROPERTIES:",
        ":ID: tri-a",
        ":END:",
        "TRIA_MARKER",
        "#+TRANSCLUDE: [[id:tri-b]]",
        "",
        "* Cycle Node B",
        ":PROPERTIES:",
        ":ID: tri-b",
        ":END:",
        "TRIB_MARKER",
        "#+TRANSCLUDE: [[file:dag.org::*Cycle Node C]]",
        "",
        "* Cycle Node C",
        ":PROPERTIES:",
        ":ID: tri-c",
        ":END:",
        "TRIC_MARKER",
        "#+TRANSCLUDE: [[id:tri-a]]",
        "",
      ].join("\n");

      const hostDiamond = [
        "#+TITLE: Diamond DAG",
        "",
        "* Left Arm",
        "#+TRANSCLUDE: [[id:node-branch-1]] :only-contents",
        "",
        "* Right Arm",
        "#+TRANSCLUDE: [[id:node-branch-2]] :only-contents",
      ].join("\n");

      const files = new Map<string, string>([
        ["dag.org", dagDoc],
        ["diamond-host.org", hostDiamond],
      ]);
      const index = new OrgIdIndex();
      for (const [p, content] of files) index.upsertFile(p, content);

      const engine = new OrgTransclusionEngine(createMemoryTransclusionProvider(files, index));
      const app = createMockApp() as unknown as import("obsidian").App;

      // Diamond DAG: BOTH expansions of shared-leaf MUST succeed with 0 cycle errors
      const diamondRoot = await renderOrgPreviewWithTransclusions(
        hostDiamond,
        app,
        "diamond-host.org",
        { settings: { ...DEFAULT_SETTINGS, enableTransclusion: true, transclusionMaxDepth: 4 } },
        { resolver: engine }
      );
      expect(diamondRoot.querySelectorAll(".org-transclusion-error")).toHaveLength(0);
      const sharedExpansions = diamondRoot.querySelectorAll(
        '.org-transclusion[data-canonical-key="id:shared-leaf"][data-transclusion-status="ok"]'
      );
      expect(sharedExpansions).toHaveLength(2);
      for (const exp of Array.from(sharedExpansions)) {
        expect(exp.textContent).toContain("SHARED_LEAF_PAYLOAD");
      }

      // 3-node mixed cycle A -> B -> C -> A: A, B, C expand and C -> A blocks cleanly as "cycle"
      const cycleRoot = await renderOrgPreviewWithTransclusions(
        "* Cycle Host\n#+TRANSCLUDE: [[id:tri-a]]\n",
        app,
        "cycle-host.org",
        { settings: { ...DEFAULT_SETTINGS, enableTransclusion: true, transclusionMaxDepth: 6 } },
        { resolver: engine }
      );
      expect(cycleRoot.textContent).toContain("TRIA_MARKER");
      expect(cycleRoot.textContent).toContain("TRIB_MARKER");
      expect(cycleRoot.textContent).toContain("TRIC_MARKER");
      const cycleErrors = cycleRoot.querySelectorAll(
        '.org-transclusion-error-cycle[data-transclusion-status="cycle"]'
      );
      expect(cycleErrors).toHaveLength(1);
      expect(cycleErrors[0].getAttribute("data-transclusion-depth")).toBe("3");
    });
  });

  describe("8. Plugin lifecycle & command/view churn", () => {
    it("cleans up hover popovers, views, and listeners across registerNodeNavigation mount/dispose/re-mount and OrgView open/close churn", async () => {
      const targetDoc = [
        "* Target Knowledge",
        ":PROPERTIES:",
        ":ID: churn-target",
        ":END:",
        "Target preview body.",
      ].join("\n");
      const viewerDoc = [
        "* Viewer Doc",
        "Jump to [[id:churn-target][Target]].",
      ].join("\n");

      const h = createWorkspaceHarness(
        {
          "target.org": { content: targetDoc },
          "viewer.org": { content: viewerDoc },
        },
        { defaultMode: "reading" }
      );
      await h.vaultIndex.initialize();

      const popoverHost = document.createElement("div");
      document.body.appendChild(popoverHost);

      try {
        // 1. Mount -> Backlinks view -> Hover -> Dispose -> Re-mount cycle
        for (let cycle = 0; cycle < 2; cycle++) {
          h.plugin.nodeNavigation.dispose();
          h.registeredViews.clear();
          h.registeredCommands.clear();

          const handle = registerNodeNavigation({
            plugin: h.plugin as unknown as Parameters<typeof registerNodeNavigation>[0]["plugin"],
            vaultIndex: h.vaultIndex,
          });
          h.plugin.nodeNavigation = handle;

          expect(h.registeredViews.has(VIEW_TYPE_ORG_BACKLINKS)).toBe(true);
          expect(Array.from(h.registeredCommands.keys())).toEqual([
            "quick-open-node",
            "open-backlinks",
          ]);

          const backlinksLeaf = { app: h.app };
          const backlinksFactory = h.registeredViews.get(VIEW_TYPE_ORG_BACKLINKS)!;
          const backlinksView = backlinksFactory(backlinksLeaf) as OrgBacklinksView;
          await backlinksView.onOpen();
          backlinksView.setTargetFile("target.org");
          expect(backlinksView.contentEl.textContent).toContain("viewer.org:2");

          // Hover inside a preview container attached to handle
          const hoverRoot = document.createElement("div");
          const link = document.createElement("a");
          link.className = "org-link-id";
          link.dataset.orgId = "churn-target";
          hoverRoot.appendChild(link);
          document.body.appendChild(hoverRoot);

          handle.attachHoverPreview(hoverRoot, {
            hoverDelayMs: 0,
            hostContainer: popoverHost,
          });
          link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          await flushAsync(5);
          expect(popoverHost.querySelectorAll(".org-node-hover-popover")).toHaveLength(1);

          // Dispose handle + close backlinks view -> zero popovers, leaves detached, closed view ignores updates
          handle.dispose();
          await backlinksView.onClose();
          expect(h.app.workspace.detachLeavesOfType).toHaveBeenCalledWith(VIEW_TYPE_ORG_BACKLINKS);
          expect(popoverHost.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);
          expect(document.body.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);

          // Hovering disposed link does nothing
          link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          await flushAsync(5);
          expect(popoverHost.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);

          const rendersAfterClose = backlinksView.getRenderCount();
          h.vaultIndex.upsertContent("viewer.org", `${viewerDoc}\n[[id:churn-target]]\n`);
          expect(backlinksView.getRenderCount()).toBe(rendersAfterClose);

          hoverRoot.remove();
        }

        // 2. Repeated OrgView onOpen -> onClose -> onOpen leaf churn with active hover popovers
        for (let iter = 0; iter < 4; iter++) {
          const { leaf, view } = await h.openOrgLeaf("viewer.org", "reading");
          const preview = view.contentEl.querySelector<HTMLElement>(".org-preview")!;
          expect(preview).toBeTruthy();

          // Re-attach immediate hover preview on rendered link and open popover
          const disposeLocalHover = h.plugin.nodeNavigation.attachHoverPreview(preview, {
            hoverDelayMs: 0,
            hostContainer: popoverHost,
          });
          const link = preview.querySelector<HTMLAnchorElement>("a.org-link-id")!;
          expect(link).toBeTruthy();
          link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          await flushAsync(5);
          expect(popoverHost.querySelectorAll(".org-node-hover-popover")).toHaveLength(1);

          disposeLocalHover();
          await h.closeOrgLeaf(leaf);
          expect(view.editor).toBeNull();
          expect(document.body.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);
        }

        // 3. Same-instance OrgView onOpen -> onClose -> onOpen restores editor cleanly and leaks zero popovers
        const sameView = new OrgView(
          { app: h.app } as unknown as import("obsidian").WorkspaceLeaf,
          h.plugin
        );
        sameView.file = h.files.get("viewer.org")!.file as unknown as import("obsidian").TFile;
        attachObsidianDomHelpers(sameView.contentEl);

        await (sameView as unknown as { onOpen(): Promise<void> }).onOpen();
        sameView.setViewData(viewerDoc, true);
        expect(sameView.editor).not.toBeNull();
        // Trigger hover popover via OrgView's own disposeHoverPreview hook (using default 120ms delay)
        const link1 = sameView.contentEl.querySelector<HTMLAnchorElement>("a.org-link-id")!;
        link1.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await flushAsync(140);
        expect(document.body.querySelectorAll(".org-node-hover-popover")).toHaveLength(1);

        await (sameView as unknown as { onClose(): Promise<void> }).onClose();
        expect(sameView.editor).toBeNull();
        expect(document.body.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);

        await (sameView as unknown as { onOpen(): Promise<void> }).onOpen();
        sameView.setViewData(viewerDoc, true);
        expect(sameView.editor).not.toBeNull();
        expect(sameView.getViewData()).toBe(viewerDoc);
        await (sameView as unknown as { onClose(): Promise<void> }).onClose();
        expect(sameView.editor).toBeNull();
        expect(document.body.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);
      } finally {
        popoverHost.remove();
        h.vaultIndex.destroy();
        h.plugin.nodeNavigation.dispose();
      }
    });
  });

  describe("9. Simulated abnormal close / abrupt teardown while buffer is dirty or conflicted", () => {
    it("preserves exact disk bytes on abrupt close while conflicted and restores clean FileSyncGuard state on reopen", async () => {
      const initial = "* Critical Note\r\nDisk baseline.\r\n";
      const localUnsaved = "* Critical Note\r\nUnsaved Obsidian crash buffer.\r\n";
      const emacsOnDisk = "* Critical Note\r\nEmacs authoritative content on disk.\r\n";

      const h = createWorkspaceHarness(
        { "notes/critical.org": { content: initial } },
        { defaultMode: "live" }
      );
      await h.vaultIndex.initialize();
      const upsertSpy = vi.spyOn(h.vaultIndex, "upsertContent");

      const { leaf, view } = await h.openOrgLeaf("notes/critical.org", "live");

      // Local edit makes buffer dirty and starts debounced outlineTimer (180ms)
      view.editor!.dispatch({
        changes: {
          from: 0,
          to: view.editor!.state.doc.length,
          insert: localUnsaved.replace(/\r\n/g, "\n"),
        },
        userEvent: "input",
      });
      expect(view.syncGuard.isDirty()).toBe(true);

      // Emacs modifies disk before user resolves or saves -> view becomes conflicted
      h.updateDiskFile("notes/critical.org", emacsOnDisk, false);
      view.setViewData(emacsOnDisk, false);
      expect(view.syncGuard.isConflicted()).toBe(true);

      // Abrupt close WITHOUT user clicking Reload / Keep / Copy
      h.saveSpy.mockClear();
      upsertSpy.mockClear();
      await h.closeOrgLeaf(leaf);

      // Must NOT save over Emacs bytes, and pending outlineTimer must be cleared
      expect(h.saveSpy).not.toHaveBeenCalled();
      expect(h.files.get("notes/critical.org")!.content).toBe(emacsOnDisk);
      expect(sha256(h.files.get("notes/critical.org")!.content)).toBe(sha256(emacsOnDisk));
      await flushAsync(220);
      expect(upsertSpy).not.toHaveBeenCalled();

      // Reopen file cleanly -> fresh OrgView starts with clean FileSyncGuard matching disk
      const { leaf: reopenedLeaf, view: reopenedView } = await h.openOrgLeaf(
        "notes/critical.org",
        "live"
      );
      expect(reopenedView.syncGuard.isDirty()).toBe(false);
      expect(reopenedView.syncGuard.isConflicted()).toBe(false);
      expect(reopenedView.syncGuard.getExternalDiskContent()).toBeNull();
      expect(reopenedView.syncGuard.getLastDiskContent()).toBe(emacsOnDisk);
      expect(sha256(reopenedView.getViewData())).toBe(sha256(emacsOnDisk));
      expect(
        reopenedView.contentEl.querySelector(".org-conflict-banner")?.classList.contains("is-hidden")
      ).toBe(true);

      await h.closeOrgLeaf(reopenedLeaf);
      h.vaultIndex.destroy();
      h.plugin.nodeNavigation.dispose();
    });

    it("survives abrupt teardown or failed save while dirty without corrupting disk or FileSyncGuard on reopen", async () => {
      const initial = "* Dirty Teardown\nOriginal disk bytes.\n";
      const dirtyEdit = "* Dirty Teardown\nHalf-typed crash buffer.\n";

      // Case A: Abrupt editor destroy (simulating crash before onClose save)
      {
        const h = createSingleViewHarness("notes/crash.org", initial, "live");
        await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
        h.view.setViewData(initial, true);

        h.view.editor!.dispatch({
          changes: { from: 0, to: h.view.editor!.state.doc.length, insert: dirtyEdit },
          userEvent: "input",
        });
        expect(h.view.syncGuard.isDirty()).toBe(true);
        h.saveSpy.mockClear();

        // Simulate abrupt teardown without graceful save
        h.view.editor!.destroy();
        h.view.editor = null;
        expect(h.saveSpy).not.toHaveBeenCalled();
        expect(h.getDisk()).toBe(initial);

        // Fresh reopen restores clean FileSyncGuard from disk
        const fresh = createSingleViewHarness("notes/crash.org", h.getDisk(), "live");
        await (fresh.view as unknown as { onOpen(): Promise<void> }).onOpen();
        fresh.view.setViewData(h.getDisk(), true);
        expect(fresh.view.syncGuard.isDirty()).toBe(false);
        expect(fresh.view.syncGuard.isConflicted()).toBe(false);
        expect(fresh.view.getViewData()).toBe(initial);
        await (fresh.view as unknown as { onClose(): Promise<void> }).onClose();
      }

      // Case B: onClose save throws disk write error while dirty -> disk remains intact & guard state stays bounded
      {
        const h = createSingleViewHarness("notes/io-fail.org", initial, "live");
        h.saveSpy.mockRejectedValueOnce(new Error("EACCES: disk read-only"));

        await (h.view as unknown as { onOpen(): Promise<void> }).onOpen();
        h.view.setViewData(initial, true);

        h.view.editor!.dispatch({
          changes: { from: 0, to: h.view.editor!.state.doc.length, insert: dirtyEdit },
          userEvent: "input",
        });

        await expect(
          (h.view as unknown as { onClose(): Promise<void> }).onClose()
        ).rejects.toThrow("EACCES: disk read-only");
        expect(h.getDisk()).toBe(initial);

        // Standalone FileSyncGuard sanity: clear/reset restores clean invariants
        const guard = new FileSyncGuard();
        guard.reset(dirtyEdit);
        expect(guard.onDiskUpdate(initial, dirtyEdit, true)).toEqual({
          action: "replace-editor",
          content: initial,
        });
        expect(guard.isDirty()).toBe(false);
        expect(guard.isConflicted()).toBe(false);
      }
    });
  });
});
