import { afterEach, describe, expect, it, vi } from "vitest";
import { VIEW_TYPE_ORG_GRAPH } from "../src/constants";
import {
  canonicalFileNodeKey,
  canonicalOrgNodeKey,
  createDefaultDisplayConfig,
  createDefaultForceConfig,
  createDefaultGlobalGraphState,
  type OrgGraphData,
  type OrgGraphEdge,
  type OrgGraphNode,
  type OrgGraphViewState,
} from "../src/core/graph/types";
import { VaultIndexService } from "../src/core/index/vaultIndexService";
import type OrgNativePlugin from "../src/main";
import {
  MAX_GRAPH_SCALE,
  MIN_GRAPH_SCALE,
  OrgGraphCanvasRenderer,
  resolveGraphTheme,
} from "../src/views/graph/canvasRenderer";
import { OrgGlobalGraphView } from "../src/views/graph/OrgGlobalGraphView";
import { OrgLocalGraphView } from "../src/views/graph/OrgLocalGraphView";
import { OrgReaderFocusBus } from "../src/views/graph/readerFocusBus";
import { OrgGraphSimulation } from "../src/views/graph/simulation";
import {
  ICON_ORG_BACKLINKS,
  ICON_ORG_GRAPH,
  ICON_ORG_LOCAL_GRAPH,
  registerOrgNativeIcons,
} from "../src/views/icons";
import { OrgBacklinksView } from "../src/views/nodes/OrgBacklinksView";
import { createMockApp, registeredIcons, TFile } from "./mocks/obsidian";

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeNode(
  id: string,
  overrides: Partial<OrgGraphNode> = {}
): OrgGraphNode {
  return {
    id,
    kind: "org-node",
    orgId: id.startsWith("id:") ? id.slice(3) : undefined,
    filePath: "notes/a.org",
    line: 0,
    endLine: 10,
    level: 1,
    title: `Node ${id}`,
    headingPath: [`Node ${id}`],
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

function makeEdge(
  source: string,
  target: string,
  kind: OrgGraphEdge["kind"] = "reference",
  overrides: Partial<OrgGraphEdge> = {}
): OrgGraphEdge {
  return {
    id: `${kind}:${source}->${target}`,
    source,
    target,
    kind,
    weight: 1,
    ...overrides,
  };
}

function buildSyntheticGraphData(
  nodes: OrgGraphNode[],
  edges: OrgGraphEdge[],
  granularity: "node" | "file" = "node",
  centerNodeId?: string
): OrgGraphData {
  const nodeMap = new Map<string, OrgGraphNode>();
  for (const n of nodes) {
    n.inDegree = 0;
    n.outDegree = 0;
    n.transcludeIn = 0;
    n.transcludeOut = 0;
    n.degree = 0;
    nodeMap.set(n.id, n);
  }
  let referenceEdges = 0;
  let transclusionEdges = 0;
  let structuralEdges = 0;
  const files = new Set<string>();
  let duplicateCount = 0;
  let unresolvedCount = 0;

  for (const n of nodes) {
    if (n.filePath) files.add(n.filePath);
    if (n.status === "duplicate") duplicateCount++;
    if (n.kind === "unresolved") unresolvedCount++;
  }

  for (const e of edges) {
    const s = nodeMap.get(e.source);
    const t = nodeMap.get(e.target);
    if (!s || !t) continue;
    s.outDegree++;
    t.inDegree++;
    s.degree++;
    t.degree++;
    if (e.kind === "reference") referenceEdges++;
    else if (e.kind === "transclusion") {
      transclusionEdges++;
      s.transcludeOut++;
      t.transcludeIn++;
    } else {
      structuralEdges++;
    }
  }

  let orphanCount = 0;
  for (const n of nodes) {
    if (n.degree === 0) orphanCount++;
  }

  return {
    granularity,
    nodes,
    edges,
    nodeMap,
    centerNodeId,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      referenceEdges,
      transclusionEdges,
      structuralEdges,
      orphanCount,
      duplicateCount,
      unresolvedCount,
      fileCount: files.size,
    },
    indexVersion: 1,
  };
}

function buildLargeSyntheticGraph(nodeCount: number, edgesPerNode = 3): OrgGraphData {
  const nodes: OrgGraphNode[] = [];
  const edges: OrgGraphEdge[] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push(
      makeNode(`id:n-${i}`, {
        filePath: `folder/file-${i % 40}.org`,
        title: i % 5 === 0 ? `中文节点 ${i}` : `Concept ${i}`,
        line: (i % 125) * 4,
      })
    );
  }
  for (let i = 0; i < nodeCount; i++) {
    for (let k = 1; k <= edgesPerNode; k++) {
      const targetIdx = (i * 7 + k * 13) % nodeCount;
      if (targetIdx === i) continue;
      const kind = k === edgesPerNode && i % 4 === 0 ? "transclusion" : "reference";
      edges.push(makeEdge(`id:n-${i}`, `id:n-${targetIdx}`, kind));
    }
  }
  return buildSyntheticGraphData(nodes, edges);
}

describe("Agent B — OrgGraphSimulation", () => {
  it("produces deterministic initial phyllotaxis layout and steps cleanly", () => {
    const dataA = buildSyntheticGraphData(
      [
        makeNode("id:a", { isCenter: true }),
        makeNode("id:b"),
        makeNode("id:c"),
        makeNode("id:d"),
      ],
      [
        makeEdge("id:a", "id:b"),
        makeEdge("id:b", "id:c", "transclusion"),
        makeEdge("id:c", "id:d"),
      ]
    );
    const dataB = buildSyntheticGraphData(
      [
        makeNode("id:a", { isCenter: true }),
        makeNode("id:b"),
        makeNode("id:c"),
        makeNode("id:d"),
      ],
      [
        makeEdge("id:a", "id:b"),
        makeEdge("id:b", "id:c", "transclusion"),
        makeEdge("id:c", "id:d"),
      ]
    );

    const sim1 = new OrgGraphSimulation();
    const sim2 = new OrgGraphSimulation();
    sim1.setGraph(dataA);
    sim2.setGraph(dataB);

    expect(sim1.getAlpha()).toBeCloseTo(0.85, 5);
    expect(sim1.getPosition("id:a")).toEqual({ x: 0, y: 0 });
    expect(sim1.getPosition("id:b")).toEqual(sim2.getPosition("id:b"));
    expect(sim1.getPosition("id:c")).toEqual(sim2.getPosition("id:c"));

    sim1.step(20);
    sim2.step(20);
    expect(sim1.getPosition("id:b")).toEqual(sim2.getPosition("id:b"));
    expect(sim1.getPosition("id:c")).toEqual(sim2.getPosition("id:c"));

    const moved = sim1.stepFrame(12);
    expect(typeof moved).toBe("boolean");
    expect(sim1.isActive()).toBe(true);

    sim1.stop();
    expect(sim1.getAlpha()).toBe(0);
    expect(sim1.isActive()).toBe(false);
    sim1.dispose();
    sim2.dispose();
  });

  it("preserves surviving coordinates across add, delete, same-file seed, and cross-file move", () => {
    const sim = new OrgGraphSimulation();
    const initial = buildSyntheticGraphData(
      [
        makeNode("id:anchor", { filePath: "inbox.org", title: "Anchor" }),
        makeNode("id:peer", { filePath: "inbox.org", title: "Peer" }),
        makeNode("id:portable", { filePath: "inbox.org", title: "Portable" }),
        makeNode("id:ephemeral", { filePath: "temp.org", title: "Ephemeral" }),
      ],
      [makeEdge("id:anchor", "id:peer")]
    );

    sim.setGraph(initial);
    sim.step(30);

    // Pin explicit positions so we can verify exact preservation and neighbor centroid seeding
    sim.dragTo("id:anchor", 320, -180);
    sim.endDrag("id:anchor");
    const anchorBefore = sim.getPosition("id:anchor")!;
    const portableBefore = sim.getPosition("id:portable")!;
    const peerBefore = sim.getPosition("id:peer")!;

    // Incremental update:
    // - id:ephemeral deleted
    // - id:portable moved cross-file from inbox.org -> archive.org
    // - id:new-neighbor added connected to id:anchor
    // - id:new-same-file added disconnected in archive.org (shares file with id:portable)
    const edited = buildSyntheticGraphData(
      [
        makeNode("id:anchor", { filePath: "inbox.org", title: "Anchor" }),
        makeNode("id:peer", { filePath: "inbox.org", title: "Peer" }),
        makeNode("id:portable", { filePath: "archive.org", title: "Portable" }),
        makeNode("id:new-neighbor", { filePath: "other.org", title: "Neighbor" }),
        makeNode("id:new-same-file", { filePath: "archive.org", title: "SameFile" }),
      ],
      [
        makeEdge("id:anchor", "id:peer"),
        makeEdge("id:anchor", "id:new-neighbor"),
      ]
    );

    sim.setGraph(edited);

    // Gentle incremental reheat (0.14), NOT 1.0 or 0.85
    expect(sim.getAlpha()).toBeCloseTo(0.14, 5);

    // Surviving nodes retain exact coordinates before ticking
    expect(sim.getPosition("id:anchor")).toEqual(anchorBefore);
    expect(sim.getPosition("id:peer")).toEqual(peerBefore);
    expect(sim.getPosition("id:portable")).toEqual(portableBefore);
    expect(sim.getNode("id:portable")?.data.filePath).toBe("archive.org");
    expect(sim.getPosition("id:ephemeral")).toBeNull();

    // Neighbor-seeded node sits near anchorBefore (within jitter <= 20)
    const neighborPos = sim.getPosition("id:new-neighbor")!;
    expect(
      Math.hypot(neighborPos.x - anchorBefore.x, neighborPos.y - anchorBefore.y)
    ).toBeLessThan(22);

    // Same-file disconnected node sits near portableBefore (which was in archive.org)
    const sameFilePos = sim.getPosition("id:new-same-file")!;
    expect(
      Math.hypot(sameFilePos.x - portableBefore.x, sameFilePos.y - portableBefore.y)
    ).toBeLessThan(22);

    sim.dispose();
  });

  it("handles beginDrag/dragTo/endDrag and 5,000-node tick budget safely", () => {
    const largeData = buildLargeSyntheticGraph(5000, 3);
    const sim = new OrgGraphSimulation();

    const t0 = performance.now();
    sim.setGraph(largeData, undefined, { warmUpTicks: 8, warmUpMaxMs: 45 });
    const warmElapsed = performance.now() - t0;

    expect(sim.getNodes().length).toBe(5000);
    expect(sim.getLinks().length).toBeGreaterThan(10000);
    // warmUp respects maxMs budget cleanly (generous CI margin)
    expect(warmElapsed).toBeLessThan(600);

    for (const node of sim.getNodes()) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }

    sim.beginDrag("id:n-0");
    sim.dragTo("id:n-0", 500, -250);
    expect(sim.getNode("id:n-0")?.fx).toBe(500);
    expect(sim.getNode("id:n-0")?.fy).toBe(-250);

    sim.step(1);
    expect(sim.getPosition("id:n-0")).toEqual({ x: 500, y: -250 });

    sim.endDrag("id:n-0");
    expect(sim.getNode("id:n-0")?.fx).toBeNull();
    expect(sim.getNode("id:n-0")?.fy).toBeNull();

    sim.dispose();
  });
});

describe("Agent B — OrgGraphCanvasRenderer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.className = "";
    document.body.replaceChildren();
  });

  it("supports coordinate transforms, zoom clamp, fitToView, centerOnNode, and quadtree hitTest in happy-dom", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });
    document.body.appendChild(container);

    const onSelectNode = vi.fn();
    const onOpenNode = vi.fn();
    const onDragStart = vi.fn();
    const onDragMove = vi.fn();
    const onDragEnd = vi.fn();

    const renderer = new OrgGraphCanvasRenderer(container, {
      onSelectNode,
      onOpenNode,
      onDragStart,
      onDragMove,
      onDragEnd,
    });

    // happy-dom returns null for getContext('2d'); renderer must remain fully functional
    expect(renderer.canvas.parentElement).toBe(container);

    const sim = new OrgGraphSimulation();
    const data = buildSyntheticGraphData(
      [
        makeNode("id:n1", { title: "Alpha" }),
        makeNode("id:n2", { title: "Beta" }),
      ],
      [makeEdge("id:n1", "id:n2")]
    );
    sim.setGraph(data);
    sim.dragTo("id:n1", -100, -50);
    sim.endDrag("id:n1");
    sim.dragTo("id:n2", 140, 80);
    sim.endDrag("id:n2");

    renderer.setData(data, sim.getNodes(), sim.getLinks());
    expect(renderer.getQuadtree().size()).toBe(2);

    // Coordinate transform roundtrip
    const screen = renderer.worldToScreen(-100, -50);
    const back = renderer.screenToWorld(screen.x, screen.y);
    expect(back.x).toBeCloseTo(-100, 5);
    expect(back.y).toBeCloseTo(-50, 5);

    // Zoom clamp
    renderer.zoomBy(100);
    expect(renderer.getViewportState().scale).toBe(MAX_GRAPH_SCALE);
    renderer.zoomBy(0.0001);
    expect(renderer.getViewportState().scale).toBe(MIN_GRAPH_SCALE);

    // Cursor-anchored zoom keeps world point under cursor invariant
    renderer.setViewportState({ panX: 400, panY: 300, scale: 1 });
    const anchorX = 250;
    const anchorY = 180;
    const worldBefore = renderer.screenToWorld(anchorX, anchorY);
    renderer.zoomBy(2, anchorX, anchorY);
    const worldAfter = renderer.screenToWorld(anchorX, anchorY);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 5);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 5);

    // fitToView centers bounding box
    renderer.fitToView(48);
    const midScreen = renderer.worldToScreen(20, 15);
    expect(midScreen.x).toBeCloseTo(400, 1);
    expect(midScreen.y).toBeCloseTo(300, 1);

    // centerOnNode puts target node at viewport center
    expect(renderer.centerOnNode("id:n1")).toBe(true);
    const n1Screen = renderer.worldToScreen(-100, -50);
    expect(n1Screen.x).toBeCloseTo(400, 3);
    expect(n1Screen.y).toBeCloseTo(300, 3);

    // Quadtree hitTest hits node on center and misses background
    expect(renderer.hitTest(n1Screen.x, n1Screen.y)?.id).toBe("id:n1");
    expect(renderer.hitTest(10, 10)).toBeNull();

    // Pointer click (<4px movement) selects node without dragging physics
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: n1Screen.x,
        clientY: n1Screen.y,
        bubbles: true,
      })
    );
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        clientX: n1Screen.x + 1,
        clientY: n1Screen.y + 1,
        bubbles: true,
      })
    );
    expect(onSelectNode).toHaveBeenCalledWith(expect.objectContaining({ id: "id:n1" }));
    expect(onDragStart).not.toHaveBeenCalled();

    // Dragging node (>=4px movement) invokes drag callbacks
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: n1Screen.x,
        clientY: n1Screen.y,
        bubbles: true,
      })
    );
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointermove", {
        button: 0,
        clientX: n1Screen.x + 25,
        clientY: n1Screen.y + 15,
        bubbles: true,
      })
    );
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        clientX: n1Screen.x + 25,
        clientY: n1Screen.y + 15,
        bubbles: true,
      })
    );
    expect(onDragStart).toHaveBeenCalledWith("id:n1");
    expect(onDragMove).toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenCalledWith("id:n1");

    // Background drag pans viewport
    const panBefore = renderer.getViewportState();
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        button: 0,
        clientX: 15,
        clientY: 15,
        bubbles: true,
      })
    );
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointermove", {
        button: 0,
        clientX: 65,
        clientY: 45,
        bubbles: true,
      })
    );
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointerup", {
        button: 0,
        clientX: 65,
        clientY: 45,
        bubbles: true,
      })
    );
    const panAfter = renderer.getViewportState();
    expect(panAfter.panX).toBeCloseTo(panBefore.panX + 50, 3);
    expect(panAfter.panY).toBeCloseTo(panBefore.panY + 30, 3);

    // Double click on node opens it
    const n1MovedScreen = renderer.worldToScreen(-100, -50);
    renderer.canvas.dispatchEvent(
      new MouseEvent("dblclick", {
        clientX: n1MovedScreen.x,
        clientY: n1MovedScreen.y,
        bubbles: true,
      })
    );
    expect(onOpenNode).toHaveBeenCalledWith(
      expect.objectContaining({ id: "id:n1" }),
      expect.any(MouseEvent)
    );

    // Wheel zoom updates scale smoothly
    const scaleBeforeWheel = renderer.getViewportState().scale;
    renderer.canvas.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -120,
        clientX: 400,
        clientY: 300,
        bubbles: true,
      })
    );
    expect(renderer.getViewportState().scale).toBeGreaterThan(scaleBeforeWheel);

    renderer.dispose();
    sim.dispose();
  });

  it("batches distinct reference/transclusion/structural strokes, parallel curves, dimming, and theme changes", async () => {
    const dashCalls: number[][] = [];
    const alphaCalls: number[] = [];
    const textDraws: string[] = [];
    let quadCurves = 0;

    const fakeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(() => {
        quadCurves++;
      }),
      arc: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn((dash: number[]) => {
        dashCalls.push([...dash]);
      }),
      strokeText: vi.fn(),
      fillText: vi.fn((text: string) => {
        textDraws.push(text);
      }),
      set globalAlpha(val: number) {
        alphaCalls.push(val);
      },
      get globalAlpha() {
        return 1;
      },
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      lineJoin: "round",
      font: "",
      textAlign: "center",
      textBaseline: "top",
    } as unknown as CanvasRenderingContext2D;

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx);

    document.body.className = "theme-dark";
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 900, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 700, configurable: true });
    document.body.appendChild(container);

    const renderer = new OrgGraphCanvasRenderer(container);
    expect(resolveGraphTheme(container).isDark).toBe(true);

    const data = buildSyntheticGraphData(
      [
        makeNode("id:hub", { title: "核心概念 Hub", isCenter: true }),
        makeNode("id:ref", { title: "Reference Target" }),
        makeNode("id:dup", { title: "Duplicate Node", status: "duplicate" }),
        makeNode("missing:ghost", {
          kind: "unresolved",
          orgId: "ghost",
          filePath: "",
          title: "Missing: ghost",
        }),
      ],
      [
        makeEdge("id:hub", "id:ref", "reference", { parallelIndex: 0, parallelCount: 2 }),
        makeEdge("id:hub", "id:ref", "transclusion", { parallelIndex: 1, parallelCount: 2 }),
        makeEdge("id:hub", "id:dup", "structural"),
        makeEdge("id:dup", "missing:ghost", "reference"),
      ]
    );

    const sim = new OrgGraphSimulation();
    sim.setGraph(data);
    sim.dragTo("id:hub", 0, 0);
    sim.dragTo("id:ref", 120, 0);
    sim.dragTo("id:dup", -120, 80);
    sim.dragTo("missing:ghost", -220, 140);

    renderer.setData(data, sim.getNodes(), sim.getLinks(), {
      showArrows: true,
      showLabels: true,
      labelFadeThreshold: 0.75,
      nodeSizeScale: 1,
      linkThickness: 1,
    });

    // Verify all 3 edge dash styles and parallel quadratic curve were batched
    expect(dashCalls.some((d) => d.length === 0)).toBe(true);
    expect(dashCalls.some((d) => d[0] === 6 && d[1] === 4)).toBe(true);
    expect(dashCalls.some((d) => d[0] === 2 && d[1] === 3)).toBe(true);
    expect(quadCurves).toBeGreaterThanOrEqual(2);
    expect(textDraws.some((t) => t.includes("核心概念"))).toBe(true);

    // Selecting id:hub dims non-1-hop node/edge (missing:ghost / id:dup->missing:ghost) to 0.15
    alphaCalls.length = 0;
    renderer.setSelectedNode("id:hub");
    expect(alphaCalls).toContain(0.15);

    // Theme class mutation updates renderer theme automatically
    document.body.className = "theme-light";
    await waitMs(20);
    expect(renderer.getTheme().isDark).toBe(false);

    renderer.dispose();
    sim.dispose();
  });
});

describe("Agent B — OrgGlobalGraphView lifecycle, HUD, hover safety, and persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function createHarness() {
    const baseApp = createMockApp();
    const fileA = new TFile("notes/memory.org");
    const fileB = new TFile("notes/architecture.org");
    const contentA = [
      "#+TITLE: Memory Systems",
      "* Episodic Buffer",
      ":PROPERTIES:",
      ":ID: mem-001",
      ":END:",
      "Links to [[id:arch-002][Architecture]] and <script>alert(1)</script> safely.",
      "#+TRANSCLUDE: [[id:arch-002]]",
    ].join("\n");
    const contentB = [
      "#+TITLE: Architecture",
      "* Retrieval Pipeline",
      ":PROPERTIES:",
      ":ID: arch-002",
      ":END:",
      "Core retrieval pipeline with CJK 检索说明.",
    ].join("\n");

    const diskContents = new Map<string, string>([
      [fileA.path, contentA],
      [fileB.path, contentB],
    ]);

    const modifySpy = vi.fn(async () => {});
    const createSpy = vi.fn(async (p: string) => new TFile(p));
    const app = {
      ...baseApp,
      vault: {
        ...baseApp.vault,
        getFiles: () => [fileA, fileB],
        getAbstractFileByPath: (p: string) =>
          p === fileA.path ? fileA : p === fileB.path ? fileB : null,
        cachedRead: async (f: TFile) => diskContents.get(f.path) ?? "",
        modify: modifySpy,
        create: createSpy,
      },
    };

    const plugin = {
      app,
      settings: { language: "en" },
      uiLanguage: "en" as const,
      t: (k: string) => k,
      registerEvent: () => {},
    } as unknown as OrgNativePlugin;

    const vaultIndex = new VaultIndexService(app as never, plugin, { debounceMs: 0 });
    vaultIndex.upsertContent(fileA.path, contentA);
    vaultIndex.upsertContent(fileB.path, contentB);

    const leaf = { app } as never;
    const saveState = vi.fn();
    const openNode = vi.fn();
    const focusInLocalGraph = vi.fn();

    const buildGlobalGraph = vi.fn((state: OrgGraphViewState): OrgGraphData => {
      if (state.granularity === "file") {
        const fNodes = [
          makeNode(canonicalFileNodeKey(fileA.path), {
            kind: "file",
            filePath: fileA.path,
            title: "Memory Systems",
            headingPath: [],
          }),
          makeNode(canonicalFileNodeKey(fileB.path), {
            kind: "file",
            filePath: fileB.path,
            title: "Architecture",
            headingPath: [],
          }),
        ].filter((n) =>
          !state.filter.search.trim() ||
          n.title.toLowerCase().includes(state.filter.search.toLowerCase())
        );
        const fEdges: OrgGraphEdge[] = [];
        if (fNodes.length === 2 && state.filter.showReference) {
          fEdges.push(
            makeEdge(
              canonicalFileNodeKey(fileA.path),
              canonicalFileNodeKey(fileB.path),
              "reference"
            )
          );
        }
        return buildSyntheticGraphData(fNodes, fEdges, "file");
      }

      const nodes = vaultIndex.index.getAllNodes().map((entry) =>
        makeNode(canonicalOrgNodeKey(entry.id!), {
          orgId: entry.id,
          filePath: entry.filePath,
          line: entry.line,
          endLine: entry.endLine,
          level: entry.level,
          title: entry.title,
          headingPath: entry.headingPath,
          tags: entry.tags ?? [],
        })
      );

      const q = state.filter.search.trim().toLowerCase();
      const filteredNodes = q
        ? nodes.filter(
            (n) =>
              n.title.toLowerCase().includes(q) ||
              (n.orgId ?? "").toLowerCase().includes(q)
          )
        : nodes;
      const present = new Set(filteredNodes.map((n) => n.id));
      const edges: OrgGraphEdge[] = [];
      const addIfValid = (e: OrgGraphEdge) => {
        if (present.has(e.source) && present.has(e.target)) {
          edges.push(e);
        }
      };

      if (state.filter.showReference) {
        addIfValid(makeEdge("id:mem-001", "id:arch-002", "reference"));
      }
      if (state.filter.showTransclusion) {
        addIfValid(makeEdge("id:mem-001", "id:arch-002", "transclusion"));
      }

      return buildSyntheticGraphData(filteredNodes, edges, "node");
    });

    const view = new OrgGlobalGraphView(leaf, {
      vaultIndex,
      buildGlobalGraph,
      uiLanguage: "en",
      openNode,
      focusInLocalGraph,
      saveState,
      hoverDelayMs: 0,
    });

    return {
      app,
      leaf,
      vaultIndex,
      view,
      buildGlobalGraph,
      saveState,
      openNode,
      focusInLocalGraph,
      modifySpy,
      createSpy,
      diskContents,
      fileA,
      fileB,
    };
  }

  it("mounts HUD, toggles granularity, filters search, updates color rules, and disposes cleanly", async () => {
    const { view, vaultIndex, buildGlobalGraph, saveState, modifySpy, createSpy } =
      createHarness();

    expect(view.getViewType()).toBe(VIEW_TYPE_ORG_GRAPH);
    await view.onOpen();

    const container = view.contentEl.querySelector(".org-graph-container") as HTMLElement;
    expect(container).not.toBeNull();
    expect(container.querySelector(".org-graph-canvas")).not.toBeNull();

    // Stats pill reflects initial node graph (2 nodes, 2 edges)
    const statsPill = container.querySelector(".org-graph-stats-pill") as HTMLElement;
    expect(statsPill.textContent).toContain("2 nodes");
    expect(statsPill.textContent).toContain("2 edges");

    // Toggle granularity to Files via UI button
    const fileBtn = container.querySelector(
      'button[data-granularity="file"]'
    ) as HTMLButtonElement;
    fileBtn.click();
    expect(view.getViewState().granularity).toBe("file");
    expect(statsPill.textContent).toContain("2 nodes");
    expect(statsPill.textContent).toContain("1 edge");
    expect(saveState).toHaveBeenCalled();

    // Switch back to Nodes
    view.setGranularity("node");
    expect(view.getViewState().granularity).toBe("node");

    // Open gear controls panel & filter by search query
    const gearBtn = container.querySelector(".org-graph-gear-btn") as HTMLButtonElement;
    gearBtn.click();
    expect(view.getViewState().controlsOpen).toBe(true);
    expect(
      container.querySelector(".org-graph-controls-panel")?.classList.contains("is-open")
    ).toBe(true);

    const searchInput = container.querySelector(
      ".org-graph-search-input"
    ) as HTMLInputElement;
    searchInput.value = "Retrieval";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(view.getGraphData()?.nodes.map((n) => n.id)).toEqual(["id:arch-002"]);

    // Clear search and test color mode + custom rules editor
    view.setSearchQuery("");
    expect(view.getGraphData()?.nodes.length).toBe(2);

    view.setColorMode("custom");
    const addRuleBtn = container.querySelector(
      ".org-graph-group-add-btn"
    ) as HTMLButtonElement;
    addRuleBtn.click();
    expect(view.getViewState().groups.length).toBe(1);

    // Zero disk writes occurred across all graph interactions
    expect(modifySpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(buildGlobalGraph).toHaveBeenCalled();

    await view.onClose();
    expect(view.contentEl.children.length).toBe(0);
    vaultIndex.dispose();
  });

  it("handles node selection, inspector actions, safe hover popover, double-click open, index sync, and state roundtrip", async () => {
    const {
      view,
      leaf,
      vaultIndex,
      openNode,
      focusInLocalGraph,
      modifySpy,
      createSpy,
    } = createHarness();

    await view.onOpen();
    const container = view.contentEl.querySelector(".org-graph-container") as HTMLElement;
    const renderer = view.getRenderer()!;

    // Select node id:mem-001 and inspect bottom-left card
    view.selectNode("id:mem-001");
    expect(view.getSelectedNodeId()).toBe("id:mem-001");

    const inspector = container.querySelector(".org-graph-inspector-card") as HTMLElement;
    expect(inspector.classList.contains("is-hidden")).toBe(false);
    expect(inspector.textContent).toContain("Episodic Buffer");
    expect(inspector.textContent).toContain("mem-001");
    expect(inspector.textContent).toContain("notes/memory.org");

    const focusBtn = inspector.querySelector(
      ".org-graph-inspector-btn:not(.is-primary)"
    ) as HTMLButtonElement;
    focusBtn.click();
    expect(focusInLocalGraph).toHaveBeenCalledWith(
      expect.objectContaining({ id: "id:mem-001" })
    );

    // Stepping simulation directly automatically invalidates quadtree for accurate hitTest & centerOnNode
    view.getSimulation().reheat(0.9);
    view.getSimulation().step(10);
    view.getSimulation().stop();
    view.centerOnNode("id:mem-001");
    const steppedPos = view.getNodePosition("id:mem-001")!;
    const steppedScreen = renderer.worldToScreen(steppedPos.x, steppedPos.y);
    expect(renderer.hitTest(steppedScreen.x, steppedScreen.y)?.id).toBe("id:mem-001");

    // Double-click node on canvas triggers openNode while preserving Graph leaf
    const pos = view.getNodePosition("id:mem-001")!;
    const screen = renderer.worldToScreen(pos.x, pos.y);
    renderer.canvas.dispatchEvent(
      new MouseEvent("dblclick", {
        clientX: screen.x,
        clientY: screen.y,
        bubbles: true,
      })
    );
    expect(openNode).toHaveBeenCalledWith(
      expect.objectContaining({ id: "id:mem-001" }),
      { preserveLeaf: leaf }
    );

    // Hovering node shows strictly read-only popover with escaped textContent (no <script> elements!)
    renderer.canvas.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: screen.x,
        clientY: screen.y,
        bubbles: true,
      })
    );
    await waitMs(25);
    const popover = container.querySelector(".org-graph-hover-popover") as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.querySelector("script")).toBeNull();
    expect(popover.textContent).toContain("<script>alert(1)</script>");

    // VaultIndex incremental update preserves surviving node coordinates & gently reheats (<= 0.14)
    view.getSimulation().step(80);
    view.getSimulation().stop();
    const beforeArchPos = view.getNodePosition("id:arch-002")!;
    const setGraphSpy = vi.spyOn(view.getSimulation(), "setGraph");
    vaultIndex.upsertContent(
      "notes/new.org",
      "* New Concept\n:PROPERTIES:\n:ID: new-003\n:END:\nLinks to [[id:arch-002]].\n"
    );
    await waitMs(160);
    expect(setGraphSpy).toHaveBeenCalled();
    expect(view.getGraphData()?.nodes.some((n) => n.id === "id:new-003")).toBe(true);
    expect(view.getSimulationAlpha()).toBeLessThanOrEqual(0.14);
    const afterArchPos = view.getNodePosition("id:arch-002")!;
    expect(
      Math.hypot(afterArchPos.x - beforeArchPos.x, afterArchPos.y - beforeArchPos.y)
    ).toBeLessThan(25);

    // Zoom toolbar buttons and empty overlay work cleanly
    const zoomInBtn = container.querySelector('button[data-action="zoom-in"]') as HTMLButtonElement;
    const zoomOutBtn = container.querySelector('button[data-action="zoom-out"]') as HTMLButtonElement;
    const fitBtn = container.querySelector('button[data-action="fit-view"]') as HTMLButtonElement;
    const relayoutBtn = container.querySelector('button[data-action="relayout"]') as HTMLButtonElement;
    const scale0 = view.getViewportState().scale;
    zoomInBtn.click();
    expect(view.getViewportState().scale).toBeGreaterThan(scale0);
    zoomOutBtn.click();
    expect(view.getViewportState().scale).toBeCloseTo(scale0, 3);
    fitBtn.click();
    view.getSimulation().dragTo("id:mem-001", 9999, 9999);
    view.getSimulation().endDrag("id:mem-001");
    relayoutBtn.click();
    expect(view.getSimulationAlpha()).toBeGreaterThan(0.05);
    const resetPos = view.getNodePosition("id:mem-001")!;
    expect(Math.hypot(resetPos.x, resetPos.y)).toBeLessThan(500);

    // Empty overlay shown when search matches zero nodes, cleared when reset
    view.setSearchQuery("zzzz-no-match");
    expect(
      container.querySelector(".org-graph-empty-state")?.classList.contains("is-hidden")
    ).toBe(false);
    expect(view.getSelectedNodeId()).toBeNull();
    view.setSearchQuery("");
    expect(
      container.querySelector(".org-graph-empty-state")?.classList.contains("is-hidden")
    ).toBe(true);

    // getState / setState roundtrip
    view.selectNode("id:mem-001");
    view.setViewportState({ panX: 250, panY: 175, scale: 1.45 });
    view.setSearchQuery("Buffer");
    const saved = view.getState();

    const restoredView = new OrgGlobalGraphView(leaf, {
      vaultIndex,
      buildGlobalGraph: () =>
        buildSyntheticGraphData(
          [makeNode("id:mem-001", { title: "Episodic Buffer" })],
          []
        ),
      uiLanguage: "en",
    });
    await restoredView.setState(saved, { history: false });
    await restoredView.onOpen();

    expect(restoredView.getViewState().filter.search).toBe("Buffer");
    expect(restoredView.getViewportState().scale).toBeCloseTo(1.45, 3);
    expect(restoredView.getSelectedNodeId()).toBe("id:mem-001");

    expect(modifySpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();

    await restoredView.onClose();
    await view.onClose();
    vaultIndex.dispose();
  });

  it("registers distinct Lucide-weight custom SVG icons and exposes them from Org views", () => {
    registeredIcons.clear();
    registerOrgNativeIcons();

    for (const iconId of [ICON_ORG_GRAPH, ICON_ORG_LOCAL_GRAPH, ICON_ORG_BACKLINKS]) {
      const svg = registeredIcons.get(iconId);
      expect(svg).toBeDefined();
      expect(svg).toContain("currentColor");
      expect(svg).toContain("stroke-width: 7.5");
    }

    const app = createMockApp();
    const plugin = {
      app,
      settings: { language: "en" },
      uiLanguage: "en" as const,
      t: (k: string) => k,
      registerEvent: () => {},
    } as unknown as OrgNativePlugin;
    const vaultIndex = new VaultIndexService(app as never, plugin);
    const leaf = { app } as never;
    const focusBus = new OrgReaderFocusBus();

    const globalView = new OrgGlobalGraphView(leaf, { vaultIndex, uiLanguage: "en" });
    const localView = new OrgLocalGraphView(leaf, {
      vaultIndex,
      focusBus,
      uiLanguage: "en",
    });
    const backlinksView = new OrgBacklinksView(leaf, vaultIndex);

    expect(globalView.getIcon()).toBe(ICON_ORG_GRAPH);
    expect(localView.getIcon()).toBe(ICON_ORG_LOCAL_GRAPH);
    expect(backlinksView.getIcon()).toBe(ICON_ORG_BACKLINKS);
    expect(globalView.getIcon()).not.toBe("git-fork");
    expect(localView.getIcon()).not.toBe("network");
    expect(backlinksView.getIcon()).not.toBe("links-going-in");

    vaultIndex.dispose();
  });

  it("prevents label-to-label overlaps for <12 clustered CJK/Latin nodes, separates overlapping nodes at low repelStrength, and resets sliders on dblclick / reset-defaults", async () => {
    const fakeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      arc: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
      globalAlpha: 1,
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      lineJoin: "round",
      font: "",
      textAlign: "center",
      textBaseline: "top",
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx);

    // 1. Tight cluster of 8 nodes (< 12) must yield 0 pairwise overlapping LabelBoxes
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 640, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 480, configurable: true });
    document.body.appendChild(container);

    const clusterData = buildSyntheticGraphData(
      Array.from({ length: 8 }, (_, i) =>
        makeNode(`id:c-${i}`, {
          title: `知识图谱节点标题 ${i} 较长名称测试`,
          isCenter: i === 0,
        })
      ),
      [makeEdge("id:c-0", "id:c-1"), makeEdge("id:c-0", "id:c-2")]
    );

    const collideSim = new OrgGraphSimulation({ repelStrength: 40, linkDistance: 60 });
    collideSim.setGraph(clusterData, { repelStrength: 40, linkDistance: 60 }, { warmUpTicks: 0 });
    // Deliberately stack nodes near origin and verify forceCollide pushes them apart
    for (let i = 0; i < 8; i++) {
      collideSim.dragTo(`id:c-${i}`, (i % 2) * 2, Math.floor(i / 2) * 2);
      collideSim.endDrag(`id:c-${i}`);
    }
    collideSim.step(40);
    const d0 = collideSim.getPosition("id:c-0")!;
    const d1 = collideSim.getPosition("id:c-1")!;
    expect(Math.hypot(d0.x - d1.x, d0.y - d1.y)).toBeGreaterThan(18);

    const renderer = new OrgGraphCanvasRenderer(container);
    renderer.setViewportState({ panX: 320, panY: 240, scale: 1 });
    renderer.setData(clusterData, collideSim.getNodes(), collideSim.getLinks(), {
      showArrows: true,
      showLabels: true,
      labelFadeThreshold: 0.4,
      nodeSizeScale: 1,
      linkThickness: 1,
    });

    const boxes = renderer.getLastPlacedLabelBoxes();
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const overlap =
          boxes[i].x0 < boxes[j].x1 &&
          boxes[i].x1 > boxes[j].x0 &&
          boxes[i].y0 < boxes[j].y1 &&
          boxes[i].y1 > boxes[j].y0;
        expect(overlap).toBe(false);
      }
    }

    renderer.dispose();
    collideSim.dispose();

    // 2. Slider --slider-pct, dblclick single-slider reset, and panel reset-defaults button
    const { leaf, vaultIndex } = createHarness();
    const view = new OrgGlobalGraphView(leaf, {
      vaultIndex,
      uiLanguage: "zh",
    });
    await view.onOpen();

    const viewRoot = view.contentEl.querySelector(".org-graph-container") as HTMLElement;
    const gearBtn = viewRoot.querySelector(".org-graph-gear-btn") as HTMLButtonElement;
    gearBtn.click();

    const repelInput = viewRoot.querySelector(
      'input[data-slider-key="forces.repelStrength"]'
    ) as HTMLInputElement;
    expect(repelInput).not.toBeNull();
    repelInput.value = "40";
    repelInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(view.getViewState().forces.repelStrength).toBe(40);
    expect(repelInput.style.getPropertyValue("--slider-pct")).toBe("0.00%");

    // Double-click resets only repelStrength to default (240)
    repelInput.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(view.getViewState().forces.repelStrength).toBe(
      createDefaultForceConfig().repelStrength
    );
    expect(Number.parseFloat(repelInput.style.getPropertyValue("--slider-pct"))).toBeGreaterThan(
      20
    );

    // Mutate multiple display & filter settings then click restore defaults
    view.updateDisplayConfig({ nodeSizeScale: 0.5, showLabels: false });
    view.updateFilter({ showOrphans: false });
    const resetAllBtn = viewRoot.querySelector(
      'button[data-action="reset-defaults"]'
    ) as HTMLButtonElement;
    expect(resetAllBtn).not.toBeNull();
    resetAllBtn.click();

    expect(view.getViewState().display).toEqual(createDefaultDisplayConfig());
    expect(view.getViewState().filter.showOrphans).toBe(true);
    expect(view.getViewState().forces).toEqual(createDefaultForceConfig());

    // Header close button closes drawer
    const closeBtn = viewRoot.querySelector(
      'button[data-action="close-controls"]'
    ) as HTMLButtonElement;
    closeBtn.click();
    expect(
      viewRoot.querySelector(".org-graph-controls-panel")?.classList.contains("is-open")
    ).toBe(false);

    await view.onClose();
    vaultIndex.dispose();
  });
});
