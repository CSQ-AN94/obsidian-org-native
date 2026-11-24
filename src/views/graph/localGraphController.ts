import { TFile, type App, type EventRef, type WorkspaceLeaf } from "obsidian";
import {
  VIEW_TYPE_ORG,
  VIEW_TYPE_ORG_BACKLINKS,
  VIEW_TYPE_ORG_GRAPH,
  VIEW_TYPE_ORG_LOCAL_GRAPH,
} from "../../constants";
import {
  canonicalFileNodeKey,
  canonicalOrgNodeKey,
  createDefaultLocalGraphState,
  type OrgGraphData,
  type OrgGraphFilterState,
  type OrgGraphLocalState,
  type OrgGraphNode,
  type OrgReaderFocusEvent,
} from "../../core/graph/types";
import type { OrgIdIndex } from "../../core/index/orgIdIndex";
import type {
  VaultIndexChangeEvent,
  VaultIndexService,
} from "../../core/index/vaultIndexService";
import type { OrgNodeEntry, OrgViewMode } from "../../core/model/types";
import type { OrgReaderFocusBus } from "./readerFocusBus";

export type LocalGraphTargetStatus = "ok" | "no-focus" | "target-missing";

export interface LocalGraphSnapshot {
  state: OrgGraphLocalState;
  targetStatus: LocalGraphTargetStatus;
  data: OrgGraphData | null;
  lastFocusEvent?: OrgReaderFocusEvent | null;
}

export interface LocalGraphBuildContext {
  index: OrgIdIndex;
  state: OrgGraphLocalState;
  targetStatus: LocalGraphTargetStatus;
  filter?: OrgGraphFilterState;
}

export type LocalGraphBuilder = (context: LocalGraphBuildContext) => OrgGraphData | null;

export interface LocalGraphControllerOptions {
  app: App;
  vaultIndex: VaultIndexService;
  focusBus: OrgReaderFocusBus;
  initialState?: Partial<OrgGraphLocalState>;
  initialFilter?: OrgGraphFilterState;
  buildLocalGraph?: LocalGraphBuilder;
  onChange?: (snapshot: LocalGraphSnapshot) => void;
  /** Subscribe to `vaultIndex.onDidChange` automatically inside `start()` (default: true). */
  subscribeToIndex?: boolean;
}

const IGNORED_LEAF_VIEW_TYPES = new Set<string>([
  VIEW_TYPE_ORG_GRAPH,
  VIEW_TYPE_ORG_LOCAL_GRAPH,
  VIEW_TYPE_ORG_BACKLINKS,
]);

interface ParsedDuplicateKey {
  orgId: string;
  filePath: string;
  line: number;
}

function isOrgPath(filePath: string | null | undefined): filePath is string {
  return typeof filePath === "string" && filePath.toLowerCase().endsWith(".org");
}

function parseDuplicateNodeKey(nodeKey: string): ParsedDuplicateKey | null {
  if (!nodeKey.startsWith("dup:")) return null;
  const body = nodeKey.slice(4);
  const atIdx = body.indexOf("@");
  const colonIdx = body.lastIndexOf(":");
  if (atIdx <= 0 || colonIdx <= atIdx + 1) return null;
  const orgId = body.slice(0, atIdx).trim();
  const filePath = body.slice(atIdx + 1, colonIdx);
  const line = Number(body.slice(colonIdx + 1));
  if (!orgId || !filePath || !Number.isFinite(line)) return null;
  return { orgId, filePath, line };
}

function extractOrgIdFromNodeKey(nodeKey: string | null | undefined): string | null {
  if (!nodeKey) return null;
  if (nodeKey.startsWith("id:")) {
    const id = nodeKey.slice(3).trim();
    return id || null;
  }
  if (nodeKey.startsWith("missing:")) {
    const id = nodeKey.slice("missing:".length).trim();
    return id || null;
  }
  if (nodeKey.startsWith("dup:")) {
    return parseDuplicateNodeKey(nodeKey)?.orgId ?? null;
  }
  return null;
}

function extractFilePathFromNodeKey(nodeKey: string | null | undefined): string | null {
  if (!nodeKey) return null;
  if (nodeKey.startsWith("file:")) {
    return nodeKey.slice("file:".length) || null;
  }
  if (nodeKey.startsWith("dup:")) {
    return parseDuplicateNodeKey(nodeKey)?.filePath ?? null;
  }
  return null;
}

function setsIntersect(a: ReadonlySet<string>, b?: ReadonlySet<string>): boolean {
  if (!b || a.size === 0 || b.size === 0) return false;
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

function isOrgGraphNode(value: unknown): value is OrgGraphNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "id" in value &&
    "filePath" in value
  );
}

function getLeafViewType(leaf: WorkspaceLeaf | null | undefined): string | null {
  if (!leaf || typeof leaf !== "object") return null;
  const view = (leaf as { view?: { getViewType?: () => string } }).view;
  if (!view || typeof view.getViewType !== "function") return null;
  return view.getViewType();
}

function getLeafOrgFilePath(leaf: WorkspaceLeaf | null | undefined): string | null {
  if (!leaf || typeof leaf !== "object") return null;
  const view = (leaf as { view?: { file?: { path?: string } | null } }).view;
  const path = view?.file?.path;
  return isOrgPath(path) ? path : null;
}

function buildFileFallbackEntry(
  filePath: string,
  index: OrgIdIndex,
  hint?: Partial<OrgGraphNode>
): OrgNodeEntry {
  const fileData = index.getFileIndexData(filePath);
  const level0 = fileData?.nodes.find((n) => n.level === 0);
  if (level0) return level0;
  return {
    filePath,
    line: 0,
    endLine: Math.max(0, hint?.endLine ?? 0),
    level: 0,
    title: fileData?.fileTitle ?? hint?.fileTitle ?? hint?.title ?? filePath,
    headingPath: [],
    drawerStartLine: 0,
    drawerEndLine: 0,
    tags: hint?.tags && hint.tags.length > 0 ? [...hint.tags] : undefined,
  };
}

/**
 * Resolve any canonical `OrgGraphNode` (`id:`, `file:`, `dup:`, or newly created `missing:`)
 * into a concrete `OrgNodeEntry` suitable for `VaultIndexService.openNode`.
 */
export function resolveGraphNodeToOpenTarget(
  node: OrgGraphNode,
  index: OrgIdIndex
): OrgNodeEntry | null {
  if (!node) return null;

  if (node.kind === "file" || node.id.startsWith("file:")) {
    const filePath = node.filePath || node.id.slice("file:".length);
    if (!filePath || !index.getFileIndexData(filePath)) return null;
    return buildFileFallbackEntry(filePath, index, node);
  }

  if (node.id.startsWith("dup:")) {
    const parsed = parseDuplicateNodeKey(node.id);
    const orgId = node.orgId ?? parsed?.orgId;
    const matchPath = parsed?.filePath ?? node.filePath;
    const matchLine = parsed?.line ?? node.line;
    if (orgId) {
      const res = index.resolveId(orgId);
      if (res.status === "found") return res.node;
      if (res.status === "duplicate") {
        return (
          res.nodes.find((n) => n.filePath === matchPath && n.line === matchLine) ??
          res.nodes.find((n) => n.filePath === matchPath) ??
          res.nodes[0]
        );
      }
      return null;
    }
  }

  if (node.kind === "unresolved" || node.id.startsWith("missing:")) {
    const targetId =
      node.orgId ??
      (node.id.startsWith("missing:") ? node.id.slice("missing:".length).trim() : "");
    if (!targetId) return null;
    const res = index.resolveId(targetId);
    if (res.status === "found") return res.node;
    if (res.status === "duplicate") {
      return res.nodes.find((n) => n.filePath === node.filePath) ?? res.nodes[0];
    }
    return null;
  }

  const orgId =
    node.orgId ?? (node.id.startsWith("id:") ? node.id.slice("id:".length).trim() : "");
  if (orgId) {
    const res = index.resolveId(orgId);
    if (res.status === "found") return res.node;
    if (res.status === "duplicate") {
      return (
        res.nodes.find((n) => n.filePath === node.filePath && n.line === node.line) ??
        res.nodes.find((n) => n.filePath === node.filePath) ??
        res.nodes[0]
      );
    }
    if (node.customId) {
      const customRes = index.resolveCustomId(node.customId, node.filePath);
      if (customRes.status === "found") return customRes.node;
      if (customRes.status === "duplicate") return customRes.nodes[0];
    }
    return null;
  }

  if (node.customId) {
    const customRes = index.resolveCustomId(node.customId, node.filePath);
    if (customRes.status === "found") return customRes.node;
    if (customRes.status === "duplicate") return customRes.nodes[0];
  }

  if (node.filePath) {
    const nodes = index.getNodesInFile(node.filePath);
    const exact = nodes.find((n) => n.line === node.line);
    if (exact) return exact;
    if (index.getFileIndexData(node.filePath)) {
      return {
        filePath: node.filePath,
        line: Math.max(0, node.line),
        endLine: Math.max(node.line, node.endLine),
        level: node.level,
        title: node.title,
        headingPath: [...node.headingPath],
        drawerStartLine: Math.max(0, node.line),
        drawerEndLine: Math.max(0, node.line),
        tags: node.tags.length > 0 ? [...node.tags] : undefined,
        todo: node.todo,
        parentNodeId: node.parentNodeId,
      };
    }
  }

  return null;
}

function normalizeInitialLocalState(initial?: Partial<OrgGraphLocalState>): OrgGraphLocalState {
  const base = createDefaultLocalGraphState().local!;
  if (!initial) return base;

  const depth: 1 | 2 | 3 =
    initial.depth === 1 || initial.depth === 2 || initial.depth === 3
      ? initial.depth
      : base.depth;
  const followReader =
    typeof initial.followReader === "boolean" ? initial.followReader : base.followReader;
  let lockedNodeId =
    typeof initial.lockedNodeId === "string" && initial.lockedNodeId.trim()
      ? initial.lockedNodeId.trim()
      : null;
  let centerNodeId =
    typeof initial.centerNodeId === "string" && initial.centerNodeId.trim()
      ? initial.centerNodeId.trim()
      : null;
  const centerFilePath =
    typeof initial.centerFilePath === "string" && initial.centerFilePath.trim()
      ? initial.centerFilePath
      : null;

  if (followReader) {
    lockedNodeId = null;
  } else {
    if (!centerNodeId && lockedNodeId) {
      centerNodeId = lockedNodeId;
    } else if (!lockedNodeId && centerNodeId) {
      lockedNodeId = centerNodeId;
    } else if (!lockedNodeId && centerFilePath) {
      const fileKey = canonicalFileNodeKey(centerFilePath);
      centerNodeId = fileKey;
      lockedNodeId = fileKey;
    }
  }

  return {
    depth,
    showIncoming:
      typeof initial.showIncoming === "boolean" ? initial.showIncoming : base.showIncoming,
    showOutgoing:
      typeof initial.showOutgoing === "boolean" ? initial.showOutgoing : base.showOutgoing,
    followReader,
    lockedNodeId,
    centerNodeId,
    centerFilePath,
  };
}

/**
 * Coordinates Local Graph state (`depth`, incoming/outgoing, follow vs lock),
 * `OrgReaderFocusBus` + Obsidian workspace synchronization with scroll-jitter immunity,
 * incremental index reconciliation, and safe Graph -> Reader navigation.
 */
export class LocalGraphController {
  private readonly app: App;
  private readonly vaultIndex: VaultIndexService;
  private readonly focusBus: OrgReaderFocusBus;
  private readonly buildLocalGraph?: LocalGraphBuilder;
  private readonly onChangeCallback?: (snapshot: LocalGraphSnapshot) => void;
  private readonly subscribeToIndex: boolean;

  private state: OrgGraphLocalState;
  private filter?: OrgGraphFilterState;
  private targetStatus: LocalGraphTargetStatus = "no-focus";
  private data: OrgGraphData | null = null;
  private lastFocusEvent: OrgReaderFocusEvent | null = null;

  private started = false;
  private suppressBusHandling = false;
  private unsubFocusBus: (() => void) | null = null;
  private unsubVaultIndex: (() => void) | null = null;
  private workspaceEventRefs: EventRef[] = [];
  private listeners = new Set<(snapshot: LocalGraphSnapshot) => void>();

  constructor(options: LocalGraphControllerOptions) {
    this.app = options.app;
    this.vaultIndex = options.vaultIndex;
    this.focusBus = options.focusBus;
    this.buildLocalGraph = options.buildLocalGraph;
    this.onChangeCallback = options.onChange;
    this.subscribeToIndex = options.subscribeToIndex ?? true;
    this.filter = options.initialFilter ? { ...options.initialFilter } : undefined;
    this.state = normalizeInitialLocalState(options.initialState);
    this.reconcileCenterWithIndex({ allowUnindexedFileFocus: false });
  }

  getState(): OrgGraphLocalState {
    return { ...this.state };
  }

  getTargetStatus(): LocalGraphTargetStatus {
    return this.targetStatus;
  }

  getData(): OrgGraphData | null {
    return this.data;
  }

  getSnapshot(): LocalGraphSnapshot {
    return {
      state: { ...this.state },
      targetStatus: this.targetStatus,
      data: this.data,
      lastFocusEvent: this.lastFocusEvent,
    };
  }

  subscribe(listener: (snapshot: LocalGraphSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setData(data: OrgGraphData | null): void {
    this.data = data;
  }

  setFilter(filter: OrgGraphFilterState): void {
    this.filter = { ...filter };
    if (this.buildLocalGraph && this.targetStatus !== "no-focus") {
      this.rebuild();
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubFocusBus = this.focusBus.subscribe((event) => {
      this.handleFocusEvent(event);
    });

    const workspace = this.app?.workspace;
    if (workspace && typeof workspace.on === "function") {
      const leafRef = workspace.on("active-leaf-change", (leaf) => {
        this.handleActiveLeafChange(leaf);
      });
      if (leafRef) this.workspaceEventRefs.push(leafRef);

      const fileRef = workspace.on("file-open", (file) => {
        this.handleFileOpen(file);
      });
      if (fileRef) this.workspaceEventRefs.push(fileRef);
    }

    if (this.subscribeToIndex && typeof this.vaultIndex?.onDidChange === "function") {
      this.unsubVaultIndex = this.vaultIndex.onDidChange((event) => {
        this.handleIndexChange(event);
      });
    }

    this.syncInitialState();
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;

    this.unsubFocusBus?.();
    this.unsubFocusBus = null;

    this.unsubVaultIndex?.();
    this.unsubVaultIndex = null;

    const workspace = this.app?.workspace;
    if (workspace && typeof workspace.offref === "function") {
      for (const ref of this.workspaceEventRefs) {
        workspace.offref(ref);
      }
    }
    this.workspaceEventRefs = [];
  }

  setDepth(depth: 1 | 2 | 3): boolean {
    if (depth !== 1 && depth !== 2 && depth !== 3) return false;
    if (this.state.depth === depth) return false;
    this.state.depth = depth;
    this.commitChange();
    return true;
  }

  setShowIncoming(showIncoming: boolean): boolean {
    if (this.state.showIncoming === showIncoming) return false;
    this.state.showIncoming = showIncoming;
    this.commitChange();
    return true;
  }

  setShowOutgoing(showOutgoing: boolean): boolean {
    if (this.state.showOutgoing === showOutgoing) return false;
    this.state.showOutgoing = showOutgoing;
    this.commitChange();
    return true;
  }

  lockFocus(nodeKey?: string | null): boolean {
    const requestedKey = typeof nodeKey === "string" ? nodeKey.trim() : "";
    const resolvedLockKey =
      requestedKey ||
      this.state.centerNodeId ||
      (this.state.centerFilePath ? canonicalFileNodeKey(this.state.centerFilePath) : null);

    if (
      !this.state.followReader &&
      this.state.lockedNodeId === resolvedLockKey &&
      this.state.centerNodeId === resolvedLockKey
    ) {
      return false;
    }

    const prevNodeId = this.state.centerNodeId;
    this.state.followReader = false;
    this.state.lockedNodeId = resolvedLockKey;
    if (resolvedLockKey) {
      this.state.centerNodeId = resolvedLockKey;
      if (requestedKey && requestedKey !== prevNodeId) {
        this.state.centerFilePath = null;
      }
    }
    this.reconcileCenterWithIndex({ allowUnindexedFileFocus: false });
    this.commitChange();
    return true;
  }

  unlockFocus(): boolean {
    const wasLocked = !this.state.followReader || this.state.lockedNodeId !== null;
    this.state.followReader = true;
    this.state.lockedNodeId = null;

    const readerChanged = this.syncToCurrentReaderFocus();
    if (!wasLocked && !readerChanged) {
      return false;
    }

    if (!readerChanged) {
      this.reconcileCenterWithIndex({ allowUnindexedFileFocus: false });
    }
    this.commitChange();
    return true;
  }

  toggleLock(): boolean {
    if (this.state.followReader) {
      return this.lockFocus();
    }
    return this.unlockFocus();
  }

  /**
   * Explicitly switch the Local Graph center to `nodeKey` and resume Reader
   * synchronization so subsequent reader navigation continues following cleanly.
   */
  focusNode(nodeKey: string, filePath?: string | null): boolean {
    const normalized = nodeKey.trim();
    if (!normalized) return false;

    const prevNodeId = this.state.centerNodeId;
    const prevFile = this.state.centerFilePath;
    const prevFollow = this.state.followReader;
    const prevLocked = this.state.lockedNodeId;
    const prevStatus = this.targetStatus;

    const index = this.vaultIndex.index;
    const orgId = extractOrgIdFromNodeKey(normalized);
    let resolvedFile = filePath !== undefined ? filePath : normalized !== prevNodeId ? null : prevFile;
    let resolvedLine = 0;
    let resolvedTitle: string | undefined;

    if (orgId) {
      const res = index.resolveId(orgId);
      if (res.status === "found") {
        resolvedFile = res.node.filePath;
        resolvedLine = res.node.line;
        resolvedTitle = res.node.title;
      } else if (res.status === "duplicate") {
        const match =
          (resolvedFile ? res.nodes.find((n) => n.filePath === resolvedFile) : undefined) ??
          res.nodes[0];
        resolvedFile = match.filePath;
        resolvedLine = match.line;
        resolvedTitle = match.title;
      }
    } else if (normalized.startsWith("file:")) {
      resolvedFile = normalized.slice("file:".length) || resolvedFile;
      resolvedTitle = index.getFileIndexData(resolvedFile ?? "")?.fileTitle ?? resolvedFile ?? undefined;
    }

    this.state.followReader = true;
    this.state.lockedNodeId = null;
    this.state.centerNodeId = normalized;
    this.state.centerFilePath = resolvedFile ?? null;
    this.reconcileCenterWithIndex({ allowUnindexedFileFocus: false });

    const changed =
      this.state.centerNodeId !== prevNodeId ||
      this.state.centerFilePath !== prevFile ||
      this.state.followReader !== prevFollow ||
      this.state.lockedNodeId !== prevLocked ||
      this.targetStatus !== prevStatus ||
      (this.buildLocalGraph !== undefined && this.data === null);

    if (!changed) return false;

    const manualEvent: OrgReaderFocusEvent = {
      filePath: this.state.centerFilePath ?? "",
      line: resolvedLine,
      nodeKey: this.state.centerNodeId,
      orgId,
      title: resolvedTitle,
      reason: "manual",
      timestamp: Date.now(),
    };
    this.lastFocusEvent = manualEvent;

    // Update focusBus current state so future reader events to the previous
    // reader node are not suppressed as duplicates by OrgReaderFocusBus.emit.
    this.suppressBusHandling = true;
    try {
      this.focusBus.emit(manualEvent);
    } finally {
      this.suppressBusHandling = false;
    }

    this.commitChange();
    return true;
  }

  rebuild(): OrgGraphData | null {
    if (this.targetStatus === "no-focus") {
      this.data = null;
    } else if (this.buildLocalGraph) {
      this.data = this.buildLocalGraph({
        index: this.vaultIndex.index,
        state: { ...this.state },
        targetStatus: this.targetStatus,
        filter: this.filter ? { ...this.filter } : undefined,
      });
    }
    this.notifyListeners();
    return this.data;
  }

  shouldRefreshForIndexEvent(
    event?: VaultIndexChangeEvent,
    currentData?: OrgGraphData | null
  ): boolean {
    if (!event || event.kind === "full") {
      return true;
    }

    const data = currentData !== undefined ? currentData : this.data;
    const trackedFiles = new Set<string>();
    const trackedOrgIds = new Set<string>();

    if (this.state.centerFilePath) {
      trackedFiles.add(this.state.centerFilePath);
    }

    for (const key of [this.state.centerNodeId, this.state.lockedNodeId]) {
      const keyFile = extractFilePathFromNodeKey(key);
      if (keyFile) trackedFiles.add(keyFile);
      const keyOrgId = extractOrgIdFromNodeKey(key);
      if (keyOrgId) trackedOrgIds.add(keyOrgId);
    }

    if (event.filePath && trackedFiles.has(event.filePath)) return true;
    if (event.oldPath && trackedFiles.has(event.oldPath)) return true;

    if (setsIntersect(trackedOrgIds, event.affectedNodeIds)) return true;
    if (setsIntersect(trackedOrgIds, event.affectedTargetIds)) return true;

    if (data) {
      for (const node of data.nodes) {
        const nodeFilePath = node.filePath || extractFilePathFromNodeKey(node.id);
        if (
          nodeFilePath &&
          (nodeFilePath === event.filePath || nodeFilePath === event.oldPath)
        ) {
          return true;
        }
        if (node.duplicatePeers) {
          for (const peer of node.duplicatePeers) {
            if (peer.filePath === event.filePath || peer.filePath === event.oldPath) {
              return true;
            }
          }
        }
        const nodeOrgId =
          node.orgId ??
          extractOrgIdFromNodeKey(node.id);
        if (
          nodeOrgId &&
          (event.affectedNodeIds?.has(nodeOrgId) || event.affectedTargetIds?.has(nodeOrgId))
        ) {
          return true;
        }
      }

      for (const edge of data.edges) {
        if (edge.links) {
          for (const link of edge.links) {
            if (link.sourcePath === event.filePath || link.sourcePath === event.oldPath) {
              return true;
            }
            if (
              event.affectedNodeIds?.has(link.targetId) ||
              event.affectedTargetIds?.has(link.targetId)
            ) {
              return true;
            }
          }
        }
      }
    } else if (this.state.centerFilePath) {
      for (const node of this.vaultIndex.index.getNodesInFile(this.state.centerFilePath)) {
        if (
          node.id &&
          (event.affectedNodeIds?.has(node.id) || event.affectedTargetIds?.has(node.id))
        ) {
          return true;
        }
      }
    }

    return false;
  }

  handleIndexChange(
    event?: VaultIndexChangeEvent,
    currentData?: OrgGraphData | null
  ): boolean {
    if (currentData !== undefined) {
      this.data = currentData;
    }

    if (!this.shouldRefreshForIndexEvent(event, currentData)) {
      return false;
    }

    if (event?.kind === "rename" && event.oldPath && event.filePath) {
      if (this.state.centerFilePath === event.oldPath) {
        this.state.centerFilePath = event.filePath;
      }
      const oldFileKey = canonicalFileNodeKey(event.oldPath);
      const nextFileKey = canonicalFileNodeKey(event.filePath);
      if (this.state.centerNodeId === oldFileKey) {
        this.state.centerNodeId = nextFileKey;
      }
      if (this.state.lockedNodeId === oldFileKey) {
        this.state.lockedNodeId = nextFileKey;
      }
    }

    if (event?.kind === "full" && this.state.followReader && this.targetStatus === "no-focus") {
      this.syncToCurrentReaderFocus();
    }

    const removedCenterFile =
      event?.kind === "remove" &&
      Boolean(event.filePath) &&
      event.filePath === this.state.centerFilePath;

    this.reconcileCenterWithIndex({
      allowUnindexedFileFocus: !removedCenterFile,
      treatRemovedFileAsMissing: removedCenterFile,
    });
    this.commitChange();
    return true;
  }

  async openNodeFromGraph(
    nodeKeyOrEntry: string | OrgGraphNode | OrgNodeEntry,
    graphData?: OrgGraphData | null,
    sourceLeaf?: WorkspaceLeaf | null,
    preferredMode?: OrgViewMode
  ): Promise<boolean> {
    const targetEntry = this.resolveOpenTarget(nodeKeyOrEntry, graphData);
    if (!targetEntry) return false;

    await this.vaultIndex.openNode(targetEntry, preferredMode, {
      preserveLeaf: sourceLeaf ?? undefined,
      highlight: true,
    });
    return true;
  }

  private resolveOpenTarget(
    nodeKeyOrEntry: string | OrgGraphNode | OrgNodeEntry,
    graphData?: OrgGraphData | null
  ): OrgNodeEntry | null {
    const index = this.vaultIndex.index;
    const data = graphData !== undefined ? graphData : this.data;

    if (typeof nodeKeyOrEntry === "string") {
      const key = nodeKeyOrEntry.trim();
      if (!key) return null;

      const graphNode =
        data?.nodeMap?.get(key) ?? data?.nodes.find((candidate) => candidate.id === key);
      if (graphNode) {
        const resolved = resolveGraphNodeToOpenTarget(graphNode, index);
        if (resolved) return resolved;
        if (graphNode.kind === "file" && graphNode.filePath && this.hasVaultFile(graphNode.filePath)) {
          return buildFileFallbackEntry(graphNode.filePath, index, graphNode);
        }
        return null;
      }

      if (key.startsWith("file:")) {
        const filePath = key.slice("file:".length);
        if (!filePath) return null;
        if (index.getFileIndexData(filePath) || this.hasVaultFile(filePath)) {
          return buildFileFallbackEntry(filePath, index);
        }
        return null;
      }

      if (key.startsWith("dup:")) {
        const parsed = parseDuplicateNodeKey(key);
        if (!parsed) return null;
        const res = index.resolveId(parsed.orgId);
        if (res.status === "found") return res.node;
        if (res.status === "duplicate") {
          return (
            res.nodes.find((n) => n.filePath === parsed.filePath && n.line === parsed.line) ??
            res.nodes.find((n) => n.filePath === parsed.filePath) ??
            res.nodes[0]
          );
        }
        return null;
      }

      const orgId = extractOrgIdFromNodeKey(key) ?? key;
      const res = index.resolveId(orgId);
      if (res.status === "found") return res.node;
      if (res.status === "duplicate") return res.nodes[0];
      return null;
    }

    if (isOrgGraphNode(nodeKeyOrEntry)) {
      const resolved = resolveGraphNodeToOpenTarget(nodeKeyOrEntry, index);
      if (resolved) return resolved;
      if (
        (nodeKeyOrEntry.kind === "file" || nodeKeyOrEntry.id.startsWith("file:")) &&
        nodeKeyOrEntry.filePath &&
        this.hasVaultFile(nodeKeyOrEntry.filePath)
      ) {
        return buildFileFallbackEntry(nodeKeyOrEntry.filePath, index, nodeKeyOrEntry);
      }
      return null;
    }

    if (nodeKeyOrEntry.id) {
      const res = index.resolveId(nodeKeyOrEntry.id);
      if (res.status === "found") return res.node;
      if (res.status === "duplicate") {
        return (
          res.nodes.find(
            (n) =>
              n.filePath === nodeKeyOrEntry.filePath && n.line === nodeKeyOrEntry.line
          ) ??
          res.nodes.find((n) => n.filePath === nodeKeyOrEntry.filePath) ??
          res.nodes[0]
        );
      }
    }

    return nodeKeyOrEntry;
  }

  private syncInitialState(): void {
    if (!this.state.followReader) {
      this.reconcileCenterWithIndex({ allowUnindexedFileFocus: false });
      if (this.targetStatus !== "no-focus") {
        this.commitChange();
      }
      return;
    }

    if (this.syncToCurrentReaderFocus()) {
      this.commitChange();
      return;
    }

    this.reconcileCenterWithIndex({ allowUnindexedFileFocus: false });
    if (this.targetStatus !== "no-focus") {
      this.commitChange();
    }
  }

  private syncToCurrentReaderFocus(): boolean {
    const currentBusEvent = this.focusBus.getCurrent();
    if (currentBusEvent) {
      return this.applyFocusEvent(currentBusEvent, { notify: false });
    }

    const activeOrgPath = this.resolveWorkspaceActiveOrgPath();
    if (activeOrgPath) {
      const resolved = this.focusBus.resolveFocusForFileLine(
        this.vaultIndex.index,
        activeOrgPath,
        0,
        "file-open"
      );
      return this.applyFocusEvent(resolved, { notify: false });
    }

    return false;
  }

  private resolveWorkspaceActiveOrgPath(): string | null {
    const ws = this.app?.workspace as
      | {
          activeLeaf?: WorkspaceLeaf | null;
          getMostRecentLeaf?: () => WorkspaceLeaf | null;
          getActiveFile?: () => { path?: string } | null;
          getLeavesOfType?: (type: string) => WorkspaceLeaf[];
        }
      | undefined;
    if (!ws) return null;

    const activeViewType = getLeafViewType(ws.activeLeaf);
    if (!activeViewType || !IGNORED_LEAF_VIEW_TYPES.has(activeViewType)) {
      const activeLeafPath = getLeafOrgFilePath(ws.activeLeaf);
      if (activeLeafPath) return activeLeafPath;

      const activeFile = ws.getActiveFile?.();
      if (isOrgPath(activeFile?.path)) return activeFile.path;
    }

    const recentLeaf = ws.getMostRecentLeaf?.();
    const recentType = getLeafViewType(recentLeaf);
    if (!recentType || !IGNORED_LEAF_VIEW_TYPES.has(recentType)) {
      const recentPath = getLeafOrgFilePath(recentLeaf);
      if (recentPath) return recentPath;
    }

    const orgLeaves = ws.getLeavesOfType?.(VIEW_TYPE_ORG) ?? [];
    for (const leaf of orgLeaves) {
      const path = getLeafOrgFilePath(leaf);
      if (path) return path;
    }

    return null;
  }

  private handleFocusEvent(event: OrgReaderFocusEvent): void {
    if (this.suppressBusHandling) return;
    this.applyFocusEvent(event, { notify: true });
  }

  private applyFocusEvent(
    event: OrgReaderFocusEvent,
    options: { notify: boolean }
  ): boolean {
    if (!this.state.followReader && event.reason !== "manual") {
      return false;
    }

    const nextNodeId =
      event.nodeKey ?? (event.orgId ? canonicalOrgNodeKey(event.orgId) : null);
    const nextFile = event.filePath || null;

    const prevCenterNodeId = this.state.centerNodeId;
    const prevFile = this.state.centerFilePath;

    const identityChanged =
      nextNodeId !== prevCenterNodeId || (!nextNodeId && nextFile !== prevFile);

    if (!identityChanged) {
      return false;
    }

    this.state.centerNodeId = nextNodeId;
    this.state.centerFilePath = nextFile;
    if (!this.state.followReader && event.reason === "manual") {
      this.state.lockedNodeId = nextNodeId;
    }
    this.lastFocusEvent = event;

    this.reconcileCenterWithIndex({ allowUnindexedFileFocus: true });

    if (options.notify) {
      this.commitChange();
    }
    return true;
  }

  private handleActiveLeafChange(leaf: WorkspaceLeaf | null | undefined): void {
    if (!this.state.followReader) return;
    if (!leaf) return;

    const viewType = getLeafViewType(leaf);
    if (viewType && IGNORED_LEAF_VIEW_TYPES.has(viewType)) {
      return;
    }

    let filePath = getLeafOrgFilePath(leaf);
    if (!filePath) {
      const viewFilePath = (leaf as { view?: { file?: { path?: string } | null } }).view?.file
        ?.path;
      if (viewFilePath && !isOrgPath(viewFilePath)) {
        return;
      }
      const activeFile = this.app?.workspace?.getActiveFile?.();
      if (isOrgPath(activeFile?.path)) {
        filePath = activeFile.path;
      }
    }

    if (!filePath || filePath === this.state.centerFilePath) {
      return;
    }

    this.followOrgFilePath(filePath);
  }

  private handleFileOpen(file: TFile | { path?: string } | null | undefined): void {
    if (!this.state.followReader) return;
    const filePath = file?.path;
    if (!isOrgPath(filePath)) return;
    if (filePath === this.state.centerFilePath) return;

    this.followOrgFilePath(filePath);
  }

  private followOrgFilePath(filePath: string): void {
    const resolved = this.focusBus.resolveFocusForFileLine(
      this.vaultIndex.index,
      filePath,
      0,
      "file-open"
    );
    this.focusBus.emit(resolved);
    // Ensure local state updates even if focusBus.current already matched `resolved`
    // after a manual focusNode() override.
    this.applyFocusEvent(resolved, { notify: true });
  }

  private reconcileCenterWithIndex(options: {
    allowUnindexedFileFocus: boolean;
    treatRemovedFileAsMissing?: boolean;
  }): void {
    const index = this.vaultIndex.index;
    const centerNodeId = this.state.centerNodeId;
    const centerFilePath = this.state.centerFilePath;

    if (!centerNodeId && !centerFilePath) {
      this.targetStatus = "no-focus";
      return;
    }

    if (centerNodeId?.startsWith("id:")) {
      const orgId = centerNodeId.slice("id:".length).trim();
      const res = orgId ? index.resolveId(orgId) : { status: "missing" as const };
      if (res.status === "found") {
        this.state.centerFilePath = res.node.filePath;
        this.targetStatus = "ok";
        return;
      }
      if (res.status === "duplicate") {
        const sameFile = res.nodes.find((n) => n.filePath === this.state.centerFilePath);
        this.state.centerFilePath = sameFile ? sameFile.filePath : res.nodes[0].filePath;
        this.targetStatus = "ok";
        return;
      }
      this.targetStatus = "target-missing";
      return;
    }

    if (centerNodeId?.startsWith("dup:")) {
      const parsed = parseDuplicateNodeKey(centerNodeId);
      if (!parsed) {
        this.targetStatus = "target-missing";
        return;
      }
      const res = index.resolveId(parsed.orgId);
      if (res.status === "duplicate") {
        const peer =
          res.nodes.find((n) => n.filePath === parsed.filePath && n.line === parsed.line) ??
          res.nodes.find((n) => n.filePath === parsed.filePath);
        if (peer) {
          this.state.centerFilePath = peer.filePath;
          this.targetStatus = "ok";
          return;
        }
      } else if (res.status === "found" && res.node.filePath === parsed.filePath) {
        this.state.centerFilePath = res.node.filePath;
        this.targetStatus = "ok";
        return;
      }
      this.targetStatus = "target-missing";
      return;
    }

    if (centerNodeId?.startsWith("missing:")) {
      const targetId = centerNodeId.slice("missing:".length).trim();
      const res = targetId ? index.resolveId(targetId) : { status: "missing" as const };
      if (res.status === "found") {
        const nextKey = canonicalOrgNodeKey(targetId);
        this.state.centerNodeId = nextKey;
        if (this.state.lockedNodeId === centerNodeId) {
          this.state.lockedNodeId = nextKey;
        }
        this.state.centerFilePath = res.node.filePath;
        this.targetStatus = "ok";
        return;
      }
      if (res.status === "duplicate") {
        const nextKey = canonicalOrgNodeKey(targetId);
        this.state.centerNodeId = nextKey;
        if (this.state.lockedNodeId === centerNodeId) {
          this.state.lockedNodeId = nextKey;
        }
        this.state.centerFilePath = res.nodes[0].filePath;
        this.targetStatus = "ok";
        return;
      }
      this.targetStatus = "target-missing";
      return;
    }

    const resolvedFilePath =
      (centerNodeId?.startsWith("file:") ? centerNodeId.slice("file:".length) : null) ??
      centerFilePath;

    if (!resolvedFilePath) {
      this.targetStatus = "no-focus";
      return;
    }

    this.state.centerFilePath = resolvedFilePath;
    if (options.treatRemovedFileAsMissing) {
      this.targetStatus = "target-missing";
      return;
    }

    if (
      index.getFileIndexData(resolvedFilePath) ||
      this.hasVaultFile(resolvedFilePath) ||
      options.allowUnindexedFileFocus
    ) {
      this.targetStatus = "ok";
      return;
    }

    this.targetStatus = "target-missing";
  }

  private hasVaultFile(filePath: string): boolean {
    const vault = this.app?.vault;
    if (!vault) return false;
    const abstract = vault.getAbstractFileByPath?.(filePath);
    if (abstract instanceof TFile) return true;
    const files = vault.getFiles?.() ?? [];
    return files.some((file) => file.path === filePath);
  }

  private commitChange(): void {
    if (this.targetStatus === "no-focus") {
      this.data = null;
    } else if (this.buildLocalGraph) {
      this.data = this.buildLocalGraph({
        index: this.vaultIndex.index,
        state: { ...this.state },
        targetStatus: this.targetStatus,
        filter: this.filter ? { ...this.filter } : undefined,
      });
    }
    this.notifyListeners();
  }

  private notifyListeners(): void {
    const snapshot = this.getSnapshot();
    this.onChangeCallback?.(snapshot);
    for (const listener of Array.from(this.listeners)) {
      listener(snapshot);
    }
  }
}
