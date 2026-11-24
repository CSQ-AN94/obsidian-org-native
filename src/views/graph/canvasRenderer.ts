// @ts-expect-error d3-quadtree is bundled via d3-force without @types/d3-quadtree
import { quadtree as d3Quadtree } from "d3-quadtree";
import {
  createDefaultDisplayConfig,
  type OrgGraphData,
  type OrgGraphDisplayConfig,
  type OrgGraphNode,
} from "../../core/graph/types";
import { resolveSimLinkEndpoints, type SimLink, type SimNode } from "./simulation";

export interface SpatialQuadtree<T> {
  x(fn: (d: T) => number): this;
  y(fn: (d: T) => number): this;
  addAll(data: Iterable<T>): this;
  find(x: number, y: number, radius?: number): T | undefined;
  visit(
    callback: (
      node: QuadtreeNode<T>,
      x0: number,
      y0: number,
      x1: number,
      y1: number
    ) => boolean | void
  ): this;
  size(): number;
}

export interface QuadtreeNode<T> {
  length?: number;
  data?: T;
  next?: QuadtreeNode<T>;
}

const createQuadtree = d3Quadtree as unknown as <T>() => SpatialQuadtree<T>;

export const MIN_GRAPH_SCALE = 0.08;
export const MAX_GRAPH_SCALE = 6.0;
const DRAG_THRESHOLD_PX = 4;
const MAX_LABELS_PER_FRAME = 180;

export interface GraphViewportState {
  panX: number;
  panY: number;
  scale: number;
}

export interface GraphHoverAnchor {
  node: OrgGraphNode;
  screenX: number;
  screenY: number;
  clientX: number;
  clientY: number;
}

export interface OrgGraphTheme {
  isDark: boolean;
  background: string;
  textNormal: string;
  textMuted: string;
  accent: string;
  nodeDefault: string;
  fileNode: string;
  referenceEdge: string;
  transclusionEdge: string;
  structuralEdge: string;
  duplicateColor: string;
  unresolvedColor: string;
  borderColor: string;
  labelHalo: string;
  fontFamily: string;
}

export interface OrgGraphCanvasCallbacks {
  onSelectNode?: (node: OrgGraphNode | null) => void;
  onOpenNode?: (node: OrgGraphNode, event: MouseEvent) => void;
  onHoverNode?: (anchor: GraphHoverAnchor | null) => void;
  onDragStart?: (nodeId: string) => void;
  onDragMove?: (nodeId: string, worldX: number, worldY: number) => void;
  onDragEnd?: (nodeId: string) => void;
  onViewportChange?: (viewport: GraphViewportState) => void;
  getPositionVersion?: () => number;
}

function readCssVar(style: CSSStyleDeclaration | null, name: string, fallback: string): string {
  if (!style) return fallback;
  const val = style.getPropertyValue(name)?.trim();
  return val || fallback;
}

export function resolveGraphTheme(el: HTMLElement): OrgGraphTheme {
  const doc = el.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
  const body = doc?.body;
  const isDark = body
    ? body.classList.contains("theme-dark") || !body.classList.contains("theme-light")
    : true;

  let computed: CSSStyleDeclaration | null = null;
  try {
    computed = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  } catch {
    computed = null;
  }

  const background = readCssVar(
    computed,
    "--background-primary",
    isDark ? "#1e1e1e" : "#ffffff"
  );
  const textNormal = readCssVar(
    computed,
    "--text-normal",
    isDark ? "#dcddde" : "#222222"
  );
  const textMuted = readCssVar(
    computed,
    "--text-muted",
    isDark ? "#9aa2b1" : "#5c6470"
  );
  const accent = readCssVar(
    computed,
    "--interactive-accent",
    isDark ? "#8b5cf6" : "#6d28d9"
  );
  const transclusionEdge = readCssVar(
    computed,
    "--color-purple",
    accent
  );
  const duplicateColor = readCssVar(
    computed,
    "--color-orange",
    isDark ? "#e39b2d" : "#c97a16"
  );
  const unresolvedColor = readCssVar(
    computed,
    "--text-error",
    isDark ? "#ef6b6b" : "#cf222e"
  );
  const borderColor = readCssVar(
    computed,
    "--background-modifier-border",
    isDark ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.14)"
  );
  const fontFamily = readCssVar(
    computed,
    "--font-interface",
    '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", system-ui, -apple-system, sans-serif'
  );

  return {
    isDark,
    background,
    textNormal,
    textMuted,
    accent,
    nodeDefault: isDark ? "#7c899e" : "#64748b",
    fileNode: accent,
    referenceEdge: isDark ? "rgba(165, 177, 194, 0.72)" : "rgba(85, 96, 112, 0.65)",
    transclusionEdge,
    structuralEdge: isDark ? "rgba(130, 142, 160, 0.45)" : "rgba(110, 120, 136, 0.42)",
    duplicateColor,
    unresolvedColor,
    borderColor,
    labelHalo: isDark ? "rgba(24, 24, 27, 0.86)" : "rgba(255, 255, 255, 0.88)",
    fontFamily,
  };
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function truncateLabel(title: string, maxChars = 26): string {
  const chars = Array.from(title.trim());
  if (chars.length <= maxChars) return chars.join("");
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

export interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function estimateLabelWidthFallback(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code > 0x2e7f ? fontSize * 1.02 : fontSize * 0.6;
  }
  return width + 4;
}

function circleIntersectsBox(
  cx: number,
  cy: number,
  cr: number,
  box: LabelBox
): boolean {
  const nearestX = clamp(cx, box.x0, box.x1);
  const nearestY = clamp(cy, box.y0, box.y1);
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy < cr * cr;
}

type PointerInteraction =
  | { kind: "idle" }
  | {
      kind: "drag-pending";
      nodeId: string;
      startScreenX: number;
      startScreenY: number;
    }
  | {
      kind: "dragging";
      nodeId: string;
    }
  | {
      kind: "pan-pending";
      startScreenX: number;
      startScreenY: number;
      startPanX: number;
      startPanY: number;
    }
  | {
      kind: "panning";
      startScreenX: number;
      startScreenY: number;
      startPanX: number;
      startPanY: number;
    };

/**
 * HiDPI Canvas2D graph renderer with batched edge drawing, parallel curve separation,
 * d3-quadtree spatial hit-testing, zoom-adaptive CJK/Latin label LOD, and dynamic theme sync.
 */
export class OrgGraphCanvasRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private theme: OrgGraphTheme;
  private themeObserver: MutationObserver | null = null;

  private width: number;
  private height: number;
  private dpr = 1;
  private viewport: GraphViewportState;
  private display: OrgGraphDisplayConfig = createDefaultDisplayConfig();

  private graphData: OrgGraphData | null = null;
  private nodes: readonly SimNode[] = [];
  private links: readonly SimLink[] = [];
  private nodeById = new Map<string, SimNode>();
  private neighborMap = new Map<string, Set<string>>();
  private maxNodeWorldRadius = 18;

  private spatialTree: SpatialQuadtree<SimNode> | null = null;
  private quadtreeDirty = true;
  private lastQuadtreeVersion = -1;

  private selectedNodeId: string | null = null;
  private hoveredNodeId: string | null = null;
  private activeFocusId: string | null = null;
  private focusBlend = 0;
  private hoverNodeIdAnim: string | null = null;
  private hoverScale = 1;
  private animRafId: number | null = null;
  private textWidthCache = new Map<string, number>();
  private lastPlacedLabelBoxes: LabelBox[] = [];
  private interaction: PointerInteraction = { kind: "idle" };
  private disposed = false;

  private readonly boundPointerDown: (e: PointerEvent) => void;
  private readonly boundPointerMove: (e: PointerEvent) => void;
  private readonly boundPointerUp: (e: PointerEvent) => void;
  private readonly boundPointerLeave: (e: PointerEvent) => void;
  private readonly boundDblClick: (e: MouseEvent) => void;
  private readonly boundWheel: (e: WheelEvent) => void;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: OrgGraphCanvasCallbacks = {}
  ) {
    const doc = container.ownerDocument ?? document;
    this.canvas = doc.createElement("canvas");
    this.canvas.className = "org-graph-canvas";
    this.canvas.setAttribute("tabindex", "0");
    container.appendChild(this.canvas);

    try {
      this.ctx = this.canvas.getContext("2d");
    } catch {
      this.ctx = null;
    }

    this.width = Math.max(1, container.clientWidth || 800);
    this.height = Math.max(1, container.clientHeight || 600);
    this.viewport = {
      panX: this.width / 2,
      panY: this.height / 2,
      scale: 1,
    };

    this.applyCanvasDimensions();
    this.theme = resolveGraphTheme(this.container);
    this.observeThemeChanges();

    this.boundPointerDown = (e) => this.handlePointerDown(e);
    this.boundPointerMove = (e) => this.handlePointerMove(e);
    this.boundPointerUp = (e) => this.handlePointerUp(e);
    this.boundPointerLeave = () => this.handlePointerLeave();
    this.boundDblClick = (e) => this.handleDoubleClick(e);
    this.boundWheel = (e) => this.handleWheel(e);

    this.canvas.addEventListener("pointerdown", this.boundPointerDown);
    this.canvas.addEventListener("pointermove", this.boundPointerMove);
    this.canvas.addEventListener("pointerup", this.boundPointerUp);
    this.canvas.addEventListener("pointercancel", this.boundPointerUp);
    this.canvas.addEventListener("pointerleave", this.boundPointerLeave);
    this.canvas.addEventListener("dblclick", this.boundDblClick);
    this.canvas.addEventListener("wheel", this.boundWheel, { passive: false });
  }

  private observeThemeChanges(): void {
    if (typeof MutationObserver === "undefined") return;
    const doc = this.container.ownerDocument ?? document;
    const targets = [doc.body, doc.documentElement].filter(
      (el): el is HTMLElement => Boolean(el)
    );
    if (targets.length === 0) return;

    this.themeObserver = new MutationObserver(() => {
      if (this.disposed) return;
      this.refreshTheme();
    });
    for (const target of targets) {
      this.themeObserver.observe(target, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    }
  }

  refreshTheme(): void {
    this.textWidthCache.clear();
    this.theme = resolveGraphTheme(this.container);
    this.render();
  }

  getTheme(): OrgGraphTheme {
    return this.theme;
  }

  private applyCanvasDimensions(): void {
    const win = this.container.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : undefined);
    this.dpr = Math.max(1, Math.min(3, win?.devicePixelRatio ?? 1));
    this.canvas.width = Math.max(1, Math.round(this.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * this.dpr));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  resize(width: number, height: number): void {
    const nextW = Math.max(1, Math.round(width));
    const nextH = Math.max(1, Math.round(height));
    if (nextW === this.width && nextH === this.height) return;

    const dx = (nextW - this.width) * 0.5;
    const dy = (nextH - this.height) * 0.5;
    this.width = nextW;
    this.height = nextH;
    this.viewport.panX += dx;
    this.viewport.panY += dy;

    this.applyCanvasDimensions();
    this.render();
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  setData(
    data: OrgGraphData | null,
    simNodes: readonly SimNode[],
    simLinks: readonly SimLink[],
    display?: Partial<OrgGraphDisplayConfig>
  ): void {
    this.graphData = data;
    if (display) {
      this.display = { ...this.display, ...display };
    }
    this.nodes = simNodes;
    this.links = simLinks;

    this.nodeById.clear();
    this.neighborMap.clear();
    let maxR = 12;

    for (const node of simNodes) {
      this.nodeById.set(node.id, node);
      this.neighborMap.set(node.id, new Set<string>());
      const r = this.getNodeRadius(node);
      if (r > maxR) maxR = r;
    }
    this.maxNodeWorldRadius = maxR;

    for (const link of simLinks) {
      const endpoints = resolveSimLinkEndpoints(link);
      if (!endpoints) continue;
      this.neighborMap.get(endpoints.source.id)?.add(endpoints.target.id);
      this.neighborMap.get(endpoints.target.id)?.add(endpoints.source.id);
    }

    if (this.selectedNodeId && !this.nodeById.has(this.selectedNodeId)) {
      this.selectedNodeId = null;
    }
    if (this.hoveredNodeId && !this.nodeById.has(this.hoveredNodeId)) {
      this.hoveredNodeId = null;
      this.canvas.classList.remove("is-hovering-node");
    }
    if (this.activeFocusId && !this.nodeById.has(this.activeFocusId)) {
      this.activeFocusId = null;
      this.focusBlend = 0;
    }
    if (this.hoverNodeIdAnim && !this.nodeById.has(this.hoverNodeIdAnim)) {
      this.hoverNodeIdAnim = null;
      this.hoverScale = 1;
    }
    const nextFocus = this.hoveredNodeId ?? this.selectedNodeId;
    if (nextFocus) {
      this.activeFocusId = nextFocus;
      this.focusBlend = 1;
    }
    if (this.hoveredNodeId) {
      this.hoverNodeIdAnim = this.hoveredNodeId;
    }

    this.quadtreeDirty = true;
    this.ensureQuadtree();
    this.render();
  }

  setDisplayConfig(display: Partial<OrgGraphDisplayConfig>): void {
    this.display = { ...this.display, ...display };
    let maxR = 12;
    for (const node of this.nodes) {
      const r = this.getNodeRadius(node);
      if (r > maxR) maxR = r;
    }
    this.maxNodeWorldRadius = maxR;
    this.render();
  }

  markPositionsDirty(): void {
    this.quadtreeDirty = true;
  }

  getNodeRadius(node: SimNode): number {
    let base = 4.5 + Math.min(10, Math.sqrt(Math.max(0, node.data.degree)) * 1.45);
    if (node.data.kind === "file") base += 1.6;
    if (node.data.isCenter) base += 3.2;
    return base * Math.max(0.4, this.display.nodeSizeScale);
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: wx * this.viewport.scale + this.viewport.panX,
      y: wy * this.viewport.scale + this.viewport.panY,
    };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const s = Math.max(MIN_GRAPH_SCALE, this.viewport.scale);
    return {
      x: (sx - this.viewport.panX) / s,
      y: (sy - this.viewport.panY) / s,
    };
  }

  getViewportState(): GraphViewportState {
    return { ...this.viewport };
  }

  setViewportState(next: Partial<GraphViewportState>): void {
    const scale =
      typeof next.scale === "number" && Number.isFinite(next.scale)
        ? clamp(next.scale, MIN_GRAPH_SCALE, MAX_GRAPH_SCALE)
        : this.viewport.scale;
    const panX =
      typeof next.panX === "number" && Number.isFinite(next.panX)
        ? next.panX
        : this.viewport.panX;
    const panY =
      typeof next.panY === "number" && Number.isFinite(next.panY)
        ? next.panY
        : this.viewport.panY;

    this.viewport = { panX, panY, scale };
    this.callbacks.onViewportChange?.(this.getViewportState());
    this.render();
  }

  zoomBy(factor: number, anchorScreenX?: number, anchorScreenY?: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const sx = anchorScreenX ?? this.width * 0.5;
    const sy = anchorScreenY ?? this.height * 0.5;
    const world = this.screenToWorld(sx, sy);
    const nextScale = clamp(this.viewport.scale * factor, MIN_GRAPH_SCALE, MAX_GRAPH_SCALE);
    this.viewport = {
      scale: nextScale,
      panX: sx - world.x * nextScale,
      panY: sy - world.y * nextScale,
    };
    this.callbacks.onViewportChange?.(this.getViewportState());
    this.render();
  }

  fitToView(padding = 64): void {
    if (this.nodes.length === 0) {
      this.viewport = {
        panX: this.width * 0.5,
        panY: this.height * 0.5,
        scale: 1,
      };
      this.callbacks.onViewportChange?.(this.getViewportState());
      this.render();
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const node of this.nodes) {
      const r = this.getNodeRadius(node);
      if (node.x - r < minX) minX = node.x - r;
      if (node.x + r > maxX) maxX = node.x + r;
      if (node.y - r < minY) minY = node.y - r;
      if (node.y + r > maxY) maxY = node.y + r;
    }

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const availW = Math.max(40, this.width - padding * 2);
    const availH = Math.max(40, this.height - padding * 2);

    const scale =
      this.nodes.length === 1
        ? 1
        : clamp(Math.min(availW / spanX, availH / spanY), MIN_GRAPH_SCALE, 1.6);

    const midX = (minX + maxX) * 0.5;
    const midY = (minY + maxY) * 0.5;
    this.viewport = {
      scale,
      panX: this.width * 0.5 - midX * scale,
      panY: this.height * 0.5 - midY * scale,
    };
    this.callbacks.onViewportChange?.(this.getViewportState());
    this.render();
  }

  centerOnNode(nodeId: string): boolean {
    const node = this.nodeById.get(nodeId);
    if (!node) return false;
    this.viewport = {
      ...this.viewport,
      panX: this.width * 0.5 - node.x * this.viewport.scale,
      panY: this.height * 0.5 - node.y * this.viewport.scale,
    };
    this.callbacks.onViewportChange?.(this.getViewportState());
    this.render();
    return true;
  }

  setSelectedNode(nodeId: string | null): void {
    const normalized = nodeId && this.nodeById.has(nodeId) ? nodeId : null;
    if (this.selectedNodeId === normalized) return;
    this.selectedNodeId = normalized;
    const focusTarget = this.hoveredNodeId ?? this.selectedNodeId;
    if (focusTarget) {
      this.activeFocusId = focusTarget;
      this.focusBlend = 1;
    } else {
      this.scheduleVisualAnimation();
    }
    this.render();
  }

  getSelectedNodeId(): string | null {
    return this.selectedNodeId;
  }

  setHoveredNode(nodeId: string | null): void {
    const normalized = nodeId && this.nodeById.has(nodeId) ? nodeId : null;
    if (this.hoveredNodeId === normalized) return;
    this.hoveredNodeId = normalized;
    this.canvas.classList.toggle("is-hovering-node", normalized !== null);
    this.scheduleVisualAnimation();
    this.render();
  }

  getHoveredNodeId(): string | null {
    return this.hoveredNodeId;
  }

  getLastPlacedLabelBoxes(): readonly LabelBox[] {
    return this.lastPlacedLabelBoxes;
  }

  private scheduleVisualAnimation(): void {
    const targetFocus = this.hoveredNodeId ?? this.selectedNodeId;
    const targetFocusBlend = targetFocus && this.nodeById.has(targetFocus) ? 1 : 0;
    const targetHoverId =
      this.hoveredNodeId && this.nodeById.has(this.hoveredNodeId) ? this.hoveredNodeId : null;
    const targetHoverScale = targetHoverId ? 1.24 : 1;

    if (targetFocus) {
      this.activeFocusId = targetFocus;
    }
    if (targetHoverId) {
      this.hoverNodeIdAnim = targetHoverId;
    }

    if (typeof requestAnimationFrame !== "function") {
      this.activeFocusId = targetFocus;
      this.focusBlend = targetFocusBlend;
      this.hoverNodeIdAnim = targetHoverId;
      this.hoverScale = targetHoverScale;
      return;
    }

    if (this.animRafId !== null) return;

    const tickVisual = () => {
      this.animRafId = null;
      if (this.disposed) return;

      const curFocus = this.hoveredNodeId ?? this.selectedNodeId;
      const goalBlend = curFocus && this.nodeById.has(curFocus) ? 1 : 0;
      const goalHoverId =
        this.hoveredNodeId && this.nodeById.has(this.hoveredNodeId) ? this.hoveredNodeId : null;
      const goalScale = goalHoverId ? 1.24 : 1;

      if (curFocus) this.activeFocusId = curFocus;
      if (goalHoverId) this.hoverNodeIdAnim = goalHoverId;

      this.focusBlend += (goalBlend - this.focusBlend) * 0.24;
      this.hoverScale += (goalScale - this.hoverScale) * 0.28;

      const blendDone = Math.abs(goalBlend - this.focusBlend) < 0.015;
      const scaleDone = Math.abs(goalScale - this.hoverScale) < 0.01;
      if (blendDone) {
        this.focusBlend = goalBlend;
        if (goalBlend === 0) {
          this.activeFocusId = null;
        }
      }
      if (scaleDone) {
        this.hoverScale = goalScale;
        if (!goalHoverId) {
          this.hoverNodeIdAnim = null;
        }
      }

      this.render();

      if (!blendDone || !scaleDone) {
        this.animRafId = requestAnimationFrame(tickVisual);
      }
    };

    this.animRafId = requestAnimationFrame(tickVisual);
  }

  private ensureQuadtree(): SpatialQuadtree<SimNode> {
    const version = this.callbacks.getPositionVersion?.();
    const versionChanged = version !== undefined && version !== this.lastQuadtreeVersion;
    if (!this.spatialTree || this.quadtreeDirty || versionChanged) {
      this.spatialTree = createQuadtree<SimNode>()
        .x((d) => d.x)
        .y((d) => d.y)
        .addAll(this.nodes);
      this.quadtreeDirty = false;
      if (version !== undefined) {
        this.lastQuadtreeVersion = version;
      }
    }
    return this.spatialTree;
  }

  getQuadtree(): SpatialQuadtree<SimNode> {
    return this.ensureQuadtree();
  }

  hitTest(screenX: number, screenY: number): SimNode | null {
    if (this.nodes.length === 0) return null;
    const tree = this.ensureQuadtree();
    const world = this.screenToWorld(screenX, screenY);
    const slopWorld = 8 / Math.max(MIN_GRAPH_SCALE, this.viewport.scale);
    const searchRadius = this.maxNodeWorldRadius + slopWorld;
    const minX = world.x - searchRadius;
    const maxX = world.x + searchRadius;
    const minY = world.y - searchRadius;
    const maxY = world.y + searchRadius;

    let best: SimNode | null = null;
    let bestScore = Infinity;

    tree.visit((quad, x0, y0, x1, y1) => {
      if (x0 > maxX || x1 < minX || y0 > maxY || y1 < minY) {
        return true;
      }
      if (!quad.length && quad.data) {
        let leaf: QuadtreeNode<SimNode> | undefined = quad;
        while (leaf) {
          const candidate = leaf.data;
          if (candidate) {
            const dx = world.x - candidate.x;
            const dy = world.y - candidate.y;
            const nodeR = this.getNodeRadius(candidate);
            const effR = nodeR + slopWorld;
            const dist2 = dx * dx + dy * dy;
            if (dist2 <= effR * effR) {
              const score = Math.sqrt(dist2) / Math.max(1, nodeR);
              if (
                score < bestScore ||
                (Math.abs(score - bestScore) < 1e-6 &&
                  candidate.id === this.selectedNodeId)
              ) {
                best = candidate;
                bestScore = score;
              }
            }
          }
          leaf = leaf.next;
        }
      }
      return false;
    });

    return best;
  }

  private canvasLocalCoords(event: { clientX: number; clientY: number }): {
    x: number;
    y: number;
  } {
    const rect = this.canvas.getBoundingClientRect?.() ?? {
      left: 0,
      top: 0,
      width: this.width,
      height: this.height,
    };
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.disposed || event.button !== 0) return;
    const { x, y } = this.canvasLocalCoords(event);
    const hit = this.hitTest(x, y);

    if (this.canvas.setPointerCapture) {
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        // Ignore in synthetic test environments
      }
    }

    if (hit) {
      this.interaction = {
        kind: "drag-pending",
        nodeId: hit.id,
        startScreenX: x,
        startScreenY: y,
      };
    } else {
      this.interaction = {
        kind: "pan-pending",
        startScreenX: x,
        startScreenY: y,
        startPanX: this.viewport.panX,
        startPanY: this.viewport.panY,
      };
    }
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.disposed) return;
    const { x, y } = this.canvasLocalCoords(event);

    if (this.interaction.kind === "drag-pending") {
      const dist = Math.hypot(
        x - this.interaction.startScreenX,
        y - this.interaction.startScreenY
      );
      if (dist >= DRAG_THRESHOLD_PX) {
        const nodeId = this.interaction.nodeId;
        this.interaction = { kind: "dragging", nodeId };
        this.canvas.classList.add("is-dragging-node");
        this.callbacks.onHoverNode?.(null);
        this.callbacks.onDragStart?.(nodeId);
        const world = this.screenToWorld(x, y);
        this.callbacks.onDragMove?.(nodeId, world.x, world.y);
      }
      return;
    }

    if (this.interaction.kind === "dragging") {
      const world = this.screenToWorld(x, y);
      this.callbacks.onDragMove?.(this.interaction.nodeId, world.x, world.y);
      return;
    }

    if (this.interaction.kind === "pan-pending") {
      const dist = Math.hypot(
        x - this.interaction.startScreenX,
        y - this.interaction.startScreenY
      );
      if (dist >= DRAG_THRESHOLD_PX) {
        this.interaction = {
          kind: "panning",
          startScreenX: this.interaction.startScreenX,
          startScreenY: this.interaction.startScreenY,
          startPanX: this.interaction.startPanX,
          startPanY: this.interaction.startPanY,
        };
        this.canvas.classList.add("is-panning");
        this.callbacks.onHoverNode?.(null);
      } else {
        return;
      }
    }

    if (this.interaction.kind === "panning") {
      this.viewport = {
        ...this.viewport,
        panX: this.interaction.startPanX + (x - this.interaction.startScreenX),
        panY: this.interaction.startPanY + (y - this.interaction.startScreenY),
      };
      this.callbacks.onViewportChange?.(this.getViewportState());
      this.render();
      return;
    }

    // Idle hover hit-test
    const hit = this.hitTest(x, y);
    const nextHoverId = hit?.id ?? null;
    if (nextHoverId !== this.hoveredNodeId) {
      this.setHoveredNode(nextHoverId);
    }
    this.callbacks.onHoverNode?.(
      hit
        ? {
            node: hit.data,
            screenX: x,
            screenY: y,
            clientX: event.clientX,
            clientY: event.clientY,
          }
        : null
    );
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.disposed) return;

    if (this.canvas.releasePointerCapture) {
      try {
        this.canvas.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore in synthetic test environments
      }
    }

    const current = this.interaction;
    this.interaction = { kind: "idle" };
    this.canvas.classList.remove("is-dragging-node", "is-panning");

    if (current.kind === "drag-pending") {
      const node = this.nodeById.get(current.nodeId) ?? null;
      this.setSelectedNode(node?.id ?? null);
      this.callbacks.onSelectNode?.(node?.data ?? null);
      return;
    }

    if (current.kind === "dragging") {
      this.callbacks.onDragEnd?.(current.nodeId);
      return;
    }

    if (current.kind === "pan-pending") {
      this.setSelectedNode(null);
      this.callbacks.onSelectNode?.(null);
    }
  }

  private handlePointerLeave(): void {
    if (this.disposed) return;
    if (this.interaction.kind === "idle") {
      if (this.hoveredNodeId !== null) {
        this.setHoveredNode(null);
      }
      this.callbacks.onHoverNode?.(null);
    }
  }

  private handleDoubleClick(event: MouseEvent): void {
    if (this.disposed) return;
    const { x, y } = this.canvasLocalCoords(event);
    const hit = this.hitTest(x, y);
    if (hit) {
      this.callbacks.onOpenNode?.(hit.data, event);
    }
  }

  private handleWheel(event: WheelEvent): void {
    if (this.disposed) return;
    event.preventDefault();
    const { x, y } = this.canvasLocalCoords(event);
    const delta = clamp(-event.deltaY, -240, 240);
    const factor = Math.exp(delta * 0.0018);
    this.zoomBy(factor, x, y);
  }

  render(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;

    const { width, height, dpr, theme, display } = this;
    const { panX, panY, scale } = this.viewport;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (this.nodes.length === 0) {
      ctx.restore();
      return;
    }

    const marginWorld = 110 / Math.max(MIN_GRAPH_SCALE, scale);
    const viewMinX = -panX / scale - marginWorld;
    const viewMaxX = (width - panX) / scale + marginWorld;
    const viewMinY = -panY / scale - marginWorld;
    const viewMaxY = (height - panY) / scale + marginWorld;

    const focusId =
      this.activeFocusId && this.nodeById.has(this.activeFocusId) && this.focusBlend > 0.015
        ? this.activeFocusId
        : null;
    const focusNeighbors = focusId ? this.neighborMap.get(focusId) : undefined;
    const hasFocus = Boolean(focusId);
    const focusBlend = hasFocus ? clamp(this.focusBlend, 0, 1) : 0;

    const thicknessMul = Math.max(0.35, display.linkThickness);
    const baseLineWidth = clamp(Math.sqrt(scale) * 1.15 * thicknessMul, 0.65, 3.2);

    type EdgeBatchKey =
      | "dim-structural"
      | "dim-reference"
      | "dim-transclusion"
      | "act-structural"
      | "act-reference"
      | "act-transclusion";

    interface VisibleEdgeItem {
      sx1: number;
      sy1: number;
      sx2: number;
      sy2: number;
      cpx: number;
      cpy: number;
      midX: number;
      midY: number;
      curved: boolean;
      selfLoop: boolean;
      targetR: number;
      len: number;
    }

    const batches: Record<EdgeBatchKey, VisibleEdgeItem[]> = {
      "dim-structural": [],
      "dim-reference": [],
      "dim-transclusion": [],
      "act-structural": [],
      "act-reference": [],
      "act-transclusion": [],
    };

    for (const link of this.links) {
      const endpoints = resolveSimLinkEndpoints(link);
      if (!endpoints) continue;
      const { source, target } = endpoints;

      // Viewport bounding-box culling
      if (
        (source.x < viewMinX && target.x < viewMinX) ||
        (source.x > viewMaxX && target.x > viewMaxX) ||
        (source.y < viewMinY && target.y < viewMinY) ||
        (source.y > viewMaxY && target.y > viewMaxY)
      ) {
        continue;
      }

      const sx1 = source.x * scale + panX;
      const sy1 = source.y * scale + panY;
      const sx2 = target.x * scale + panX;
      const sy2 = target.y * scale + panY;
      const selfLoop = source.id === target.id;
      const targetR = Math.max(2, this.getNodeRadius(target) * scale);
      const len = Math.hypot(sx2 - sx1, sy2 - sy1);

      let curved = false;
      let cpx = (sx1 + sx2) * 0.5;
      let cpy = (sy1 + sy2) * 0.5;
      let midX = cpx;
      let midY = cpy;

      if (!selfLoop && link.data.parallelCount && link.data.parallelCount > 1 && len > 2) {
        curved = true;
        const p0 = source.id <= target.id ? source : target;
        const p1 = source.id <= target.id ? target : source;
        const cdx = (p1.x - p0.x) * scale;
        const cdy = (p1.y - p0.y) * scale;
        const clen = Math.hypot(cdx, cdy) || 1;
        const cnx = -cdy / clen;
        const cny = cdx / clen;
        const slot = (link.data.parallelIndex ?? 0) - (link.data.parallelCount - 1) / 2;
        const offset = slot * Math.min(46, Math.max(16, len * 0.2));
        cpx += cnx * offset;
        cpy += cny * offset;
        midX = 0.25 * sx1 + 0.5 * cpx + 0.25 * sx2;
        midY = 0.25 * sy1 + 0.5 * cpy + 0.25 * sy2;
      }

      const isIncident =
        !hasFocus || source.id === focusId || target.id === focusId;
      const prefix = isIncident ? "act" : "dim";
      const key = `${prefix}-${link.data.kind}` as EdgeBatchKey;
      batches[key].push({
        sx1,
        sy1,
        sx2,
        sy2,
        cpx,
        cpy,
        midX,
        midY,
        curved,
        selfLoop,
        targetR,
        len,
      });
    }

    const drawEdgeBatch = (
      items: VisibleEdgeItem[],
      kind: "structural" | "reference" | "transclusion",
      dimmed: boolean
    ) => {
      if (items.length === 0) return;

      ctx.save();
      if (dimmed) {
        const dimFrom =
          kind === "structural" ? 0.45 : kind === "transclusion" ? 0.88 : 0.78;
        ctx.globalAlpha =
          focusBlend >= 0.999 ? 0.15 : dimFrom + (0.15 - dimFrom) * focusBlend;
      } else if (kind === "structural") {
        ctx.globalAlpha = hasFocus ? 0.45 + 0.27 * focusBlend : 0.45;
      } else if (kind === "transclusion") {
        ctx.globalAlpha = hasFocus ? 0.88 + 0.08 * focusBlend : 0.88;
      } else {
        ctx.globalAlpha = hasFocus ? 0.78 + 0.18 * focusBlend : 0.78;
      }

      if (kind === "structural") {
        ctx.strokeStyle = theme.structuralEdge;
        ctx.lineWidth = Math.max(0.65, baseLineWidth * 0.85);
        ctx.setLineDash([2, 3]);
      } else if (kind === "transclusion") {
        ctx.strokeStyle = theme.transclusionEdge;
        ctx.lineWidth = Math.max(0.95, baseLineWidth * (hasFocus && !dimmed ? 1.45 : 1.2));
        ctx.setLineDash([6, 4]);
      } else {
        ctx.strokeStyle = hasFocus && !dimmed ? theme.accent : theme.referenceEdge;
        ctx.lineWidth = Math.max(0.85, baseLineWidth * (hasFocus && !dimmed ? 1.35 : 1));
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      for (const e of items) {
        if (e.selfLoop) {
          const loopR = Math.max(8, e.targetR * 1.1);
          ctx.moveTo(e.sx1 + loopR * 2, e.sy1 - loopR * 0.4);
          ctx.arc(e.sx1 + loopR, e.sy1 - loopR * 0.4, loopR, 0, Math.PI * 2);
        } else if (e.curved) {
          ctx.moveTo(e.sx1, e.sy1);
          ctx.quadraticCurveTo(e.cpx, e.cpy, e.sx2, e.sy2);
        } else {
          ctx.moveTo(e.sx1, e.sy1);
          ctx.lineTo(e.sx2, e.sy2);
        }
      }
      ctx.stroke();

      // Distinct midpoint diamonds for transclusion edges
      if (kind === "transclusion") {
        ctx.setLineDash([]);
        ctx.fillStyle = theme.transclusionEdge;
        ctx.beginPath();
        for (const e of items) {
          if (e.selfLoop || e.len < 24) continue;
          const dx = e.sx2 - e.sx1;
          const dy = e.sy2 - e.sy1;
          const elen = Math.hypot(dx, dy) || 1;
          const ux = dx / elen;
          const uy = dy / elen;
          const nx = -uy;
          const ny = ux;
          const r = clamp(3.4 * Math.sqrt(scale), 2.5, 5.2);
          ctx.moveTo(e.midX + ux * r, e.midY + uy * r);
          ctx.lineTo(e.midX + nx * r * 0.72, e.midY + ny * r * 0.72);
          ctx.lineTo(e.midX - ux * r, e.midY - uy * r);
          ctx.lineTo(e.midX - nx * r * 0.72, e.midY - ny * r * 0.72);
          ctx.closePath();
        }
        ctx.fill();
      }

      // Directional arrowheads (solid triangle for reference/structural, chevron for transclusion)
      if (display.showArrows && scale >= 0.22) {
        ctx.setLineDash([]);
        if (kind === "transclusion") {
          ctx.strokeStyle = theme.transclusionEdge;
          ctx.lineWidth = Math.max(1.1, baseLineWidth * 1.15);
          ctx.beginPath();
          for (const e of items) {
            if (e.selfLoop || e.len <= e.targetR + 10) continue;
            const edx = e.curved ? e.sx2 - e.cpx : e.sx2 - e.sx1;
            const edy = e.curved ? e.sy2 - e.cpy : e.sy2 - e.sy1;
            const elen = Math.hypot(edx, edy) || 1;
            const ux = edx / elen;
            const uy = edy / elen;
            const nx = -uy;
            const ny = ux;
            const tipX = e.sx2 - ux * (e.targetR + 2.5);
            const tipY = e.sy2 - uy * (e.targetR + 2.5);
            const lenA = clamp(7 * Math.sqrt(scale), 4.5, 9);
            const halfW = lenA * 0.58;
            ctx.moveTo(tipX - ux * lenA + nx * halfW, tipY - uy * lenA + ny * halfW);
            ctx.lineTo(tipX, tipY);
            ctx.lineTo(tipX - ux * lenA - nx * halfW, tipY - uy * lenA - ny * halfW);
          }
          ctx.stroke();
        } else {
          ctx.fillStyle =
            kind === "structural"
              ? theme.structuralEdge
              : hasFocus && !dimmed
                ? theme.accent
                : theme.referenceEdge;
          ctx.beginPath();
          for (const e of items) {
            if (e.selfLoop || e.len <= e.targetR + 10) continue;
            const edx = e.curved ? e.sx2 - e.cpx : e.sx2 - e.sx1;
            const edy = e.curved ? e.sy2 - e.cpy : e.sy2 - e.sy1;
            const elen = Math.hypot(edx, edy) || 1;
            const ux = edx / elen;
            const uy = edy / elen;
            const nx = -uy;
            const ny = ux;
            const tipX = e.sx2 - ux * (e.targetR + 2);
            const tipY = e.sy2 - uy * (e.targetR + 2);
            const lenA = clamp(6.5 * Math.sqrt(scale), 4, 8.5);
            const halfW = lenA * 0.48;
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(tipX - ux * lenA + nx * halfW, tipY - uy * lenA + ny * halfW);
            ctx.lineTo(tipX - ux * lenA - nx * halfW, tipY - uy * lenA - ny * halfW);
            ctx.closePath();
          }
          ctx.fill();
        }
      }

      ctx.restore();
    };

    drawEdgeBatch(batches["dim-structural"], "structural", true);
    drawEdgeBatch(batches["dim-reference"], "reference", true);
    drawEdgeBatch(batches["dim-transclusion"], "transclusion", true);
    drawEdgeBatch(batches["act-structural"], "structural", false);
    drawEdgeBatch(batches["act-reference"], "reference", false);
    drawEdgeBatch(batches["act-transclusion"], "transclusion", false);

    // Draw nodes (dimmed first, highlighted/normal second)
    interface VisibleNodeItem {
      node: SimNode;
      sx: number;
      sy: number;
      sr: number;
      highlighted: boolean;
    }

    const dimmedNodes: VisibleNodeItem[] = [];
    const activeNodes: VisibleNodeItem[] = [];
    let centerNodeItem: VisibleNodeItem | null = null;
    let selectedNodeItem: VisibleNodeItem | null = null;
    let hoveredNodeItem: VisibleNodeItem | null = null;

    for (const node of this.nodes) {
      if (
        node.x < viewMinX ||
        node.x > viewMaxX ||
        node.y < viewMinY ||
        node.y > viewMaxY
      ) {
        continue;
      }
      const sx = node.x * scale + panX;
      const sy = node.y * scale + panY;
      const sr = Math.max(2, this.getNodeRadius(node) * scale);
      const isFocused =
        !hasFocus ||
        node.id === focusId ||
        Boolean(focusNeighbors?.has(node.id));
      const item: VisibleNodeItem = {
        node,
        sx,
        sy,
        sr,
        highlighted: isFocused,
      };
      if (isFocused) {
        activeNodes.push(item);
      } else {
        dimmedNodes.push(item);
      }
      if (node.data.isCenter || node.id === this.graphData?.centerNodeId) {
        centerNodeItem = item;
      }
      if (node.id === this.selectedNodeId) {
        selectedNodeItem = item;
      }
      if (node.id === this.hoveredNodeId) {
        hoveredNodeItem = item;
      }
    }

    const drawNodeGroup = (items: VisibleNodeItem[], dimmed: boolean) => {
      if (items.length === 0) return;
      ctx.save();
      ctx.globalAlpha = dimmed
        ? focusBlend >= 0.999
          ? 0.15
          : 1 - 0.85 * focusBlend
        : 1;

      for (const { node, sx, sy, sr } of items) {
        const isCenter = Boolean(
          node.data.isCenter || node.id === this.graphData?.centerNodeId
        );
        const isSelected = node.id === this.selectedNodeId;
        const isHovered = node.id === this.hoveredNodeId;
        const hoverRatio =
          node.id === this.hoverNodeIdAnim
            ? clamp((this.hoverScale - 1) / 0.24, 0, 1)
            : 0;
        const drawSr = sr * (1 + 0.24 * hoverRatio);
        const isUnresolved = node.data.kind === "unresolved";
        const isDuplicate = node.data.status === "duplicate";

        if (hoverRatio > 0.05) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(sx, sy, drawSr + 6.5, 0, Math.PI * 2);
          ctx.strokeStyle = theme.accent;
          ctx.globalAlpha = (dimmed ? 0.15 : 1) * 0.24 * hoverRatio;
          ctx.lineWidth = 4;
          ctx.stroke();
          ctx.restore();
        }

        if (isCenter) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(sx, sy, drawSr + 5.5, 0, Math.PI * 2);
          ctx.strokeStyle = theme.accent;
          ctx.globalAlpha = dimmed ? 0.15 : 0.3;
          ctx.lineWidth = 4;
          ctx.stroke();
          ctx.restore();

          ctx.beginPath();
          ctx.arc(sx, sy, drawSr + 2.5, 0, Math.PI * 2);
          ctx.strokeStyle = theme.accent;
          ctx.lineWidth = 1.8;
          ctx.setLineDash([]);
          ctx.stroke();
        }

        // Fill circle
        ctx.beginPath();
        ctx.arc(sx, sy, drawSr, 0, Math.PI * 2);
        if (isUnresolved) {
          ctx.fillStyle = theme.background;
          ctx.fill();
          ctx.strokeStyle = theme.unresolvedColor;
          ctx.lineWidth = 1.6;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          const fill =
            node.data.groupColor ??
            (node.data.kind === "file" ? theme.fileNode : theme.nodeDefault);
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.strokeStyle = theme.background;
          ctx.lineWidth = Math.max(0.8, Math.min(1.5, drawSr * 0.14));
          ctx.setLineDash([]);
          ctx.stroke();
        }

        if (isDuplicate) {
          ctx.beginPath();
          ctx.arc(sx, sy, drawSr + 2.2, 0, Math.PI * 2);
          ctx.strokeStyle = theme.duplicateColor;
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.stroke();
        }

        if (isSelected || isHovered || hoverRatio > 0.05) {
          ctx.beginPath();
          ctx.arc(sx, sy, drawSr + 3, 0, Math.PI * 2);
          ctx.strokeStyle = isSelected ? theme.accent : theme.textNormal;
          ctx.lineWidth = 2.2;
          ctx.setLineDash([]);
          ctx.stroke();
        }
      }

      ctx.restore();
    };

    drawNodeGroup(dimmedNodes, true);
    drawNodeGroup(activeNodes, false);

    // Zoom-adaptive CJK/Latin label LOD
    this.renderLabels(
      ctx,
      activeNodes,
      dimmedNodes,
      centerNodeItem,
      selectedNodeItem,
      hoveredNodeItem
    );

    ctx.restore();
  }

  private measureLabelWidth(
    ctx: CanvasRenderingContext2D,
    text: string,
    font: string,
    fontSize: number
  ): number {
    const cacheKey = `${font}::${text}`;
    const cached = this.textWidthCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let measured = 0;
    if (typeof ctx.measureText === "function") {
      try {
        measured = ctx.measureText(text)?.width ?? 0;
      } catch {
        measured = 0;
      }
    }
    const width =
      Number.isFinite(measured) && measured > 0
        ? measured
        : estimateLabelWidthFallback(text, fontSize);
    if (this.textWidthCache.size >= 2000) {
      this.textWidthCache.clear();
    }
    this.textWidthCache.set(cacheKey, width);
    return width;
  }

  private renderLabels(
    ctx: CanvasRenderingContext2D,
    activeNodes: Array<{ node: SimNode; sx: number; sy: number; sr: number }>,
    dimmedNodes: Array<{ node: SimNode; sx: number; sy: number; sr: number }>,
    centerItem: { node: SimNode; sx: number; sy: number; sr: number } | null,
    selectedItem: { node: SimNode; sx: number; sy: number; sr: number } | null,
    hoveredItem: { node: SimNode; sx: number; sy: number; sr: number } | null
  ): void {
    const { display, theme, viewport, width, height } = this;
    const scale = viewport.scale;

    const drawnIds = new Set<string>();
    const placedBoxes: LabelBox[] = [];
    this.lastPlacedLabelBoxes = placedBoxes;

    const nodeCircles =
      this.nodes.length <= 200
        ? [...activeNodes, ...dimmedNodes].map((item) => ({
            id: item.node.id,
            sx: item.sx,
            sy: item.sy,
            sr: item.sr + 2,
          }))
        : [];

    const drawLabelItem = (
      item: { node: SimNode; sx: number; sy: number; sr: number },
      alpha: number,
      emphasize: boolean,
      forceOnHovered = false
    ) => {
      const maxChars =
        width < 380 ? (emphasize ? 24 : 18) : emphasize ? 32 : 26;
      const text = truncateLabel(item.node.data.title || item.node.id, maxChars);
      if (!text) return;

      const fontSize = emphasize ? 12.5 : 11.5;
      const font = `${emphasize ? 600 : 500} ${fontSize}px ${theme.fontFamily}`;
      ctx.font = font;

      const textW = this.measureLabelWidth(ctx, text, font, fontSize);
      const halfW = textW * 0.5;
      const boxH = fontSize + 4;
      const padX = emphasize ? 7 : 6;
      const padY = 3;

      const clampCenterX = (cx: number): number => {
        if (width <= textW + 16) return width * 0.5;
        return clamp(cx, halfW + 8, width - halfW - 8);
      };

      const makeSlot = (
        slot: "below" | "above" | "right" | "left",
        clampEdge: boolean
      ) => {
        if (slot === "below" || slot === "above") {
          const cx = clampEdge ? clampCenterX(item.sx) : item.sx;
          const y0 =
            slot === "below"
              ? item.sy + item.sr + 5
              : item.sy - item.sr - boxH - 5;
          const rawBox: LabelBox = {
            x0: cx - halfW,
            y0,
            x1: cx + halfW,
            y1: y0 + boxH,
          };
          return {
            drawX: cx,
            y: y0,
            align: "center" as CanvasTextAlign,
            rawBox,
            paddedBox: {
              x0: rawBox.x0 - padX,
              y0: rawBox.y0 - padY,
              x1: rawBox.x1 + padX,
              y1: rawBox.y1 + padY,
            },
          };
        }
        if (slot === "right") {
          const x0 = item.sx + item.sr + 6;
          const y0 = item.sy - boxH * 0.5;
          const rawBox: LabelBox = { x0, y0, x1: x0 + textW, y1: y0 + boxH };
          return {
            drawX: x0,
            y: y0,
            align: "left" as CanvasTextAlign,
            rawBox,
            paddedBox: {
              x0: rawBox.x0 - padX,
              y0: rawBox.y0 - padY,
              x1: rawBox.x1 + padX,
              y1: rawBox.y1 + padY,
            },
          };
        }
        const x1 = item.sx - item.sr - 6;
        const x0 = x1 - textW;
        const y0 = item.sy - boxH * 0.5;
        const rawBox: LabelBox = { x0, y0, x1, y1: y0 + boxH };
        return {
          drawX: x1,
          y: y0,
          align: "right" as CanvasTextAlign,
          rawBox,
          paddedBox: {
            x0: rawBox.x0 - padX,
            y0: rawBox.y0 - padY,
            x1: rawBox.x1 + padX,
            y1: rawBox.y1 + padY,
          },
        };
      };

      const slots: Array<"below" | "above" | "right" | "left"> = [
        "below",
        "above",
        "right",
        "left",
      ];

      let chosen: ReturnType<typeof makeSlot> | null = null;
      for (const slot of slots) {
        const candidate = makeSlot(slot, emphasize);
        const insideViewport =
          candidate.rawBox.x0 >= 4 &&
          candidate.rawBox.x1 <= width - 4 &&
          candidate.rawBox.y0 >= 4 &&
          candidate.rawBox.y1 <= height - 4;
        if (!insideViewport && !emphasize) continue;

        let collides = false;
        for (const existing of placedBoxes) {
          if (boxesOverlap(candidate.paddedBox, existing)) {
            collides = true;
            break;
          }
        }
        if (!collides && !emphasize && nodeCircles.length > 0) {
          for (const circle of nodeCircles) {
            if (circle.id === item.node.id) continue;
            if (
              circleIntersectsBox(circle.sx, circle.sy, circle.sr, candidate.rawBox)
            ) {
              collides = true;
              break;
            }
          }
        }
        if (!collides) {
          chosen = candidate;
          break;
        }
      }

      if (!chosen) {
        if (!forceOnHovered) return;
        const prefersAbove = item.sy + item.sr + boxH + 10 > height - 4;
        chosen = makeSlot(prefersAbove ? "above" : "below", true);
      }

      placedBoxes.push(chosen.paddedBox);
      drawnIds.add(item.node.id);

      ctx.save();
      if (
        emphasize &&
        typeof ctx.roundRect === "function" &&
        typeof ctx.fillRect === "function"
      ) {
        const pillX = chosen.rawBox.x0 - 5;
        const pillY = chosen.rawBox.y0 - 2;
        const pillW = chosen.rawBox.x1 - chosen.rawBox.x0 + 10;
        const pillH = boxH + 4;
        ctx.save();
        ctx.globalAlpha = alpha * 0.86;
        ctx.fillStyle = theme.background;
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 5);
        ctx.fill();
        ctx.strokeStyle = theme.borderColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      ctx.globalAlpha = alpha;
      ctx.textAlign = chosen.align;
      ctx.textBaseline = "top";
      ctx.lineWidth = 3.2;
      ctx.lineJoin = "round";
      ctx.strokeStyle = theme.labelHalo;
      ctx.strokeText(text, chosen.drawX, chosen.y);
      ctx.fillStyle = emphasize ? theme.textNormal : theme.textMuted;
      ctx.fillText(text, chosen.drawX, chosen.y);
      ctx.restore();
    };

    // Priority order: hovered -> selected -> center -> degree-sorted active nodes -> dimmed (zoomed in)
    if (hoveredItem) {
      drawLabelItem(hoveredItem, 1, true, true);
    }
    if (selectedItem && !drawnIds.has(selectedItem.node.id)) {
      drawLabelItem(selectedItem, 1, true, !hoveredItem);
    }
    if (display.showLabels && centerItem && !drawnIds.has(centerItem.node.id)) {
      drawLabelItem(centerItem, 1, true, !hoveredItem && !selectedItem);
    }

    if (!display.showLabels || scale < display.labelFadeThreshold) {
      return;
    }

    const fadeSpan = 0.35;
    const generalAlpha = clamp(
      0.35 + ((scale - display.labelFadeThreshold) / fadeSpan) * 0.65,
      0.2,
      1
    );

    const candidates = [...activeNodes].sort(
      (a, b) => b.node.data.degree - a.node.data.degree
    );
    let count = drawnIds.size;

    for (const item of candidates) {
      if (count >= MAX_LABELS_PER_FRAME) break;
      if (drawnIds.has(item.node.id)) continue;
      drawLabelItem(item, generalAlpha, false);
      count = drawnIds.size;
    }

    if (scale >= display.labelFadeThreshold + 0.45 && count < MAX_LABELS_PER_FRAME) {
      for (const item of dimmedNodes) {
        if (count >= MAX_LABELS_PER_FRAME) break;
        if (drawnIds.has(item.node.id)) continue;
        drawLabelItem(item, 0.22 * generalAlpha, false);
        count = drawnIds.size;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.animRafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.animRafId);
      this.animRafId = null;
    }
    this.themeObserver?.disconnect();
    this.themeObserver = null;

    this.canvas.removeEventListener("pointerdown", this.boundPointerDown);
    this.canvas.removeEventListener("pointermove", this.boundPointerMove);
    this.canvas.removeEventListener("pointerup", this.boundPointerUp);
    this.canvas.removeEventListener("pointercancel", this.boundPointerUp);
    this.canvas.removeEventListener("pointerleave", this.boundPointerLeave);
    this.canvas.removeEventListener("dblclick", this.boundDblClick);
    this.canvas.removeEventListener("wheel", this.boundWheel);

    this.canvas.remove();
    this.nodeById.clear();
    this.neighborMap.clear();
    this.textWidthCache.clear();
    this.lastPlacedLabelBoxes = [];
    this.spatialTree = null;
    this.ctx = null;
  }
}
