import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceCenter,
  type ForceCollide,
  type ForceLink,
  type ForceManyBody,
  type ForceX,
  type ForceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import {
  createDefaultForceConfig,
  type OrgGraphData,
  type OrgGraphEdge,
  type OrgGraphForceConfig,
  type OrgGraphNode,
} from "../../core/graph/types";

export interface SimNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  data: OrgGraphNode;
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string;
  source: SimNode | string;
  target: SimNode | string;
  data: OrgGraphEdge;
}

export interface SetGraphOptions {
  preserveLayout?: boolean;
  warmUpTicks?: number;
  warmUpMaxMs?: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hashString32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function deterministicJitter(id: string, radiusMin = 6, radiusRange = 10): { dx: number; dy: number } {
  const hash = hashString32(id);
  const angle = ((hash & 0xffff) / 0xffff) * Math.PI * 2;
  const dist = radiusMin + (((hash >>> 16) & 0xff) / 255) * radiusRange;
  return {
    dx: Math.cos(angle) * dist,
    dy: Math.sin(angle) * dist,
  };
}

function phyllotaxisPosition(index: number, totalCount: number): { x: number; y: number } {
  const spacing = totalCount >= 2000 ? 15 : totalCount >= 500 ? 17 : 20;
  const radius = spacing * Math.sqrt(index + 0.5);
  const angle = index * GOLDEN_ANGLE;
  return {
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
  };
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function resolveSimLinkEndpoints(
  link: SimLink
): { source: SimNode; target: SimNode } | null {
  if (
    typeof link.source === "object" &&
    link.source !== null &&
    typeof link.target === "object" &&
    link.target !== null
  ) {
    return { source: link.source, target: link.target };
  }
  return null;
}

/**
 * Deterministic d3-force wrapper with incremental coordinate preservation,
 * Barnes-Hut scaling, and time-budgeted stepping.
 */
export class OrgGraphSimulation {
  private forceConfig: OrgGraphForceConfig;
  private nodes: SimNode[] = [];
  private links: SimLink[] = [];
  private nodeById = new Map<string, SimNode>();
  private draggingIds = new Set<string>();
  private spiralCursor = 0;
  private positionVersion = 0;

  private readonly simulation: Simulation<SimNode, SimLink>;
  private readonly linkForce: ForceLink<SimNode, SimLink>;
  private readonly manyBodyForce: ForceManyBody<SimNode>;
  private readonly collideForce: ForceCollide<SimNode>;
  private readonly centerForce: ForceCenter<SimNode>;
  private readonly xForce: ForceX<SimNode>;
  private readonly yForce: ForceY<SimNode>;

  constructor(forces?: Partial<OrgGraphForceConfig>) {
    this.forceConfig = {
      ...createDefaultForceConfig(),
      ...(forces ?? {}),
    };

    this.linkForce = forceLink<SimNode, SimLink>([])
      .id((d) => d.id)
      .distance((link) => {
        const base = this.forceConfig.linkDistance;
        return link.data.kind === "structural" ? base * 0.75 : base;
      })
      .strength((link) => {
        const base = Math.max(0.01, Math.min(1, this.forceConfig.linkStrength));
        return link.data.kind === "structural" ? base * 0.55 : base;
      });

    this.manyBodyForce = forceManyBody<SimNode>()
      .theta(0.85)
      .strength(-Math.abs(this.forceConfig.repelStrength));

    this.collideForce = forceCollide<SimNode>()
      .radius((node) => this.getCollisionRadius(node, this.nodes.length))
      .strength(0.65)
      .iterations(1);

    this.centerForce = forceCenter<SimNode>(0, 0).strength(this.forceConfig.centerStrength * 0.2);
    this.xForce = forceX<SimNode>(0).strength(this.forceConfig.centerStrength * 0.45);
    this.yForce = forceY<SimNode>(0).strength(this.forceConfig.centerStrength * 0.45);

    this.simulation = forceSimulation<SimNode, SimLink>([])
      .alphaDecay(0.024)
      .velocityDecay(0.36)
      .force("link", this.linkForce)
      .force("charge", this.manyBodyForce)
      .force("collide", this.collideForce)
      .force("center", this.centerForce)
      .force("x", this.xForce)
      .force("y", this.yForce)
      .stop();
  }

  private getCollisionRadius(node: SimNode, nodeCount: number): number {
    let base = 4.5 + Math.min(10, Math.sqrt(Math.max(0, node.data.degree)) * 1.45);
    if (node.data.kind === "file") base += 1.6;
    if (node.data.isCenter) base += 3.2;
    const pad = nodeCount <= 120 ? 8 : nodeCount <= 600 ? 5 : 2;
    return base + pad;
  }

  setGraph(
    data: OrgGraphData,
    forces?: Partial<OrgGraphForceConfig>,
    options: SetGraphOptions = {}
  ): void {
    if (forces) {
      this.forceConfig = {
        ...this.forceConfig,
        ...forces,
      };
    }

    const preserveLayout = options.preserveLayout ?? true;
    const prevNodeById = preserveLayout ? this.nodeById : new Map<string, SimNode>();
    const prevCount = this.nodes.length;

    const newNodeIds = new Set<string>();
    let survivingCount = 0;
    for (const node of data.nodes) {
      if (prevNodeById.has(node.id)) {
        survivingCount++;
      } else {
        newNodeIds.add(node.id);
      }
    }

    // Index surviving neighbor positions and per-file centroids for zero-jump seeding.
    const adjacentSurviving = new Map<string, SimNode[]>();
    if (prevNodeById.size > 0 && newNodeIds.size > 0) {
      for (const edge of data.edges) {
        const srcNew = newNodeIds.has(edge.source);
        const tgtNew = newNodeIds.has(edge.target);
        if (srcNew && !tgtNew) {
          const neighbor = prevNodeById.get(edge.target);
          if (neighbor) {
            const list = adjacentSurviving.get(edge.source) ?? [];
            list.push(neighbor);
            adjacentSurviving.set(edge.source, list);
          }
        } else if (tgtNew && !srcNew) {
          const neighbor = prevNodeById.get(edge.source);
          if (neighbor) {
            const list = adjacentSurviving.get(edge.target) ?? [];
            list.push(neighbor);
            adjacentSurviving.set(edge.target, list);
          }
        }
      }
    }

    const fileCentroids = new Map<string, { sumX: number; sumY: number; count: number }>();
    if (prevNodeById.size > 0 && newNodeIds.size > 0) {
      for (const node of data.nodes) {
        const existing = prevNodeById.get(node.id);
        if (!existing || !node.filePath) continue;
        const acc = fileCentroids.get(node.filePath) ?? { sumX: 0, sumY: 0, count: 0 };
        acc.sumX += existing.x;
        acc.sumY += existing.y;
        acc.count += 1;
        fileCentroids.set(node.filePath, acc);
      }
    }

    if (!preserveLayout || prevCount === 0 || survivingCount === 0) {
      this.spiralCursor = 0;
    }

    const nextNodes: SimNode[] = [];
    const nextNodeById = new Map<string, SimNode>();

    for (const node of data.nodes) {
      const existing = prevNodeById.get(node.id);
      if (existing) {
        const simNode: SimNode = {
          id: node.id,
          x: Number.isFinite(existing.x) ? existing.x : 0,
          y: Number.isFinite(existing.y) ? existing.y : 0,
          vx: Number.isFinite(existing.vx) ? existing.vx : 0,
          vy: Number.isFinite(existing.vy) ? existing.vy : 0,
          fx: existing.fx ?? null,
          fy: existing.fy ?? null,
          data: node,
        };
        nextNodes.push(simNode);
        nextNodeById.set(node.id, simNode);
        continue;
      }

      let x = 0;
      let y = 0;
      const neighbors = adjacentSurviving.get(node.id);
      if (neighbors && neighbors.length > 0) {
        let sx = 0;
        let sy = 0;
        for (const n of neighbors) {
          sx += n.x;
          sy += n.y;
        }
        const jitter = deterministicJitter(node.id);
        x = sx / neighbors.length + jitter.dx;
        y = sy / neighbors.length + jitter.dy;
      } else if (node.filePath && fileCentroids.has(node.filePath)) {
        const centroid = fileCentroids.get(node.filePath)!;
        const jitter = deterministicJitter(node.id);
        x = centroid.sumX / centroid.count + jitter.dx;
        y = centroid.sumY / centroid.count + jitter.dy;
      } else if (node.isCenter && (prevCount === 0 || !preserveLayout || survivingCount === 0)) {
        x = 0;
        y = 0;
      } else {
        const spiralSlot =
          prevNodeById.size > 0
            ? Math.max(this.spiralCursor, prevNodeById.size)
            : this.spiralCursor;
        this.spiralCursor = spiralSlot + 1;
        const pos = phyllotaxisPosition(
          spiralSlot,
          Math.max(data.nodes.length, prevNodeById.size + newNodeIds.size)
        );
        x = pos.x;
        y = pos.y;
      }

      const simNode: SimNode = {
        id: node.id,
        x,
        y,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
        data: node,
      };
      nextNodes.push(simNode);
      nextNodeById.set(node.id, simNode);
    }

    // Filter draggingIds to surviving nodes
    for (const id of Array.from(this.draggingIds)) {
      if (!nextNodeById.has(id)) {
        this.draggingIds.delete(id);
      }
    }

    const nextLinks: SimLink[] = [];
    for (const edge of data.edges) {
      const src = nextNodeById.get(edge.source);
      const tgt = nextNodeById.get(edge.target);
      if (!src || !tgt) continue;
      nextLinks.push({
        id: edge.id,
        source: src,
        target: tgt,
        data: edge,
      });
    }

    this.nodes = nextNodes;
    this.links = nextLinks;
    this.nodeById = nextNodeById;

    this.applyForceParameters(nextNodes.length);
    this.simulation.nodes(this.nodes);
    this.linkForce.links(this.links);

    if (this.nodes.length === 0) {
      this.simulation.alpha(0);
      return;
    }

    if (survivingCount > 0 && preserveLayout) {
      this.simulation.alpha(0.14);
    } else {
      this.simulation.alpha(0.85);
    }

    if (options.warmUpTicks !== undefined && options.warmUpTicks > 0) {
      this.warmUp(options.warmUpTicks, options.warmUpMaxMs ?? 45);
    }
    this.positionVersion++;
  }

  /**
   * Update node/edge metadata (e.g., color groups) without disturbing simulation physics.
   */
  updateMetadata(data: OrgGraphData): void {
    for (const node of data.nodes) {
      const simNode = this.nodeById.get(node.id);
      if (simNode) {
        simNode.data = node;
      }
    }
    const edgeById = new Map<string, OrgGraphEdge>();
    for (const edge of data.edges) {
      edgeById.set(edge.id, edge);
    }
    for (const simLink of this.links) {
      const next = edgeById.get(simLink.id);
      if (next) {
        simLink.data = next;
      }
    }
  }

  private applyForceParameters(nodeCount: number): void {
    const theta = nodeCount >= 800 ? 0.9 : 0.85;
    this.manyBodyForce
      .theta(theta)
      .strength(-Math.abs(this.forceConfig.repelStrength))
      .distanceMax(nodeCount >= 2000 ? 1400 : Infinity);

    if (nodeCount >= 2500) {
      this.simulation.force("collide", null);
    } else {
      this.collideForce.radius((node) => this.getCollisionRadius(node, nodeCount));
      this.simulation.force("collide", this.collideForce);
    }

    this.centerForce.strength(this.forceConfig.centerStrength * 0.2);
    this.xForce.strength(this.forceConfig.centerStrength * 0.45);
    this.yForce.strength(this.forceConfig.centerStrength * 0.45);

    this.linkForce
      .distance((link) => {
        const base = this.forceConfig.linkDistance;
        return link.data.kind === "structural" ? base * 0.75 : base;
      })
      .strength((link) => {
        const base = Math.max(0.01, Math.min(1, this.forceConfig.linkStrength));
        return link.data.kind === "structural" ? base * 0.55 : base;
      });
  }

  warmUp(ticks?: number, maxMs = 45): number {
    if (this.nodes.length === 0) return 0;
    const defaultTicks =
      this.nodes.length >= 2500 ? 24 : this.nodes.length >= 800 ? 45 : 80;
    const targetTicks = Math.max(0, Math.floor(ticks ?? defaultTicks));
    if (targetTicks === 0) return 0;

    const start = nowMs();
    let executed = 0;
    for (let i = 0; i < targetTicks; i++) {
      this.simulation.tick(1);
      executed++;
      if (!this.isActive()) break;
      if (Number.isFinite(maxMs) && nowMs() - start >= maxMs) {
        break;
      }
    }
    if (executed > 0) {
      this.positionVersion++;
    }
    return executed;
  }

  stepFrame(maxBudgetMs = 12): boolean {
    if (this.nodes.length === 0 || !this.isActive()) {
      return false;
    }

    const start = nowMs();
    this.simulation.tick(1);

    // Small graphs can smoothly advance one extra tick when frame headroom allows.
    if (
      this.nodes.length < 250 &&
      this.isActive() &&
      nowMs() - start < maxBudgetMs * 0.45
    ) {
      this.simulation.tick(1);
    }

    this.positionVersion++;
    return this.isActive();
  }

  step(ticks = 1): void {
    const count = Math.max(0, Math.floor(ticks));
    if (count === 0 || this.nodes.length === 0) return;
    this.simulation.tick(count);
    this.positionVersion++;
  }

  stop(): void {
    this.simulation.alphaTarget(0);
    this.simulation.alpha(0);
    this.simulation.stop();
  }

  reheat(alpha = 0.65): void {
    if (this.nodes.length === 0) return;
    this.simulation.alpha(Math.max(0, Math.min(1, alpha)));
  }

  isActive(): boolean {
    if (this.nodes.length === 0) return false;
    return (
      this.simulation.alpha() >= this.simulation.alphaMin() ||
      this.simulation.alphaTarget() > 0 ||
      this.draggingIds.size > 0
    );
  }

  updateForces(config: Partial<OrgGraphForceConfig>): void {
    this.forceConfig = {
      ...this.forceConfig,
      ...config,
    };
    this.applyForceParameters(this.nodes.length);
    this.simulation.nodes(this.nodes);
    this.linkForce.links(this.links);
    if (this.nodes.length > 0) {
      this.simulation.alpha(Math.max(this.simulation.alpha(), 0.35));
    }
  }

  beginDrag(id: string): void {
    const node = this.nodeById.get(id);
    if (!node) return;
    this.draggingIds.add(id);
    node.fx = node.x;
    node.fy = node.y;
    node.vx = 0;
    node.vy = 0;
    this.simulation.alphaTarget(0.32);
    this.simulation.alpha(Math.max(this.simulation.alpha(), 0.34));
  }

  dragTo(id: string, x: number, y: number): void {
    const node = this.nodeById.get(id);
    if (!node) return;
    node.fx = x;
    node.fy = y;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    if (!this.draggingIds.has(id)) {
      this.draggingIds.add(id);
      this.simulation.alphaTarget(0.32);
    }
    this.simulation.alpha(Math.max(this.simulation.alpha(), 0.34));
    this.positionVersion++;
  }

  endDrag(id: string, pin = false): void {
    const node = this.nodeById.get(id);
    this.draggingIds.delete(id);
    if (node && !pin) {
      node.fx = null;
      node.fy = null;
    }
    if (this.draggingIds.size === 0) {
      this.simulation.alphaTarget(0);
      this.simulation.alpha(Math.max(this.simulation.alpha(), 0.22));
    }
  }

  getPosition(id: string): { x: number; y: number } | null {
    const node = this.nodeById.get(id);
    if (!node) return null;
    return { x: node.x, y: node.y };
  }

  getAlpha(): number {
    return this.simulation.alpha();
  }

  getPositionVersion(): number {
    return this.positionVersion;
  }

  getAlphaTarget(): number {
    return this.simulation.alphaTarget();
  }

  getNodes(): readonly SimNode[] {
    return this.nodes;
  }

  getLinks(): readonly SimLink[] {
    return this.links;
  }

  getNode(id: string): SimNode | undefined {
    return this.nodeById.get(id);
  }

  getForces(): OrgGraphForceConfig {
    return { ...this.forceConfig };
  }

  dispose(): void {
    this.stop();
    this.nodes = [];
    this.links = [];
    this.nodeById.clear();
    this.draggingIds.clear();
  }
}
