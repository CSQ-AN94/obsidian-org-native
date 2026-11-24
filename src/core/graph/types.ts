import type { OrgIdLink, OrgIdStatus, OrgNodeEntry } from "../model/types";

export type OrgGraphGranularity = "node" | "file";
export type OrgGraphEdgeKind = "reference" | "transclusion" | "structural";
export type OrgGraphNodeKind = "org-node" | "file" | "unresolved";
export type OrgGraphColorSchemeMode =
  | "none"
  | "file"
  | "folder"
  | "tag"
  | "level"
  | "custom";

export interface OrgGraphNode {
  /** Canonical graph identity (`id:<orgId>`, `file:<path>`, `missing:<id>`, or `dup:<id>@<path>:<line>`). */
  id: string;
  kind: OrgGraphNodeKind;
  orgId?: string;
  customId?: string;
  filePath: string;
  fileTitle?: string;
  line: number;
  endLine: number;
  level: number;
  title: string;
  headingPath: string[];
  parentNodeId?: string;
  tags: string[];
  todo?: string;
  status: OrgIdStatus;
  duplicateCount?: number;
  duplicatePeers?: OrgNodeEntry[];
  inDegree: number;
  outDegree: number;
  transcludeIn: number;
  transcludeOut: number;
  degree: number;
  groupColor?: string;
  groupId?: string;
  isCenter?: boolean;
  hopDistance?: number;
}

export interface OrgGraphEdge {
  /** Deterministic key `<kind>:<source>-><target>`. */
  id: string;
  source: string;
  target: string;
  kind: OrgGraphEdgeKind;
  weight: number;
  links?: OrgIdLink[];
  /** Zero-based curve slot when multiple edge kinds share the same `(source, target)`. */
  parallelIndex?: number;
  parallelCount?: number;
}

export interface OrgGraphStats {
  nodeCount: number;
  edgeCount: number;
  referenceEdges: number;
  transclusionEdges: number;
  structuralEdges: number;
  orphanCount: number;
  duplicateCount: number;
  unresolvedCount: number;
  fileCount: number;
}

export interface OrgGraphData {
  granularity: OrgGraphGranularity;
  nodes: OrgGraphNode[];
  edges: OrgGraphEdge[];
  nodeMap: Map<string, OrgGraphNode>;
  centerNodeId?: string;
  stats: OrgGraphStats;
  indexVersion: number;
}

export interface OrgGraphColorGroup {
  id: string;
  query: string;
  color: string;
  label?: string;
}

export interface OrgGraphFilterState {
  search: string;
  showReference: boolean;
  showTransclusion: boolean;
  showStructural: boolean;
  showOrphans: boolean;
  showUnresolved: boolean;
}

export interface OrgGraphLocalFilterState extends OrgGraphFilterState {
  depth: 1 | 2 | 3;
  showIncoming: boolean;
  showOutgoing: boolean;
  followReader: boolean;
  lockedNodeId?: string | null;
}

export interface OrgGraphDisplayConfig {
  showArrows: boolean;
  showLabels: boolean;
  labelFadeThreshold: number;
  nodeSizeScale: number;
  linkThickness: number;
}

export interface OrgGraphForceConfig {
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
}

export interface OrgGraphLocalState {
  depth: 1 | 2 | 3;
  showIncoming: boolean;
  showOutgoing: boolean;
  followReader: boolean;
  lockedNodeId: string | null;
  centerNodeId: string | null;
  centerFilePath: string | null;
}

export interface OrgGraphViewState {
  granularity: OrgGraphGranularity;
  filter: OrgGraphFilterState;
  local?: OrgGraphLocalState;
  colorMode: OrgGraphColorSchemeMode;
  groups: OrgGraphColorGroup[];
  display: OrgGraphDisplayConfig;
  forces: OrgGraphForceConfig;
  controlsOpen: boolean;
}

export interface OrgGraphPatch {
  addedNodes: OrgGraphNode[];
  removedNodeIds: Set<string>;
  updatedNodes: OrgGraphNode[];
  addedEdges: OrgGraphEdge[];
  removedEdgeIds: Set<string>;
  updatedEdges: OrgGraphEdge[];
}

export type OrgReaderFocusReason = "file-open" | "click" | "cursor" | "jump" | "manual";

export interface OrgReaderFocusEvent {
  filePath: string;
  line: number;
  nodeKey: string | null;
  orgId: string | null;
  title?: string;
  reason: OrgReaderFocusReason;
  timestamp: number;
}

export function canonicalOrgNodeKey(orgId: string): string {
  return `id:${orgId.trim()}`;
}

export function canonicalDuplicateNodeKey(
  orgId: string,
  filePath: string,
  line: number
): string {
  return `dup:${orgId.trim()}@${filePath}:${line}`;
}

export function canonicalFileNodeKey(filePath: string): string {
  return `file:${filePath}`;
}

export function canonicalUnresolvedNodeKey(targetId: string): string {
  return `missing:${targetId.trim()}`;
}

export function createDefaultDisplayConfig(): OrgGraphDisplayConfig {
  return {
    showArrows: true,
    showLabels: true,
    labelFadeThreshold: 0.75,
    nodeSizeScale: 1,
    linkThickness: 1,
  };
}

export function createDefaultForceConfig(): OrgGraphForceConfig {
  return {
    centerStrength: 0.14,
    repelStrength: 240,
    linkStrength: 0.65,
    linkDistance: 105,
  };
}

export function createDefaultGlobalGraphState(): OrgGraphViewState {
  return {
    granularity: "node",
    filter: {
      search: "",
      showReference: true,
      showTransclusion: true,
      showStructural: false,
      showOrphans: true,
      showUnresolved: false,
    },
    colorMode: "file",
    groups: [],
    display: createDefaultDisplayConfig(),
    forces: createDefaultForceConfig(),
    controlsOpen: false,
  };
}

export function createDefaultLocalGraphState(): OrgGraphViewState {
  return {
    granularity: "node",
    filter: {
      search: "",
      showReference: true,
      showTransclusion: true,
      showStructural: false,
      showOrphans: true,
      showUnresolved: false,
    },
    local: {
      depth: 1,
      showIncoming: true,
      showOutgoing: true,
      followReader: true,
      lockedNodeId: null,
      centerNodeId: null,
      centerFilePath: null,
    },
    colorMode: "file",
    groups: [],
    display: {
      ...createDefaultDisplayConfig(),
      labelFadeThreshold: 0.4,
    },
    forces: {
      ...createDefaultForceConfig(),
      centerStrength: 0.18,
      repelStrength: 280,
      linkDistance: 120,
    },
    controlsOpen: false,
  };
}

export function mergeGraphViewState(
  base: OrgGraphViewState,
  partial?: Partial<OrgGraphViewState> | null
): OrgGraphViewState {
  if (!partial) return base;
  return {
    granularity: partial.granularity === "file" ? "file" : base.granularity,
    filter: {
      ...base.filter,
      ...(partial.filter ?? {}),
    },
    local: base.local
      ? {
          ...base.local,
          ...(partial.local ?? {}),
          depth:
            partial.local?.depth === 1 ||
            partial.local?.depth === 2 ||
            partial.local?.depth === 3
              ? partial.local.depth
              : base.local.depth,
        }
      : partial.local,
    colorMode: partial.colorMode ?? base.colorMode,
    groups: Array.isArray(partial.groups)
      ? partial.groups.map((g) => ({ ...g }))
      : [...base.groups],
    display: {
      ...base.display,
      ...(partial.display ?? {}),
    },
    forces: {
      ...base.forces,
      ...(partial.forces ?? {}),
    },
    controlsOpen:
      typeof partial.controlsOpen === "boolean"
        ? partial.controlsOpen
        : base.controlsOpen,
  };
}
