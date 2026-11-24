import type { IdResolution, OrgIdIndex } from "../index/orgIdIndex";
import type { OrgIdLink, OrgNodeEntry } from "../model/types";
import {
  addAggregatedEdge,
  createEmptyOrgGraphData,
  createFileGraphNode,
  createIdResolutionCache,
  createOrgNodeFromEntry,
  createUnresolvedGraphNode,
  finalizeOrgGraphData,
  findStructuralParentEntry,
  isSameNodeEntry,
  normalizeGraphFilter,
  recordUnresolvedTarget,
  resolveOrgNodeMeta,
} from "./graphAdapter";
import {
  canonicalFileNodeKey,
  canonicalOrgNodeKey,
  canonicalUnresolvedNodeKey,
  type OrgGraphColorGroup,
  type OrgGraphColorSchemeMode,
  type OrgGraphData,
  type OrgGraphEdge,
  type OrgGraphEdgeKind,
  type OrgGraphFilterState,
  type OrgGraphGranularity,
  type OrgGraphNode,
} from "./types";

export interface BuildLocalOrgGraphOptions {
  centerNodeId?: string | null;
  centerFilePath?: string | null;
  granularity?: OrgGraphGranularity;
  depth?: 1 | 2 | 3;
  showIncoming?: boolean;
  showOutgoing?: boolean;
  filter?: Partial<OrgGraphFilterState>;
  colorMode?: OrgGraphColorSchemeMode;
  groups?: OrgGraphColorGroup[];
}

type ResolvedCenter =
  | { kind: "org-node"; key: string; entry: OrgNodeEntry }
  | { kind: "file"; key: string; filePath: string }
  | { kind: "missing"; key: string; targetId: string };

function clampDepth(depth?: number): 1 | 2 | 3 {
  if (depth === 2) return 2;
  if (depth === 3) return 3;
  return 1;
}

function pickResolvedNode(res: IdResolution): OrgNodeEntry | undefined {
  if (res.status === "found") return res.node;
  if (res.status === "duplicate") return res.nodes[0];
  return undefined;
}

function resolveEnabledEdgeKind(
  relation: "link" | "transclude" | undefined,
  filter: OrgGraphFilterState
): OrgGraphEdgeKind | null {
  const kind: OrgGraphEdgeKind = relation === "transclude" ? "transclusion" : "reference";
  if (kind === "reference" && !filter.showReference) return null;
  if (kind === "transclusion" && !filter.showTransclusion) return null;
  return kind;
}

function parseDuplicateCenterKey(
  dupKey: string,
  index: OrgIdIndex,
  resolveId: (id: string) => IdResolution
): ResolvedCenter | null {
  const lastColon = dupKey.lastIndexOf(":");
  if (lastColon <= 4) return null;
  const lineStr = dupKey.slice(lastColon + 1);
  if (!/^\d+$/.test(lineStr)) return null;
  const targetLine = Number.parseInt(lineStr, 10);
  const body = dupKey.slice(4, lastColon);

  for (let at = body.indexOf("@"); at !== -1; at = body.indexOf("@", at + 1)) {
    const orgId = body.slice(0, at).trim();
    const filePath = body.slice(at + 1);
    if (!orgId || !filePath) continue;

    const fileData = index.getFileIndexData(filePath);
    if (fileData) {
      const match = fileData.nodes.find(
        (n) => n.id === orgId && n.line === targetLine
      );
      if (match) {
        const meta = resolveOrgNodeMeta(match, resolveId);
        return { kind: "org-node", key: meta.key, entry: match };
      }
    }

    const res = resolveId(orgId);
    if (res.status === "found") {
      return {
        kind: "org-node",
        key: canonicalOrgNodeKey(orgId),
        entry: res.node,
      };
    }
    if (res.status === "duplicate") {
      const exact =
        res.nodes.find((n) => n.filePath === filePath && n.line === targetLine) ??
        res.nodes[0];
      if (exact) {
        const meta = resolveOrgNodeMeta(exact, resolveId);
        return { kind: "org-node", key: meta.key, entry: exact };
      }
    }
  }

  return null;
}

function resolveNodeModeCenter(
  index: OrgIdIndex,
  resolveId: (id: string) => IdResolution,
  centerNodeId: string | null | undefined,
  centerFilePath: string | null | undefined,
  showUnresolved: boolean
): ResolvedCenter | null {
  const rawCenter = centerNodeId?.trim();
  if (rawCenter) {
    if (rawCenter.startsWith("dup:")) {
      const parsedDup = parseDuplicateCenterKey(rawCenter, index, resolveId);
      if (parsedDup) return parsedDup;
    } else if (rawCenter.startsWith("file:")) {
      const fp = rawCenter.slice(5);
      if (fp && index.getFileIndexData(fp)) {
        return {
          kind: "file",
          key: canonicalFileNodeKey(fp),
          filePath: fp,
        };
      }
    } else if (rawCenter.startsWith("missing:")) {
      const missingId = rawCenter.slice(8).trim();
      if (missingId) {
        const entry = pickResolvedNode(resolveId(missingId));
        if (entry) {
          return {
            kind: "org-node",
            key: canonicalOrgNodeKey(missingId),
            entry,
          };
        }
        if (showUnresolved && index.getBacklinkEntries(missingId).length > 0) {
          return {
            kind: "missing",
            key: canonicalUnresolvedNodeKey(missingId),
            targetId: missingId,
          };
        }
      }
    } else {
      const orgId = rawCenter.startsWith("id:") ? rawCenter.slice(3).trim() : rawCenter;
      if (orgId) {
        const entry = pickResolvedNode(resolveId(orgId));
        if (entry) {
          return {
            kind: "org-node",
            key: canonicalOrgNodeKey(orgId),
            entry,
          };
        }
      }
    }
  }

  const fallbackPath = centerFilePath?.trim();
  if (fallbackPath && index.getFileIndexData(fallbackPath)) {
    return {
      kind: "file",
      key: canonicalFileNodeKey(fallbackPath),
      filePath: fallbackPath,
    };
  }

  return null;
}

function resolveFileModeCenter(
  index: OrgIdIndex,
  resolveId: (id: string) => IdResolution,
  centerNodeId: string | null | undefined,
  centerFilePath: string | null | undefined,
  showUnresolved: boolean
): ResolvedCenter | null {
  const rawCenter = centerNodeId?.trim();
  if (rawCenter) {
    if (rawCenter.startsWith("file:")) {
      const fp = rawCenter.slice(5);
      if (fp && index.getFileIndexData(fp)) {
        return { kind: "file", key: canonicalFileNodeKey(fp), filePath: fp };
      }
    } else if (rawCenter.startsWith("dup:")) {
      const parsedDup = parseDuplicateCenterKey(rawCenter, index, resolveId);
      if (parsedDup?.kind === "org-node" && index.getFileIndexData(parsedDup.entry.filePath)) {
        return {
          kind: "file",
          key: canonicalFileNodeKey(parsedDup.entry.filePath),
          filePath: parsedDup.entry.filePath,
        };
      }
    } else if (rawCenter.startsWith("missing:")) {
      const missingId = rawCenter.slice(8).trim();
      if (missingId) {
        const res = resolveId(missingId);
        const node = res.status === "found" ? res.node : res.status === "duplicate" ? res.nodes[0] : undefined;
        if (node && index.getFileIndexData(node.filePath)) {
          return {
            kind: "file",
            key: canonicalFileNodeKey(node.filePath),
            filePath: node.filePath,
          };
        }
        if (showUnresolved && index.getBacklinkEntries(missingId).length > 0) {
          return {
            kind: "missing",
            key: canonicalUnresolvedNodeKey(missingId),
            targetId: missingId,
          };
        }
      }
    } else {
      const orgId = rawCenter.startsWith("id:") ? rawCenter.slice(3).trim() : rawCenter;
      if (orgId) {
        const res = resolveId(orgId);
        const node =
          res.status === "found"
            ? res.node
            : res.status === "duplicate"
              ? res.nodes[0]
              : undefined;
        if (node && index.getFileIndexData(node.filePath)) {
          return {
            kind: "file",
            key: canonicalFileNodeKey(node.filePath),
            filePath: node.filePath,
          };
        }
      }
    }
  }

  const fallbackPath = centerFilePath?.trim();
  if (fallbackPath && index.getFileIndexData(fallbackPath)) {
    return {
      kind: "file",
      key: canonicalFileNodeKey(fallbackPath),
      filePath: fallbackPath,
    };
  }

  return null;
}

function buildLocalNodeGraph(
  index: OrgIdIndex,
  resolveId: (id: string) => IdResolution,
  center: ResolvedCenter,
  depth: 1 | 2 | 3,
  showIncoming: boolean,
  showOutgoing: boolean,
  filter: OrgGraphFilterState,
  colorMode: OrgGraphColorSchemeMode,
  groups: OrgGraphColorGroup[]
): OrgGraphData {
  const nodeMap = new Map<string, OrgGraphNode>();
  const entryByKey = new Map<string, OrgNodeEntry>();
  const distances = new Map<string, number>();
  const edgeMap = new Map<string, OrgGraphEdge>();
  const unresolvedBySource = new Map<string, Set<string>>();

  const ensureEntryNode = (entry: OrgNodeEntry): string => {
    const meta = resolveOrgNodeMeta(entry, resolveId);
    if (!nodeMap.has(meta.key)) {
      const fileData = index.getFileIndexData(entry.filePath);
      nodeMap.set(meta.key, createOrgNodeFromEntry(entry, fileData?.fileTitle, meta));
      entryByKey.set(meta.key, entry);
    }
    return meta.key;
  };

  const ensureFileNode = (filePath: string): string | undefined => {
    const key = canonicalFileNodeKey(filePath);
    if (nodeMap.has(key)) return key;
    const fileData = index.getFileIndexData(filePath);
    if (!fileData) return undefined;
    nodeMap.set(key, createFileGraphNode(fileData, false));
    return key;
  };

  const ensureMissingNode = (targetId: string): string => {
    const key = canonicalUnresolvedNodeKey(targetId);
    if (!nodeMap.has(key)) {
      nodeMap.set(key, createUnresolvedGraphNode(targetId));
    }
    return key;
  };

  if (center.kind === "org-node") {
    ensureEntryNode(center.entry);
  } else if (center.kind === "file") {
    ensureFileNode(center.filePath);
  } else {
    ensureMissingNode(center.targetId);
  }

  distances.set(center.key, 0);
  let frontier: string[] = [center.key];

  const resolveLinkTargetKey = (
    targetId: string,
    sourceKey: string,
    withinDiscoveryHorizon: boolean
  ): string | null => {
    const targetEntry = pickResolvedNode(resolveId(targetId));
    if (targetEntry) {
      return ensureEntryNode(targetEntry);
    }
    if (withinDiscoveryHorizon) {
      recordUnresolvedTarget(unresolvedBySource, targetId, sourceKey);
    }
    if (!filter.showUnresolved) return null;
    return ensureMissingNode(targetId);
  };

  // Step 1: Bounded BFS discovery of nodes within `depth` hops.
  for (let currentDist = 0; currentDist < depth && frontier.length > 0; currentDist++) {
    const nextFrontier: string[] = [];
    const nextDist = currentDist + 1;

    const visitNeighbor = (neighborKey: string | null | undefined) => {
      if (!neighborKey || distances.has(neighborKey)) return;
      distances.set(neighborKey, nextDist);
      nextFrontier.push(neighborKey);
    };

    for (const uKey of frontier) {
      const uNode = nodeMap.get(uKey);
      if (!uNode) continue;

      if (uNode.kind === "org-node") {
        const uEntry = entryByKey.get(uKey);
        if (!uEntry) continue;
        const fileData = index.getFileIndexData(uEntry.filePath);

        if (showOutgoing && fileData) {
          for (let i = 0; i < fileData.links.length; i++) {
            const link = fileData.links[i];
            if (!resolveEnabledEdgeKind(link.relation, filter)) continue;
            const meta = fileData.linkMeta?.[i];
            if (!meta?.sourceNode || !isSameNodeEntry(meta.sourceNode, uEntry)) {
              continue;
            }
            visitNeighbor(resolveLinkTargetKey(link.targetId, uKey, true));
          }

          if (filter.showStructural && uEntry.id) {
            for (const candidate of fileData.nodes) {
              if (!candidate.id || candidate === uEntry) continue;
              const parentEntry = findStructuralParentEntry(candidate, fileData.nodes);
              if (parentEntry && isSameNodeEntry(parentEntry, uEntry)) {
                visitNeighbor(ensureEntryNode(candidate));
              }
            }
          }
        }

        if (showIncoming) {
          const isPrimary = uEntry.id ? uKey === canonicalOrgNodeKey(uEntry.id) : false;
          if (isPrimary && uEntry.id) {
            for (const bl of index.getBacklinkEntries(uEntry.id)) {
              if (!resolveEnabledEdgeKind(bl.link.relation, filter)) continue;
              if (bl.sourceNode?.id) {
                visitNeighbor(ensureEntryNode(bl.sourceNode));
              } else {
                visitNeighbor(ensureFileNode(bl.link.sourcePath));
              }
            }
          }

          if (filter.showStructural) {
            if (uEntry.parentNodeId && fileData) {
              const parentEntry = findStructuralParentEntry(uEntry, fileData.nodes);
              if (parentEntry) {
                visitNeighbor(ensureEntryNode(parentEntry));
              } else {
                const res = resolveId(uEntry.parentNodeId);
                const fallbackParent =
                  res.status === "found"
                    ? res.node
                    : res.status === "duplicate"
                      ? res.nodes[0]
                      : undefined;
                if (fallbackParent) visitNeighbor(ensureEntryNode(fallbackParent));
              }
            } else {
              visitNeighbor(ensureFileNode(uEntry.filePath));
            }
          }
        }
      } else if (uNode.kind === "file") {
        const fileData = index.getFileIndexData(uNode.filePath);
        if (showOutgoing && fileData) {
          for (let i = 0; i < fileData.links.length; i++) {
            const link = fileData.links[i];
            if (!resolveEnabledEdgeKind(link.relation, filter)) continue;
            const meta = fileData.linkMeta?.[i];
            if (meta?.sourceNode?.id) continue;
            visitNeighbor(resolveLinkTargetKey(link.targetId, uKey, true));
          }

          if (filter.showStructural) {
            for (const candidate of fileData.nodes) {
              if (candidate.id && !candidate.parentNodeId) {
                visitNeighbor(ensureEntryNode(candidate));
              }
            }
          }
        }
      } else if (uNode.kind === "unresolved") {
        if (showIncoming && filter.showUnresolved && uNode.orgId) {
          for (const bl of index.getBacklinkEntries(uNode.orgId)) {
            if (!resolveEnabledEdgeKind(bl.link.relation, filter)) continue;
            if (bl.sourceNode?.id) {
              visitNeighbor(ensureEntryNode(bl.sourceNode));
            } else {
              visitNeighbor(ensureFileNode(bl.link.sourcePath));
            }
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  // Step 2: Populate edges among discovered nodes while honoring center direction filters.
  const maybeAddEdge = (
    sourceKey: string,
    targetKey: string,
    kind: OrgGraphEdgeKind,
    link?: OrgIdLink
  ) => {
    if (!distances.has(sourceKey) || !distances.has(targetKey)) return;
    if (!showOutgoing && sourceKey === center.key) return;
    if (!showIncoming && targetKey === center.key) return;
    addAggregatedEdge(edgeMap, sourceKey, targetKey, kind, link);
  };

  const maybeAddLinkEdge = (sourceKey: string, link: OrgIdLink, kind: OrgGraphEdgeKind) => {
    const res = resolveId(link.targetId);
    if (res.status === "missing") {
      if (filter.showUnresolved) {
        maybeAddEdge(sourceKey, canonicalUnresolvedNodeKey(link.targetId), kind, link);
      }
      return;
    }
    maybeAddEdge(sourceKey, canonicalOrgNodeKey(link.targetId), kind, link);
  };

  for (const uKey of distances.keys()) {
    const uNode = nodeMap.get(uKey);
    if (!uNode) continue;

    if (uNode.kind === "org-node") {
      const uEntry = entryByKey.get(uKey);
      if (!uEntry) continue;
      const fileData = index.getFileIndexData(uEntry.filePath);
      if (!fileData) continue;

      for (let i = 0; i < fileData.links.length; i++) {
        const link = fileData.links[i];
        const kind = resolveEnabledEdgeKind(link.relation, filter);
        if (!kind) continue;
        const meta = fileData.linkMeta?.[i];
        if (!meta?.sourceNode || !isSameNodeEntry(meta.sourceNode, uEntry)) {
          continue;
        }
        maybeAddLinkEdge(uKey, link, kind);
      }

      if (filter.showStructural && uEntry.id) {
        for (const candidate of fileData.nodes) {
          if (!candidate.id || candidate === uEntry) continue;
          const parentEntry = findStructuralParentEntry(candidate, fileData.nodes);
          if (parentEntry && isSameNodeEntry(parentEntry, uEntry)) {
            const childMeta = resolveOrgNodeMeta(candidate, resolveId);
            maybeAddEdge(uKey, childMeta.key, "structural");
          }
        }
      }
    } else if (uNode.kind === "file") {
      const fileData = index.getFileIndexData(uNode.filePath);
      if (!fileData) continue;

      for (let i = 0; i < fileData.links.length; i++) {
        const link = fileData.links[i];
        const kind = resolveEnabledEdgeKind(link.relation, filter);
        if (!kind) continue;
        const meta = fileData.linkMeta?.[i];
        if (meta?.sourceNode?.id) continue;
        maybeAddLinkEdge(uKey, link, kind);
      }

      if (filter.showStructural) {
        for (const candidate of fileData.nodes) {
          if (candidate.id && !candidate.parentNodeId) {
            const childMeta = resolveOrgNodeMeta(candidate, resolveId);
            maybeAddEdge(uKey, childMeta.key, "structural");
          }
        }
      }
    }
  }

  for (const [id, node] of nodeMap.entries()) {
    node.isCenter = id === center.key;
    node.hopDistance = distances.get(id);
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
    centerNodeId: center.key,
  });
}

function buildLocalFileGraph(
  index: OrgIdIndex,
  resolveId: (id: string) => IdResolution,
  center: ResolvedCenter,
  depth: 1 | 2 | 3,
  showIncoming: boolean,
  showOutgoing: boolean,
  filter: OrgGraphFilterState,
  colorMode: OrgGraphColorSchemeMode,
  groups: OrgGraphColorGroup[]
): OrgGraphData {
  const nodeMap = new Map<string, OrgGraphNode>();
  const distances = new Map<string, number>();
  const edgeMap = new Map<string, OrgGraphEdge>();
  const unresolvedBySource = new Map<string, Set<string>>();

  const ensureFileNode = (filePath: string): string | undefined => {
    const key = canonicalFileNodeKey(filePath);
    if (nodeMap.has(key)) return key;
    const fileData = index.getFileIndexData(filePath);
    if (!fileData) return undefined;
    nodeMap.set(key, createFileGraphNode(fileData, true));
    return key;
  };

  const ensureMissingNode = (targetId: string): string => {
    const key = canonicalUnresolvedNodeKey(targetId);
    if (!nodeMap.has(key)) {
      nodeMap.set(key, createUnresolvedGraphNode(targetId));
    }
    return key;
  };

  if (center.kind === "file") {
    ensureFileNode(center.filePath);
  } else if (center.kind === "missing") {
    ensureMissingNode(center.targetId);
  }

  distances.set(center.key, 0);
  let frontier: string[] = [center.key];

  // Step 1: Bounded BFS over file nodes & optional missing targets.
  for (let currentDist = 0; currentDist < depth && frontier.length > 0; currentDist++) {
    const nextFrontier: string[] = [];
    const nextDist = currentDist + 1;

    const visitNeighbor = (neighborKey: string | null | undefined) => {
      if (!neighborKey || distances.has(neighborKey)) return;
      distances.set(neighborKey, nextDist);
      nextFrontier.push(neighborKey);
    };

    for (const uKey of frontier) {
      const uNode = nodeMap.get(uKey);
      if (!uNode) continue;

      if (uNode.kind === "file") {
        const fileData = index.getFileIndexData(uNode.filePath);
        if (!fileData) continue;

        if (showOutgoing) {
          for (const link of fileData.links) {
            if (!resolveEnabledEdgeKind(link.relation, filter)) continue;
            const res = resolveId(link.targetId);
            if (res.status === "missing") {
              recordUnresolvedTarget(unresolvedBySource, link.targetId, uKey);
              if (filter.showUnresolved) {
                visitNeighbor(ensureMissingNode(link.targetId));
              }
              continue;
            }
            const targetEntry = pickResolvedNode(res);
            if (!targetEntry || targetEntry.filePath === uNode.filePath) continue;
            visitNeighbor(ensureFileNode(targetEntry.filePath));
          }
        }

        if (showIncoming) {
          for (const entry of fileData.nodes) {
            if (!entry.id) continue;
            const primary = pickResolvedNode(resolveId(entry.id));
            if (!primary || !isSameNodeEntry(primary, entry)) continue;

            for (const bl of index.getBacklinkEntries(entry.id)) {
              if (!resolveEnabledEdgeKind(bl.link.relation, filter)) continue;
              if (bl.link.sourcePath === uNode.filePath) continue;
              visitNeighbor(ensureFileNode(bl.link.sourcePath));
            }
          }
        }
      } else if (uNode.kind === "unresolved") {
        if (showIncoming && filter.showUnresolved && uNode.orgId) {
          for (const bl of index.getBacklinkEntries(uNode.orgId)) {
            if (!resolveEnabledEdgeKind(bl.link.relation, filter)) continue;
            visitNeighbor(ensureFileNode(bl.link.sourcePath));
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  // Step 2: Populate edges among discovered nodes.
  for (const uKey of distances.keys()) {
    const uNode = nodeMap.get(uKey);
    if (!uNode || uNode.kind !== "file") continue;
    const fileData = index.getFileIndexData(uNode.filePath);
    if (!fileData) continue;

    for (const link of fileData.links) {
      const kind = resolveEnabledEdgeKind(link.relation, filter);
      if (!kind) continue;

      const res = resolveId(link.targetId);
      let targetKey: string | null = null;
      if (res.status === "missing") {
        if (filter.showUnresolved) {
          targetKey = canonicalUnresolvedNodeKey(link.targetId);
        }
      } else {
        const targetEntry = pickResolvedNode(res);
        if (targetEntry && targetEntry.filePath !== uNode.filePath) {
          targetKey = canonicalFileNodeKey(targetEntry.filePath);
        }
      }

      if (!targetKey || !distances.has(targetKey)) continue;
      if (!showOutgoing && uKey === center.key) continue;
      if (!showIncoming && targetKey === center.key) continue;
      addAggregatedEdge(edgeMap, uKey, targetKey, kind, link);
    }
  }

  for (const [id, node] of nodeMap.entries()) {
    node.isCenter = id === center.key;
    node.hopDistance = distances.get(id);
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
    centerNodeId: center.key,
  });
}

/**
 * Build a bounded 1/2/3-hop Local Org Graph centered on `centerNodeId`
 * (or fallback `centerFilePath`) directly via `OrgIdIndex` lookups without scanning
 * unrelated vault files. Returns a clean empty graph when the center is missing.
 */
export function buildLocalOrgGraph(
  index: OrgIdIndex,
  options: BuildLocalOrgGraphOptions = {}
): OrgGraphData {
  const granularity: OrgGraphGranularity =
    options.granularity === "file" ? "file" : "node";
  const depth = clampDepth(options.depth);
  const showIncoming = options.showIncoming ?? true;
  const showOutgoing = options.showOutgoing ?? true;
  const filter = normalizeGraphFilter(options.filter);
  const colorMode: OrgGraphColorSchemeMode = options.colorMode ?? "file";
  const groups = options.groups ?? [];
  const resolveId = createIdResolutionCache(index);

  if (granularity === "file") {
    const center = resolveFileModeCenter(
      index,
      resolveId,
      options.centerNodeId,
      options.centerFilePath,
      filter.showUnresolved
    );
    if (!center) {
      return createEmptyOrgGraphData("file", index.getVersion());
    }
    return buildLocalFileGraph(
      index,
      resolveId,
      center,
      depth,
      showIncoming,
      showOutgoing,
      filter,
      colorMode,
      groups
    );
  }

  const center = resolveNodeModeCenter(
    index,
    resolveId,
    options.centerNodeId,
    options.centerFilePath,
    filter.showUnresolved
  );
  if (!center) {
    return createEmptyOrgGraphData("node", index.getVersion());
  }

  return buildLocalNodeGraph(
    index,
    resolveId,
    center,
    depth,
    showIncoming,
    showOutgoing,
    filter,
    colorMode,
    groups
  );
}
