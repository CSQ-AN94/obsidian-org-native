import type {
  BrokenIdLinkDiagnostic,
  DuplicateIdDiagnostic,
  OrgIdLink,
  OrgIdStatus,
  OrgIndexDiagnostics,
  OrgNodeEntry,
  OrgSectionNode,
} from "../model/types";
import { parseInline } from "../parser/inline";
import { parseOrgDoc } from "../parser/parse";
import { buildSectionTree } from "../parser/sectionTree";
import { parseOrgIdTarget } from "../../util/links";
import { formatContextExcerpt } from "./nodeUtils";

export interface OrgFileMetadata {
  mtime?: number;
  size?: number;
  indexedAt?: number;
}

export interface OrgLinkSourceMeta {
  sourceHeadingPath: string[];
  sourceNode?: OrgNodeEntry;
  excerpt: string;
}

export interface OrgFileIndexData {
  filePath: string;
  nodes: OrgNodeEntry[];
  links: OrgIdLink[];
  linkMeta?: OrgLinkSourceMeta[];
  invalidLinks?: OrgIdLink[];
  invalidLinkMeta?: OrgLinkSourceMeta[];
  contentHash?: string;
  mtime?: number;
  size?: number;
  indexedAt?: number;
}

export interface OrgBacklinkEntry {
  link: OrgIdLink;
  sourceHeadingPath: string[];
  sourceNode?: OrgNodeEntry;
  targetStatus: OrgIdStatus;
  excerpt: string;
}

export interface OrgFileBacklinkGroup {
  node: OrgNodeEntry;
  status: OrgIdStatus;
  duplicatePeers: OrgNodeEntry[];
  backlinks: OrgBacklinkEntry[];
}

export interface OrgFileLinkIssue {
  kind: "broken" | "duplicate" | "invalid";
  link: OrgIdLink;
  sourceHeadingPath: string[];
  sourceNode?: OrgNodeEntry;
  duplicateNodes?: OrgNodeEntry[];
}

export interface NodeNotFoundDiagnostic {
  id: string;
  reason: "id-not-indexed" | "file-missing" | "node-missing-at-location";
  filePath?: string;
  line?: number;
  detectedAt: number;
}

export interface OutdatedFileEntry {
  filePath: string;
  reason: "unindexed" | "deleted" | "modified" | "stale-marked" | "pending-update";
  indexedMtime?: number;
  currentMtime?: number;
  indexedSize?: number;
  currentSize?: number;
}

export interface IndexOutdatedDiagnostic {
  isOutdated: boolean;
  initialized: boolean;
  lastFullScanAt: number | null;
  lastUpdatedAt: number | null;
  indexVersion: number;
  outdatedFiles: OutdatedFileEntry[];
}

export interface OrgExtendedDiagnostics extends OrgIndexDiagnostics {
  invalidIdLinks: BrokenIdLinkDiagnostic[];
  nodeNotFound: NodeNotFoundDiagnostic[];
  indexOutdated: IndexOutdatedDiagnostic;
}

export interface VaultFileSnapshot {
  path: string;
  mtime?: number;
  size?: number;
}

export interface OrgUpsertResult {
  changed: boolean;
  affectedNodeIds: Set<string>;
  affectedTargetIds: Set<string>;
}

export interface OrgIndexMetrics {
  fullScans: number;
  incrementalUpserts: number;
  skippedUnchanged: number;
  renames: number;
  removals: number;
  backlinkLookups: number;
}

export type IdResolution =
  | { status: "found"; node: OrgNodeEntry }
  | { status: "duplicate"; nodes: OrgNodeEntry[] }
  | { status: "missing" };

interface BacklinkRecord {
  link: OrgIdLink;
  sourceHeadingPath: string[];
  sourceNode?: OrgNodeEntry;
  excerpt: string;
}

const LINK_SKIP_KINDS = new Set([
  "blank",
  "src",
  "example",
  "comment-block",
  "export",
  "comment",
  "fixed-width",
  "math-block",
  "block-start",
  "block-end",
  "drawer-start",
  "drawer-end",
  "drawer",
  "keyword",
  "rule",
  "table-rule",
]);

function computeContentHash(source: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2, 33) ^ code;
  }
  return `${source.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

function compareLinks(a: OrgIdLink, b: OrgIdLink): number {
  return (
    a.sourcePath.localeCompare(b.sourcePath) ||
    a.line - b.line ||
    a.from - b.from
  );
}

/**
 * Parse a single `.org` document into indexed `:ID:` / `:CUSTOM_ID:` nodes
 * and `[[id:...]]` links, ignoring code/example/comment/math blocks.
 */
export function extractOrgFileIndexData(filePath: string, source: string): OrgFileIndexData {
  const doc = parseOrgDoc(source);
  const tree = buildSectionTree(doc);
  const nodes: OrgNodeEntry[] = [];
  const links: OrgIdLink[] = [];
  const linkMeta: OrgLinkSourceMeta[] = [];
  const invalidLinks: OrgIdLink[] = [];
  const invalidLinkMeta: OrgLinkSourceMeta[] = [];
  const lineMeta = new Map<number, { sourceHeadingPath: string[]; sourceNode?: OrgNodeEntry }>();

  let fileNode: OrgNodeEntry | undefined;
  if ((tree.fileId || tree.fileCustomId) && tree.fileDrawerStartLine != null) {
    fileNode = {
      id: tree.fileId,
      customId: tree.fileCustomId,
      filePath,
      line: 0,
      endLine: Math.max(0, doc.lines.length - 1),
      level: 0,
      title: doc.title ?? filePath,
      headingPath: [],
      drawerStartLine: tree.fileDrawerStartLine,
      drawerEndLine: tree.fileDrawerEndLine ?? tree.fileDrawerStartLine,
    };
    nodes.push(fileNode);
  }

  for (const idx of tree.preambleLines) {
    lineMeta.set(idx, { sourceHeadingPath: [], sourceNode: fileNode });
  }

  const visitSection = (
    sec: OrgSectionNode,
    ancestors: string[],
    parentNode?: OrgNodeEntry
  ) => {
    const title = sec.titleText || `Heading (L${sec.headingLineIndex + 1})`;
    const headingPath = [...ancestors, title];
    let currentNode = parentNode;

    if ((sec.id || sec.customId) && sec.drawerStartLine != null) {
      currentNode = {
        id: sec.id,
        customId: sec.customId,
        filePath,
        line: sec.headingLineIndex,
        endLine: sec.endLineIndex,
        level: sec.level,
        title,
        headingPath,
        drawerStartLine: sec.drawerStartLine,
        drawerEndLine: sec.drawerEndLine ?? sec.drawerStartLine,
      };
      nodes.push(currentNode);
    }

    const meta = { sourceHeadingPath: headingPath, sourceNode: currentNode };
    lineMeta.set(sec.headingLineIndex, meta);
    for (const bodyLine of sec.bodyLines) {
      lineMeta.set(bodyLine, meta);
    }

    for (const child of sec.children) visitSection(child, headingPath, currentNode);
  };

  for (const s of tree.sections) visitSection(s, [], fileNode);

  for (const line of doc.lines) {
    const isTranscludeKeyword =
      line.kind === "keyword" && /^\s*#\+TRANSCLUDE:/i.test(line.text);
    if (LINK_SKIP_KINDS.has(line.kind) && !isTranscludeKeyword) continue;

    let text = line.text;
    let base = line.from;
    if (line.kind === "heading" && line.heading) {
      text = line.text.slice(
        line.heading.titleFrom - line.from,
        line.heading.titleTo - line.from
      );
      base = line.heading.titleFrom;
    } else if (line.kind === "list" && line.list) {
      text = line.text.slice(line.list.contentFrom - line.from);
      base = line.list.contentFrom;
    }
    if (!text) continue;

    const enclosing = lineMeta.get(line.index) ?? {
      sourceHeadingPath: [],
      sourceNode: fileNode,
    };
    const excerpt = formatContextExcerpt(line.text);
    const relation: "link" | "transclude" = isTranscludeKeyword ? "transclude" : "link";

    for (const token of parseInline(text, base, { tags: false })) {
      if (token.type !== "link") continue;
      const targetId = parseOrgIdTarget(token.target);
      if (targetId) {
        links.push({
          sourcePath: filePath,
          line: line.index,
          from: token.from,
          to: token.to,
          targetId,
          desc: token.desc,
          relation,
          context: line.text.trim(),
        });
        linkMeta.push({
          sourceHeadingPath: enclosing.sourceHeadingPath,
          sourceNode: enclosing.sourceNode,
          excerpt,
        });
      } else if (/^id:\s*$/i.test(token.target.trim())) {
        invalidLinks.push({
          sourcePath: filePath,
          line: line.index,
          from: token.from,
          to: token.to,
          targetId: "",
          desc: token.desc,
          relation,
          context: line.text.trim(),
        });
        invalidLinkMeta.push({
          sourceHeadingPath: enclosing.sourceHeadingPath,
          sourceNode: enclosing.sourceNode,
          excerpt,
        });
      }
    }
  }

  return {
    filePath,
    nodes,
    links,
    linkMeta,
    invalidLinks,
    invalidLinkMeta,
    contentHash: computeContentHash(source),
  };
}

function compareNodes(a: OrgNodeEntry, b: OrgNodeEntry): number {
  return a.filePath.localeCompare(b.filePath) || a.line - b.line;
}

function scoreNodeMatch(node: OrgNodeEntry, queryLower: string, terms: string[]): number {
  const idLower = (node.id ?? "").toLowerCase();
  const customIdLower = (node.customId ?? "").toLowerCase();
  const titleLower = node.title.toLowerCase();
  const breadcrumbLower = node.headingPath.join(" / ").toLowerCase();
  const fileLower = node.filePath.toLowerCase();

  if (idLower === queryLower || customIdLower === queryLower) return 0;
  if (titleLower === queryLower) return 1;
  if (
    (idLower && idLower.startsWith(queryLower)) ||
    (customIdLower && customIdLower.startsWith(queryLower))
  ) {
    return 2;
  }
  if (titleLower.startsWith(queryLower)) return 3;
  if (titleLower.includes(queryLower)) return 4;
  if (idLower.includes(queryLower) || customIdLower.includes(queryLower)) return 5;
  if (breadcrumbLower.includes(queryLower) || fileLower.includes(queryLower)) return 6;

  if (terms.length > 1) {
    const combined = `${titleLower} ${breadcrumbLower} ${fileLower} ${idLower} ${customIdLower}`;
    if (terms.every((term) => combined.includes(term))) return 7;
  }

  return -1;
}

/**
 * Incremental vault-wide Org ID and link index.
 */
export class OrgIdIndex {
  private files = new Map<string, OrgFileIndexData>();
  private byId = new Map<string, OrgNodeEntry[]>();
  private byCustomId = new Map<string, OrgNodeEntry[]>();
  private byTargetId = new Map<string, BacklinkRecord[]>();
  private staleFiles = new Set<string>();
  private nodeNotFoundMap = new Map<string, NodeNotFoundDiagnostic>();

  private indexVersion = 0;
  private initialized = false;
  private lastFullScanAt: number | null = null;
  private lastUpdatedAt: number | null = null;
  private metrics: OrgIndexMetrics = {
    fullScans: 0,
    incrementalUpserts: 0,
    skippedUnchanged: 0,
    renames: 0,
    removals: 0,
    backlinkLookups: 0,
  };

  clear(): void {
    this.files.clear();
    this.byId.clear();
    this.byCustomId.clear();
    this.byTargetId.clear();
    this.staleFiles.clear();
    this.nodeNotFoundMap.clear();
    this.initialized = false;
    this.lastFullScanAt = null;
    this.lastUpdatedAt = null;
    this.indexVersion++;
  }

  resetMetrics(): void {
    this.metrics = {
      fullScans: 0,
      incrementalUpserts: 0,
      skippedUnchanged: 0,
      renames: 0,
      removals: 0,
      backlinkLookups: 0,
    };
  }

  getMetrics(): OrgIndexMetrics {
    return { ...this.metrics };
  }

  getVersion(): number {
    return this.indexVersion;
  }

  getIndexedFilePaths(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  markInitialized(timestamp = Date.now(), countFullScan = true): void {
    this.initialized = true;
    this.lastFullScanAt = timestamp;
    this.lastUpdatedAt = timestamp;
    if (countFullScan) {
      this.metrics.fullScans++;
    }
  }

  markFileStale(filePath: string): void {
    this.staleFiles.add(filePath);
  }

  clearFileStale(filePath: string): void {
    this.staleFiles.delete(filePath);
  }

  recordNodeNotFound(
    id: string,
    reason: NodeNotFoundDiagnostic["reason"],
    context: { filePath?: string; line?: number } = {}
  ): void {
    const key = `${reason}:${id}:${context.filePath ?? ""}:${context.line ?? ""}`;
    this.nodeNotFoundMap.set(key, {
      id,
      reason,
      filePath: context.filePath,
      line: context.line,
      detectedAt: Date.now(),
    });
  }

  clearNodeNotFound(id?: string): void {
    if (!id) {
      this.nodeNotFoundMap.clear();
      return;
    }
    for (const [key, entry] of this.nodeNotFoundMap.entries()) {
      if (entry.id === id) {
        this.nodeNotFoundMap.delete(key);
      }
    }
  }

  upsertFile(filePath: string, source: string, meta?: OrgFileMetadata): OrgUpsertResult {
    const prev = this.files.get(filePath);
    const nextHash = computeContentHash(source);
    const now = meta?.indexedAt ?? Date.now();

    if (prev && prev.contentHash === nextHash) {
      if (meta?.mtime !== undefined) prev.mtime = meta.mtime;
      if (meta?.size !== undefined) prev.size = meta.size;
      prev.indexedAt = now;
      this.staleFiles.delete(filePath);
      this.metrics.skippedUnchanged++;
      return {
        changed: false,
        affectedNodeIds: new Set(),
        affectedTargetIds: new Set(),
      };
    }

    const affectedNodeIds = new Set<string>();
    const affectedTargetIds = new Set<string>();

    if (prev) {
      for (const node of prev.nodes) {
        if (node.id) affectedNodeIds.add(node.id);
      }
      for (const link of prev.links) {
        affectedTargetIds.add(link.targetId);
      }
      this.unindexNodes(prev.nodes);
      this.unindexLinks(prev.links);
    }

    const data = extractOrgFileIndexData(filePath, source);
    data.mtime = meta?.mtime;
    data.size = meta?.size;
    data.indexedAt = now;

    for (const node of data.nodes) {
      if (node.id) {
        affectedNodeIds.add(node.id);
        this.clearNodeNotFound(node.id);
      }
    }
    for (const link of data.links) {
      affectedTargetIds.add(link.targetId);
    }

    this.files.set(filePath, data);
    this.indexNodes(data.nodes);
    this.indexLinks(data);
    this.staleFiles.delete(filePath);
    this.lastUpdatedAt = now;
    this.indexVersion++;
    this.metrics.incrementalUpserts++;

    return {
      changed: true,
      affectedNodeIds,
      affectedTargetIds,
    };
  }

  removeFile(filePath: string): OrgUpsertResult {
    this.staleFiles.delete(filePath);
    const prev = this.files.get(filePath);
    if (!prev) {
      return {
        changed: false,
        affectedNodeIds: new Set(),
        affectedTargetIds: new Set(),
      };
    }

    const affectedNodeIds = new Set<string>();
    const affectedTargetIds = new Set<string>();
    for (const node of prev.nodes) {
      if (node.id) affectedNodeIds.add(node.id);
    }
    for (const link of prev.links) {
      affectedTargetIds.add(link.targetId);
    }

    this.unindexNodes(prev.nodes);
    this.unindexLinks(prev.links);
    this.files.delete(filePath);
    this.lastUpdatedAt = Date.now();
    this.indexVersion++;
    this.metrics.removals++;

    return {
      changed: true,
      affectedNodeIds,
      affectedTargetIds,
    };
  }

  renameFile(oldPath: string, newPath: string): OrgUpsertResult {
    if (oldPath === newPath) {
      return {
        changed: false,
        affectedNodeIds: new Set(),
        affectedTargetIds: new Set(),
      };
    }
    const prev = this.files.get(oldPath);
    if (!prev) {
      return {
        changed: false,
        affectedNodeIds: new Set(),
        affectedTargetIds: new Set(),
      };
    }

    const affectedNodeIds = new Set<string>();
    const affectedTargetIds = new Set<string>();

    this.unindexNodes(prev.nodes);
    this.unindexLinks(prev.links);
    this.files.delete(oldPath);

    const nodeMap = new Map<OrgNodeEntry, OrgNodeEntry>();
    const newNodes = prev.nodes.map((node) => {
      const nextNode: OrgNodeEntry = {
        ...node,
        filePath: newPath,
        title: node.level === 0 && node.title === oldPath ? newPath : node.title,
      };
      nodeMap.set(node, nextNode);
      if (nextNode.id) affectedNodeIds.add(nextNode.id);
      return nextNode;
    });

    const newLinks = prev.links.map((link) => {
      affectedTargetIds.add(link.targetId);
      return { ...link, sourcePath: newPath };
    });

    const newLinkMeta = prev.linkMeta?.map((meta) => ({
      ...meta,
      sourceNode: meta.sourceNode ? (nodeMap.get(meta.sourceNode) ?? meta.sourceNode) : undefined,
    }));

    const newInvalidLinks = prev.invalidLinks?.map((link) => ({
      ...link,
      sourcePath: newPath,
    }));

    const newInvalidLinkMeta = prev.invalidLinkMeta?.map((meta) => ({
      ...meta,
      sourceNode: meta.sourceNode ? (nodeMap.get(meta.sourceNode) ?? meta.sourceNode) : undefined,
    }));

    const updated: OrgFileIndexData = {
      filePath: newPath,
      nodes: newNodes,
      links: newLinks,
      linkMeta: newLinkMeta,
      invalidLinks: newInvalidLinks,
      invalidLinkMeta: newInvalidLinkMeta,
      contentHash: prev.contentHash,
      mtime: prev.mtime,
      size: prev.size,
      indexedAt: Date.now(),
    };

    if (this.staleFiles.delete(oldPath)) {
      this.staleFiles.add(newPath);
    }
    for (const [key, entry] of this.nodeNotFoundMap.entries()) {
      if (entry.filePath === oldPath) {
        this.nodeNotFoundMap.set(key, { ...entry, filePath: newPath });
      }
    }

    this.files.set(newPath, updated);
    this.indexNodes(updated.nodes);
    this.indexLinks(updated);
    this.lastUpdatedAt = Date.now();
    this.indexVersion++;
    this.metrics.renames++;

    return {
      changed: true,
      affectedNodeIds,
      affectedTargetIds,
    };
  }

  resolveId(id: string): IdResolution {
    const key = id.trim();
    const matches = this.byId.get(key);
    if (!matches || matches.length === 0) return { status: "missing" };
    if (matches.length === 1) return { status: "found", node: matches[0] };
    return { status: "duplicate", nodes: [...matches].sort(compareNodes) };
  }

  resolveCustomId(customId: string, preferredFilePath?: string): IdResolution {
    const key = customId.trim();
    const matches = this.byCustomId.get(key);
    if (!matches || matches.length === 0) return { status: "missing" };
    if (preferredFilePath) {
      const local = matches.filter((n) => n.filePath === preferredFilePath);
      if (local.length === 1) return { status: "found", node: local[0] };
      if (local.length > 1) return { status: "duplicate", nodes: [...local].sort(compareNodes) };
    }
    if (matches.length === 1) return { status: "found", node: matches[0] };
    return { status: "duplicate", nodes: [...matches].sort(compareNodes) };
  }

  getNodeStatus(id: string): OrgIdStatus {
    const res = this.resolveId(id);
    return res.status;
  }

  getBacklinks(id: string): OrgIdLink[] {
    this.metrics.backlinkLookups++;
    const key = id.trim();
    const records = this.byTargetId.get(key);
    if (!records || records.length === 0) return [];
    return records.map((r) => r.link).sort(compareLinks);
  }

  getBacklinkEntries(id: string): OrgBacklinkEntry[] {
    this.metrics.backlinkLookups++;
    const key = id.trim();
    const records = this.byTargetId.get(key);
    if (!records || records.length === 0) return [];
    const targetStatus = this.getNodeStatus(key);
    return [...records]
      .sort((a, b) => compareLinks(a.link, b.link))
      .map((rec) => ({
        link: rec.link,
        sourceHeadingPath: rec.sourceHeadingPath,
        sourceNode: rec.sourceNode,
        targetStatus,
        excerpt: rec.excerpt,
      }));
  }

  getNodesInFile(filePath: string): OrgNodeEntry[] {
    const data = this.files.get(filePath);
    if (!data) return [];
    return [...data.nodes].sort((a, b) => a.line - b.line);
  }

  getFileOutgoingTargetIds(filePath: string): Set<string> {
    const data = this.files.get(filePath);
    const out = new Set<string>();
    if (!data) return out;
    for (const link of data.links) {
      out.add(link.targetId);
    }
    return out;
  }

  getBacklinksForFile(filePath: string): Array<{ node: OrgNodeEntry; backlinks: OrgIdLink[] }> {
    return this.getNodesInFile(filePath)
      .filter((node) => Boolean(node.id))
      .map((node) => ({
        node,
        backlinks: this.getBacklinks(node.id!),
      }));
  }

  getFileBacklinkGroups(filePath: string): OrgFileBacklinkGroup[] {
    return this.getNodesInFile(filePath)
      .filter((node) => Boolean(node.id))
      .map((node) => {
        const id = node.id!;
        const res = this.resolveId(id);
        const status: OrgIdStatus = res.status;
        const duplicatePeers =
          res.status === "duplicate" ? res.nodes.filter((peer) => peer !== node) : [];
        return {
          node,
          status,
          duplicatePeers,
          backlinks: this.getBacklinkEntries(id),
        };
      });
  }

  getFileLinkIssues(filePath: string): OrgFileLinkIssue[] {
    const data = this.files.get(filePath);
    if (!data) return [];

    const issues: OrgFileLinkIssue[] = [];
    data.links.forEach((link, idx) => {
      const meta = data.linkMeta?.[idx];
      const res = this.resolveId(link.targetId);
      if (res.status === "missing") {
        issues.push({
          kind: "broken",
          link,
          sourceHeadingPath: meta?.sourceHeadingPath ?? [],
          sourceNode: meta?.sourceNode,
        });
      } else if (res.status === "duplicate") {
        issues.push({
          kind: "duplicate",
          link,
          sourceHeadingPath: meta?.sourceHeadingPath ?? [],
          sourceNode: meta?.sourceNode,
          duplicateNodes: res.nodes,
        });
      }
    });

    data.invalidLinks?.forEach((link, idx) => {
      const meta = data.invalidLinkMeta?.[idx];
      issues.push({
        kind: "invalid",
        link,
        sourceHeadingPath: meta?.sourceHeadingPath ?? [],
        sourceNode: meta?.sourceNode,
      });
    });

    return issues.sort((a, b) => compareLinks(a.link, b.link));
  }

  searchNodes(query: string): OrgNodeEntry[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.getAllNodes();

    const terms = normalized.split(/\s+/).filter(Boolean);
    const matches: Array<{ node: OrgNodeEntry; rank: number }> = [];

    for (const data of this.files.values()) {
      for (const node of data.nodes) {
        const rank = scoreNodeMatch(node, normalized, terms);
        if (rank >= 0) {
          matches.push({ node, rank });
        }
      }
    }

    matches.sort((a, b) => a.rank - b.rank || compareNodes(a.node, b.node));
    return matches.map((entry) => entry.node);
  }

  getDuplicateIds(): DuplicateIdDiagnostic[] {
    const duplicates: DuplicateIdDiagnostic[] = [];
    for (const [id, nodes] of this.byId.entries()) {
      if (nodes.length > 1) {
        duplicates.push({ id, nodes: [...nodes].sort(compareNodes) });
      }
    }
    return duplicates.sort((a, b) => a.id.localeCompare(b.id));
  }

  getBrokenIdLinks(): BrokenIdLinkDiagnostic[] {
    const broken: BrokenIdLinkDiagnostic[] = [];
    for (const data of this.files.values()) {
      for (const link of data.links) {
        if (!this.byId.has(link.targetId)) {
          broken.push({ link });
        }
      }
    }
    return broken.sort((a, b) => compareLinks(a.link, b.link));
  }

  getInvalidIdLinks(): BrokenIdLinkDiagnostic[] {
    const invalid: BrokenIdLinkDiagnostic[] = [];
    for (const data of this.files.values()) {
      for (const link of data.invalidLinks ?? []) {
        invalid.push({ link });
      }
    }
    return invalid.sort((a, b) => compareLinks(a.link, b.link));
  }

  getNodeNotFoundDiagnostics(): NodeNotFoundDiagnostic[] {
    return Array.from(this.nodeNotFoundMap.values()).sort(
      (a, b) => b.detectedAt - a.detectedAt || a.id.localeCompare(b.id)
    );
  }

  getOutdatedFiles(
    vaultFiles?: VaultFileSnapshot[],
    pendingPaths?: ReadonlySet<string>
  ): OutdatedFileEntry[] {
    const byPath = new Map<string, OutdatedFileEntry>();

    if (vaultFiles) {
      const vaultMap = new Map<string, VaultFileSnapshot>();
      for (const snap of vaultFiles) {
        if (snap.path.toLowerCase().endsWith(".org")) {
          vaultMap.set(snap.path, snap);
        }
      }

      for (const [filePath, snap] of vaultMap.entries()) {
        const indexed = this.files.get(filePath);
        if (!indexed) {
          byPath.set(filePath, {
            filePath,
            reason: pendingPaths?.has(filePath) ? "pending-update" : "unindexed",
            currentMtime: snap.mtime,
            currentSize: snap.size,
          });
          continue;
        }

        if (pendingPaths?.has(filePath)) {
          byPath.set(filePath, {
            filePath,
            reason: "pending-update",
            indexedMtime: indexed.mtime,
            currentMtime: snap.mtime,
            indexedSize: indexed.size,
            currentSize: snap.size,
          });
          continue;
        }

        if (this.staleFiles.has(filePath)) {
          byPath.set(filePath, {
            filePath,
            reason: "stale-marked",
            indexedMtime: indexed.mtime,
            currentMtime: snap.mtime,
            indexedSize: indexed.size,
            currentSize: snap.size,
          });
          continue;
        }

        const mtimeMismatch =
          snap.mtime !== undefined &&
          indexed.mtime !== undefined &&
          snap.mtime !== indexed.mtime;
        const sizeMismatch =
          snap.size !== undefined &&
          indexed.size !== undefined &&
          snap.size !== indexed.size;

        if (mtimeMismatch || sizeMismatch) {
          byPath.set(filePath, {
            filePath,
            reason: "modified",
            indexedMtime: indexed.mtime,
            currentMtime: snap.mtime,
            indexedSize: indexed.size,
            currentSize: snap.size,
          });
        }
      }

      for (const filePath of this.files.keys()) {
        if (!vaultMap.has(filePath)) {
          byPath.set(filePath, {
            filePath,
            reason: "deleted",
          });
        }
      }
    } else {
      for (const filePath of this.staleFiles) {
        byPath.set(filePath, { filePath, reason: "stale-marked" });
      }
      if (pendingPaths) {
        for (const filePath of pendingPaths) {
          byPath.set(filePath, { filePath, reason: "pending-update" });
        }
      }
    }

    return Array.from(byPath.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  getAllNodes(): OrgNodeEntry[] {
    const all: OrgNodeEntry[] = [];
    for (const data of this.files.values()) {
      all.push(...data.nodes);
    }
    return all.sort(compareNodes);
  }

  getDiagnostics(): OrgIndexDiagnostics {
    let nodeCount = 0;
    for (const data of this.files.values()) nodeCount += data.nodes.length;
    return {
      fileCount: this.files.size,
      nodeCount,
      duplicates: this.getDuplicateIds(),
      brokenLinks: this.getBrokenIdLinks(),
    };
  }

  getExtendedDiagnostics(
    vaultFiles?: VaultFileSnapshot[],
    pendingPaths?: ReadonlySet<string>
  ): OrgExtendedDiagnostics {
    const base = this.getDiagnostics();
    const outdatedFiles = this.getOutdatedFiles(vaultFiles, pendingPaths);
    return {
      ...base,
      invalidIdLinks: this.getInvalidIdLinks(),
      nodeNotFound: this.getNodeNotFoundDiagnostics(),
      indexOutdated: {
        isOutdated: !this.initialized || outdatedFiles.length > 0,
        initialized: this.initialized,
        lastFullScanAt: this.lastFullScanAt,
        lastUpdatedAt: this.lastUpdatedAt,
        indexVersion: this.indexVersion,
        outdatedFiles,
      },
    };
  }

  private indexNodes(nodes: OrgNodeEntry[]): void {
    for (const node of nodes) {
      if (node.id) {
        const list = this.byId.get(node.id) ?? [];
        list.push(node);
        this.byId.set(node.id, list);
      }
      if (node.customId) {
        const list = this.byCustomId.get(node.customId) ?? [];
        list.push(node);
        this.byCustomId.set(node.customId, list);
      }
    }
  }

  private unindexNodes(nodes: OrgNodeEntry[]): void {
    for (const node of nodes) {
      if (node.id) {
        const list = this.byId.get(node.id);
        if (list) {
          const next = list.filter((n) => n !== node);
          if (next.length === 0) this.byId.delete(node.id);
          else this.byId.set(node.id, next);
        }
      }
      if (node.customId) {
        const list = this.byCustomId.get(node.customId);
        if (list) {
          const next = list.filter((n) => n !== node);
          if (next.length === 0) this.byCustomId.delete(node.customId);
          else this.byCustomId.set(node.customId, next);
        }
      }
    }
  }

  private indexLinks(data: OrgFileIndexData): void {
    data.links.forEach((link, idx) => {
      const meta = data.linkMeta?.[idx];
      const rec: BacklinkRecord = {
        link,
        sourceHeadingPath: meta?.sourceHeadingPath ?? [],
        sourceNode: meta?.sourceNode,
        excerpt: meta?.excerpt ?? formatContextExcerpt(link.context ?? ""),
      };
      const list = this.byTargetId.get(link.targetId) ?? [];
      list.push(rec);
      this.byTargetId.set(link.targetId, list);
    });
  }

  private unindexLinks(links: OrgIdLink[]): void {
    if (links.length === 0) return;
    const linkSet = new Set(links);
    const affectedTargets = new Set<string>();
    for (const link of links) affectedTargets.add(link.targetId);

    for (const targetId of affectedTargets) {
      const list = this.byTargetId.get(targetId);
      if (!list) continue;
      const next = list.filter((rec) => !linkSet.has(rec.link));
      if (next.length === 0) this.byTargetId.delete(targetId);
      else this.byTargetId.set(targetId, next);
    }
  }
}
