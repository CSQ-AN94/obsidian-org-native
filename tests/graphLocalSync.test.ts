import { describe, expect, it, vi } from "vitest";
import {
  VIEW_TYPE_ORG,
  VIEW_TYPE_ORG_BACKLINKS,
  VIEW_TYPE_ORG_GRAPH,
  VIEW_TYPE_ORG_LOCAL_GRAPH,
} from "../src/constants";
import {
  canonicalDuplicateNodeKey,
  canonicalFileNodeKey,
  canonicalOrgNodeKey,
  canonicalUnresolvedNodeKey,
  type OrgGraphData,
  type OrgGraphNode,
  type OrgGraphStats,
} from "../src/core/graph/types";
import {
  VaultIndexService,
  type VaultIndexChangeEvent,
} from "../src/core/index/vaultIndexService";
import { translate, type TranslationKey } from "../src/i18n";
import type OrgNativePlugin from "../src/main";
import {
  LocalGraphController,
  resolveGraphNodeToOpenTarget,
  type LocalGraphBuildContext,
} from "../src/views/graph/localGraphController";
import { OrgReaderFocusBus } from "../src/views/graph/readerFocusBus";
import { createMockApp, TFile } from "./mocks/obsidian";

function makeStats(overrides: Partial<OrgGraphStats> = {}): OrgGraphStats {
  return {
    nodeCount: 0,
    edgeCount: 0,
    referenceEdges: 0,
    transclusionEdges: 0,
    structuralEdges: 0,
    orphanCount: 0,
    duplicateCount: 0,
    unresolvedCount: 0,
    fileCount: 0,
    ...overrides,
  };
}

function makeGraphNode(overrides: Partial<OrgGraphNode> & { id: string }): OrgGraphNode {
  return {
    kind: "org-node",
    filePath: "notes/a.org",
    line: 0,
    endLine: 0,
    level: 1,
    title: overrides.id,
    headingPath: [],
    tags: [],
    status: "found",
    inDegree: 0,
    outDegree: 0,
    transcludeIn: 0,
    transcludeOut: 0,
    degree: 0,
    ...overrides,
  };
}

function makeGraphData(nodes: OrgGraphNode[], centerNodeId?: string): OrgGraphData {
  const nodeMap = new Map<string, OrgGraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  return {
    granularity: "node",
    nodes,
    edges: [],
    nodeMap,
    centerNodeId,
    stats: makeStats({ nodeCount: nodes.length }),
    indexVersion: 1,
  };
}

interface WorkspaceHarness {
  app: import("obsidian").App;
  plugin: OrgNativePlugin;
  vaultIndex: VaultIndexService;
  focusBus: OrgReaderFocusBus;
  handlers: {
    activeLeafChange: Array<(leaf: unknown) => void>;
    fileOpen: Array<(file: unknown) => void>;
  };
  offrefSpy: ReturnType<typeof vi.fn>;
  setFiles: (files: Record<string, string>) => void;
  emitActiveLeafChange: (leaf: unknown) => void;
  emitFileOpen: (file: unknown) => void;
}

function createHarness(initialFiles: Record<string, string> = {}): WorkspaceHarness {
  const baseApp = createMockApp();
  const fileMap = new Map<string, TFile>();
  const contentMap = new Map<string, string>();
  const handlers: WorkspaceHarness["handlers"] = {
    activeLeafChange: [],
    fileOpen: [],
  };
  const offrefSpy = vi.fn((ref: { event?: string; cb?: (arg: unknown) => void }) => {
    if (ref?.event === "active-leaf-change" && ref.cb) {
      handlers.activeLeafChange = handlers.activeLeafChange.filter((fn) => fn !== ref.cb);
    } else if (ref?.event === "file-open" && ref.cb) {
      handlers.fileOpen = handlers.fileOpen.filter((fn) => fn !== ref.cb);
    }
  });

  const app = {
    ...baseApp,
    workspace: {
      ...baseApp.workspace,
      on: vi.fn((event: string, cb: (arg: unknown) => void) => {
        if (event === "active-leaf-change") handlers.activeLeafChange.push(cb);
        if (event === "file-open") handlers.fileOpen.push(cb);
        return { event, cb };
      }),
      offref: offrefSpy,
    },
    vault: {
      ...baseApp.vault,
      getFiles: () => Array.from(fileMap.values()),
      getAbstractFileByPath: (path: string) => fileMap.get(path) ?? null,
      cachedRead: async (file: TFile) => contentMap.get(file.path) ?? "",
    },
  };

  const plugin = {
    t: (key: TranslationKey) => translate("en", key),
    uiLanguage: "en" as const,
  } as unknown as OrgNativePlugin;

  const vaultIndex = new VaultIndexService(
    app as unknown as import("obsidian").App,
    plugin,
    { debounceMs: 0 }
  );
  const focusBus = new OrgReaderFocusBus();

  const setFiles = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      if (!fileMap.has(path)) {
        fileMap.set(path, new TFile(path));
      }
      contentMap.set(path, content);
      vaultIndex.upsertContent(path, content);
    }
  };

  setFiles(initialFiles);

  return {
    app: app as unknown as import("obsidian").App,
    plugin,
    vaultIndex,
    focusBus,
    handlers,
    offrefSpy,
    setFiles,
    emitActiveLeafChange: (leaf) => {
      for (const cb of [...handlers.activeLeafChange]) cb(leaf);
    },
    emitFileOpen: (file) => {
      for (const cb of [...handlers.fileOpen]) cb(file);
    },
  };
}

describe("Sprint 04 Agent C — Local Graph & Reader Sync", () => {
  it("auto-follows file open, heading click, cursor crossing :ID: sections, and non-ID files", () => {
    const harness = createHarness({
      "notes/alpha.org": [
        ":PROPERTIES:",
        ":ID: alpha-root",
        ":END:",
        "#+TITLE: Alpha Root",
        "",
        "* Section One",
        ":PROPERTIES:",
        ":ID: alpha-sec1",
        ":END:",
        "Paragraph one in sec1.",
        "Paragraph two in sec1.",
        "",
        "* Section Two",
        ":PROPERTIES:",
        ":ID: alpha-sec2",
        ":END:",
        "Body in sec2 with [[id:beta-intro][Beta]].",
      ].join("\n"),
      "notes/beta.org": [
        "#+TITLE: Beta Notes",
        "* Beta Intro",
        ":PROPERTIES:",
        ":ID: beta-intro",
        ":END:",
        "Beta body.",
      ].join("\n"),
      "notes/plain.org": [
        "#+TITLE: Plain File",
        "* Unindexed Heading",
        "No ID drawers anywhere.",
      ].join("\n"),
    });

    const buildSpy = vi.fn((ctx: LocalGraphBuildContext) =>
      makeGraphData(
        ctx.state.centerNodeId ? [makeGraphNode({ id: ctx.state.centerNodeId, filePath: ctx.state.centerFilePath ?? "" })] : [],
        ctx.state.centerNodeId ?? undefined
      )
    );

    const controller = new LocalGraphController({
      app: harness.app as unknown as import("obsidian").App,
      vaultIndex: harness.vaultIndex,
      focusBus: harness.focusBus,
      buildLocalGraph: buildSpy,
    });

    controller.start();
    expect(controller.getTargetStatus()).toBe("no-focus");
    expect(buildSpy).toHaveBeenCalledTimes(0);

    // 1. Workspace file-open resolves alpha.org line 0 -> id:alpha-root
    harness.emitFileOpen(new TFile("notes/alpha.org"));
    expect(controller.getState()).toMatchObject({
      centerNodeId: canonicalOrgNodeKey("alpha-root"),
      centerFilePath: "notes/alpha.org",
      followReader: true,
    });
    expect(controller.getTargetStatus()).toBe("ok");
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // 2. Clicking Section One shifts to id:alpha-sec1
    const clickEvent = harness.focusBus.resolveFocusForFileLine(
      harness.vaultIndex.index,
      "notes/alpha.org",
      5,
      "click"
    );
    harness.focusBus.emit(clickEvent);
    expect(controller.getState().centerNodeId).toBe("id:alpha-sec1");
    expect(buildSpy).toHaveBeenCalledTimes(2);

    // 3. Cursor moving into Section Two shifts to id:alpha-sec2
    const cursorEvent = harness.focusBus.resolveFocusForFileLine(
      harness.vaultIndex.index,
      "notes/alpha.org",
      15,
      "cursor"
    );
    harness.focusBus.emit(cursorEvent);
    expect(controller.getState().centerNodeId).toBe("id:alpha-sec2");
    expect(buildSpy).toHaveBeenCalledTimes(3);

    // 4. Opening a file with no :ID: nodes falls back to file:<path>
    harness.emitFileOpen(new TFile("notes/plain.org"));
    expect(controller.getState()).toMatchObject({
      centerNodeId: canonicalFileNodeKey("notes/plain.org"),
      centerFilePath: "notes/plain.org",
    });
    expect(controller.getTargetStatus()).toBe("ok");
    expect(buildSpy).toHaveBeenCalledTimes(4);

    // 5. Opening beta.org (heading :ID: without file-level :ID:) resolves first :ID: node
    harness.emitFileOpen(new TFile("notes/beta.org"));
    expect(controller.getState()).toMatchObject({
      centerNodeId: "id:beta-intro",
      centerFilePath: "notes/beta.org",
    });
    expect(buildSpy).toHaveBeenCalledTimes(5);

    controller.dispose();
  });

  it("enforces scroll-jitter immunity so same-section cursor/scroll noise triggers zero rebuilds", () => {
    const harness = createHarness({
      "notes/alpha.org": [
        "* Section One",
        ":PROPERTIES:",
        ":ID: sec-1",
        ":END:",
        "Line 4",
        "Line 5",
        "Line 6",
        "Line 7",
        "* Section Two",
        ":PROPERTIES:",
        ":ID: sec-2",
        ":END:",
        "Line 12",
      ].join("\n"),
    });

    const buildSpy = vi.fn((ctx: LocalGraphBuildContext) =>
      makeGraphData([], ctx.state.centerNodeId ?? undefined)
    );
    const snapshotSpy = vi.fn();

    const controller = new LocalGraphController({
      app: harness.app as unknown as import("obsidian").App,
      vaultIndex: harness.vaultIndex,
      focusBus: harness.focusBus,
      buildLocalGraph: buildSpy,
      onChange: snapshotSpy,
    });
    controller.start();

    harness.focusBus.emit(
      harness.focusBus.resolveFocusForFileLine(harness.vaultIndex.index, "notes/alpha.org", 0, "click")
    );
    expect(controller.getState().centerNodeId).toBe("id:sec-1");
    buildSpy.mockClear();
    snapshotSpy.mockClear();

    // Repeated cursor/scroll jitter across lines 4..7 in the exact same section
    for (const line of [4, 5, 6, 7, 5, 4]) {
      const ev = harness.focusBus.resolveFocusForFileLine(
        harness.vaultIndex.index,
        "notes/alpha.org",
        line,
        "cursor"
      );
      harness.focusBus.emit(ev);
    }

    // Also emit a raw cursor event targeting the same nodeKey directly on the bus
    harness.focusBus.emit({
      filePath: "notes/alpha.org",
      line: 6,
      nodeKey: "id:sec-1",
      orgId: "sec-1",
      reason: "cursor",
      timestamp: Date.now(),
    });

    // Redundant file-open / active-leaf-change on the same file
    harness.emitFileOpen(new TFile("notes/alpha.org"));
    harness.emitActiveLeafChange({
      view: { getViewType: () => VIEW_TYPE_ORG, file: new TFile("notes/alpha.org") },
    });

    expect(buildSpy).toHaveBeenCalledTimes(0);
    expect(snapshotSpy).toHaveBeenCalledTimes(0);

    // Null-nodeKey fallback jitter within same file vs different file
    harness.focusBus.emit({
      filePath: "notes/no-id-a.org",
      line: 1,
      nodeKey: null,
      orgId: null,
      reason: "cursor",
      timestamp: Date.now(),
    });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    harness.focusBus.emit({
      filePath: "notes/no-id-a.org",
      line: 18,
      nodeKey: null,
      orgId: null,
      reason: "cursor",
      timestamp: Date.now(),
    });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    harness.focusBus.emit({
      filePath: "notes/no-id-b.org",
      line: 2,
      nodeKey: null,
      orgId: null,
      reason: "cursor",
      timestamp: Date.now(),
    });
    expect(buildSpy).toHaveBeenCalledTimes(2);

    controller.dispose();
  });

  it("locks focus to ignore reader navigation and resumes sync cleanly on unlockFocus or focusNode", () => {
    const harness = createHarness({
      "a.org": "* A\n:PROPERTIES:\n:ID: node-a\n:END:\n",
      "b.org": "* B\n:PROPERTIES:\n:ID: node-b\n:END:\n",
      "c.org": "* C\n:PROPERTIES:\n:ID: node-c\n:END:\n",
    });

    const buildSpy = vi.fn((ctx: LocalGraphBuildContext) =>
      makeGraphData([], ctx.state.centerNodeId ?? undefined)
    );
    const controller = new LocalGraphController({
      app: harness.app as unknown as import("obsidian").App,
      vaultIndex: harness.vaultIndex,
      focusBus: harness.focusBus,
      buildLocalGraph: buildSpy,
    });
    controller.start();

    harness.emitFileOpen(new TFile("a.org"));
    expect(controller.getState().centerNodeId).toBe("id:node-a");

    // Lock current center
    expect(controller.lockFocus()).toBe(true);
    expect(controller.getState()).toMatchObject({
      followReader: false,
      lockedNodeId: "id:node-a",
      centerNodeId: "id:node-a",
      centerFilePath: "a.org",
    });
    // Locking same node again is a no-op
    expect(controller.lockFocus()).toBe(false);
    buildSpy.mockClear();

    // Reader navigates across files & sections -> Local Graph MUST NOT move
    harness.emitFileOpen(new TFile("b.org"));
    harness.focusBus.emit(
      harness.focusBus.resolveFocusForFileLine(harness.vaultIndex.index, "b.org", 0, "click")
    );
    harness.focusBus.emit(
      harness.focusBus.resolveFocusForFileLine(harness.vaultIndex.index, "c.org", 0, "cursor")
    );
    expect(controller.getState()).toMatchObject({
      followReader: false,
      lockedNodeId: "id:node-a",
      centerNodeId: "id:node-a",
      centerFilePath: "a.org",
    });
    expect(buildSpy).toHaveBeenCalledTimes(0);

    // Unlock resumes sync immediately to Reader's latest location (node-c in c.org)
    expect(controller.unlockFocus()).toBe(true);
    expect(controller.getState()).toMatchObject({
      followReader: true,
      lockedNodeId: null,
      centerNodeId: "id:node-c",
      centerFilePath: "c.org",
    });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // Toggle lock -> locks onto node-c
    expect(controller.toggleLock()).toBe(true);
    expect(controller.getState()).toMatchObject({
      followReader: false,
      lockedNodeId: "id:node-c",
      centerNodeId: "id:node-c",
    });

    // Reader moves back to node-a while locked -> ignored
    harness.focusBus.emit(
      harness.focusBus.resolveFocusForFileLine(harness.vaultIndex.index, "a.org", 0, "jump")
    );
    expect(controller.getState().centerNodeId).toBe("id:node-c");

    // Manual event on focusBus shifts center even while locked
    harness.focusBus.emit({
      filePath: "a.org",
      line: 0,
      nodeKey: "id:node-a",
      orgId: "node-a",
      reason: "manual",
      timestamp: Date.now(),
    });
    expect(controller.getState()).toMatchObject({
      followReader: false,
      lockedNodeId: "id:node-a",
      centerNodeId: "id:node-a",
      centerFilePath: "a.org",
    });

    // Explicit focusNode switches center ONCE AND resumes Reader sync cleanly
    buildSpy.mockClear();
    expect(controller.focusNode("id:node-b")).toBe(true);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      followReader: true,
      lockedNodeId: null,
      centerNodeId: "id:node-b",
      centerFilePath: "b.org",
    });

    // Subsequent reader cursor event now follows cleanly (even back to previous node-a!)
    harness.focusBus.emit(
      harness.focusBus.resolveFocusForFileLine(harness.vaultIndex.index, "a.org", 0, "cursor")
    );
    expect(controller.getState().centerNodeId).toBe("id:node-a");

    controller.dispose();
  });

  it("handles depth (1/2/3), incoming/outgoing direction toggles, and filter updates without redundant rebuilds", () => {
    const harness = createHarness({
      "a.org": "* A\n:PROPERTIES:\n:ID: node-a\n:END:\n",
    });
    const observedContexts: LocalGraphBuildContext[] = [];
    const controller = new LocalGraphController({
      app: harness.app as unknown as import("obsidian").App,
      vaultIndex: harness.vaultIndex,
      focusBus: harness.focusBus,
      buildLocalGraph: (ctx) => {
        observedContexts.push(ctx);
        return makeGraphData([], ctx.state.centerNodeId ?? undefined);
      },
    });
    controller.start();
    controller.focusNode("id:node-a");
    observedContexts.length = 0;

    expect(controller.setDepth(1)).toBe(false);
    expect(controller.setDepth(2)).toBe(true);
    expect(controller.setDepth(3)).toBe(true);
    expect(controller.setDepth(3)).toBe(false);
    expect(controller.setShowIncoming(false)).toBe(true);
    expect(controller.setShowIncoming(false)).toBe(false);
    expect(controller.setShowOutgoing(false)).toBe(true);
    expect(controller.setShowOutgoing(true)).toBe(true);

    expect(observedContexts.map((c) => [c.state.depth, c.state.showIncoming, c.state.showOutgoing])).toEqual([
      [2, true, true],
      [3, true, true],
      [3, false, true],
      [3, false, false],
      [3, false, true],
    ]);

    controller.setFilter({
      search: "tag:arch",
      showReference: true,
      showTransclusion: false,
      showStructural: false,
      showOrphans: false,
      showUnresolved: false,
    });
    expect(observedContexts[observedContexts.length - 1].filter?.search).toBe("tag:arch");
    expect(observedContexts[observedContexts.length - 1].filter?.showTransclusion).toBe(false);

    controller.dispose();
  });

  it("resolves graph nodes cleanly via resolveGraphNodeToOpenTarget and opens targets via openNodeFromGraph while preserving the Local Graph leaf and state", async () => {
    const alphaContent = [
      ":PROPERTIES:",
      ":ID: alpha-root",
      ":END:",
      "#+TITLE: Alpha Root",
      "",
      "* Subheading",
      "Link to [[id:beta-sec][Beta Sec]].",
    ].join("\n");
    const betaContent = [
      "#+TITLE: Beta File",
      "* Intro",
      "** Target Section",
      ":PROPERTIES:",
      ":ID: beta-sec",
      ":END:",
      "Target body content.",
    ].join("\n");
    const plainContent = "#+TITLE: Plain Doc\n* Unidentified\nPlain body.\n";
    const dupAContent = "* Dup One\n:PROPERTIES:\n:ID: shared-dup\n:END:\n";
    const dupBContent = "* Header\n* Dup Two\n:PROPERTIES:\n:ID: shared-dup\n:END:\n";

    const harness = createHarness({
      "notes/alpha.org": alphaContent,
      "notes/beta.org": betaContent,
      "notes/plain.org": plainContent,
      "notes/dup-a.org": dupAContent,
      "notes/dup-b.org": dupBContent,
    });

    const index = harness.vaultIndex.index;

    // Pure helper unit assertions
    const idTarget = resolveGraphNodeToOpenTarget(
      makeGraphNode({
        id: "id:beta-sec",
        kind: "org-node",
        orgId: "beta-sec",
        filePath: "notes/beta.org",
        line: 2,
      }),
      index
    );
    expect(idTarget).toMatchObject({
      id: "beta-sec",
      filePath: "notes/beta.org",
      line: 2,
      headingPath: ["Intro", "Target Section"],
    });

    const fileTarget = resolveGraphNodeToOpenTarget(
      makeGraphNode({
        id: "file:notes/plain.org",
        kind: "file",
        filePath: "notes/plain.org",
        line: 0,
        level: 0,
        title: "Plain Doc",
      }),
      index
    );
    expect(fileTarget).toMatchObject({
      filePath: "notes/plain.org",
      line: 0,
      level: 0,
      title: "Plain Doc",
    });

    const dupTarget = resolveGraphNodeToOpenTarget(
      makeGraphNode({
        id: canonicalDuplicateNodeKey("shared-dup", "notes/dup-b.org", 1),
        kind: "org-node",
        orgId: "shared-dup",
        filePath: "notes/dup-b.org",
        line: 1,
        status: "duplicate",
      }),
      index
    );
    expect(dupTarget).toMatchObject({
      id: "shared-dup",
      filePath: "notes/dup-b.org",
      line: 1,
    });

    const missingTarget = resolveGraphNodeToOpenTarget(
      makeGraphNode({
        id: canonicalUnresolvedNodeKey("never-created"),
        kind: "unresolved",
        orgId: "never-created",
        filePath: "",
        status: "missing",
      }),
      index
    );
    expect(missingTarget).toBeNull();

    // Full multi-pane openNodeFromGraph integration with VaultIndexService.openNode
    const orgOpenFileSpy = vi.fn(async (file: TFile) => {
      orgLeaf.view.file = file;
    });
    const jumpToLineSpy = vi.fn();
    let currentMode: "reading" | "live" | "source" = "live";
    const setModeSpy = vi.fn((mode: "reading" | "live" | "source") => {
      currentMode = mode;
    });
    const orgLeaf = {
      view: {
        getViewType: () => VIEW_TYPE_ORG,
        file: new TFile("notes/alpha.org"),
        getMode: () => currentMode,
        setMode: setModeSpy,
        jumpToLine: jumpToLineSpy,
      },
      openFile: orgOpenFileSpy,
    };

    const localGraphViewport = { zoom: 1.45, panX: 120, panY: -45 };
    const localLeafOpenFileSpy = vi.fn(async () => {});
    const localGraphLeaf = {
      view: {
        getViewType: () => VIEW_TYPE_ORG_LOCAL_GRAPH,
        viewport: localGraphViewport,
      },
      openFile: localLeafOpenFileSpy,
    };

    const globalGraphLeaf = {
      view: { getViewType: () => VIEW_TYPE_ORG_GRAPH },
      openFile: vi.fn(async () => {}),
    };

    const ws = harness.app.workspace as unknown as Record<string, unknown>;
    ws.activeLeaf = localGraphLeaf;
    ws.getLeavesOfType = (type: string) => {
      if (type === VIEW_TYPE_ORG) return [orgLeaf];
      if (type === VIEW_TYPE_ORG_LOCAL_GRAPH) return [localGraphLeaf];
      if (type === VIEW_TYPE_ORG_GRAPH) return [globalGraphLeaf];
      return [];
    };
    ws.setActiveLeaf = vi.fn((leaf: unknown) => {
      ws.activeLeaf = leaf;
    });

    const graphData = makeGraphData(
      [
        makeGraphNode({ id: "id:alpha-root", filePath: "notes/alpha.org", orgId: "alpha-root", line: 0 }),
        makeGraphNode({ id: "id:beta-sec", filePath: "notes/beta.org", orgId: "beta-sec", line: 2 }),
        makeGraphNode({
          id: "file:notes/plain.org",
          kind: "file",
          filePath: "notes/plain.org",
          line: 0,
          level: 0,
        }),
        makeGraphNode({
          id: "missing:not-found",
          kind: "unresolved",
          orgId: "not-found",
          filePath: "",
          status: "missing",
        }),
      ],
      "id:alpha-root"
    );

    const controller = new LocalGraphController({
      app: harness.app as unknown as import("obsidian").App,
      vaultIndex: harness.vaultIndex,
      focusBus: harness.focusBus,
      initialState: {
        depth: 2,
        followReader: false,
        lockedNodeId: "id:alpha-root",
        centerNodeId: "id:alpha-root",
        centerFilePath: "notes/alpha.org",
      },
      buildLocalGraph: () => graphData,
    });
    controller.start();

    const openNodeSpy = vi.spyOn(harness.vaultIndex, "openNode");

    // Unresolved ghost returns false and does not call openNode
    expect(
      await controller.openNodeFromGraph(
        "missing:not-found",
        graphData,
        localGraphLeaf as unknown as import("obsidian").WorkspaceLeaf,
        "reading"
      )
    ).toBe(false);
    expect(openNodeSpy).not.toHaveBeenCalled();

    // Double-clicking id:beta-sec opens beta.org at line 2 in orgLeaf while preserving localGraphLeaf
    expect(
      await controller.openNodeFromGraph(
        "id:beta-sec",
        graphData,
        localGraphLeaf as unknown as import("obsidian").WorkspaceLeaf,
        "reading"
      )
    ).toBe(true);

    expect(openNodeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "beta-sec", filePath: "notes/beta.org", line: 2 }),
      "reading",
      { preserveLeaf: localGraphLeaf, highlight: true }
    );
    expect(localLeafOpenFileSpy).not.toHaveBeenCalled();
    expect(orgOpenFileSpy).toHaveBeenCalledTimes(1);
    expect(setModeSpy).toHaveBeenCalledWith("reading");
    expect(jumpToLineSpy).toHaveBeenCalledWith(2, { highlight: true });

    // Local Graph lock state & viewport preserved untouched!
    expect(localGraphLeaf.view.viewport).toEqual({ zoom: 1.45, panX: 120, panY: -45 });
    expect(controller.getState()).toMatchObject({
      depth: 2,
      followReader: false,
      lockedNodeId: "id:alpha-root",
      centerNodeId: "id:alpha-root",
      centerFilePath: "notes/alpha.org",
    });

    // Double-clicking file:notes/plain.org opens plain.org cleanly too
    ws.activeLeaf = localGraphLeaf;
    expect(
      await controller.openNodeFromGraph(
        "file:notes/plain.org",
        graphData,
        localGraphLeaf as unknown as import("obsidian").WorkspaceLeaf
      )
    ).toBe(true);
    expect(orgOpenFileSpy).toHaveBeenCalledWith(expect.objectContaining({ path: "notes/plain.org" }));
    expect(localLeafOpenFileSpy).not.toHaveBeenCalled();

    // Org source texts remain strictly unmodified
    expect(await harness.vaultIndex.readFileReadOnly("notes/alpha.org")).toBe(alphaContent);
    expect(await harness.vaultIndex.readFileReadOnly("notes/beta.org")).toBe(betaContent);

    controller.dispose();
  });

  it("tracks cross-file node migrations seamlessly without losing locked id:<orgId> focus", () => {
    const movingSection = [
      "* Portable Knowledge",
      ":PROPERTIES:",
      ":ID: portable-1",
      ":END:",
      "Moved across files.",
    ].join("\n");

    const harness = createHarness({
      "inbox.org": `${movingSection}\n* Other Note\n:PROPERTIES:\n:ID: other-note\n:END:\n`,
      "archive.org": "#+TITLE: Archive\n",
    });

    const controller = new LocalGraphController({
      app: harness.app as unknown as import("obsidian").App,
      vaultIndex: harness.vaultIndex,
      focusBus: harness.focusBus,
      buildLocalGraph: (ctx) =>
        makeGraphData(
          [
            makeGraphNode({
              id: "id:portable-1",
              orgId: "portable-1",
              filePath: ctx.state.centerFilePath ?? "inbox.org",
            }),
          ],
          ctx.state.centerNodeId ?? undefined
        ),
    });
    controller.start();
    controller.lockFocus("id:portable-1");

    expect(controller.getState()).toMatchObject({
      centerNodeId: "id:portable-1",
      lockedNodeId: "id:portable-1",
      centerFilePath: "inbox.org",
      followReader: false,
    });
    expect(controller.getTargetStatus()).toBe("ok");

    // 1. Copy-then-delete migration into archive.org
    harness.setFiles({
      "archive.org": `#+TITLE: Archive\n${movingSection}\n`,
    });
    expect(controller.getTargetStatus()).toBe("ok");

    harness.setFiles({
      "inbox.org": "* Other Note\n:PROPERTIES:\n:ID: other-note\n:END:\n",
    });
    expect(controller.getState()).toMatchObject({
      centerNodeId: "id:portable-1",
      lockedNodeId: "id:portable-1",
      centerFilePath: "archive.org",
      followReader: false,
    });
    expect(controller.getTargetStatus()).toBe("ok");

    // 2. Two-step cut-then-paste migration into vault/long-term.org
    harness.setFiles({ "archive.org": "#+TITLE: Archive\n" });
    expect(controller.getTargetStatus()).toBe("target-missing");
    expect(controller.getState().lockedNodeId).toBe("id:portable-1");

    harness.setFiles({ "vault/long-term.org": movingSection });
    expect(controller.getTargetStatus()).toBe("ok");
    expect(controller.getState()).toMatchObject({
      centerNodeId: "id:portable-1",
      lockedNodeId: "id:portable-1",
      centerFilePath: "vault/long-term.org",
    });

    // 3. Direct renameFile also updates centerFilePath cleanly
    const renameRes = harness.vaultIndex.index.renameFile("vault/long-term.org", "vault/final.org");
    const renameEvent: VaultIndexChangeEvent = {
      kind: "rename",
      filePath: "vault/final.org",
      oldPath: "vault/long-term.org",
      affectedNodeIds: renameRes.affectedNodeIds,
      affectedTargetIds: renameRes.affectedTargetIds,
    };
    expect(controller.handleIndexChange(renameEvent)).toBe(true);
    expect(controller.getState()).toMatchObject({
      centerNodeId: "id:portable-1",
      lockedNodeId: "id:portable-1",
      centerFilePath: "vault/final.org",
    });
    expect(controller.getTargetStatus()).toBe("ok");

    controller.dispose();
  });

  it("transitions deleted locked node to target-missing and skips unrelated file edits in shouldRefreshForIndexEvent", () => {
    const harness = createHarness({
      "center.org": "* Center\n:PROPERTIES:\n:ID: center-id\n:END:\nSee [[id:neighbor-id][Neighbor]] and [[id:future-id][Future]].\n",
      "neighbor.org": "* Neighbor\n:PROPERTIES:\n:ID: neighbor-id\n:END:\n",
      "unrelated.org": "* Unrelated\n:PROPERTIES:\n:ID: unrelated-id\n:END:\n",
      "referrer.org": "* Referrer\n:PROPERTIES:\n:ID: ref-id\n:END:\nNo link yet.\n",
    });

    const buildSpy = vi.fn((ctx: LocalGraphBuildContext) =>
      makeGraphData(
        [
          makeGraphNode({ id: "id:center-id", orgId: "center-id", filePath: "center.org" }),
          makeGraphNode({ id: "id:neighbor-id", orgId: "neighbor-id", filePath: "neighbor.org" }),
          makeGraphNode({
            id: "missing:future-id",
            kind: "unresolved",
            orgId: "future-id",
            filePath: "",
            status: "missing",
          }),
        ],
        ctx.state.centerNodeId ?? undefined
      )
    );

    const controller = new LocalGraphController({
      app: harness.app as unknown as import("obsidian").App,
      vaultIndex: harness.vaultIndex,
      focusBus: harness.focusBus,
      buildLocalGraph: buildSpy,
    });
    controller.start();
    controller.lockFocus("id:center-id");
    buildSpy.mockClear();

    // Unrelated file edit -> skipped completely
    harness.setFiles({
      "unrelated.org": "* Unrelated\n:PROPERTIES:\n:ID: unrelated-id\n:END:\nEdited unrelated body.\n",
    });
    expect(buildSpy).toHaveBeenCalledTimes(0);

    const unrelatedEvent: VaultIndexChangeEvent = {
      kind: "upsert",
      filePath: "unrelated.org",
      affectedNodeIds: new Set(["unrelated-id"]),
      affectedTargetIds: new Set(["some-other-id"]),
    };
    expect(controller.shouldRefreshForIndexEvent(unrelatedEvent, controller.getData())).toBe(false);
    expect(controller.handleIndexChange(unrelatedEvent, controller.getData())).toBe(false);
    expect(buildSpy).toHaveBeenCalledTimes(0);

    // New incoming link from referrer.org targeting center-id -> triggers refresh
    harness.setFiles({
      "referrer.org": "* Referrer\n:PROPERTIES:\n:ID: ref-id\n:END:\nNow cites [[id:center-id]].\n",
    });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // Creating previously unresolved target future-id in currentData -> triggers refresh
    const futureEvent: VaultIndexChangeEvent = {
      kind: "upsert",
      filePath: "future.org",
      affectedNodeIds: new Set(["future-id"]),
      affectedTargetIds: new Set(),
    };
    expect(controller.shouldRefreshForIndexEvent(futureEvent, controller.getData())).toBe(true);

    // Deleting locked node enters target-missing cleanly without throwing
    const removeRes = harness.vaultIndex.index.removeFile("center.org");
    const removeEvent: VaultIndexChangeEvent = {
      kind: "remove",
      filePath: "center.org",
      affectedNodeIds: removeRes.affectedNodeIds,
      affectedTargetIds: removeRes.affectedTargetIds,
    };
    expect(() => controller.handleIndexChange(removeEvent)).not.toThrow();
    expect(controller.getTargetStatus()).toBe("target-missing");
    expect(controller.getState()).toMatchObject({
      followReader: false,
      lockedNodeId: "id:center-id",
      centerNodeId: "id:center-id",
    });

    // Unrelated edit while target-missing is still skipped
    expect(controller.handleIndexChange(unrelatedEvent)).toBe(false);

    controller.dispose();
  });

  it("ignores graph/backlinks/non-org active-leaf changes in multi-pane workspaces and cleans up on dispose", () => {
    const harness = createHarness({
      "a.org": [
        "* Root A",
        ":PROPERTIES:",
        ":ID: a-root",
        ":END:",
        "* Deep Sub",
        ":PROPERTIES:",
        ":ID: a-deep",
        ":END:",
        "Reading deep section.",
      ].join("\n"),
      "gamma.org": "* Gamma\n:PROPERTIES:\n:ID: gamma-1\n:END:\n",
    });

    const orgLeafA = {
      view: { getViewType: () => VIEW_TYPE_ORG, file: new TFile("a.org") },
    };
    const orgLeafGamma = {
      view: { getViewType: () => VIEW_TYPE_ORG, file: new TFile("gamma.org") },
    };
    const localGraphLeaf = {
      view: { getViewType: () => VIEW_TYPE_ORG_LOCAL_GRAPH },
    };
    const globalGraphLeaf = {
      view: { getViewType: () => VIEW_TYPE_ORG_GRAPH },
    };
    const backlinksLeaf = {
      view: { getViewType: () => VIEW_TYPE_ORG_BACKLINKS },
    };
    const markdownLeaf = {
      view: { getViewType: () => "markdown", file: new TFile("README.md") },
    };

    const buildSpy = vi.fn((ctx: LocalGraphBuildContext) =>
      makeGraphData([], ctx.state.centerNodeId ?? undefined)
    );

    const controller = new LocalGraphController({
      app: harness.app as unknown as import("obsidian").App,
      vaultIndex: harness.vaultIndex,
      focusBus: harness.focusBus,
      buildLocalGraph: buildSpy,
    });
    controller.start();

    // Reader is inside a-deep subsection of a.org
    harness.focusBus.emit(
      harness.focusBus.resolveFocusForFileLine(harness.vaultIndex.index, "a.org", 6, "click")
    );
    expect(controller.getState()).toMatchObject({
      centerNodeId: "id:a-deep",
      centerFilePath: "a.org",
    });
    buildSpy.mockClear();

    // Interacting with Local Graph, Global Graph, Backlinks, null leaf, or Markdown leaf never steals or clears focus
    harness.emitActiveLeafChange(localGraphLeaf);
    harness.emitActiveLeafChange(globalGraphLeaf);
    harness.emitActiveLeafChange(backlinksLeaf);
    harness.emitActiveLeafChange(markdownLeaf);
    harness.emitActiveLeafChange(null);
    harness.emitFileOpen(null);
    harness.emitFileOpen(new TFile("README.md"));

    expect(controller.getState()).toMatchObject({
      centerNodeId: "id:a-deep",
      centerFilePath: "a.org",
    });
    expect(buildSpy).toHaveBeenCalledTimes(0);

    // Clicking back into OrgView already showing a.org keeps sub-section a-deep instead of resetting to line 0
    harness.emitActiveLeafChange(orgLeafA);
    expect(controller.getState().centerNodeId).toBe("id:a-deep");
    expect(buildSpy).toHaveBeenCalledTimes(0);

    // Switching to another OrgView split pane showing gamma.org updates Local Graph
    harness.emitActiveLeafChange(orgLeafGamma);
    expect(controller.getState()).toMatchObject({
      centerNodeId: "id:gamma-1",
      centerFilePath: "gamma.org",
    });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // Dispose unsubscribes all workspace, focusBus, and index listeners
    controller.dispose();
    expect(harness.offrefSpy).toHaveBeenCalledTimes(2);
    expect(harness.handlers.activeLeafChange).toHaveLength(0);
    expect(harness.handlers.fileOpen).toHaveLength(0);

    harness.emitFileOpen(new TFile("a.org"));
    harness.focusBus.emit(
      harness.focusBus.resolveFocusForFileLine(harness.vaultIndex.index, "a.org", 0, "click")
    );
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(controller.getState().centerNodeId).toBe("id:gamma-1");
  });

  it("supports initialState persistence, snapshot subscriptions, new-tab open preservation, and file-node lifecycle without buildLocalGraph", async () => {
    const harness = createHarness({
      "a.org": "* A\n:PROPERTIES:\n:ID: node-a\n:END:\n",
      "b.org": "* B\n:PROPERTIES:\n:ID: node-b\n:END:\n",
      "plain.org": "#+TITLE: Plain\nJust prose.\n",
    });

    // Pre-existing reader focus on node-b should NOT override a locked restored state
    harness.focusBus.emit(
      harness.focusBus.resolveFocusForFileLine(harness.vaultIndex.index, "b.org", 0, "click")
    );

    const snapshots: Array<{ centerNodeId: string | null; status: string }> = [];
    const controller = new LocalGraphController({
      app: harness.app as unknown as import("obsidian").App,
      vaultIndex: harness.vaultIndex,
      focusBus: harness.focusBus,
      initialState: {
        depth: 3,
        showIncoming: false,
        followReader: false,
        lockedNodeId: "id:node-a",
      },
    });
    const unsub = controller.subscribe((snap) => {
      snapshots.push({ centerNodeId: snap.state.centerNodeId, status: snap.targetStatus });
    });
    controller.start();

    expect(controller.getState()).toMatchObject({
      depth: 3,
      showIncoming: false,
      followReader: false,
      lockedNodeId: "id:node-a",
      centerNodeId: "id:node-a",
      centerFilePath: "a.org",
    });
    expect(controller.getTargetStatus()).toBe("ok");

    // Lock a file: node and track rename -> remove -> recreate
    expect(controller.lockFocus("file:plain.org")).toBe(true);
    expect(controller.getTargetStatus()).toBe("ok");

    const renameRes = harness.vaultIndex.index.renameFile("plain.org", "archive/plain.org");
    expect(
      controller.handleIndexChange({
        kind: "rename",
        filePath: "archive/plain.org",
        oldPath: "plain.org",
        affectedNodeIds: renameRes.affectedNodeIds,
        affectedTargetIds: renameRes.affectedTargetIds,
      })
    ).toBe(true);
    expect(controller.getState()).toMatchObject({
      centerNodeId: "file:archive/plain.org",
      lockedNodeId: "file:archive/plain.org",
      centerFilePath: "archive/plain.org",
    });
    expect(controller.getTargetStatus()).toBe("ok");

    harness.vaultIndex.index.removeFile("archive/plain.org");
    expect(
      controller.handleIndexChange({
        kind: "remove",
        filePath: "archive/plain.org",
      })
    ).toBe(true);
    expect(controller.getTargetStatus()).toBe("target-missing");

    harness.setFiles({ "archive/plain.org": "#+TITLE: Restored\n" });
    expect(controller.getTargetStatus()).toBe("ok");

    // Snapshot subscription stops after unsub()
    const countBeforeUnsub = snapshots.length;
    unsub();
    controller.setDepth(2);
    expect(snapshots.length).toBe(countBeforeUnsub);

    // Opening node when NO VIEW_TYPE_ORG leaf exists creates a new tab without touching localGraphLeaf
    const newTabOpenFile = vi.fn(async () => {});
    const newTabLeaf = {
      view: { getViewType: () => VIEW_TYPE_ORG, jumpToLine: vi.fn() },
      openFile: newTabOpenFile,
    };
    const localLeafOpenFile = vi.fn(async () => {});
    const localGraphLeaf = {
      view: { getViewType: () => VIEW_TYPE_ORG_LOCAL_GRAPH },
      openFile: localLeafOpenFile,
    };
    const ws = harness.app.workspace as unknown as Record<string, unknown>;
    ws.activeLeaf = localGraphLeaf;
    ws.getLeavesOfType = () => [];
    ws.getLeaf = vi.fn((mode?: unknown) => (mode === "tab" ? newTabLeaf : localGraphLeaf));

    const entryB = harness.vaultIndex.index.resolveId("node-b");
    expect(entryB.status).toBe("found");
    if (entryB.status === "found") {
      expect(
        await controller.openNodeFromGraph(
          entryB.node,
          null,
          localGraphLeaf as unknown as import("obsidian").WorkspaceLeaf
        )
      ).toBe(true);
      expect(newTabOpenFile).toHaveBeenCalledTimes(1);
      expect(localLeafOpenFile).not.toHaveBeenCalled();
    }

    controller.dispose();
  });
});
