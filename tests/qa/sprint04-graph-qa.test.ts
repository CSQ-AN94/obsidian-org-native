import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, EventRef, WorkspaceLeaf } from "obsidian";
import {
  PLUGIN_ID,
  VIEW_TYPE_ORG,
  VIEW_TYPE_ORG_GRAPH,
  VIEW_TYPE_ORG_LOCAL_GRAPH,
} from "../../src/constants";
import {
  buildOrgGraph,
  diffOrgGraphs,
} from "../../src/core/graph/graphAdapter";
import { buildLocalOrgGraph } from "../../src/core/graph/localGraph";
import {
  canonicalOrgNodeKey,
  type OrgGraphViewState,
} from "../../src/core/graph/types";
import { VaultIndexService } from "../../src/core/index/vaultIndexService";
import {
  createMemoryTransclusionProvider,
  OrgTransclusionEngine,
} from "../../src/core/transclusion";
import { translate, type TranslationKey } from "../../src/i18n";
import type OrgNativePlugin from "../../src/main";
import { DEFAULT_SETTINGS, type OrgNativeSettings } from "../../src/settings";
import { OrgView } from "../../src/views/OrgView";
import {
  OrgGlobalGraphView,
  OrgLocalGraphView,
  registerOrgGraph,
  type OrgGraphHandle,
} from "../../src/views/graph";
import { OrgGraphSimulation } from "../../src/views/graph/simulation";
import { attachObsidianDomHelpers, createMockApp, TFile } from "../mocks/obsidian";

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function loadTestVaultDiskFiles(): Map<string, string> {
  const vaultDir = path.resolve(process.cwd(), "test-vault");
  const orgFiles = fs
    .readdirSync(vaultDir)
    .filter((f) => f.endsWith(".org"))
    .sort();
  const map = new Map<string, string>();
  for (const name of orgFiles) {
    map.set(name, fs.readFileSync(path.join(vaultDir, name), "utf8"));
  }
  return map;
}

interface MockLeaf {
  id: string;
  view: unknown;
  viewState: Record<string, unknown>;
  openFile: ReturnType<typeof vi.fn>;
  setViewState: (state: Record<string, unknown>) => Promise<void>;
  getViewState: () => Record<string, unknown>;
  detach: () => void;
}

interface WorkspaceQaHarness {
  app: App;
  plugin: OrgNativePlugin;
  vaultIndex: VaultIndexService;
  handle: OrgGraphHandle;
  leaves: MockLeaf[];
  activeLeaf: MockLeaf | null;
  commands: Map<string, { id: string; name: string; callback?: () => void }>;
  modifySpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
  deleteSpy: ReturnType<typeof vi.fn>;
  saveDataSpy: ReturnType<typeof vi.fn>;
  getActiveListenerCount: () => number;
  setActiveLeaf: (leaf: MockLeaf | null) => void;
  openOrgFile: (filePath: string, opts?: { newLeaf?: boolean | "tab" | "split" }) => Promise<MockLeaf>;
  upsertDiskFile: (filePath: string, content: string) => void;
  deleteDiskFile: (filePath: string) => void;
  dispose: () => Promise<void>;
}

function createWorkspaceHarness(
  initialFiles: Record<string, string> | Map<string, string>,
  options: { debounceMs?: number } = {}
): WorkspaceQaHarness {
  const baseApp = createMockApp();
  const fileObjs = new Map<string, TFile>();
  const fileContents = new Map<string, string>();

  const entries =
    initialFiles instanceof Map ? Array.from(initialFiles.entries()) : Object.entries(initialFiles);
  for (const [p, content] of entries) {
    fileObjs.set(p, new TFile(p));
    fileContents.set(p, content);
  }

  const wsHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const vaultHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const registeredViews = new Map<string, (leaf: WorkspaceLeaf) => unknown>();
  const commands = new Map<string, { id: string; name: string; callback?: () => void }>();
  const leaves: MockLeaf[] = [];
  let leafCounter = 0;

  const harnessRef: {
    activeLeaf: MockLeaf | null;
    plugin?: OrgNativePlugin;
    app?: App;
  } = { activeLeaf: null };

  const emitWs = (event: string, ...args: unknown[]) => {
    const set = wsHandlers.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) cb(...args);
  };

  const emitVault = (event: string, ...args: unknown[]) => {
    const set = vaultHandlers.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) cb(...args);
  };

  const closeLeafView = (leaf: MockLeaf) => {
    const view = leaf.view as { onClose?: () => Promise<void> | void } | null;
    if (view && typeof view.onClose === "function") {
      void view.onClose();
    }
    const idx = leaves.indexOf(leaf);
    if (idx >= 0) leaves.splice(idx, 1);
    if (harnessRef.activeLeaf === leaf) {
      harnessRef.activeLeaf = leaves[0] ?? null;
    }
  };

  const createLeaf = (): MockLeaf => {
    const leaf: MockLeaf & { app?: App } = {
      id: `leaf-${++leafCounter}`,
      get app() {
        return harnessRef.app;
      },
      view: null,
      viewState: {},
      openFile: vi.fn(async (file: TFile) => {
        const currentView = leaf.view as { getViewType?: () => string; onClose?: () => Promise<void> } | null;
        if (!currentView || currentView.getViewType?.() !== VIEW_TYPE_ORG) {
          if (currentView && typeof currentView.onClose === "function") {
            await currentView.onClose();
          }
          const view = new OrgView(
            leaf as unknown as WorkspaceLeaf,
            harnessRef.plugin!
          );
          attachObsidianDomHelpers(view.contentEl);
          leaf.view = view;
          leaf.viewState = { type: VIEW_TYPE_ORG };
          await (view as unknown as { onOpen(): Promise<void> }).onOpen();
        }
        const orgView = leaf.view as OrgView;
        orgView.file = file as unknown as import("obsidian").TFile;
        harnessRef.activeLeaf = leaf;
        const content = fileContents.get(file.path) ?? "";
        orgView.setViewData(content, true);
        emitWs("file-open", file);
        emitWs("active-leaf-change", leaf);
      }),
      setViewState: async (state: Record<string, unknown>) => {
        const type = String(state.type ?? "");
        const prevView = leaf.view as { getViewType?: () => string; onClose?: () => Promise<void> } | null;
        if (prevView && prevView.getViewType?.() !== type && typeof prevView.onClose === "function") {
          await prevView.onClose();
        }
        const creator = registeredViews.get(type);
        if (creator && prevView?.getViewType?.() !== type) {
          const view = creator(leaf as unknown as WorkspaceLeaf) as {
            contentEl?: HTMLElement;
            onOpen?: () => Promise<void>;
            setState?: (s: unknown, r: unknown) => Promise<void>;
          };
          if (view.contentEl) attachObsidianDomHelpers(view.contentEl);
          leaf.view = view;
          await view.onOpen?.();
          if (state.state) {
            await view.setState?.(state.state, { history: false });
          }
        }
        leaf.viewState = { ...state };
        if (state.active) {
          harnessRef.activeLeaf = leaf;
          emitWs("active-leaf-change", leaf);
        }
      },
      getViewState: () => ({ ...leaf.viewState }),
      detach: () => closeLeafView(leaf),
    };
    leaves.push(leaf);
    return leaf;
  };

  const modifySpy = vi.fn(async (file: TFile, data: string) => {
    fileContents.set(file.path, data);
    emitVault("modify", file);
  });
  const createSpy = vi.fn(async (p: string, data: string) => {
    const file = new TFile(p);
    fileObjs.set(p, file);
    fileContents.set(p, data);
    emitVault("create", file);
    return file;
  });
  const deleteSpy = vi.fn(async (file: TFile) => {
    fileObjs.delete(file.path);
    fileContents.delete(file.path);
    emitVault("delete", file);
  });
  const saveDataSpy = vi.fn(async (_data: unknown) => {});

  const makeSubscriber = (map: Map<string, Set<(...args: unknown[]) => void>>) => {
    return (event: string, cb: (...args: unknown[]) => void): EventRef => {
      let set = map.get(event);
      if (!set) {
        set = new Set();
        map.set(event, set);
      }
      set.add(cb);
      return { event, cb, map } as unknown as EventRef;
    };
  };

  const removeRef = (ref: unknown) => {
    const r = ref as { event?: string; cb?: (...args: unknown[]) => void; map?: Map<string, Set<(...args: unknown[]) => void>> } | null;
    if (r?.event && r.cb && r.map) {
      r.map.get(r.event)?.delete(r.cb);
    }
  };

  const app = {
    ...baseApp,
    workspace: {
      ...baseApp.workspace,
      get activeLeaf() {
        return harnessRef.activeLeaf;
      },
      set activeLeaf(leaf: MockLeaf | null) {
        harnessRef.activeLeaf = leaf;
      },
      getLeavesOfType: (type: string) =>
        leaves.filter(
          (l) => (l.view as { getViewType?: () => string } | null)?.getViewType?.() === type
        ),
      getActiveViewOfType: <T>(ctor: new (...args: never[]) => T): T | null => {
        const v = harnessRef.activeLeaf?.view;
        return v instanceof ctor ? (v as T) : null;
      },
      getActiveFile: (): TFile | null => {
        const v = harnessRef.activeLeaf?.view as { file?: TFile | null } | null;
        return v?.file ?? null;
      },
      getMostRecentLeaf: () => harnessRef.activeLeaf,
      getLeaf: (newLeaf?: boolean | "tab" | "split" | "window") => {
        if (newLeaf === true || newLeaf === "tab" || newLeaf === "split" || newLeaf === "window") {
          return createLeaf();
        }
        return harnessRef.activeLeaf ?? createLeaf();
      },
      getRightLeaf: () => createLeaf(),
      revealLeaf: (leaf: MockLeaf) => {
        harnessRef.activeLeaf = leaf;
        emitWs("active-leaf-change", leaf);
      },
      detachLeavesOfType: (type: string) => {
        const targets = leaves.filter(
          (l) => (l.view as { getViewType?: () => string } | null)?.getViewType?.() === type
        );
        for (const l of targets) closeLeafView(l);
      },
      setActiveLeaf: (leaf: MockLeaf) => {
        harnessRef.activeLeaf = leaf;
        emitWs("active-leaf-change", leaf);
      },
      on: makeSubscriber(wsHandlers),
      offref: removeRef,
    },
    vault: {
      ...baseApp.vault,
      getFiles: () => Array.from(fileObjs.values()),
      getAbstractFileByPath: (p: string) => fileObjs.get(p) ?? null,
      cachedRead: async (file: TFile) => fileContents.get(file.path) ?? "",
      read: async (file: TFile) => fileContents.get(file.path) ?? "",
      modify: modifySpy,
      create: createSpy,
      delete: deleteSpy,
      on: makeSubscriber(vaultHandlers),
      offref: removeRef,
    },
  } as unknown as App;

  harnessRef.app = app;

  const settings: OrgNativeSettings = {
    ...DEFAULT_SETTINGS,
    defaultMode: "reading",
    enableTransclusion: true,
  };

  const pluginEventRefs: EventRef[] = [];
  const plugin = {
    app,
    settings,
    uiLanguage: "en" as const,
    t: (key: TranslationKey) => translate("en", key),
    saveData: saveDataSpy,
    registerView: (type: string, creator: (leaf: WorkspaceLeaf) => unknown) => {
      registeredViews.set(type, creator);
    },
    addCommand: (cmd: { id: string; name: string; callback?: () => void }) => {
      commands.set(`${PLUGIN_ID}:${cmd.id}`, cmd);
    },
    addRibbonIcon: (_icon: string, title: string, cb: () => void) => {
      const btn = document.createElement("button");
      btn.setAttribute("aria-label", title);
      btn.addEventListener("click", cb);
      return btn;
    },
    registerEvent: (ref: EventRef) => {
      pluginEventRefs.push(ref);
    },
  } as unknown as OrgNativePlugin;

  harnessRef.plugin = plugin;

  const vaultIndex = new VaultIndexService(app, plugin, {
    debounceMs: options.debounceMs ?? 0,
  });
  vaultIndex.start();

  const transclusionEngine = new OrgTransclusionEngine(
    createMemoryTransclusionProvider(fileContents, vaultIndex.index),
    { defaultMaxDepth: settings.transclusionMaxDepth }
  );

  (plugin as unknown as Record<string, unknown>).vaultIndex = vaultIndex;
  (plugin as unknown as Record<string, unknown>).transclusionEngine = transclusionEngine;

  const handle = registerOrgGraph({ plugin, vaultIndex });
  (plugin as unknown as Record<string, unknown>).graph = handle;

  const getActiveListenerCount = () => {
    let total = 0;
    for (const s of wsHandlers.values()) total += s.size;
    for (const s of vaultHandlers.values()) total += s.size;
    return total;
  };

  return {
    app,
    plugin,
    vaultIndex,
    handle,
    leaves,
    get activeLeaf() {
      return harnessRef.activeLeaf;
    },
    commands,
    modifySpy,
    createSpy,
    deleteSpy,
    saveDataSpy,
    getActiveListenerCount,
    setActiveLeaf: (leaf: MockLeaf | null) => {
      harnessRef.activeLeaf = leaf;
      if (leaf) emitWs("active-leaf-change", leaf);
    },
    openOrgFile: async (filePath: string, opts = {}) => {
      const file = fileObjs.get(filePath);
      if (!file) throw new Error(`Missing test file: ${filePath}`);
      const leaf =
        opts.newLeaf || !harnessRef.activeLeaf || (harnessRef.activeLeaf.view as { getViewType?: () => string })?.getViewType?.() !== VIEW_TYPE_ORG
          ? createLeaf()
          : harnessRef.activeLeaf;
      await leaf.openFile(file);
      return leaf;
    },
    upsertDiskFile: (filePath: string, content: string) => {
      const existed = fileObjs.has(filePath);
      const file = fileObjs.get(filePath) ?? new TFile(filePath);
      fileObjs.set(filePath, file);
      fileContents.set(filePath, content);
      emitVault(existed ? "modify" : "create", file);
    },
    deleteDiskFile: (filePath: string) => {
      const file = fileObjs.get(filePath);
      if (!file) return;
      fileObjs.delete(filePath);
      fileContents.delete(filePath);
      emitVault("delete", file);
    },
    dispose: async () => {
      handle.dispose();
      for (const l of [...leaves]) {
        const view = l.view as { onClose?: () => Promise<void> | void } | null;
        if (view && typeof view.onClose === "function") {
          await view.onClose();
        }
      }
      leaves.length = 0;
      vaultIndex.dispose();
      for (const ref of pluginEventRefs) {
        removeRef(ref);
      }
      pluginEventRefs.length = 0;
    },
  };
}

function setElementBox(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
}

function buildSyntheticGraphScaleCorpus(totalNodes: number, fileCount: number): Map<string, string> {
  const nodesPerFile = totalNodes / fileCount;
  const tag = `s4_${totalNodes}`;
  const nodeId = (g: number) => `s4-${tag}-${g}`;
  const files = new Map<string, string>();

  for (let f = 0; f < fileCount; f++) {
    const lines = [
      `#+TITLE: Scale Corpus ${f + 1}/${fileCount}`,
      `#+FILETAGS: :scale:cluster${f % 5}:`,
      "",
    ];
    for (let k = 0; k < nodesPerFile; k++) {
      const g = f * nodesPerFile + k;
      const level = (k % 3) + 1;
      const next = (g + 1) % totalNodes;
      const cross = (g + nodesPerFile + 3) % totalNodes;
      const transclude = (g + Math.max(5, Math.floor(totalNodes / 4))) % totalNodes;
      lines.push(`${"*".repeat(level)} Node ${g} :lvl${level}:`);
      lines.push(":PROPERTIES:");
      lines.push(`:ID: ${nodeId(g)}`);
      lines.push(":END:");
      lines.push(`Refs: [[id:${nodeId(next)}]], [[id:${nodeId(cross)}]].`);
      if (k % 5 === 0) {
        lines.push(`#+TRANSCLUDE: [[id:${nodeId(transclude)}]] :only-contents`);
      }
      lines.push("");
    }
    files.set(`scale/file-${String(f).padStart(3, "0")}.org`, lines.join("\n"));
  }
  return files;
}

describe("Sprint 04 Graph QA — Full Integration, Sync, Scale & Byte-Safety", () => {
  const activeHarnesses: WorkspaceQaHarness[] = [];

  afterEach(async () => {
    while (activeHarnesses.length > 0) {
      const h = activeHarnesses.pop()!;
      await h.dispose();
    }
    vi.restoreAllMocks();
    document.body.className = "";
    document.body.replaceChildren();
  });

  it("1. Opens Global Graph & File Graph via registerOrgGraph sharing one OrgIdIndex", async () => {
    const disk = loadTestVaultDiskFiles();
    const h = createWorkspaceHarness(disk);
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    const globalLeaf = await h.handle.openGlobalGraph();
    expect(globalLeaf).not.toBeNull();

    const globalView = globalLeaf!.view as OrgGlobalGraphView;
    expect(globalView).toBeInstanceOf(OrgGlobalGraphView);
    expect(globalView.getViewType()).toBe(VIEW_TYPE_ORG_GRAPH);

    const nodeData = globalView.getGraphData()!;
    expect(nodeData.granularity).toBe("node");
    expect(nodeData.nodeMap.has("id:graph-showcase-hub")).toBe(true);
    expect(nodeData.nodeMap.has("id:graph-layer-core")).toBe(true);
    expect(nodeData.nodeMap.has("id:graph-layer-leaf")).toBe(true);
    expect(nodeData.nodeMap.has("id:graph-layer-composer")).toBe(true);
    expect(nodeData.nodeMap.has("id:graph-orphan-island")).toBe(true);
    expect(nodeData.indexVersion).toBe(h.vaultIndex.index.getVersion());

    // Toggle to File granularity via UI button
    const fileBtn = globalView.contentEl.querySelector(
      'button[data-granularity="file"]'
    ) as HTMLButtonElement;
    expect(fileBtn).not.toBeNull();
    fileBtn.click();

    const fileData = globalView.getGraphData()!;
    expect(fileData.granularity).toBe("file");
    expect(fileData.nodes.length).toBe(7);
    expect(fileData.nodeMap.has("file:07-graph-showcase.org")).toBe(true);
    expect(fileData.nodeMap.get("file:07-graph-showcase.org")?.tags).toEqual(
      expect.arrayContaining(["graph", "architecture", "memory", "zh中文"])
    );

    // Mutating the shared OrgIdIndex updates the graph indexVersion cleanly
    const versionBefore = fileData.indexVersion;
    h.upsertDiskFile(
      "08-ephemeral-memory.org",
      "#+TITLE: Ephemeral\n* Ephemeral\n:PROPERTIES:\n:ID: eph-1\n:END:\n"
    );
    await waitMs(180);
    expect(globalView.getGraphData()!.indexVersion).toBeGreaterThan(versionBefore);
    expect(globalView.getGraphData()!.nodeMap.has("file:08-ephemeral-memory.org")).toBe(true);
  });

  it("2. Opens Local Graph and switches depth 1 / 2 / 3 and showIncoming / showOutgoing", async () => {
    const disk = loadTestVaultDiskFiles();
    const h = createWorkspaceHarness(disk);
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    const localLeaf = await h.handle.openLocalGraph({
      focusNodeKey: "id:graph-showcase-hub",
      filePath: "07-graph-showcase.org",
    });
    expect(localLeaf).not.toBeNull();
    const localView = localLeaf!.view as OrgLocalGraphView;
    expect(localView).toBeInstanceOf(OrgLocalGraphView);

    const depth1Btn = localView.contentEl.querySelector(
      'button.org-graph-depth-btn[data-depth="1"]'
    ) as HTMLButtonElement;
    const depth2Btn = localView.contentEl.querySelector(
      'button.org-graph-depth-btn[data-depth="2"]'
    ) as HTMLButtonElement;
    const depth3Btn = localView.contentEl.querySelector(
      'button.org-graph-depth-btn[data-depth="3"]'
    ) as HTMLButtonElement;

    depth1Btn.click();
    const g1 = localView.getGraphData()!;
    expect(localView.getLocalState().depth).toBe(1);
    expect(g1.nodeMap.has("id:graph-layer-core")).toBe(true);
    expect(g1.nodeMap.has("id:graph-layer-leaf")).toBe(false);

    depth2Btn.click();
    const g2 = localView.getGraphData()!;
    expect(localView.getLocalState().depth).toBe(2);
    expect(g2.nodeMap.has("id:graph-layer-leaf")).toBe(true);
    expect(g2.nodes.length).toBeGreaterThan(g1.nodes.length);

    depth3Btn.click();
    const g3 = localView.getGraphData()!;
    expect(localView.getLocalState().depth).toBe(3);
    expect(g3.nodes.length).toBeGreaterThan(g2.nodes.length);

    // Verify showIncoming / showOutgoing filtering around id:graph-layer-core
    localView.focusNode("id:graph-layer-core", "07-graph-showcase.org");
    depth1Btn.click();
    const both = localView.getGraphData()!;
    expect(both.nodeMap.has("id:graph-showcase-hub")).toBe(true);
    expect(both.nodeMap.has("id:graph-layer-composer")).toBe(true);
    expect(both.nodeMap.has("id:graph-layer-leaf")).toBe(true);

    const panelCheckboxes = Array.from(
      localView.contentEl.querySelectorAll<HTMLInputElement>(
        ".org-graph-local-panel-slot input[type='checkbox']"
      )
    );
    expect(panelCheckboxes).toHaveLength(3);
    const [incomingToggle, outgoingToggle] = panelCheckboxes;

    // Hide incoming -> hub & composer disappear, outgoing leaf remains
    incomingToggle.checked = false;
    incomingToggle.dispatchEvent(new Event("change", { bubbles: true }));
    const outgoingOnly = localView.getGraphData()!;
    expect(outgoingOnly.nodeMap.has("id:graph-showcase-hub")).toBe(false);
    expect(outgoingOnly.nodeMap.has("id:graph-layer-composer")).toBe(false);
    expect(outgoingOnly.nodeMap.has("id:graph-layer-leaf")).toBe(true);

    // Restore incoming & hide outgoing -> hub & composer appear, leaf disappears
    incomingToggle.checked = true;
    incomingToggle.dispatchEvent(new Event("change", { bubbles: true }));
    outgoingToggle.checked = false;
    outgoingToggle.dispatchEvent(new Event("change", { bubbles: true }));
    const incomingOnly = localView.getGraphData()!;
    expect(incomingOnly.nodeMap.has("id:graph-showcase-hub")).toBe(true);
    expect(incomingOnly.nodeMap.has("id:graph-layer-composer")).toBe(true);
    expect(incomingOnly.nodeMap.has("id:graph-layer-leaf")).toBe(false);
  });

  it("3. Graph -> Reader jump opens target file, preserves Graph leaf, unfolds & highlights target heading", async () => {
    const disk = loadTestVaultDiskFiles();
    const h = createWorkspaceHarness(disk);
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    const globalLeaf = (await h.handle.openGlobalGraph()) as unknown as MockLeaf;
    const globalView = globalLeaf.view as OrgGlobalGraphView;
    const renderer = globalView.getRenderer()!;
    setElementBox(globalView.contentEl.querySelector(".org-graph-canvas-wrap")!, 900, 650);
    renderer.resize(900, 650);
    renderer.centerOnNode("id:graph-layer-leaf");

    // Double-click target node while NO OrgView leaf exists yet
    const pos = globalView.getNodePosition("id:graph-layer-leaf")!;
    const screen = renderer.worldToScreen(pos.x, pos.y);
    renderer.canvas.dispatchEvent(
      new MouseEvent("dblclick", {
        clientX: screen.x,
        clientY: screen.y,
        bubbles: true,
      })
    );
    await waitMs(50);

    // Graph leaf was NOT overwritten
    expect(globalLeaf.openFile).not.toHaveBeenCalled();
    expect(globalLeaf.view).toBe(globalView);
    expect(h.app.workspace.getLeavesOfType(VIEW_TYPE_ORG_GRAPH)).toHaveLength(1);

    const orgLeaves = h.app.workspace.getLeavesOfType(VIEW_TYPE_ORG);
    expect(orgLeaves).toHaveLength(1);
    const orgView = orgLeaves[0].view as OrgView;
    expect(orgView.file?.path).toBe("07-graph-showcase.org");

    const highlighted = orgView.contentEl.querySelector(".org-heading-jump-highlight");
    expect(highlighted).not.toBeNull();
    expect(highlighted?.textContent).toContain("Leaf Canvas Renderer");

    // Fold entire document into overview mode, then jump again from Graph -> must unfold & highlight target
    orgView.foldLevel("overview");
    const leafHeadingLine = h.vaultIndex.index.resolveId("graph-layer-leaf");
    expect(leafHeadingLine.status).toBe("found");
    if (leafHeadingLine.status === "found") {
      const targetSec = orgView.contentEl.querySelector(
        `.org-section[data-line="${leafHeadingLine.node.line}"]`
      ) as HTMLElement;
      expect(targetSec.closest(".org-section.is-folded")).not.toBeNull();
    }

    h.setActiveLeaf(globalLeaf);
    globalView.selectNode("id:graph-layer-leaf");
    const openSourceBtn = globalView.contentEl.querySelector(
      ".org-graph-inspector-btn.is-primary"
    ) as HTMLButtonElement;
    openSourceBtn.click();
    await waitMs(50);

    expect(globalLeaf.openFile).not.toHaveBeenCalled();
    if (leafHeadingLine.status === "found") {
      const targetSecAfter = orgView.contentEl.querySelector(
        `.org-section[data-line="${leafHeadingLine.node.line}"]`
      ) as HTMLElement;
      expect(targetSecAfter.closest(".org-section.is-folded")).toBeNull();
    }
    const reHighlighted = orgView.contentEl.querySelector(".org-heading-jump-highlight");
    expect(reHighlighted?.textContent).toContain("Leaf Canvas Renderer");
  });

  it("4. Reader -> Local Graph auto-follows across files & headings without scroll jitter", async () => {
    const disk = loadTestVaultDiskFiles();
    const h = createWorkspaceHarness(disk);
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    const orgLeaf = await h.openOrgFile("07-graph-showcase.org");
    const orgView = orgLeaf.view as OrgView;
    const localLeaf = (await h.handle.openLocalGraph()) as unknown as MockLeaf;
    const localView = localLeaf.view as OrgLocalGraphView;
    const buildSpy = vi.spyOn(localView, "refreshGraph");

    // Click heading section for graph-layer-core inside Reading View
    const coreEntry = h.vaultIndex.index.resolveId("graph-layer-core");
    expect(coreEntry.status).toBe("found");
    if (coreEntry.status === "found") {
      const sec = orgView.contentEl.querySelector(
        `.org-section[data-line="${coreEntry.node.line}"]`
      ) as HTMLElement;
      expect(sec).not.toBeNull();
      sec.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(localView.getLocalState().centerNodeId).toBe("id:graph-layer-core");
    buildSpy.mockClear();

    // Simulate scroll & redundant focusBus events inside same section -> zero jitter / zero rebuild
    const previewEl = orgView.contentEl.querySelector(".org-preview") as HTMLElement;
    previewEl.scrollTop = 120;
    previewEl.dispatchEvent(new Event("scroll", { bubbles: false }));
    const repeatedSameNode = h.handle.focusBus.resolveFocusForFileLine(
      h.vaultIndex.index,
      "07-graph-showcase.org",
      coreEntry.status === "found" ? coreEntry.node.line + 2 : 20,
      "cursor"
    );
    expect(h.handle.focusBus.emit(repeatedSameNode)).toBe(false);
    expect(buildSpy).not.toHaveBeenCalled();

    // Switching Reader to another .org file updates Local Graph automatically
    await h.openOrgFile("03-vla-memory-notes.org");
    const vlaEntry = h.vaultIndex.index.resolveId("vla-memory-overview");
    expect(vlaEntry.status).toBe("found");
    if (vlaEntry.status === "found") {
      const vlaOrgView = h.activeLeaf!.view as OrgView;
      const vlaSec = vlaOrgView.contentEl.querySelector(
        `.org-section[data-line="${vlaEntry.node.line}"]`
      ) as HTMLElement;
      vlaSec.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(localView.getLocalState().centerFilePath).toBe("03-vla-memory-notes.org");
    expect(localView.getLocalState().centerNodeId).toBe("id:vla-memory-overview");
  });

  it("5. Focus Lock prevents Reader switches from moving Local Graph focus", async () => {
    const disk = loadTestVaultDiskFiles();
    const h = createWorkspaceHarness(disk);
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    await h.openOrgFile("07-graph-showcase.org");
    const localLeaf = await h.handle.openLocalGraph({
      focusNodeKey: "id:graph-layer-core",
      filePath: "07-graph-showcase.org",
    });
    const localView = localLeaf!.view as OrgLocalGraphView;

    const lockBtn = localView.contentEl.querySelector(
      ".org-graph-lock-btn"
    ) as HTMLButtonElement;
    expect(lockBtn).not.toBeNull();
    lockBtn.click();

    expect(localView.getLocalState().followReader).toBe(false);
    expect(localView.getLocalState().lockedNodeId).toBe("id:graph-layer-core");
    expect(lockBtn.getAttribute("aria-pressed")).toBe("true");
    expect(
      localView.contentEl.querySelector(".org-graph-local-focus-badge")?.classList.contains("is-locked")
    ).toBe(true);

    // Switch Reader to 01-welcome-and-reading.org and click heading -> Local Graph must ignore it
    const welcomeLeaf = await h.openOrgFile("01-welcome-and-reading.org");
    const welcomeView = welcomeLeaf.view as OrgView;
    const welcomeEntry = h.vaultIndex.index.resolveId("welcome-core-idea");
    if (welcomeEntry.status === "found") {
      const sec = welcomeView.contentEl.querySelector(
        `.org-section[data-line="${welcomeEntry.node.line}"]`
      ) as HTMLElement;
      sec.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    expect(localView.getLocalState().centerNodeId).toBe("id:graph-layer-core");
    expect(localView.getLocalState().lockedNodeId).toBe("id:graph-layer-core");

    // Unlock and emit new focus -> follows Reader again
    lockBtn.click();
    expect(localView.getLocalState().followReader).toBe(true);
    h.handle.focusBus.emit(
      h.handle.focusBus.resolveFocusForFileLine(
        h.vaultIndex.index,
        "01-welcome-and-reading.org",
        welcomeEntry.status === "found" ? welcomeEntry.node.line : 11,
        "click"
      )
    );
    expect(localView.getLocalState().centerNodeId).toBe("id:welcome-core-idea");
  });

  it("6. Modifying [[id:...]] link incrementally updates graph edges while preserving surviving node coordinates", async () => {
    const h = createWorkspaceHarness({
      "a.org": "* Node A\n:PROPERTIES:\n:ID: node-a\n:END:\nLinks to [[id:node-b]].\n",
      "b.org": "* Node B\n:PROPERTIES:\n:ID: node-b\n:END:\n",
      "c.org": "* Node C\n:PROPERTIES:\n:ID: node-c\n:END:\n",
    });
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    const globalLeaf = await h.handle.openGlobalGraph();
    const globalView = globalLeaf!.view as OrgGlobalGraphView;
    const sim = globalView.getSimulation();
    sim.step(80);
    sim.stop();

    const prevGraph = globalView.getGraphData()!;
    const beforeB = { ...globalView.getNodePosition("id:node-b")! };
    const beforeC = { ...globalView.getNodePosition("id:node-c")! };
    const setGraphSpy = vi.spyOn(sim, "setGraph");

    // Add [[id:node-c]] link inside a.org
    h.upsertDiskFile(
      "a.org",
      "* Node A\n:PROPERTIES:\n:ID: node-a\n:END:\nLinks to [[id:node-b]] and [[id:node-c]].\n"
    );
    await waitMs(180);

    expect(setGraphSpy).toHaveBeenCalled();
    const nextGraph = globalView.getGraphData()!;
    const patch = diffOrgGraphs(prevGraph, nextGraph);
    expect(patch.addedEdges.map((e) => e.id)).toEqual(["reference:id:node-a->id:node-c"]);
    expect(nextGraph.edges.some((e) => e.id === "reference:id:node-a->id:node-c")).toBe(true);
    expect(globalView.getSimulationAlpha()).toBeLessThanOrEqual(0.141);

    const afterB = globalView.getNodePosition("id:node-b")!;
    const afterC = globalView.getNodePosition("id:node-c")!;
    expect(Math.hypot(afterB.x - beforeB.x, afterB.y - beforeB.y)).toBeLessThan(25);
    expect(Math.hypot(afterC.x - beforeC.x, afterC.y - beforeC.y)).toBeLessThan(25);
  });

  it("7. Adding #+TRANSCLUDE: renders distinct transclusion edge (+ parallel curved slot alongside reference)", async () => {
    const h = createWorkspaceHarness({
      "composer.org":
        "* Composer\n:PROPERTIES:\n:ID: comp-1\n:END:\nRef [[id:core-1]].\n",
      "core.org": "* Core\n:PROPERTIES:\n:ID: core-1\n:END:\nCore body.\n",
    });
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    const globalLeaf = await h.handle.openGlobalGraph();
    const globalView = globalLeaf!.view as OrgGlobalGraphView;
    const beforeEdges = globalView.getGraphData()!.edges;
    expect(beforeEdges).toHaveLength(1);
    expect(beforeEdges[0].kind).toBe("reference");
    expect(beforeEdges[0].parallelCount).toBe(1);

    // Add #+TRANSCLUDE: [[id:core-1]] alongside [[id:core-1]]
    h.upsertDiskFile(
      "composer.org",
      "* Composer\n:PROPERTIES:\n:ID: comp-1\n:END:\nRef [[id:core-1]].\n#+TRANSCLUDE: [[id:core-1]] :only-contents\n"
    );
    await waitMs(180);

    const afterData = globalView.getGraphData()!;
    expect(afterData.stats.referenceEdges).toBe(1);
    expect(afterData.stats.transclusionEdges).toBe(1);
    expect(afterData.edges).toHaveLength(2);
    expect(afterData.edges.map((e) => e.parallelCount)).toEqual([2, 2]);
    expect(afterData.edges.map((e) => e.parallelIndex).sort()).toEqual([0, 1]);

    // Verify Canvas2D draw calls apply dashed strokes & quadratic curves for parallel transclusion edge
    const dashPatterns: number[][] = [];
    let quadCurves = 0;
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(() => {
        quadCurves++;
      }),
      arc: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn(),
      setLineDash: vi.fn((pattern: number[]) => {
        dashPatterns.push([...pattern]);
      }),
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      lineJoin: "miter",
      font: "",
      textAlign: "left",
      textBaseline: "alphabetic",
    };

    const renderer = globalView.getRenderer()!;
    (renderer as unknown as { ctx: unknown }).ctx = mockCtx;
    globalView.getSimulation().step(15);
    renderer.fitToView();
    renderer.render();

    expect(dashPatterns.some((p) => p.length === 2 && p[0] === 6 && p[1] === 4)).toBe(true);
    expect(quadCurves).toBeGreaterThanOrEqual(2);
  });

  it("8. Cross-file moving :ID: node keeps canonical id:<orgId> identity & updates filePath", async () => {
    const h = createWorkspaceHarness({
      "hub.org": "* Hub\n:PROPERTIES:\n:ID: hub-1\n:END:\nRef [[id:portable-mem]].\n",
      "inbox.org":
        "* Inbox\n** Portable Memory\n:PROPERTIES:\n:ID: portable-mem\n:END:\nMoves cleanly.\n",
      "archive.org": "* Archive\nExisting archived notes.\n",
    });
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    const globalLeaf = await h.handle.openGlobalGraph();
    const globalView = globalLeaf!.view as OrgGlobalGraphView;
    const sim = globalView.getSimulation();
    sim.step(80);
    sim.stop();
    const beforePos = { ...globalView.getNodePosition("id:portable-mem")! };
    expect(globalView.getGraphData()!.nodeMap.get("id:portable-mem")?.filePath).toBe("inbox.org");

    // Move heading from inbox.org into archive.org
    h.upsertDiskFile("inbox.org", "* Inbox\nEmpty now.\n");
    h.upsertDiskFile(
      "archive.org",
      "* Archive\nExisting archived notes.\n\n** Portable Memory\n:PROPERTIES:\n:ID: portable-mem\n:END:\nMoves cleanly.\n"
    );
    await waitMs(180);

    const movedNode = globalView.getGraphData()!.nodeMap.get("id:portable-mem");
    expect(movedNode).toBeDefined();
    expect(movedNode!.id).toBe("id:portable-mem");
    expect(movedNode!.filePath).toBe("archive.org");
    expect(
      globalView.getGraphData()!.edges.some((e) => e.id === "reference:id:hub-1->id:portable-mem")
    ).toBe(true);

    const afterPos = globalView.getNodePosition("id:portable-mem")!;
    expect(Math.hypot(afterPos.x - beforePos.x, afterPos.y - beforePos.y)).toBeLessThan(25);
  });

  it("9. Duplicate ID (demo-duplicate-id) & broken ID (missing-demo-404) + showUnresolved toggle never crash", async () => {
    const disk = loadTestVaultDiskFiles();
    const h = createWorkspaceHarness(disk);
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    const globalLeaf = await h.handle.openGlobalGraph();
    const globalView = globalLeaf!.view as OrgGlobalGraphView;
    const localLeaf = await h.handle.openLocalGraph({
      focusNodeKey: "id:demo-duplicate-id",
      filePath: "05-diagnostics-demo.org",
    });
    const localView = localLeaf!.view as OrgLocalGraphView;

    // Initial state: showUnresolved=false -> ghost nodes hidden, duplicates visible cleanly
    expect(globalView.getGraphData()!.stats.duplicateCount).toBe(2);
    expect(globalView.getGraphData()!.stats.unresolvedCount).toBe(2);
    expect(globalView.getGraphData()!.nodeMap.has("missing:missing-demo-404")).toBe(false);

    // Toggle showUnresolved ON via UI checkbox
    const unresolvedCheck = globalView.contentEl.querySelector(
      'input[data-filter-key="showUnresolved"]'
    ) as HTMLInputElement;
    unresolvedCheck.checked = true;
    unresolvedCheck.dispatchEvent(new Event("change", { bubbles: true }));

    const withUnresolved = globalView.getGraphData()!;
    expect(withUnresolved.nodeMap.has("missing:missing-demo-404")).toBe(true);
    expect(withUnresolved.nodeMap.has("missing:missing-transclude-404")).toBe(true);

    // Select & hover duplicate & unresolved nodes -> zero crashes
    expect(() => globalView.selectNode("id:demo-duplicate-id")).not.toThrow();
    expect(
      globalView.contentEl.querySelector(".org-graph-status-badge.is-duplicate")
    ).not.toBeNull();

    expect(() => globalView.selectNode("missing:missing-demo-404")).not.toThrow();
    expect(
      globalView.contentEl.querySelector(".org-graph-status-badge.is-unresolved")
    ).not.toBeNull();

    // Local graph showUnresolved toggle + missing focus stays safe without throwing
    localView.updateFilter({ showUnresolved: true });
    localView.focusNode("file:05-diagnostics-demo.org", "05-diagnostics-demo.org");
    expect(localView.getGraphData()!.nodeMap.has("missing:missing-demo-404")).toBe(true);
    expect(() => localView.focusNode("missing:missing-demo-404", null)).not.toThrow();
    expect(localView.getController()?.getTargetStatus()).toBe("target-missing");

    unresolvedCheck.checked = false;
    unresolvedCheck.dispatchEvent(new Event("change", { bubbles: true }));
    expect(globalView.getGraphData()!.nodeMap.has("missing:missing-demo-404")).toBe(false);
  });

  it("10. Multi-pane coexistence (Global + Local + multiple OrgViews) & clean teardown (onClose / dispose)", async () => {
    const disk = loadTestVaultDiskFiles();
    const h = createWorkspaceHarness(disk);
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    const globalLeaf = await h.handle.openGlobalGraph();
    const localLeaf = await h.handle.openLocalGraph();
    const orgLeaf1 = await h.openOrgFile("01-welcome-and-reading.org", { newLeaf: "split" });
    const orgLeaf2 = await h.openOrgFile("07-graph-showcase.org", { newLeaf: "split" });

    expect(h.app.workspace.getLeavesOfType(VIEW_TYPE_ORG_GRAPH)).toHaveLength(1);
    expect(h.app.workspace.getLeavesOfType(VIEW_TYPE_ORG_LOCAL_GRAPH)).toHaveLength(1);
    expect(h.app.workspace.getLeavesOfType(VIEW_TYPE_ORG)).toHaveLength(2);

    const localView = localLeaf!.view as OrgLocalGraphView;
    const globalView = globalLeaf!.view as OrgGlobalGraphView;

    // Switching active OrgView pane updates Local Graph
    h.setActiveLeaf(orgLeaf1);
    expect(localView.getLocalState().centerFilePath).toBe("01-welcome-and-reading.org");
    h.setActiveLeaf(orgLeaf2);
    expect(localView.getLocalState().centerFilePath).toBe("07-graph-showcase.org");

    // Teardown via handle.dispose + OrgView.onClose + vaultIndex.dispose
    await h.dispose();

    expect(globalView.contentEl.children.length).toBe(0);
    expect(localView.contentEl.children.length).toBe(0);
    expect(h.getActiveListenerCount()).toBe(0);

    // Post-dispose bus & vault events do not throw or leak
    expect(() =>
      h.handle.focusBus.emit({
        filePath: "01-welcome-and-reading.org",
        line: 0,
        nodeKey: "id:org-native-welcome-root",
        orgId: "org-native-welcome-root",
        reason: "manual",
        timestamp: Date.now(),
      })
    ).not.toThrow();
    expect(() => h.upsertDiskFile("post-dispose.org", "* Post\n")).not.toThrow();
  });

  it("11. Scale performance stays fast at 100 / 1,000 / 5,000 synthetic Org nodes + Local depth 1..3 + simulation step", () => {
    const scales = [
      { nodes: 100, files: 10, buildCeilingMs: 500 },
      { nodes: 1000, files: 50, buildCeilingMs: 800 },
      { nodes: 5000, files: 200, buildCeilingMs: 1500 },
    ];

    for (const cfg of scales) {
      const files = buildSyntheticGraphScaleCorpus(cfg.nodes, cfg.files);
      const h = createWorkspaceHarness(files);
      activeHarnesses.push(h);
      for (const [p, content] of files.entries()) {
        h.vaultIndex.index.upsertFile(p, content);
      }
      h.vaultIndex.index.markInitialized();

      const tBuild0 = performance.now();
      const globalNode = buildOrgGraph(h.vaultIndex.index, { granularity: "node" });
      const buildNodeMs = performance.now() - tBuild0;

      const globalFile = buildOrgGraph(h.vaultIndex.index, { granularity: "file" });
      expect(globalNode.nodes).toHaveLength(cfg.nodes);
      expect(globalNode.stats.transclusionEdges).toBe(cfg.nodes / 5);
      expect(globalFile.nodes).toHaveLength(cfg.files);
      expect(buildNodeMs).toBeLessThan(cfg.buildCeilingMs);

      const centerKey = canonicalOrgNodeKey(`s4-s4_${cfg.nodes}-0`);
      const tL0 = performance.now();
      const d1 = buildLocalOrgGraph(h.vaultIndex.index, { centerNodeId: centerKey, depth: 1 });
      const d2 = buildLocalOrgGraph(h.vaultIndex.index, { centerNodeId: centerKey, depth: 2 });
      const d3 = buildLocalOrgGraph(h.vaultIndex.index, { centerNodeId: centerKey, depth: 3 });
      const localMs = performance.now() - tL0;

      expect(d1.nodes.length).toBeGreaterThan(1);
      expect(d2.nodes.length).toBeGreaterThan(d1.nodes.length);
      expect(d3.nodes.length).toBeGreaterThan(d2.nodes.length);
      expect(localMs).toBeLessThan(150);

      const sim = new OrgGraphSimulation();
      const tSim0 = performance.now();
      sim.setGraph(globalNode, undefined, {
        preserveLayout: false,
        warmUpTicks: cfg.nodes >= 2500 ? 12 : 30,
        warmUpMaxMs: 250,
      });
      sim.stepFrame(12);
      const simMs = performance.now() - tSim0;

      expect(sim.getNodes()).toHaveLength(cfg.nodes);
      expect(simMs).toBeLessThan(1000);
      for (const n of sim.getNodes()) {
        expect(Number.isFinite(n.x)).toBe(true);
        expect(Number.isFinite(n.y)).toBe(true);
      }
      sim.dispose();
    }
  });

  it("12. Strict SHA-256 verification: zero .org files in test-vault/ mutated across all graph operations", async () => {
    const vaultDir = path.resolve(process.cwd(), "test-vault");
    const diskFiles = loadTestVaultDiskFiles();
    const baselineDiskHashes = new Map<string, string>();
    for (const name of diskFiles.keys()) {
      baselineDiskHashes.set(name, sha256(fs.readFileSync(path.join(vaultDir, name))));
    }

    const h = createWorkspaceHarness(diskFiles);
    activeHarnesses.push(h);
    await h.vaultIndex.initialize();

    const globalLeaf = (await h.handle.openGlobalGraph()) as unknown as MockLeaf;
    const globalView = globalLeaf.view as OrgGlobalGraphView;
    const localLeaf = (await h.handle.openLocalGraph({
      focusNodeKey: "id:graph-showcase-hub",
      filePath: "07-graph-showcase.org",
    })) as unknown as MockLeaf;
    const localView = localLeaf.view as OrgLocalGraphView;

    // Exercise zoom, pan, drag, filters, search, color groups, lock/unlock, jump, and close
    globalView.zoomBy(1.4);
    globalView.zoomBy(0.7);
    globalView.setViewportState({ panX: 120, panY: 85, scale: 1.1 });
    globalView.fitToView();

    const renderer = globalView.getRenderer()!;
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 10, clientY: 10, button: 0, bubbles: true })
    );
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 60, clientY: 45, bubbles: true })
    );
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointerup", { clientX: 60, clientY: 45, button: 0, bubbles: true })
    );

    globalView.getSimulation().beginDrag("id:graph-showcase-hub");
    globalView.getSimulation().dragTo("id:graph-showcase-hub", 80, -40);
    globalView.getSimulation().endDrag("id:graph-showcase-hub");

    globalView.setSearchQuery("tag:#zh中文");
    globalView.setSearchQuery("");
    globalView.updateFilter({ showOrphans: false, showUnresolved: true });
    globalView.updateFilter({ showOrphans: true, showUnresolved: false });
    globalView.setColorMode("custom");
    globalView.setColorGroups([
      { id: "g1", query: "tag:#memory", color: "#0ea5e9" },
      { id: "g2", query: "file:07", color: "#7c3aed" },
    ]);
    globalView.setGranularity("file");
    globalView.setGranularity("node");

    localView.setDepth(2);
    localView.setDepth(3);
    localView.lockFocus("id:graph-layer-core");
    localView.unlockFocus();
    localView.selectNode("id:graph-layer-leaf");
    (localView.contentEl.querySelector(".org-graph-inspector-btn.is-primary") as HTMLButtonElement)?.click();
    await waitMs(40);

    await globalView.onClose();
    await localView.onClose();

    expect(h.modifySpy).not.toHaveBeenCalled();
    expect(h.createSpy).not.toHaveBeenCalled();
    expect(h.deleteSpy).not.toHaveBeenCalled();

    const afterFiles = fs.readdirSync(vaultDir).filter((f) => f.endsWith(".org")).sort();
    expect(afterFiles).toEqual(Array.from(baselineDiskHashes.keys()));
    for (const [name, expectedHash] of baselineDiskHashes.entries()) {
      const actualHash = sha256(fs.readFileSync(path.join(vaultDir, name)));
      expect(actualHash).toBe(expectedHash);
    }
  });
});
