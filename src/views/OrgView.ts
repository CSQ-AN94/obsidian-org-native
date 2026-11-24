import { Notice, setIcon, TextFileView, WorkspaceLeaf } from "obsidian";
import { Compartment, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type OrgNativePlugin from "../main";
import { VIEW_TYPE_ORG } from "../constants";
import type { FoldLevelMode, OrgViewMode } from "../core/model/types";
import { FileSyncGuard } from "../core/safety/fileSyncGuard";
import type { LinkCallbacks } from "../util/links";
import {
  createOrgEditorState,
  cycleTodo as cycleTodoCommand,
  ExternalDocChange,
  livePreviewExtension,
} from "./editor/orgEditor";
import { refreshOrgPreview } from "./editor/livePreview";
import {
  cycleEditorFold,
  setEditorFoldLevel,
  toggleFoldAtCursor,
  unfoldPos,
} from "./editor/fold";
import {
  getReadingFoldSnapshot,
  restoreReadingFoldSnapshot,
  revealReadingLine,
  setReadingFoldLevel,
  type ReadingFoldSnapshot,
} from "./reading/folding";
import { renderOrgPreview } from "./reading/render";
import { hydrateTransclusionsInDom, TransclusionRefreshController } from "./transclusion";

export class OrgView extends TextFileView {
  editor: EditorView | null = null;
  readonly syncGuard = new FileSyncGuard();
  private mode: OrgViewMode;
  private conflictBannerEl: HTMLElement | null = null;
  private editorHost: HTMLElement | null = null;
  private previewHost: HTMLElement | null = null;
  private modeAction: HTMLElement | null = null;
  private sourceAction: HTMLElement | null = null;
  private livePreviewCompartment = new Compartment();
  private suppressChange = false;
  private pendingPreviewScrollRatio: number | null = null;
  private outlineTimer: number | null = null;
  private savedReadingFolds: ReadingFoldSnapshot | null = null;
  private unsubscribeIndex: (() => void) | null = null;
  private disposeHoverPreview: (() => void) | null = null;
  private transclusionRefresh = new TransclusionRefreshController(() => {
    if (this.mode === "reading") this.renderPreview(true);
  });
  private isRefreshingFromIndex = false;
  private lineEnding: "\r\n" | "\n" = "\n";

  constructor(leaf: WorkspaceLeaf, private plugin: OrgNativePlugin) {
    super(leaf);
    this.mode = plugin.settings.defaultMode;
    const baseRequestSave = this.requestSave?.bind(this);
    this.requestSave = () => {
      if (!this.syncGuard.isDirty() || this.syncGuard.isConflicted()) return;
      baseRequestSave?.();
    };
  }

  getViewType(): string {
    return VIEW_TYPE_ORG;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Org";
  }

  getIcon(): string {
    return "file-text";
  }

  getMode(): OrgViewMode {
    return this.mode;
  }

  protected async onOpen(): Promise<void> {
    this.contentEl.addClasses([
      "org-view",
      "markdown-source-view",
      "cm-s-obsidian",
      "mod-cm6",
      "node-insert-event",
      "is-readable-line-width",
      "is-live-preview",
    ]);
    this.conflictBannerEl = this.contentEl.createDiv({
      cls: "org-conflict-banner is-hidden",
    });
    this.editorHost = this.contentEl.createDiv({ cls: "org-editor-host" });
    this.previewHost = this.contentEl.createDiv({ cls: "org-preview-host" });
    this.createEditor();
    this.updateOutline(true);
    this.sourceAction = this.addAction(
      "code-2",
      this.plugin.t("action.sourceMode"),
      () => this.setMode(this.mode === "source" ? "live" : "source")
    );
    this.modeAction = this.addAction(
      "pencil",
      this.plugin.t("action.livePreview"),
      () => this.toggleMode()
    );
    this.updateModeAction();
    this.registerDomEvent(this.contentEl, "click", (event) => {
      if (this.mode !== "reading" && this.editor && event.target === this.editorHost) {
        this.editor.focus();
      }
    });
    if (this.plugin.vaultIndex) {
      this.unsubscribeIndex = this.plugin.vaultIndex.onDidChange(() => {
        if (this.isRefreshingFromIndex) return;
        if (this.mode === "reading") {
          this.renderPreview(true);
        } else if (this.mode === "live" && this.editor) {
          this.editor.dispatch({ effects: refreshOrgPreview.of(null) });
        }
      });
    }
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path === this.file?.path) return;
        this.transclusionRefresh.notifyFileChanged(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!this.transclusionRefresh.notifyFileChanged(oldPath)) {
          this.transclusionRefresh.notifyFileChanged(file.path);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.transclusionRefresh.notifyFileChanged(file.path);
      })
    );
  }

  protected async onClose(): Promise<void> {
    if (this.outlineTimer != null) {
      window.clearTimeout(this.outlineTimer);
      this.outlineTimer = null;
    }
    this.disposeHoverPreview?.();
    this.disposeHoverPreview = null;
    this.transclusionRefresh.dispose();
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = null;
    if (this.syncGuard.shouldSaveOnClose()) {
      await this.save();
    }
    this.editor?.destroy();
    this.editor = null;
  }

  private buildLinkCallbacks(): LinkCallbacks {
    return {
      onOpenId: (id) => {
        void this.plugin.vaultIndex?.navigateToId(id, this.mode);
      },
      onOpenCustomId: (customId) => this.jumpToCustomId(customId),
      onOpenHeading: (headingTitle) => this.jumpToHeadingTitle(headingTitle),
    };
  }

  private resolveIdStatus = (id: string) => {
    return this.plugin.vaultIndex?.index.getNodeStatus(id) ?? "missing";
  };

  private createEditor(): void {
    if (!this.editorHost) return;
    const state = createOrgEditorState(this.data ?? "", {
      app: this.app,
      sourcePath: this.sourcePath(),
      displayTitle: this.displayTitle(),
      settings: this.plugin.settings,
      mode: this.mode,
      livePreviewCompartment: this.livePreviewCompartment,
      linkCallbacks: this.buildLinkCallbacks(),
      resolveIdStatus: this.resolveIdStatus,
      onDocChanged: () => this.handleDocChanged(),
    });
    this.editor = new EditorView({ state, parent: this.editorHost });
    this.applyMode(false);
  }

  private sourcePath(): string {
    return this.file?.path ?? "";
  }

  private displayTitle(): string {
    return this.file?.basename ?? "Org";
  }

  private applyLineEnding(text: string): string {
    return this.lineEnding === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
  }

  private handleDocChanged(): void {
    if (this.suppressChange) return;
    const current = this.getViewData();
    this.data = current;
    const editResult = this.syncGuard.onLocalEdit(current);
    if (editResult.shouldSave) {
      this.requestSave();
    }
    this.updateOutline();
    if (this.mode === "reading") this.renderPreview(true);
  }

  private updateOutline(immediate = false): void {
    if (!this.file) return;
    const file = this.file;
    const run = () => {
      this.outlineTimer = null;
      const content = this.getViewData();
      this.plugin.outline?.updateFile(file, content);
      this.isRefreshingFromIndex = true;
      try {
        this.plugin.vaultIndex?.upsertContent(file.path, content);
      } finally {
        this.isRefreshingFromIndex = false;
      }
    };
    if (immediate) {
      if (this.outlineTimer != null) window.clearTimeout(this.outlineTimer);
      run();
      return;
    }
    if (this.outlineTimer != null) window.clearTimeout(this.outlineTimer);
    this.outlineTimer = window.setTimeout(run, 180);
  }

  private replaceEditorFull(text: string): void {
    if (!this.editor) return;
    this.suppressChange = true;
    this.editor.dispatch({
      changes: { from: 0, to: this.editor.state.doc.length, insert: text },
      selection: { anchor: 0 },
      annotations: [ExternalDocChange.of(true), Transaction.addToHistory.of(false)],
      scrollIntoView: false,
    });
    this.suppressChange = false;
  }

  private replaceEditorMinimal(text: string): void {
    if (!this.editor) return;
    const old = this.editor.state.doc.toString();
    if (old === text) return;
    let a = 0;
    while (a < old.length && a < text.length && old[a] === text[a]) a++;
    let b = 0;
    while (
      b < old.length - a &&
      b < text.length - a &&
      old[old.length - 1 - b] === text[text.length - 1 - b]
    ) {
      b++;
    }
    this.suppressChange = true;
    this.editor.dispatch({
      changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) },
      annotations: [ExternalDocChange.of(true), Transaction.addToHistory.of(false)],
    });
    this.suppressChange = false;
  }

  private showConflictBanner(): void {
    if (!this.conflictBannerEl) return;
    this.conflictBannerEl.empty();
    this.conflictBannerEl.toggleClass("is-hidden", false);

    const msg = this.conflictBannerEl.createDiv({ cls: "org-conflict-message" });
    msg.createEl("strong", { text: this.plugin.t("conflict.title") });
    msg.createEl("span", { text: ` — ${this.plugin.t("conflict.desc")}` });

    const actions = this.conflictBannerEl.createDiv({ cls: "org-conflict-actions" });

    const reloadBtn = actions.createEl("button", {
      cls: "org-conflict-btn org-conflict-btn-reload",
      text: this.plugin.t("conflict.reloadDisk"),
    });
    reloadBtn.type = "button";
    reloadBtn.addEventListener("click", () => this.acceptDiskContent());

    const keepBtn = actions.createEl("button", {
      cls: "org-conflict-btn org-conflict-btn-keep",
      text: this.plugin.t("conflict.keepLocal"),
    });
    keepBtn.type = "button";
    keepBtn.addEventListener("click", () => {
      void this.keepLocalAndSave();
    });

    const copyBtn = actions.createEl("button", {
      cls: "org-conflict-btn org-conflict-btn-copy",
      text: this.plugin.t("conflict.saveCopy"),
    });
    copyBtn.type = "button";
    copyBtn.addEventListener("click", () => {
      void this.saveConflictCopyAndReload();
    });
  }

  private hideConflictBanner(): void {
    if (!this.conflictBannerEl) return;
    this.conflictBannerEl.empty();
    this.conflictBannerEl.toggleClass("is-hidden", true);
  }

  acceptDiskContent(): boolean {
    const disk = this.syncGuard.resolveAcceptDisk();
    if (disk === null) return false;
    this.lineEnding = disk.includes("\r\n") ? "\r\n" : "\n";
    this.data = disk;
    this.hideConflictBanner();
    this.replaceEditorMinimal(disk.replace(/\r\n/g, "\n"));
    this.updateOutline(true);
    if (this.mode === "reading") this.renderPreview(true);
    return true;
  }

  async keepLocalAndSave(): Promise<void> {
    this.syncGuard.resolveKeepLocal();
    this.hideConflictBanner();
    await this.save();
  }

  async saveConflictCopyAndReload(): Promise<string | null> {
    if (!this.file) return null;
    const localContent = this.getViewData();
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "-",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    const slash = this.file.path.lastIndexOf("/");
    const dir = slash >= 0 ? this.file.path.slice(0, slash + 1) : "";
    let candidate = `${dir}${this.file.basename}.conflict-${stamp}.org`;
    for (let n = 1; this.app.vault.getAbstractFileByPath(candidate); n++) {
      candidate = `${dir}${this.file.basename}.conflict-${stamp}-${n}.org`;
    }
    await this.app.vault.create(candidate, localContent);
    new Notice(`Saved local conflict copy: ${candidate}`);
    this.acceptDiskContent();
    return candidate;
  }

  async save(clear?: boolean): Promise<void> {
    const prep = this.syncGuard.prepareSave(this.getViewData());
    if (!prep.allowSave) return;
    this.data = prep.content;
    await super.save(clear);
  }

  setViewData(data: string, clear: boolean): void {
    const currentEditorText = this.getViewData();
    const result = this.syncGuard.onDiskUpdate(data, currentEditorText, clear);

    switch (result.action) {
      case "replace-editor":
        this.lineEnding = result.content.includes("\r\n") ? "\r\n" : "\n";
        this.data = result.content;
        this.savedReadingFolds = null;
        this.mode = this.plugin.settings.defaultMode;
        this.hideConflictBanner();
        this.replaceEditorFull(result.content.replace(/\r\n/g, "\n"));
        this.updateOutline(true);
        this.applyMode(false);
        break;
      case "reload-external":
        this.lineEnding = result.content.includes("\r\n") ? "\r\n" : "\n";
        this.data = result.content;
        this.hideConflictBanner();
        this.replaceEditorMinimal(result.content.replace(/\r\n/g, "\n"));
        this.updateOutline(true);
        if (this.mode === "reading") this.renderPreview(true);
        break;
      case "ignore-echo":
        break;
      case "noop":
        this.lineEnding = data.includes("\r\n") ? "\r\n" : "\n";
        this.data = data;
        this.hideConflictBanner();
        this.updateOutline(true);
        if (this.mode === "reading" && this.previewHost?.childElementCount === 0) {
          this.renderPreview(false);
        }
        break;
      case "conflict":
        this.showConflictBanner();
        break;
    }
  }

  getViewData(): string {
    if (this.editor) {
      return this.applyLineEnding(this.editor.state.doc.toString());
    }
    return this.data ?? "";
  }

  clear(): void {
    this.data = "";
    this.syncGuard.reset("");
    this.savedReadingFolds = null;
    this.hideConflictBanner();
    this.disposeHoverPreview?.();
    this.disposeHoverPreview = null;
    this.transclusionRefresh.abortCurrent();
    if (this.editor) {
      this.replaceEditorFull("");
    }
    this.previewHost?.empty();
  }

  toggleMode(): void {
    this.setMode(this.mode === "reading" ? "live" : "reading");
  }

  setMode(mode: OrgViewMode): void {
    if (this.mode === mode) {
      if (mode !== "reading") this.focusEditor();
      return;
    }
    if (this.mode === "reading") {
      const existing = this.previewHost?.querySelector<HTMLElement>(".org-preview");
      if (existing) this.savedReadingFolds = getReadingFoldSnapshot(existing);
    }
    if (mode === "reading" && this.mode !== "reading" && this.editor) {
      const scroller = this.editor.scrollDOM;
      const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      this.pendingPreviewScrollRatio = scroller.scrollTop / max;
    }
    this.mode = mode;
    this.applyMode(true);
  }

  private applyMode(focus = true): void {
    this.contentEl.toggleClass("is-preview-mode", this.mode === "reading");
    this.contentEl.toggleClass("is-live-preview", this.mode === "live");
    this.contentEl.toggleClass("is-source-mode", this.mode === "source");
    if (this.editor) {
      this.editor.dispatch({
        effects: this.livePreviewCompartment.reconfigure(
          livePreviewExtension({
            app: this.app,
            sourcePath: this.sourcePath(),
            displayTitle: this.displayTitle(),
            settings: this.plugin.settings,
            mode: this.mode,
            livePreviewCompartment: this.livePreviewCompartment,
            linkCallbacks: this.buildLinkCallbacks(),
            resolveIdStatus: this.resolveIdStatus,
            onDocChanged: () => this.handleDocChanged(),
          })
        ),
      });
    }
    this.updateModeAction();
    if (this.mode === "reading") {
      this.renderPreview(this.savedReadingFolds !== null);
    } else if (focus) {
      this.editor?.focus();
    }
  }

  private updateModeAction(): void {
    if (this.modeAction) {
      const toReading = this.mode !== "reading";
      setIcon(this.modeAction, toReading ? "book-open" : "pencil");
      const label = this.plugin.t(
        toReading ? "action.readingView" : "action.livePreview"
      );
      this.modeAction.setAttribute("aria-label", label);
      this.modeAction.setAttribute("title", label);
    }
    if (this.sourceAction) {
      const inSource = this.mode === "source";
      this.sourceAction.toggleClass("is-active", inSource);
      const label = this.plugin.t(inSource ? "action.livePreview" : "action.sourceMode");
      this.sourceAction.setAttribute("aria-label", label);
      this.sourceAction.setAttribute("title", label);
    }
  }

  refreshLocale(): void {
    this.updateModeAction();
    if (this.syncGuard.isConflicted()) {
      this.showConflictBanner();
    }
  }

  renderPreview(preserveFolds = false): void {
    if (!this.previewHost) return;
    this.disposeHoverPreview?.();
    this.disposeHoverPreview = null;

    const existing = this.previewHost.querySelector<HTMLElement>(".org-preview");
    const scrollTop = existing?.scrollTop ?? 0;
    const snapshot = preserveFolds
      ? existing
        ? getReadingFoldSnapshot(existing)
        : this.savedReadingFolds
      : null;
    const ratio = this.pendingPreviewScrollRatio;
    this.pendingPreviewScrollRatio = null;

    const canTransclude = Boolean(
      this.plugin.settings.enableTransclusion && this.plugin.transclusionEngine
    );
    const session = canTransclude ? this.transclusionRefresh.beginHydration() : null;
    if (!canTransclude) {
      this.transclusionRefresh.abortCurrent();
    }

    const source = this.editor?.state.doc.toString() ?? this.data ?? "";
    const preview = renderOrgPreview(source, this.app, this.sourcePath(), {
      settings: this.plugin.settings,
      fallbackTitle: this.displayTitle(),
      linkCallbacks: this.buildLinkCallbacks(),
      resolveIdStatus: this.resolveIdStatus,
      onToggleTask: (from, to, checked) => {
        this.editor?.dispatch({
          changes: { from, to, insert: checked ? "[X]" : "[ ]" },
          userEvent: "input",
        });
      },
      hydrateTransclusions:
        canTransclude && session
          ? (root, currentSourcePath) =>
              hydrateTransclusionsInDom(root, {
                app: this.app,
                sourcePath: currentSourcePath,
                resolver: this.plugin.transclusionEngine,
                settings: this.plugin.settings,
                linkCallbacks: this.buildLinkCallbacks(),
                resolveIdStatus: this.resolveIdStatus,
                t: (key) => this.plugin.t(key),
                signal: session.signal,
                isStale: session.isStale,
                onDependency: session.onDependency,
                onOpenSource: (filePath, line) => {
                  void this.plugin.vaultIndex?.openLocation(filePath, line, this.mode);
                },
              })
          : undefined,
    });
    if (snapshot) {
      restoreReadingFoldSnapshot(preview, snapshot);
    }
    this.previewHost.empty();
    this.previewHost.appendChild(preview);
    this.disposeHoverPreview = this.plugin.nodeNavigation?.attachHoverPreview(preview) ?? null;

    if (ratio != null) {
      window.requestAnimationFrame(() => {
        const max = Math.max(0, preview.scrollHeight - preview.clientHeight);
        preview.scrollTop = ratio * max;
      });
    } else {
      preview.scrollTop = scrollTop;
    }
  }

  refreshSettings(): void {
    if (!this.editor) return;
    this.editor.dispatch({
      effects: [
        this.livePreviewCompartment.reconfigure(
          livePreviewExtension({
            app: this.app,
            sourcePath: this.sourcePath(),
            displayTitle: this.displayTitle(),
            settings: this.plugin.settings,
            mode: this.mode,
            livePreviewCompartment: this.livePreviewCompartment,
            linkCallbacks: this.buildLinkCallbacks(),
            resolveIdStatus: this.resolveIdStatus,
            onDocChanged: () => this.handleDocChanged(),
          })
        ),
        refreshOrgPreview.of(null),
      ],
    });
    this.updateModeAction();
    this.updateOutline(true);
    if (this.mode === "reading") this.renderPreview(true);
  }

  foldLevel(mode: FoldLevelMode): void {
    if (this.mode === "reading") {
      const preview = this.previewHost?.querySelector<HTMLElement>(".org-preview");
      if (preview) setReadingFoldLevel(preview, mode);
    } else if (this.editor) {
      setEditorFoldLevel(this.editor, mode);
    }
  }

  toggleFold(): boolean {
    if (this.mode === "reading") return false;
    return this.editor ? toggleFoldAtCursor(this.editor) : false;
  }

  cycleFold(): boolean {
    if (this.mode === "reading") return false;
    return this.editor ? cycleEditorFold(this.editor) : false;
  }

  cycleTodo(): void {
    if (!this.editor) return;
    if (cycleTodoCommand(this.editor)) {
      this.editor.focus();
    }
  }

  focusEditor(): void {
    this.editor?.focus();
  }

  jumpToLine(line: number): void {
    if (this.mode === "reading") {
      const preview = this.previewHost?.querySelector<HTMLElement>(".org-preview");
      if (preview) {
        const target = revealReadingLine(preview, line);
        target?.scrollIntoView?.({ block: "start" });
      }
      return;
    }
    if (!this.editor) return;
    const number = Math.max(1, Math.min(this.editor.state.doc.lines, line + 1));
    const from = this.editor.state.doc.line(number).from;
    unfoldPos(this.editor, from);
    this.editor.dispatch({ selection: { anchor: from } });
    const block = this.editor.lineBlockAt(from);
    this.editor.scrollDOM.scrollTop = Math.max(0, block.top - 60);
    this.editor.focus();
  }

  private jumpToCustomId(customId: string): void {
    const preview = this.previewHost?.querySelector<HTMLElement>(".org-preview");
    if (preview) {
      const match = Array.from(preview.querySelectorAll<HTMLElement>(".org-section")).find(
        (sec) => sec.dataset.customId === customId || sec.dataset.slug === customId
      );
      if (match && Number.isFinite(Number(match.dataset.line))) {
        this.jumpToLine(Number(match.dataset.line));
        return;
      }
    }
    const lines = this.getViewData().split("\n");
    const targetRe = new RegExp(
      `^\\s*:CUSTOM_ID:\\s*${customId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
      "i"
    );
    const idx = lines.findIndex((l) => targetRe.test(l));
    if (idx >= 0) {
      this.jumpToLine(idx);
      return;
    }
    const res = this.plugin.vaultIndex?.index.resolveCustomId(customId, this.sourcePath());
    if (res?.status === "found") {
      void this.plugin.vaultIndex.openNode(res.node, this.mode);
    } else if (res?.status === "duplicate") {
      void this.plugin.vaultIndex.openNode(res.nodes[0], this.mode);
    }
  }

  private jumpToHeadingTitle(headingTitle: string): void {
    const normalized = headingTitle.trim().toLowerCase();
    const preview = this.previewHost?.querySelector<HTMLElement>(".org-preview");
    if (preview) {
      const secs = Array.from(preview.querySelectorAll<HTMLElement>(".org-section"));
      const match =
        secs.find((s) => s.dataset.title === normalized) ??
        secs.find((s) => s.dataset.title?.includes(normalized));
      if (match && Number.isFinite(Number(match.dataset.line))) {
        this.jumpToLine(Number(match.dataset.line));
        return;
      }
    }
    const lines = this.getViewData().split("\n");
    const idx = lines.findIndex((l) => /^\*+\s+/.test(l) && l.toLowerCase().includes(normalized));
    if (idx >= 0) this.jumpToLine(idx);
  }

  getEphemeralState(): { line: number } {
    if (!this.editor) return { line: 0 };
    const line = this.editor.state.doc.lineAt(this.editor.state.selection.main.head).number;
    return { line: Math.max(0, line - 1) };
  }

  setEphemeralState(state: { line?: number }): void {
    if (typeof state?.line !== "number") return;
    const targetLine = state.line;
    if (this.mode === "reading") {
      this.jumpToLine(targetLine);
      return;
    }

    const apply = () => this.jumpToLine(targetLine);
    apply();
    window.requestAnimationFrame(apply);
    window.setTimeout(apply, 120);
  }
}
