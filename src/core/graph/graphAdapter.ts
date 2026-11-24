import type {
  OrgFileIndexData,
  OrgIdIndex,
  IdResolution,
} from "../index/orgIdIndex";
import type { OrgIdLink, OrgIdStatus, OrgNodeEntry } from "../model/types";
import { assignNodeColors, matchesGraphQuery, parseGraphQuery } from "./graphFilter";
import {
  canonicalDuplicateNodeKey,
  canonicalFileNodeKey,
  canonicalOrgNodeKey,
  canonicalUnresolvedNodeKey,
  createDefaultGlobalGraphState,
  type OrgGraphColorGroup,
  type OrgGraphColorSchemeMode,
  type OrgGraphData,
  type OrgGraphEdge,
  type OrgGraphEdgeKind,
  type OrgGraphFilterState,
  type OrgGraphGranularity,
  type OrgGraphNode,
  type OrgGraphPatch,
} from "./types";

export interface BuildOrgGraphOptions {
  granularity?: OrgGraphGranularity;
  filter?: Partial<OrgGraphFilterState>;
  colorMode?: OrgGraphColorSchemeMode;
  groups?: OrgGraphColorGroup[];
}

export interface ResolvedOrgNodeMeta {
  key: string;
  status: OrgIdStatus;
  duplicateCount?: number;
  duplicatePeers?: OrgNodeEntry[];
}

export function normalizeGraphFilter(
  filter?: Partial<OrgGraphFilterState>
): OrgGraphFilterState {
  return {
    ...createDefaultGlobalGraphState().filter,
    ...(filter ?? {}),
  };
}

export function createEmptyOrgGraphData(
  granularity: OrgGraphGranularity,
  indexVersion: number,
  centerNodeId?: string
): OrgGraphData {
  return {
    granularity,
    nodes: [],
    edges: [],
    nodeMap: new Map<string, OrgGraphNode>(),
    centerNodeId,
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
    indexVersion,
  };
}

export function createIdResolutionCache(
  index: OrgIdIndex
): (id: string) => IdResolution {
  const cache = new Map<string, IdResolution>();
  return (id: string) => {
    const trimmed = id.trim();
    const cached = cache.get(trimmed);
    if (cached) return cached;
    const resolved = index.resolveId(trimmed);
    cache.set(trimmed, resolved);
    return resolved;
  };
}

export function isSameNodeEntry(a: OrgNodeEntry, b: OrgNodeEntry): boolean {
  return a === b || (a.filePath === b.filePath && a.line === b.line && a.id === b.id);
}

export function resolveOrgNodeMeta(
  entry: OrgNodeEntry,
  resolveId: (id: string) => IdResolution
): ResolvedOrgNodeMeta {
  const id = entry.id!.trim();
  const res = resolveId(id);
  if (res.status === "duplicate") {
    const primary = res.nodes[0];
    const isPrimary = primary ? isSameNodeEntry(primary, entry) : true;
    const key = isPrimary
      ? canonicalOrgNodeKey(id)
      : canonicalDuplicateNodeKey(id, entry.filePath, entry.line);
    const duplicatePeers = res.nodes.filter((peer) => !isSameNodeEntry(peer, entry));
    return {
      key,
      status: "duplicate",
      duplicateCount: res.nodes.length,
      duplicatePeers,
    };
  }

  return {
    key: canonicalOrgNodeKey(id),
    status: "found",
  };
}

export function getFileBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) || filePath : normalized || filePath;
}

export function collectFileTags(fileData: OrgFileIndexData, combineAllNodes: boolean): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const node of fileData.nodes) {
    if (!combineAllNodes && node.level > 0) continue;
    for (const tag of node.tags ?? []) {
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  }
  return tags;
}

export function createOrgNodeFromEntry(
  entry: OrgNodeEntry,
  fileTitle: string | undefined,
  meta: ResolvedOrgNodeMeta
): OrgGraphNode {
  return {
    id: meta.key,
    kind: "org-node",
    orgId: entry.id,
    customId: entry.customId,
    filePath: entry.filePath,
    fileTitle,
    line: entry.line,
    endLine: entry.endLine,
    level: entry.level,
    title: entry.title,
    headingPath: [...entry.headingPath],
    parentNodeId: entry.parentNodeId,
    tags: [...(entry.tags ?? [])],
    todo: entry.todo,
    status: meta.status,
    duplicateCount: meta.duplicateCount,
    duplicatePeers: meta.duplicatePeers,
    inDegree: 0,
    outDegree: 0,
    transcludeIn: 0,
    transcludeOut: 0,
    degree: 0,
  };
}

export function createFileGraphNode(
  fileData: OrgFileIndexData,
  combineAllTags: boolean
): OrgGraphNode {
  let maxEndLine = 0;
  let fileLevelNode: OrgNodeEntry | undefined;
  for (const node of fileData.nodes) {
    if (node.endLine > maxEndLine) maxEndLine = node.endLine;
    if (node.level === 0 && node.id && !fileLevelNode) {
      fileLevelNode = node;
    }
  }

  const basename = getFileBasename(fileData.filePath);
  return {
    id: canonicalFileNodeKey(fileData.filePath),
    kind: "file",
    orgId: combineAllTags ? fileLevelNode?.id : undefined,
    customId: combineAllTags ? fileLevelNode?.customId : undefined,
    filePath: fileData.filePath,
    fileTitle: fileData.fileTitle,
    line: 0,
    endLine: maxEndLine,
    level: 0,
    title: fileData.fileTitle?.trim() || basename,
    headingPath: [],
    tags: collectFileTags(fileData, combineAllTags),
    status: "found",
    inDegree: 0,
    outDegree: 0,
    transcludeIn: 0,
    transcludeOut: 0,
    degree: 0,
  };
}

export function createUnresolvedGraphNode(targetId: string): OrgGraphNode {
  const cleanId = targetId.trim();
  return {
    id: canonicalUnresolvedNodeKey(cleanId),
    kind: "unresolved",
    orgId: cleanId,
    filePath: "",
    line: 0,
    endLine: 0,
    level: 0,
    title: cleanId,
    headingPath: [],
    tags: [],
    status: "missing",
    inDegree: 0,
    outDegree: 0,
    transcludeIn: 0,
    transcludeOut: 0,
    degree: 0,
  };
}

export function findStructuralParentEntry(
  child: OrgNodeEntry,
  fileNodes: OrgNodeEntry[]
): OrgNodeEntry | undefined {
  if (!child.parentNodeId) return undefined;
  let best: OrgNodeEntry | undefined;
  for (const candidate of fileNodes) {
    if (candidate === child || candidate.id !== child.parentNodeId) continue;
    if (candidate.line <= child.line && child.endLine <= candidate.endLine) {
      if (!best || candidate.level > best.level || candidate.line > best.line) {
        best = candidate;
      }
    }
  }
  if (best) return best;
  return fileNodes.find((n) => n !== child && n.id === child.parentNodeId);
}

export function addAggregatedEdge(
  edgeMap: Map<string, OrgGraphEdge>,
  source: string,
  target: string,
  kind: OrgGraphEdgeKind,
  link?: OrgIdLink
): void {
  const id = `${kind}:${source}->${target}`;
  const existing = edgeMap.get(id);
  if (existing) {
    existing.weight += 1;
    if (link) {
      if (!existing.links) existing.links = [];
      existing.links.push(link);
    }
    return;
  }

  edgeMap.set(id, {
    id,
    source,
    target,
    kind,
    weight: 1,
    links: link ? [link] : undefined,
  });
}

export function computeParallelEdgeSlots(edges: OrgGraphEdge[]): void {
  const byPair = new Map<string, OrgGraphEdge[]>();
  for (const edge of edges) {
    const pairKey =
      edge.source.localeCompare(edge.target) <= 0
        ? `${edge.source}\0${edge.target}`
        : `${edge.target}\0${edge.source}`;
    const group = byPair.get(pairKey);
    if (group) {
      group.push(edge);
    } else {
      byPair.set(pairKey, [edge]);
    }
  }

  for (const group of byPair.values()) {
    if (group.length > 1) {
      group.sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          a.source.localeCompare(b.source) ||
          a.target.localeCompare(b.target) ||
          a.id.localeCompare(b.id)
      );
    }
    const count = group.length;
    for (let i = 0; i < count; i++) {
      group[i].parallelIndex = i;
      group[i].parallelCount = count;
    }
  }
}

export interface FinalizeOrgGraphParams {
  granularity: OrgGraphGranularity;
  nodeMap: Map<string, OrgGraphNode>;
  edgeMap: Map<string, OrgGraphEdge>;
  filter: OrgGraphFilterState;
  colorMode: OrgGraphColorSchemeMode;
  groups: OrgGraphColorGroup[];
  indexVersion: number;
  unresolvedBySource: Map<string, Set<string>>;
  centerNodeId?: string;
}

export function finalizeOrgGraphData(params: FinalizeOrgGraphParams): OrgGraphData {
  const {
    granularity,
    nodeMap,
    edgeMap,
    filter,
    colorMode,
    groups,
    indexVersion,
    unresolvedBySource,
    centerNodeId,
  } = params;

  const parsedQuery = parseGraphQuery(filter.search);
  const searchedNodeMap = new Map<string, OrgGraphNode>();
  for (const [id, node] of nodeMap.entries()) {
    if (
      parsedQuery.isEmpty ||
      (centerNodeId !== undefined && id === centerNodeId) ||
      matchesGraphQuery(node, parsedQuery)
    ) {
      searchedNodeMap.set(id, node);
    }
  }

  const edges: OrgGraphEdge[] = [];
  for (const edge of edgeMap.values()) {
    const src = searchedNodeMap.get(edge.source);
    const tgt = searchedNodeMap.get(edge.target);
    if (!src || !tgt) continue;
    edges.push(edge);
  }

  for (const node of searchedNodeMap.values()) {
    node.inDegree = 0;
    node.outDegree = 0;
    node.transcludeIn = 0;
    node.transcludeOut = 0;
    node.degree = 0;
  }

  for (const edge of edges) {
    const src = searchedNodeMap.get(edge.source)!;
    const tgt = searchedNodeMap.get(edge.target)!;
    src.outDegree += 1;
    tgt.inDegree += 1;
    if (edge.kind === "transclusion") {
      src.transcludeOut += 1;
      tgt.transcludeIn += 1;
    }
  }

  for (const node of searchedNodeMap.values()) {
    node.degree = node.inDegree + node.outDegree;
  }

  const finalNodes: OrgGraphNode[] = [];
  for (const node of searchedNodeMap.values()) {
    if (!filter.showOrphans && node.degree === 0 && node.id !== centerNodeId) {
      continue;
    }
    finalNodes.push(node);
  }

  finalNodes.sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line ||
      a.id.localeCompare(b.id)
  );
  edges.sort((a, b) => a.id.localeCompare(b.id));

  computeParallelEdgeSlots(edges);
  assignNodeColors(finalNodes, colorMode, groups);

  const finalNodeMap = new Map<string, OrgGraphNode>();
  const fileSet = new Set<string>();
  let orphanCount = 0;
  let duplicateCount = 0;
  let unresolvedVisibleCount = 0;

  for (const node of finalNodes) {
    finalNodeMap.set(node.id, node);
    if (node.filePath) fileSet.add(node.filePath);
    if (node.degree === 0) orphanCount += 1;
    if (node.status === "duplicate") duplicateCount += 1;
    if (node.kind === "unresolved") unresolvedVisibleCount += 1;
  }

  let referenceEdges = 0;
  let transclusionEdges = 0;
  let structuralEdges = 0;
  for (const edge of edges) {
    if (edge.kind === "reference") referenceEdges += 1;
    else if (edge.kind === "transclusion") transclusionEdges += 1;
    else if (edge.kind === "structural") structuralEdges += 1;
  }

  let unresolvedCount = unresolvedVisibleCount;
  if (!filter.showUnresolved) {
    let count = 0;
    for (const sources of unresolvedBySource.values()) {
      for (const sourceId of sources) {
        if (searchedNodeMap.has(sourceId)) {
          count += 1;
          break;
        }
      }
    }
    unresolvedCount = count;
  }

  return {
    granularity,
    nodes: finalNodes,
    edges,
    nodeMap: finalNodeMap,
    centerNodeId,
    stats: {
      nodeCount: finalNodes.length,
      edgeCount: edges.length,
      referenceEdges,
      transclusionEdges,
      structuralEdges,
      orphanCount,
      duplicateCount,
      unresolvedCount,
      fileCount: fileSet.size,
    },
    indexVersion,
  };
}

export function recordUnresolvedTarget(
  unresolvedBySource: Map<string, Set<string>>,
  targetId: string,
  sourceKey: string
): void {
  const cleanId = targetId.trim();
  let set = unresolvedBySource.get(cleanId);
  if (!set) {
    set = new Set<string>();
    unresolvedBySource.set(cleanId, set);
  }
  set.add(sourceKey);
}

function buildNodeGranularityGraph(
  index: OrgIdIndex,
  filter: OrgGraphFilterState,
  colorMode: OrgGraphColorSchemeMode,
  groups: OrgGraphColorGroup[]
): OrgGraphData {
  const allFiles = index.getAllFileIndexData();
  const resolveId = createIdResolutionCache(index);
  const nodeMap = new Map<string, OrgGraphNode>();
  const edgeMap = new Map<string, OrgGraphEdge>();
  const entryToKey = new Map<OrgNodeEntry, string>();
  const unresolvedBySource = new Map<string, Set<string>>();

  const ensureFileNode = (fileData: OrgFileIndexData): string => {
    const fileKey = canonicalFileNodeKey(fileData.filePath);
    if (!nodeMap.has(fileKey)) {
      nodeMap.set(fileKey, createFileGraphNode(fileData, false));
    }
    return fileKey;
  };

  for (const fileData of allFiles) {
    if (filter.showStructural) {
      ensureFileNode(fileData);
    }

    for (const entry of fileData.nodes) {
      if (!entry.id) continue;
      const meta = resolveOrgNodeMeta(entry, resolveId);
      entryToKey.set(entry, meta.key);
      if (!nodeMap.has(meta.key)) {
        nodeMap.set(meta.key, createOrgNodeFromEntry(entry, fileData.fileTitle, meta));
      }
    }

    if (filter.showStructural) {
      const fileKey = ensureFileNode(fileData);
      for (const entry of fileData.nodes) {
        if (!entry.id) continue;
        const childKey = entryToKey.get(entry);
        if (!childKey) continue;
        if (entry.parentNodeId) {
          const parentEntry = findStructuralParentEntry(entry, fileData.nodes);
          const parentKey =
            (parentEntry ? entryToKey.get(parentEntry) : undefined) ??
            canonicalOrgNodeKey(entry.parentNodeId);
          if (parentKey !== childKey && nodeMap.has(parentKey)) {
            addAggregatedEdge(edgeMap, parentKey, childKey, "structural");
          }
        } else {
          addAggregatedEdge(edgeMap, fileKey, childKey, "structural");
        }
      }
    }

    for (let i = 0; i < fileData.links.length; i++) {
      const link = fileData.links[i];
      const kind: OrgGraphEdgeKind =
        link.relation === "transclude" ? "transclusion" : "reference";
      if (kind === "reference" && !filter.showReference) continue;
      if (kind === "transclusion" && !filter.showTransclusion) continue;

      const meta = fileData.linkMeta?.[i];
      const sourceKey =
        meta?.sourceNode && meta.sourceNode.id
          ? (entryToKey.get(meta.sourceNode) ?? canonicalOrgNodeKey(meta.sourceNode.id))
          : ensureFileNode(fileData);

      const targetRes = resolveId(link.targetId);
      if (targetRes.status === "missing") {
        recordUnresolvedTarget(unresolvedBySource, link.targetId, sourceKey);
        if (!filter.showUnresolved) continue;
        const missingKey = canonicalUnresolvedNodeKey(link.targetId);
        if (!nodeMap.has(missingKey)) {
          nodeMap.set(missingKey, createUnresolvedGraphNode(link.targetId));
        }
        addAggregatedEdge(edgeMap, sourceKey, missingKey, kind, link);
        continue;
      }

      const targetKey = canonicalOrgNodeKey(link.targetId);
      addAggregatedEdge(edgeMap, sourceKey, targetKey, kind, link);
    }
  }

  return finalizeOrgGraphData({
    granularity: "node",
    nodeMap,
    edgeMap,
    filter,
    colorMode,
    groups,
    indexVersion: index.getVersion(),
    unresolvedBySource,
  });
}

function buildFileGranularityGraph(
  index: OrgIdIndex,
  filter: OrgGraphFilterState,
  colorMode: OrgGraphColorSchemeMode,
  groups: OrgGraphColorGroup[]
): OrgGraphData {
  const allFiles = index.getAllFileIndexData();
  const resolveId = createIdResolutionCache(index);
  const nodeMap = new Map<string, OrgGraphNode>();
  const edgeMap = new Map<string, OrgGraphEdge>();
  const unresolvedBySource = new Map<string, Set<string>>();

  for (const fileData of allFiles) {
    const fileNode = createFileGraphNode(fileData, true);
    nodeMap.set(fileNode.id, fileNode);
  }

  for (const fileData of allFiles) {
    const sourceKey = canonicalFileNodeKey(fileData.filePath);
    for (const link of fileData.links) {
      const kind: OrgGraphEdgeKind =
        link.relation === "transclude" ? "transclusion" : "reference";
      if (kind === "reference" && !filter.showReference) continue;
      if (kind === "transclusion" && !filter.showTransclusion) continue;

      const targetRes = resolveId(link.targetId);
      if (targetRes.status === "missing") {
        recordUnresolvedTarget(unresolvedBySource, link.targetId, sourceKey);
        if (!filter.showUnresolved) continue;
        const missingKey = canonicalUnresolvedNodeKey(link.targetId);
        if (!nodeMap.has(missingKey)) {
          nodeMap.set(missingKey, createUnresolvedGraphNode(link.targetId));
        }
        addAggregatedEdge(edgeMap, sourceKey, missingKey, kind, link);
        continue;
      }

      const targetNode =
        targetRes.status === "found" ? targetRes.node : targetRes.nodes[0];
      if (!targetNode || targetNode.filePath === fileData.filePath) {
        continue;
      }

      const targetKey = canonicalFileNodeKey(targetNode.filePath);
      addAggregatedEdge(edgeMap, sourceKey, targetKey, kind, link);
    }
  }

  return finalizeOrgGraphData({
    granularity: "file",
    nodeMap,
    edgeMap,
    filter,
    colorMode,
    groups,
    indexVersion: index.getVersion(),
    unresolvedBySource,
  });
}

/**
 * Build a complete Global Org Knowledge Graph directly from `OrgIdIndex`
 * with zero duplicate file parsing.
 */
export function buildOrgGraph(
  index: OrgIdIndex,
  options: BuildOrgGraphOptions = {}
): OrgGraphData {
  const granularity: OrgGraphGranularity =
    options.granularity === "file" ? "file" : "node";
  const filter = normalizeGraphFilter(options.filter);
  const colorMode: OrgGraphColorSchemeMode = options.colorMode ?? "file";
  const groups = options.groups ?? [];

  if (granularity === "file") {
    return buildFileGranularityGraph(index, filter, colorMode, groups);
  }
  return buildNodeGranularityGraph(index, filter, colorMode, groups);
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function graphNodesEqual(a: OrgGraphNode, b: OrgGraphNode): boolean {
  return (
    a.kind === b.kind &&
    a.orgId === b.orgId &&
    a.customId === b.customId &&
    a.filePath === b.filePath &&
    a.fileTitle === b.fileTitle &&
    a.line === b.line &&
    a.endLine === b.endLine &&
    a.level === b.level &&
    a.title === b.title &&
    a.todo === b.todo &&
    a.status === b.status &&
    a.duplicateCount === b.duplicateCount &&
    a.parentNodeId === b.parentNodeId &&
    a.inDegree === b.inDegree &&
    a.outDegree === b.outDegree &&
    a.transcludeIn === b.transcludeIn &&
    a.transcludeOut === b.transcludeOut &&
    a.degree === b.degree &&
    a.groupColor === b.groupColor &&
    a.groupId === b.groupId &&
    Boolean(a.isCenter) === Boolean(b.isCenter) &&
    a.hopDistance === b.hopDistance &&
    stringArraysEqual(a.tags, b.tags) &&
    stringArraysEqual(a.headingPath, b.headingPath)
  );
}

function graphEdgesEqual(a: OrgGraphEdge, b: OrgGraphEdge): boolean {
  return (
    a.source === b.source &&
    a.target === b.target &&
    a.kind === b.kind &&
    a.weight === b.weight &&
    a.parallelIndex === b.parallelIndex &&
    a.parallelCount === b.parallelCount &&
    (a.links?.length ?? 0) === (b.links?.length ?? 0)
  );
}

/**
 * Compute an incremental node/edge diff between two graph snapshots so
 * simulation layout can preserve existing node coordinates across edits/moves.
 */
export function diffOrgGraphs(
  prev: OrgGraphData | null,
  next: OrgGraphData
): OrgGraphPatch {
  if (!prev) {
    return {
      addedNodes: [...next.nodes],
      removedNodeIds: new Set<string>(),
      updatedNodes: [],
      addedEdges: [...next.edges],
      removedEdgeIds: new Set<string>(),
      updatedEdges: [],
    };
  }

  const prevNodeMap =
    prev.nodeMap ?? new Map<string, OrgGraphNode>(prev.nodes.map((n) => [n.id, n]));
  const nextNodeMap =
    next.nodeMap ?? new Map<string, OrgGraphNode>(next.nodes.map((n) => [n.id, n]));

  const addedNodes: OrgGraphNode[] = [];
  const updatedNodes: OrgGraphNode[] = [];
  const removedNodeIds = new Set<string>();

  for (const nextNode of next.nodes) {
    const prevNode = prevNodeMap.get(nextNode.id);
    if (!prevNode) {
      addedNodes.push(nextNode);
    } else if (!graphNodesEqual(prevNode, nextNode)) {
      updatedNodes.push(nextNode);
    }
  }

  for (const prevNode of prev.nodes) {
    if (!nextNodeMap.has(prevNode.id)) {
      removedNodeIds.add(prevNode.id);
    }
  }

  const prevEdgeMap = new Map<string, OrgGraphEdge>(prev.edges.map((e) => [e.id, e]));
  const nextEdgeIds = new Set<string>(next.edges.map((e) => e.id));

  const addedEdges: OrgGraphEdge[] = [];
  const updatedEdges: OrgGraphEdge[] = [];
  const removedEdgeIds = new Set<string>();

  for (const nextEdge of next.edges) {
    const prevEdge = prevEdgeMap.get(nextEdge.id);
    if (!prevEdge) {
      addedEdges.push(nextEdge);
    } else if (!graphEdgesEqual(prevEdge, nextEdge)) {
      updatedEdges.push(nextEdge);
    }
  }

  for (const prevEdge of prev.edges) {
    if (!nextEdgeIds.has(prevEdge.id)) {
      removedEdgeIds.add(prevEdge.id);
    }
  }

  return {
    addedNodes,
    removedNodeIds,
    updatedNodes,
    addedEdges,
    removedEdgeIds,
    updatedEdges,
  };
}
