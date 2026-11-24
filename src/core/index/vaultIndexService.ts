import { App, Modal, Notice, TAbstractFile, TFile } from "obsidian";
import type OrgNativePlugin from "../../main";
import { VIEW_TYPE_ORG } from "../../constants";
import { resolveLanguage, translate, type TranslationKey, type UiLanguage } from "../../i18n";
import type { OrgNodeEntry, OrgViewMode } from "../model/types";
import { nodeLabel, type NodeLabelKey } from "../../views/nodes/nodeLabels";
import { formatContextExcerpt, formatNodeBreadcrumb } from "./nodeUtils";
import {
  OrgIdIndex,
  type NodeNotFoundDiagnostic,
  type OrgExtendedDiagnostics,
  type OutdatedFileEntry,
  type VaultFileSnapshot,
} from "./orgIdIndex";

function isOrgFile(file: TAbstractFile): file is TFile {
  return file instanceof TFile && file.extension.toLowerCase() === "org";
}

function getFileStats(file: TFile): { mtime?: number; size?: number } {
  const stat = (file as unknown as { stat?: { mtime?: number; size?: number } }).stat;
  return {
    mtime: typeof stat?.mtime === "number" ? stat.mtime : undefined,
    size: typeof stat?.size === "number" ? stat.size : undefined,
  };
}

export interface VaultIndexServiceOptions {
  debounceMs?: number;
  batchSize?: number;
}

export interface VaultIndexChangeEvent {
  kind: "full" | "upsert" | "rename" | "remove";
  filePath?: string;
  oldPath?: string;
  affectedNodeIds?: Set<string>;
  affectedTargetIds?: Set<string>;
}

interface PendingTimerEntry {
  file: TFile;
  timer: number;
}

export class VaultIndexService {
  readonly index = new OrgIdIndex();
  private listeners = new Set<(event?: VaultIndexChangeEvent) => void>();
  private pendingTimers = new Map<string, PendingTimerEntry>();
  private inFlightTasks = new Set<Promise<void>>();
  private pathGenerations = new Map<string, number>();
  private disposed = false;
  private readonly debounceMs: number;
  private readonly batchSize: number;

  constructor(
    private app: App,
    private plugin: OrgNativePlugin,
    options: VaultIndexServiceOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? 120;
    this.batchSize = Math.max(1, options.batchSize ?? 16);
  }

  onDidChange(listener: (event?: VaultIndexChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(event: VaultIndexChangeEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(event);
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.pendingTimers.values()) {
      window.clearTimeout(entry.timer);
    }
    this.pendingTimers.clear();
    this.listeners.clear();
    this.pathGenerations.clear();
  }

  getUiLanguage(): UiLanguage {
    const direct = (this.plugin as { uiLanguage?: UiLanguage }).uiLanguage;
    if (direct === "en" || direct === "zh") return direct;
    const langSetting = (this.plugin as { settings?: { language?: "auto" | "en" | "zh" } })
      .settings?.language;
    return langSetting ? resolveLanguage(langSetting) : "en";
  }

  translate(key: TranslationKey): string {
    const fn = (this.plugin as { t?: (k: TranslationKey) => string }).t;
    return typeof fn === "function" ? fn.call(this.plugin, key) : translate(this.getUiLanguage(), key);
  }

  label(key: NodeLabelKey): string {
    return nodeLabel(this.getUiLanguage(), key);
  }

  private bumpGeneration(filePath: string): number {
    const next = (this.pathGenerations.get(filePath) ?? 0) + 1;
    this.pathGenerations.set(filePath, next);
    return next;
  }

  private cancelPendingTimer(filePath: string): void {
    const pending = this.pendingTimers.get(filePath);
    if (pending) {
      window.clearTimeout(pending.timer);
      this.pendingTimers.delete(filePath);
    }
  }

  private trackTask(task: Promise<void>): Promise<void> {
    this.inFlightTasks.add(task);
    return task.finally(() => {
      this.inFlightTasks.delete(task);
    });
  }

  start(): void {
    this.plugin.registerEvent(
      this.app.vault.on("create", (file) => {
        if (isOrgFile(file)) {
          void this.indexFile(file);
        }
      })
    );
    this.plugin.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (isOrgFile(file)) {
          this.scheduleFileIndex(file);
        }
      })
    );
    this.plugin.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (isOrgFile(file) || file.path.toLowerCase().endsWith(".org")) {
          this.cancelPendingTimer(file.path);
          this.bumpGeneration(file.path);
          const res = this.index.removeFile(file.path);
          if (res.changed) {
            this.emitChange({
              kind: "remove",
              filePath: file.path,
              affectedNodeIds: res.affectedNodeIds,
              affectedTargetIds: res.affectedTargetIds,
            });
          }
        }
      })
    );
    this.plugin.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const wasOrg = oldPath.toLowerCase().endsWith(".org");
        const nowOrg = isOrgFile(file);
        this.cancelPendingTimer(oldPath);
        this.bumpGeneration(oldPath);

        if (wasOrg && nowOrg) {
          const res = this.index.renameFile(oldPath, file.path);
          if (res.changed) {
            this.emitChange({
              kind: "rename",
              filePath: file.path,
              oldPath,
              affectedNodeIds: res.affectedNodeIds,
              affectedTargetIds: res.affectedTargetIds,
            });
          } else {
            void this.indexFile(file);
          }
        } else if (wasOrg && !nowOrg) {
          const res = this.index.removeFile(oldPath);
          if (res.changed) {
            this.emitChange({
              kind: "remove",
              filePath: oldPath,
              affectedNodeIds: res.affectedNodeIds,
              affectedTargetIds: res.affectedTargetIds,
            });
          }
        } else if (!wasOrg && nowOrg) {
          void this.indexFile(file);
        }
      })
    );
  }

  scheduleFileIndex(file: TFile): void {
    if (this.disposed) return;
    this.index.markFileStale(file.path);
    this.cancelPendingTimer(file.path);

    if (this.debounceMs <= 0) {
      void this.trackTask(this.indexFile(file));
      return;
    }

    const timer = window.setTimeout(() => {
      this.pendingTimers.delete(file.path);
      void this.trackTask(this.indexFile(file));
    }, this.debounceMs);

    this.pendingTimers.set(file.path, { file, timer });
  }

  async flushPendingUpdates(): Promise<void> {
    if (this.pendingTimers.size > 0) {
      const entries = Array.from(this.pendingTimers.values());
      this.pendingTimers.clear();
      for (const entry of entries) {
        window.clearTimeout(entry.timer);
      }
      await Promise.all(entries.map((entry) => this.indexFile(entry.file)));
    }

    if (this.inFlightTasks.size > 0) {
      await Promise.all(Array.from(this.inFlightTasks));
    }
  }

  async initialize(): Promise<void> {
    if (this.disposed) return;
    for (const entry of this.pendingTimers.values()) {
      window.clearTimeout(entry.timer);
    }
    this.pendingTimers.clear();

    this.index.clear();
    const orgFiles = this.app.vault
      .getFiles()
      .filter((file) => file.extension.toLowerCase() === "org");

    for (let i = 0; i < orgFiles.length; i += this.batchSize) {
      if (this.disposed) return;
      const batch = orgFiles.slice(i, i + this.batchSize);
      await Promise.all(
        batch.map(async (file) => {
          if (this.disposed) return;
          const gen = this.pathGenerations.get(file.path) ?? 0;
          try {
            const content = await this.app.vault.cachedRead(file);
            if (this.disposed || (this.pathGenerations.get(file.path) ?? 0) !== gen) return;
            const stats = getFileStats(file);
            this.index.upsertFile(file.path, content, stats);
          } catch (error) {
            console.warn(`Org Native: failed indexing ${file.path}`, error);
          }
        })
      );
    }

    if (this.disposed) return;
    this.index.markInitialized();
    this.emitChange({ kind: "full" });
  }

  async indexFile(file: TFile): Promise<void> {
    if (this.disposed) return;
    this.cancelPendingTimer(file.path);
    const targetPath = file.path;
    const gen = this.pathGenerations.get(targetPath) ?? 0;

    try {
      const content = await this.app.vault.cachedRead(file);
      if (this.disposed || (this.pathGenerations.get(targetPath) ?? 0) !== gen) return;
      const stats = getFileStats(file);
      const res = this.index.upsertFile(targetPath, content, stats);
      if (res.changed) {
        this.emitChange({
          kind: "upsert",
          filePath: targetPath,
          affectedNodeIds: res.affectedNodeIds,
          affectedTargetIds: res.affectedTargetIds,
        });
      }
    } catch (error) {
      console.warn(`Org Native: failed indexing ${targetPath}`, error);
    }
  }

  upsertContent(filePath: string, content: string): void {
    if (this.disposed) return;
    this.cancelPendingTimer(filePath);
    const abstract = this.app.vault.getAbstractFileByPath(filePath);
    const stats = abstract instanceof TFile ? getFileStats(abstract) : undefined;
    const res = this.index.upsertFile(filePath, content, stats);
    if (res.changed) {
      this.emitChange({
        kind: "upsert",
        filePath,
        affectedNodeIds: res.affectedNodeIds,
        affectedTargetIds: res.affectedTargetIds,
      });
    }
  }

  getVaultFileSnapshots(): VaultFileSnapshot[] {
    return this.app.vault
      .getFiles()
      .filter((file) => file.extension.toLowerCase() === "org")
      .map((file) => {
        const stats = getFileStats(file);
        return {
          path: file.path,
          mtime: stats.mtime,
          size: stats.size,
        };
      });
  }

  getExtendedDiagnostics(): OrgExtendedDiagnostics {
    const snapshots = this.getVaultFileSnapshots();
    const pendingPaths = new Set(this.pendingTimers.keys());
    return this.index.getExtendedDiagnostics(snapshots, pendingPaths);
  }

  async refreshOutdatedFiles(options: { removeDeleted?: boolean } = {}): Promise<number> {
    await this.flushPendingUpdates();
    const removeDeleted = options.removeDeleted ?? true;
    const orgFiles = this.app.vault
      .getFiles()
      .filter((file) => file.extension.toLowerCase() === "org");
    const fileMap = new Map(orgFiles.map((f) => [f.path, f]));
    const diag = this.getExtendedDiagnostics();

    let updatedCount = 0;
    const toUpsert: TFile[] = [];

    for (const entry of diag.indexOutdated.outdatedFiles) {
      if (entry.reason === "deleted") {
        if (removeDeleted) {
          const res = this.index.removeFile(entry.filePath);
          if (res.changed) {
            updatedCount++;
            this.emitChange({
              kind: "remove",
              filePath: entry.filePath,
              affectedNodeIds: res.affectedNodeIds,
              affectedTargetIds: res.affectedTargetIds,
            });
          }
        }
        continue;
      }

      const targetFile = fileMap.get(entry.filePath);
      if (targetFile) {
        toUpsert.push(targetFile);
      }
    }

    for (let i = 0; i < toUpsert.length; i += this.batchSize) {
      const batch = toUpsert.slice(i, i + this.batchSize);
      await Promise.all(
        batch.map(async (file) => {
          await this.indexFile(file);
          updatedCount++;
        })
      );
    }

    if (!diag.indexOutdated.initialized) {
      this.index.markInitialized(Date.now(), false);
    }

    return updatedCount;
  }

  async readFileReadOnly(filePath: string): Promise<string | null> {
    const abstract =
      this.app.vault.getAbstractFileByPath(filePath) ??
      this.app.vault.getFiles().find((f) => f.path === filePath);
    if (!(abstract instanceof TFile)) return null;

    try {
      return await this.app.vault.cachedRead(abstract);
    } catch (error) {
      console.warn(`Org Native: failed read-only read of ${filePath}`, error);
      return null;
    }
  }

  recordNodeNotFound(
    id: string,
    reason: NodeNotFoundDiagnostic["reason"],
    context: { filePath?: string; line?: number } = {}
  ): void {
    this.index.recordNodeNotFound(id, reason, context);
  }

  async navigateToId(id: string, preferredMode?: OrgViewMode): Promise<boolean> {
    let res = this.index.resolveId(id);

    if (res.status === "missing") {
      await this.flushPendingUpdates();
      res = this.index.resolveId(id);

      if (res.status === "missing") {
        const diag = this.getExtendedDiagnostics();
        const hasPendingDiskSync = diag.indexOutdated.outdatedFiles.some(
          (entry) => entry.reason !== "deleted"
        );
        if (hasPendingDiskSync) {
          await this.refreshOutdatedFiles({ removeDeleted: false });
          res = this.index.resolveId(id);
        }
      }
    }

    if (res.status === "missing") {
      this.index.recordNodeNotFound(id, "id-not-indexed");
      new Notice(`${this.translate("notice.idNotFound")}${id}`);
      return false;
    }

    let target: OrgNodeEntry;
    if (res.status === "duplicate") {
      const locs = res.nodes.map((n) => `${n.filePath}:${n.line + 1}`).join(", ");
      new Notice(`${this.translate("notice.idDuplicate")}${id} (${locs})`, 6000);
      target = res.nodes[0];
    } else {
      target = res.node;
    }

    await this.openNode(target, preferredMode);
    return true;
  }

  async openNode(node: OrgNodeEntry, preferredMode?: OrgViewMode): Promise<void> {
    const abstract =
      this.app.vault.getAbstractFileByPath(node.filePath) ??
      this.app.vault.getFiles().find((f) => f.path === node.filePath);
    if (!(abstract instanceof TFile)) {
      this.index.recordNodeNotFound(node.id ?? node.filePath, "file-missing", {
        filePath: node.filePath,
        line: node.line,
      });
      this.index.markFileStale(node.filePath);
      new Notice(`${this.translate("notice.idNotFound")}${node.filePath}`);
      return;
    }

    let leaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_ORG)
      .find((candidate) => (candidate.view as { file?: TFile }).file?.path === abstract.path);

    if (!leaf) {
      leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(abstract);
    }

    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const view = leaf.view as {
      getMode?: () => OrgViewMode;
      setMode?: (m: OrgViewMode) => void;
      jumpToLine?: (line: number) => void;
    };

    if (preferredMode && view.getMode?.() !== preferredMode && typeof view.setMode === "function") {
      view.setMode(preferredMode);
    }

    const applyJump = () => view.jumpToLine?.(node.line);
    applyJump();
    window.requestAnimationFrame(applyJump);
  }

  async openLocation(filePath: string, line: number, preferredMode?: OrgViewMode): Promise<void> {
    await this.openNode(
      {
        filePath,
        line,
        endLine: line,
        level: 0,
        title: filePath,
        headingPath: [],
        drawerStartLine: line,
        drawerEndLine: line,
      },
      preferredMode
    );
  }

  openDiagnosticsModal(): void {
    new OrgDiagnosticsModal(this.app, this.plugin, this).open();
  }

  destroy(): void {
    for (const entry of this.pendingTimers.values()) {
      window.clearTimeout(entry.timer);
    }
    this.pendingTimers.clear();
    this.listeners.clear();
  }
}

function outdatedReasonLabel(service: VaultIndexService, reason: OutdatedFileEntry["reason"]): string {
  switch (reason) {
    case "unindexed":
      return service.label("diagnostics.reasonUnindexed");
    case "deleted":
      return service.label("diagnostics.reasonDeleted");
    case "modified":
      return service.label("diagnostics.reasonModified");
    case "stale-marked":
      return service.label("diagnostics.reasonStale");
    case "pending-update":
      return service.label("diagnostics.reasonPending");
  }
}

function notFoundReasonLabel(
  service: VaultIndexService,
  reason: NodeNotFoundDiagnostic["reason"]
): string {
  switch (reason) {
    case "id-not-indexed":
      return service.label("diagnostics.reasonIdNotIndexed");
    case "file-missing":
      return service.label("diagnostics.reasonFileMissing");
    case "node-missing-at-location":
      return service.label("diagnostics.reasonNodeMissingAtLoc");
  }
}

export class OrgDiagnosticsModal extends Modal {
  constructor(
    app: App,
    private plugin: OrgNativePlugin,
    private service: VaultIndexService
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  render(): void {
    const { contentEl } = this;
    contentEl.replaceChildren();
    contentEl.classList.add("org-diagnostics-modal");

    const diag = this.service.getExtendedDiagnostics();

    const titleEl = document.createElement("h2");
    titleEl.textContent = this.service.translate("diagnostics.title");
    contentEl.appendChild(titleEl);

    const summaryRow = document.createElement("div");
    summaryRow.className = "org-diagnostics-summary-row";

    const summaryEl = document.createElement("p");
    summaryEl.className = "org-diagnostics-summary";
    summaryEl.textContent = `${this.service.translate("diagnostics.summaryPrefix")}${
      diag.fileCount
    } · ${this.service.translate("diagnostics.nodesLabel")}${diag.nodeCount}`;
    summaryRow.appendChild(summaryEl);

    const statusBadge = document.createElement("span");
    statusBadge.className = `org-diagnostics-status ${
      diag.indexOutdated.isOutdated ? "is-outdated" : "is-fresh"
    }`;
    statusBadge.textContent = diag.indexOutdated.isOutdated
      ? this.service.label("diagnostics.statusOutdated")
      : this.service.label("diagnostics.statusFresh");
    summaryRow.appendChild(statusBadge);
    contentEl.appendChild(summaryRow);

    const actionsEl = document.createElement("div");
    actionsEl.className = "org-diagnostics-actions";

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "org-diagnostics-btn org-diagnostics-refresh-btn";
    refreshBtn.textContent = this.service.label("diagnostics.refreshOutdated");
    refreshBtn.addEventListener("click", () => {
      void this.service.refreshOutdatedFiles().then(() => this.render());
    });
    actionsEl.appendChild(refreshBtn);

    const rebuildBtn = document.createElement("button");
    rebuildBtn.type = "button";
    rebuildBtn.className = "org-diagnostics-btn org-diagnostics-rebuild-btn";
    rebuildBtn.textContent = this.service.label("diagnostics.rebuildAll");
    rebuildBtn.addEventListener("click", () => {
      void this.service.initialize().then(() => this.render());
    });
    actionsEl.appendChild(rebuildBtn);
    contentEl.appendChild(actionsEl);

    const hasAnyIssue =
      diag.indexOutdated.isOutdated ||
      diag.duplicates.length > 0 ||
      diag.brokenLinks.length > 0 ||
      diag.invalidIdLinks.length > 0 ||
      diag.nodeNotFound.length > 0;

    if (!hasAnyIssue) {
      const emptyEl = document.createElement("p");
      emptyEl.className = "org-diagnostics-empty";
      emptyEl.textContent = this.service.translate("diagnostics.none");
      contentEl.appendChild(emptyEl);
      return;
    }

    if (diag.indexOutdated.isOutdated) {
      const heading = document.createElement("h3");
      heading.textContent = this.service.label("diagnostics.outdatedHeading");
      contentEl.appendChild(heading);

      if (!diag.indexOutdated.initialized) {
        const hint = document.createElement("p");
        hint.className = "org-diagnostics-hint";
        hint.textContent = this.service.label("diagnostics.indexUninitialized");
        contentEl.appendChild(hint);
      }

      if (diag.indexOutdated.outdatedFiles.length > 0) {
        const list = document.createElement("ul");
        list.className = "org-diagnostics-list org-diagnostics-outdated-list";
        for (const item of diag.indexOutdated.outdatedFiles) {
          const li = document.createElement("li");
          const pathSpan = document.createElement("span");
          pathSpan.className = "org-diagnostics-file";
          pathSpan.textContent = item.filePath;
          li.appendChild(pathSpan);

          const reasonSpan = document.createElement("span");
          reasonSpan.className = `org-diagnostics-badge is-outdated is-${item.reason}`;
          reasonSpan.textContent = outdatedReasonLabel(this.service, item.reason);
          li.appendChild(reasonSpan);
          list.appendChild(li);
        }
        contentEl.appendChild(list);
      }
    }

    if (diag.duplicates.length > 0) {
      const heading = document.createElement("h3");
      heading.textContent = this.service.translate("diagnostics.duplicatesHeading");
      contentEl.appendChild(heading);

      const list = document.createElement("ul");
      list.className = "org-diagnostics-list org-diagnostics-duplicates-list";
      for (const dup of diag.duplicates) {
        const li = document.createElement("li");
        const idTitle = document.createElement("strong");
        idTitle.textContent = `ID: ${dup.id}`;
        li.appendChild(idTitle);

        const sub = document.createElement("ul");
        for (const node of dup.nodes) {
          const subLi = document.createElement("li");
          const link = document.createElement("a");
          link.href = "#";
          link.textContent = `${node.filePath}:${node.line + 1} — ${node.title}`;
          link.addEventListener("click", (e) => {
            e.preventDefault();
            this.close();
            void this.service.openNode(node);
          });
          subLi.appendChild(link);

          if (node.headingPath.length > 0) {
            const breadcrumb = document.createElement("div");
            breadcrumb.className = "org-diagnostics-breadcrumb";
            breadcrumb.textContent = formatNodeBreadcrumb(node);
            subLi.appendChild(breadcrumb);
          }
          sub.appendChild(subLi);
        }
        li.appendChild(sub);
        list.appendChild(li);
      }
      contentEl.appendChild(list);
    }

    if (diag.brokenLinks.length > 0) {
      const heading = document.createElement("h3");
      heading.textContent = this.service.translate("diagnostics.brokenHeading");
      contentEl.appendChild(heading);

      const list = document.createElement("ul");
      list.className = "org-diagnostics-list org-diagnostics-broken-list";
      for (const item of diag.brokenLinks) {
        const li = document.createElement("li");
        const relation = item.link.relation ?? "link";

        const link = document.createElement("a");
        link.href = "#";
        link.textContent = `${item.link.sourcePath}:${item.link.line + 1} — ${this.service.translate(
          "diagnostics.missingTarget"
        )}${item.link.targetId}`;
        link.addEventListener("click", (e) => {
          e.preventDefault();
          this.close();
          void this.service.openLocation(item.link.sourcePath, item.link.line);
        });
        li.appendChild(link);

        const badge = document.createElement("span");
        badge.className = `org-diagnostics-relation is-${relation}`;
        badge.textContent = relation;
        li.appendChild(badge);

        if (item.link.context) {
          const ctx = document.createElement("div");
          ctx.className = "org-diagnostics-context";
          ctx.textContent = formatContextExcerpt(item.link.context);
          li.appendChild(ctx);
        }
        list.appendChild(li);
      }
      contentEl.appendChild(list);
    }

    if (diag.invalidIdLinks.length > 0) {
      const heading = document.createElement("h3");
      heading.textContent = this.service.label("diagnostics.invalidHeading");
      contentEl.appendChild(heading);

      const list = document.createElement("ul");
      list.className = "org-diagnostics-list org-diagnostics-invalid-list";
      for (const item of diag.invalidIdLinks) {
        const li = document.createElement("li");
        const link = document.createElement("a");
        link.href = "#";
        link.textContent = `${item.link.sourcePath}:${item.link.line + 1} — [[id:]]`;
        link.addEventListener("click", (e) => {
          e.preventDefault();
          this.close();
          void this.service.openLocation(item.link.sourcePath, item.link.line);
        });
        li.appendChild(link);

        if (item.link.context) {
          const ctx = document.createElement("div");
          ctx.className = "org-diagnostics-context";
          ctx.textContent = formatContextExcerpt(item.link.context);
          li.appendChild(ctx);
        }
        list.appendChild(li);
      }
      contentEl.appendChild(list);
    }

    if (diag.nodeNotFound.length > 0) {
      const heading = document.createElement("h3");
      heading.textContent = this.service.label("diagnostics.notFoundHeading");
      contentEl.appendChild(heading);

      const list = document.createElement("ul");
      list.className = "org-diagnostics-list org-diagnostics-notfound-list";
      for (const item of diag.nodeNotFound) {
        const li = document.createElement("li");

        const idEl = document.createElement("code");
        idEl.className = "org-diagnostics-notfound-id";
        idEl.textContent = item.id;
        li.appendChild(idEl);

        const reasonEl = document.createElement("span");
        reasonEl.className = `org-diagnostics-badge is-notfound is-${item.reason}`;
        reasonEl.textContent = notFoundReasonLabel(this.service, item.reason);
        li.appendChild(reasonEl);

        if (item.filePath) {
          const loc = document.createElement("span");
          loc.className = "org-diagnostics-breadcrumb";
          loc.textContent =
            typeof item.line === "number" ? `${item.filePath}:${item.line + 1}` : item.filePath;
          li.appendChild(loc);
        }

        list.appendChild(li);
      }
      contentEl.appendChild(list);
    }
  }

  onClose(): void {
    this.contentEl.replaceChildren();
  }
}
