import { ItemView, WorkspaceLeaf } from "obsidian";
import type { OrgNodeEntry } from "../../core/model/types";
import type {
  VaultIndexChangeEvent,
  VaultIndexService,
} from "../../core/index/vaultIndexService";
import {
  createDefaultGlobalGraphState,
  createDefaultLocalGraphState,
  type OrgGraphColorGroup,
  type OrgGraphColorSchemeMode,
  type OrgGraphData,
  type OrgGraphDisplayConfig,
  type OrgGraphFilterState,
  type OrgGraphForceConfig,
  type OrgGraphGranularity,
  type OrgGraphNode,
  type OrgGraphViewState,
  mergeGraphViewState,
} from "../../core/graph/types";
import { translate, type TranslationKey, type UiLanguage } from "../../i18n";
import {
  OrgGraphCanvasRenderer,
  type GraphViewportState,
} from "./canvasRenderer";
import { OrgGraphControls } from "./graphControls";
import { OrgGraphSimulation } from "./simulation";

export interface OrgGraphBaseHost {
  vaultIndex?: VaultIndexService;
  t?: (key: TranslationKey) => string;
  uiLanguage?: UiLanguage | (() => UiLanguage);
  openNode?: (
    node: OrgGraphNode,
    options?: { preserveLeaf?: WorkspaceLeaf }
  ) => Promise<void> | void;
  focusInLocalGraph?: (node: OrgGraphNode) => Promise<void> | void;
  saveState?: (state: OrgGraphViewState) => Promise<void> | void;
  readFile?: (filePath: string) => Promise<string | null> | string | null;
  buildGraphData?: (state: OrgGraphViewState) => OrgGraphData;
  hoverDelayMs?: number;
}

export function cloneGraphViewState(state: OrgGraphViewState): OrgGraphViewState {
  return {
    granularity: state.granularity,
    filter: { ...state.filter },
    local: state.local ? { ...state.local } : undefined,
    colorMode: state.colorMode,
    groups: state.groups.map((g) => ({ ...g })),
    display: { ...state.display },
    forces: { ...state.forces },
    controlsOpen: state.controlsOpen,
  };
}

function createEmptyGraphData(granularity: OrgGraphGranularity): OrgGraphData {
  return {
    granularity,
    nodes: [],
    edges: [],
    nodeMap: new Map(),
    stats: {
      nodeCount: 0,
      edgeCount: 0,
      referenceEdges: 0,
      transclusionEdges: 0,
      structuralEdges: 0,
      orphanCount: 0,
      duplicateCount: 0,
      unresolvedCount: 0,
      fileCount: 0,
    },
    indexVersion: 0,
  };
}

function sameGraphTopology(a: OrgGraphData, b: OrgGraphData): boolean {
  if (a.granularity !== b.granularity) return false;
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) {
    return false;
  }
  for (let i = 0; i < a.nodes.length; i++) {
    if (a.nodes[i].id !== b.nodes[i].id) return false;
  }
  for (let i = 0; i < a.edges.length; i++) {
    if (a.edges[i].id !== b.edges[i].id) return false;
  }
  return true;
}

function toOrgNodeEntry(node: OrgGraphNode): OrgNodeEntry {
  return {
    id: node.orgId,
    customId: node.customId,
    filePath: node.filePath,
    line: node.line,
    endLine: node.endLine,
    level: node.level,
    title: node.title,
    headingPath: node.headingPath,
    drawerStartLine: node.line,
    drawerEndLine: node.line,
    tags: node.tags,
    todo: node.todo,
    parentNodeId: node.parentNodeId,
  };
}

/**
 * Base ItemView shared by OrgGlobalGraphView and OrgLocalGraphView.
 * Strictly read-only: never writes or modifies any .org file on disk.
 */
export abstract class OrgGraphBaseView extends ItemView {
  protected viewState: OrgGraphViewState;
  protected readonly simulation: OrgGraphSimulation;
  protected renderer: OrgGraphCanvasRenderer | null = null;
  protected controls: OrgGraphControls | null = null;
  protected graphData: OrgGraphData | null = null;

  private containerElRoot: HTMLElement | null = null;
  private canvasWrapEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribeIndex: (() => void) | null = null;
  private indexRefreshTimer: number | null = null;
  private persistTimer: number | null = null;
  private rafId: number | null = null;

  protected isOpen = false;
  private hasInitialLayout = false;
  private selectedNodeId: string | null = null;
  private pendingViewport: GraphViewportState | null = null;
  private pendingCustomEmptyMessage: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    initialState: OrgGraphViewState = createDefaultGlobalGraphState(),
    protected readonly baseHost: OrgGraphBaseHost = {}
  ) {
    super(leaf);
    this.viewState = cloneGraphViewState(initialState);
    this.simulation = new OrgGraphSimulation(this.viewState.forces);
  }

  protected get uiLanguage(): UiLanguage {
    const raw =
      typeof this.baseHost.uiLanguage === "function"
        ? this.baseHost.uiLanguage()
        : this.baseHost.uiLanguage;
    if (raw === "en" || raw === "zh") return raw;
    return this.baseHost.vaultIndex?.getUiLanguage?.() ?? "en";
  }

  protected t(key: TranslationKey): string {
    if (typeof this.baseHost.t === "function") {
      return this.baseHost.t(key);
    }
    if (this.baseHost.vaultIndex) {
      return this.baseHost.vaultIndex.translate(key);
    }
    return translate(this.uiLanguage, key);
  }

  protected buildGraphData(state: OrgGraphViewState): OrgGraphData {
    if (this.baseHost.buildGraphData) {
      return this.baseHost.buildGraphData(state);
    }
    return createEmptyGraphData(state.granularity);
  }

  protected shouldRefreshForIndexEvent(_event?: VaultIndexChangeEvent): boolean {
    return true;
  }

  protected savePersistedState(state: OrgGraphViewState): void {
    void this.baseHost.saveState?.(cloneGraphViewState(state));
  }

  protected schedulePersistedState(immediate = false): void {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (immediate) {
      this.savePersistedState(this.viewState);
      return;
    }
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.savePersistedState(this.viewState);
    }, 160);
  }

  protected onAfterRenderUI(_controls: OrgGraphControls): void {
    // Subclasses (e.g., OrgLocalGraphView) attach local HUD controls here.
  }

  async onOpen(): Promise<void> {
    this.cleanupRuntimeHandles();
    this.isOpen = true;
    this.hasInitialLayout = false;

    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add("org-graph-view-content");

    const container = document.createElement("div");
    container.className = "org-graph-container";
    root.appendChild(container);
    this.containerElRoot = container;

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "org-graph-canvas-wrap";
    container.appendChild(canvasWrap);
    this.canvasWrapEl = canvasWrap;

    this.renderer = new OrgGraphCanvasRenderer(canvasWrap, {
      onSelectNode: (node) => {
        this.selectedNodeId = node?.id ?? null;
        this.controls?.setSelectedNode(node);
      },
      onOpenNode: (node) => {
        void this.openGraphNode(node);
      },
      onHoverNode: (anchor) => {
        this.controls?.handleHoverAnchor(anchor);
      },
      onDragStart: (nodeId) => {
        this.controls?.removeHoverPopover();
        this.simulation.beginDrag(nodeId);
        this.kickSimulationLoop();
      },
      onDragMove: (nodeId, wx, wy) => {
        this.simulation.dragTo(nodeId, wx, wy);
        this.renderer?.markPositionsDirty();
        this.renderer?.render();
        this.kickSimulationLoop();
      },
      onDragEnd: (nodeId) => {
        this.simulation.endDrag(nodeId);
        this.kickSimulationLoop();
      },
      onViewportChange: (vp) => {
        this.pendingViewport = vp;
      },
      getPositionVersion: () => this.simulation.getPositionVersion(),
    });

    this.controls = new OrgGraphControls(container, cloneGraphViewState(this.viewState), {
      t: (key) => this.t(key),
      getUiLanguage: () => this.uiLanguage,
      hoverDelayMs: this.baseHost.hoverDelayMs,
      onChangeGranularity: (g) => this.setGranularity(g),
      onChangeFilter: (patch) => this.updateFilter(patch),
      onChangeColorMode: (mode) => this.setColorMode(mode),
      onChangeGroups: (groups) => this.setColorGroups(groups),
      onChangeDisplay: (patch) => this.updateDisplayConfig(patch),
      onChangeForces: (patch) => this.updateForceConfig(patch),
      onToggleControlsOpen: (open) => {
        this.viewState.controlsOpen = open;
        this.controls?.syncState(cloneGraphViewState(this.viewState));
        this.schedulePersistedState(true);
      },
      onResetDefaults: () => this.resetToDefaults(),
      onZoomIn: () => this.zoomBy(1.25),
      onZoomOut: () => this.zoomBy(0.8),
      onFitToView: () => this.fitToView(),
      onRelayout: () => this.relayout(),
      onOpenNode: (node) => {
        void this.openGraphNode(node);
      },
      onCloseInspector: () => this.selectNode(null),
      onFocusInLocalGraph: this.baseHost.focusInLocalGraph
        ? (node) => {
            void this.baseHost.focusInLocalGraph?.(node);
          }
        : undefined,
      readFile:
        this.baseHost.readFile ??
        (this.baseHost.vaultIndex
          ? (filePath) => this.baseHost.vaultIndex!.readFileReadOnly(filePath)
          : undefined),
    });

    if (this.pendingCustomEmptyMessage !== null) {
      this.controls.setEmptyMessage(this.pendingCustomEmptyMessage);
    }

    this.onAfterRenderUI(this.controls);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver((entries) => {
        if (!this.isOpen || !this.renderer) return;
        for (const entry of entries) {
          const w = entry.contentRect?.width ?? canvasWrap.clientWidth;
          const h = entry.contentRect?.height ?? canvasWrap.clientHeight;
          if (w > 0 && h > 0) {
            this.renderer.resize(w, h);
          }
        }
      });
      this.resizeObserver.observe(canvasWrap);
    }

    if (this.baseHost.vaultIndex) {
      this.unsubscribeIndex = this.baseHost.vaultIndex.onDidChange((event) => {
        if (!this.isOpen || !this.shouldRefreshForIndexEvent(event)) return;
        this.scheduleIndexRefresh();
      });
    }

    this.refreshGraph(false);
  }

  async onClose(): Promise<void> {
    this.isOpen = false;
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.savePersistedState(this.viewState);
    }
    this.cleanupRuntimeHandles();
    this.simulation.dispose();
    this.graphData = null;
    this.contentEl.replaceChildren();
  }

  private cleanupRuntimeHandles(): void {
    if (this.indexRefreshTimer !== null) {
      window.clearTimeout(this.indexRefreshTimer);
      this.indexRefreshTimer = null;
    }
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls?.dispose();
    this.controls = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.containerElRoot = null;
    this.canvasWrapEl = null;
  }

  private scheduleIndexRefresh(): void {
    if (this.indexRefreshTimer !== null) {
      window.clearTimeout(this.indexRefreshTimer);
    }
    this.indexRefreshTimer = window.setTimeout(() => {
      this.indexRefreshTimer = null;
      if (this.isOpen) {
        this.refreshGraph(true);
      }
    }, 120);
  }

  private kickSimulationLoop(): void {
    if (!this.isOpen || !this.renderer) return;
    if (!this.simulation.isActive()) return;
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame !== "function") return;

    const tickLoop = () => {
      this.rafId = null;
      if (!this.isOpen || !this.renderer) return;
      const stillActive = this.simulation.stepFrame(12);
      this.renderer.markPositionsDirty();
      this.renderer.render();
      if (stillActive) {
        this.rafId = requestAnimationFrame(tickLoop);
      }
    };

    this.rafId = requestAnimationFrame(tickLoop);
  }

  protected async openGraphNode(node: OrgGraphNode): Promise<void> {
    if (this.baseHost.openNode) {
      await this.baseHost.openNode(node, { preserveLeaf: this.leaf });
      return;
    }
    const vaultIndex = this.baseHost.vaultIndex;
    if (!vaultIndex) return;

    if (node.kind === "unresolved") {
      if (node.orgId) {
        await vaultIndex.navigateToId(node.orgId, undefined, {
          preserveLeaf: this.leaf,
          highlight: true,
        });
      }
      return;
    }

    if (node.kind === "file") {
      await vaultIndex.openLocation(node.filePath, node.line, undefined, {
        preserveLeaf: this.leaf,
        highlight: true,
      });
      return;
    }

    await vaultIndex.openNode(toOrgNodeEntry(node), undefined, {
      preserveLeaf: this.leaf,
      highlight: true,
    });
  }

  // --- State & View Lifecycle Persistence -----------------------------------

  getState(): Record<string, unknown> {
    const viewport = this.renderer
      ? this.renderer.getViewportState()
      : this.pendingViewport ?? undefined;
    return {
      ...cloneGraphViewState(this.viewState),
      viewport,
      selectedNodeId: this.selectedNodeId,
    };
  }

  async setState(state: unknown, result: unknown): Promise<void> {
    await super.setState(state, result as never);
    if (!state || typeof state !== "object") return;

    const raw = state as Record<string, unknown>;
    this.viewState = mergeGraphViewState(
      this.viewState,
      raw as Partial<OrgGraphViewState>
    );

    if (
      raw.viewport &&
      typeof raw.viewport === "object" &&
      typeof (raw.viewport as GraphViewportState).scale === "number"
    ) {
      const vp = raw.viewport as GraphViewportState;
      this.pendingViewport = {
        panX: Number.isFinite(vp.panX) ? vp.panX : 400,
        panY: Number.isFinite(vp.panY) ? vp.panY : 300,
        scale: Number.isFinite(vp.scale) ? vp.scale : 1,
      };
    }

    if (typeof raw.selectedNodeId === "string" || raw.selectedNodeId === null) {
      this.selectedNodeId = raw.selectedNodeId;
    }

    this.simulation.updateForces(this.viewState.forces);
    this.controls?.syncState(cloneGraphViewState(this.viewState));
    this.renderer?.setDisplayConfig(this.viewState.display);

    if (this.isOpen) {
      this.refreshGraph(true);
      if (this.pendingViewport && this.renderer) {
        this.renderer.setViewportState(this.pendingViewport);
        this.pendingViewport = null;
      }
      if (this.selectedNodeId !== null) {
        this.selectNode(this.selectedNodeId);
      }
    }
  }

  // --- Public Inspectable & Interactive API --------------------------------

  getGraphData(): OrgGraphData | null {
    return this.graphData;
  }

  getViewState(): OrgGraphViewState {
    return cloneGraphViewState(this.viewState);
  }

  getControls(): OrgGraphControls | null {
    return this.controls;
  }

  getRenderer(): OrgGraphCanvasRenderer | null {
    return this.renderer;
  }

  getSimulation(): OrgGraphSimulation {
    return this.simulation;
  }

  setEmptyMessage(message: string | null): void {
    this.pendingCustomEmptyMessage = message;
    this.controls?.setEmptyMessage(message);
  }

  setGranularity(granularity: OrgGraphGranularity): void {
    if (this.viewState.granularity === granularity) return;
    this.viewState.granularity = granularity;
    this.selectedNodeId = null;
    this.hasInitialLayout = false;
    this.controls?.syncState(cloneGraphViewState(this.viewState));
    this.refreshGraph(false);
    this.schedulePersistedState(true);
  }

  setSearchQuery(query: string): void {
    this.updateFilter({ search: query });
  }

  updateFilter(patch: Partial<OrgGraphFilterState>): void {
    this.viewState.filter = {
      ...this.viewState.filter,
      ...patch,
    };
    this.controls?.syncState(cloneGraphViewState(this.viewState));
    this.refreshGraph(true);
    this.schedulePersistedState(patch.search === undefined);
  }

  setColorMode(mode: OrgGraphColorSchemeMode): void {
    if (this.viewState.colorMode === mode) return;
    this.viewState.colorMode = mode;
    this.controls?.syncState(cloneGraphViewState(this.viewState));
    this.refreshGraph(true, { reheat: false });
    this.schedulePersistedState(true);
  }

  setColorGroups(groups: OrgGraphColorGroup[]): void {
    this.viewState.groups = groups.map((g) => ({ ...g }));
    this.controls?.syncState(cloneGraphViewState(this.viewState));
    this.refreshGraph(true, { reheat: false });
    this.schedulePersistedState(false);
  }

  updateDisplayConfig(patch: Partial<OrgGraphDisplayConfig>): void {
    this.viewState.display = {
      ...this.viewState.display,
      ...patch,
    };
    this.controls?.syncState(cloneGraphViewState(this.viewState));
    this.renderer?.setDisplayConfig(this.viewState.display);
    this.schedulePersistedState(false);
  }

  updateForceConfig(patch: Partial<OrgGraphForceConfig>): void {
    this.viewState.forces = {
      ...this.viewState.forces,
      ...patch,
    };
    this.controls?.syncState(cloneGraphViewState(this.viewState));
    this.simulation.updateForces(this.viewState.forces);
    this.kickSimulationLoop();
    this.schedulePersistedState(false);
  }

  resetToDefaults(): void {
    const defaults = this.viewState.local
      ? createDefaultLocalGraphState()
      : createDefaultGlobalGraphState();
    this.viewState = {
      ...this.viewState,
      filter: { ...defaults.filter },
      colorMode: defaults.colorMode,
      groups: defaults.groups.map((g) => ({ ...g })),
      display: { ...defaults.display },
      forces: { ...defaults.forces },
    };
    this.controls?.syncState(cloneGraphViewState(this.viewState));
    this.renderer?.setDisplayConfig(this.viewState.display);
    this.simulation.updateForces(this.viewState.forces);
    this.refreshGraph(true);
    this.schedulePersistedState(true);
  }

  updateViewState(
    patch: Partial<OrgGraphViewState>,
    options: { rebuild?: boolean; preserveLayout?: boolean; save?: boolean } = {}
  ): void {
    this.viewState = mergeGraphViewState(this.viewState, patch);
    this.controls?.syncState(cloneGraphViewState(this.viewState));
    this.renderer?.setDisplayConfig(this.viewState.display);
    this.simulation.updateForces(this.viewState.forces);
    if (options.rebuild ?? true) {
      this.refreshGraph(options.preserveLayout ?? true);
    }
    if (options.save ?? true) {
      this.schedulePersistedState(true);
    }
  }

  selectNode(nodeId: string | null): void {
    const resolved =
      nodeId && this.graphData?.nodeMap.has(nodeId) ? nodeId : null;
    this.selectedNodeId = resolved;
    const node = resolved ? this.graphData?.nodeMap.get(resolved) ?? null : null;
    this.renderer?.setSelectedNode(resolved);
    this.controls?.setSelectedNode(node);
  }

  getSelectedNodeId(): string | null {
    return this.selectedNodeId;
  }

  getViewportState(): GraphViewportState {
    if (this.renderer) {
      return this.renderer.getViewportState();
    }
    return this.pendingViewport ?? { panX: 400, panY: 300, scale: 1 };
  }

  setViewportState(state: Partial<GraphViewportState>): void {
    if (this.renderer) {
      this.renderer.setViewportState(state);
      this.pendingViewport = this.renderer.getViewportState();
    } else {
      const base = this.pendingViewport ?? { panX: 400, panY: 300, scale: 1 };
      this.pendingViewport = {
        panX: state.panX ?? base.panX,
        panY: state.panY ?? base.panY,
        scale: state.scale ?? base.scale,
      };
    }
  }

  fitToView(padding = 64): void {
    this.renderer?.fitToView(padding);
    if (this.renderer) {
      this.pendingViewport = this.renderer.getViewportState();
    }
  }

  centerOnNode(nodeId: string): boolean {
    if (!this.renderer) return false;
    const ok = this.renderer.centerOnNode(nodeId);
    if (ok) {
      this.pendingViewport = this.renderer.getViewportState();
    }
    return ok;
  }

  zoomBy(factor: number): void {
    this.renderer?.zoomBy(factor);
    if (this.renderer) {
      this.pendingViewport = this.renderer.getViewportState();
    }
  }

  relayout(): void {
    this.hasInitialLayout = false;
    this.refreshGraph(false);
  }

  getNodePosition(nodeId: string): { x: number; y: number } | null {
    return this.simulation.getPosition(nodeId);
  }

  getSimulationAlpha(): number {
    return this.simulation.getAlpha();
  }

  refreshGraph(preserveLayout = true, options: { reheat?: boolean } = {}): void {
    const prevData = this.graphData;
    const nextData = this.buildGraphData(cloneGraphViewState(this.viewState));

    if (
      preserveLayout &&
      options.reheat === false &&
      prevData &&
      sameGraphTopology(prevData, nextData)
    ) {
      this.graphData = nextData;
      this.simulation.updateMetadata(nextData);
      this.renderer?.setData(
        nextData,
        this.simulation.getNodes(),
        this.simulation.getLinks(),
        this.viewState.display
      );
      this.controls?.updateStats(nextData.stats);
      const selected = this.selectedNodeId
        ? nextData.nodeMap.get(this.selectedNodeId) ?? null
        : null;
      this.controls?.setSelectedNode(selected);
      return;
    }

    const shouldInitialFit = !this.hasInitialLayout || !preserveLayout;
    const needsWarmUp = shouldInitialFit || (prevData?.nodes.length ?? 0) === 0;
    const warmUpTicks = needsWarmUp
      ? nextData.nodes.length >= 2500
        ? 24
        : nextData.nodes.length >= 800
          ? 45
          : 70
      : 0;

    this.graphData = nextData;
    this.simulation.setGraph(nextData, this.viewState.forces, {
      preserveLayout,
      warmUpTicks,
      warmUpMaxMs: 42,
    });

    this.renderer?.setData(
      nextData,
      this.simulation.getNodes(),
      this.simulation.getLinks(),
      this.viewState.display
    );

    if (shouldInitialFit && nextData.nodes.length > 0 && this.renderer) {
      if (this.pendingViewport) {
        this.renderer.setViewportState(this.pendingViewport);
        this.pendingViewport = null;
      } else {
        this.renderer.fitToView();
      }
      this.hasInitialLayout = true;
    }

    if (this.selectedNodeId && !nextData.nodeMap.has(this.selectedNodeId)) {
      this.selectedNodeId = null;
    }
    const selectedNode = this.selectedNodeId
      ? nextData.nodeMap.get(this.selectedNodeId) ?? null
      : null;
    this.renderer?.setSelectedNode(this.selectedNodeId);
    this.controls?.setSelectedNode(selectedNode);
    this.controls?.updateStats(nextData.stats);

    this.kickSimulationLoop();
  }
}
