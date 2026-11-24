import { setIcon, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_ORG_LOCAL_GRAPH } from "../../constants";
import type { OrgIdIndex } from "../../core/index/orgIdIndex";
import type { VaultIndexChangeEvent, VaultIndexService } from "../../core/index/vaultIndexService";
import { buildLocalOrgGraph } from "../../core/graph/localGraph";
import {
  createDefaultLocalGraphState,
  mergeGraphViewState,
  type OrgGraphData,
  type OrgGraphLocalState,
  type OrgGraphNode,
  type OrgGraphViewState,
} from "../../core/graph/types";
import type { OrgGraphControls } from "./graphControls";
import {
  LocalGraphController,
  type LocalGraphSnapshot,
  type LocalGraphTargetStatus,
} from "./localGraphController";
import { OrgGraphBaseView, type OrgGraphBaseHost } from "./OrgGraphBaseView";
import type { OrgReaderFocusBus } from "./readerFocusBus";
import { ICON_ORG_LOCAL_GRAPH } from "../icons";

export type LocalOrgGraphBuilder = (
  state: OrgGraphViewState,
  localState: OrgGraphLocalState,
  index: OrgIdIndex
) => OrgGraphData;

export interface OrgLocalGraphHost extends Omit<OrgGraphBaseHost, "buildGraphData"> {
  vaultIndex: VaultIndexService;
  focusBus: OrgReaderFocusBus;
  buildLocalGraph?: LocalOrgGraphBuilder;
  initialState?: Partial<OrgGraphViewState>;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Local Org Knowledge Graph ItemView synchronized bidirectionally with OrgView
 * via `OrgReaderFocusBus` and `LocalGraphController` (supports Follow vs Lock and 1/2/3 depth).
 */
export class OrgLocalGraphView extends OrgGraphBaseView {
  private controller: LocalGraphController | null = null;
  private unsubscribeController: (() => void) | null = null;

  private focusBadgeEl: HTMLElement | null = null;
  private lockBtnEl: HTMLButtonElement | null = null;
  private depthBtns = new Map<1 | 2 | 3, HTMLButtonElement>();
  private incomingCheckEl: HTMLInputElement | null = null;
  private outgoingCheckEl: HTMLInputElement | null = null;
  private followCheckEl: HTMLInputElement | null = null;

  private lastRenderedCenterKey: string | null = null;
  private lastRenderedCenterFile: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly localHost: OrgLocalGraphHost
  ) {
    super(
      leaf,
      mergeGraphViewState(createDefaultLocalGraphState(), localHost.initialState),
      localHost
    );
  }

  getViewType(): string {
    return VIEW_TYPE_ORG_LOCAL_GRAPH;
  }

  getDisplayText(): string {
    return this.t("graph.localTitle");
  }

  getIcon(): string {
    return ICON_ORG_LOCAL_GRAPH;
  }

  getController(): LocalGraphController | null {
    return this.controller;
  }

  getLocalState(): OrgGraphLocalState {
    return (
      this.controller?.getState() ??
      this.viewState.local ??
      createDefaultLocalGraphState().local!
    );
  }

  focusNode(nodeKey: string, filePath?: string | null): boolean {
    if (!this.controller) {
      const base = this.viewState.local ?? createDefaultLocalGraphState().local!;
      this.viewState.local = {
        ...base,
        followReader: true,
        lockedNodeId: null,
        centerNodeId: nodeKey,
        centerFilePath: filePath ?? null,
      };
      return false;
    }
    return this.controller.focusNode(nodeKey, filePath);
  }

  lockFocus(nodeKey?: string | null): boolean {
    return this.controller?.lockFocus(nodeKey) ?? false;
  }

  unlockFocus(): boolean {
    return this.controller?.unlockFocus() ?? false;
  }

  toggleLock(): boolean {
    return this.controller?.toggleLock() ?? false;
  }

  setDepth(depth: 1 | 2 | 3): boolean {
    return this.controller?.setDepth(depth) ?? false;
  }

  protected override shouldRefreshForIndexEvent(_event?: VaultIndexChangeEvent): boolean {
    // LocalGraphController manages relevant incremental index change filtering & rebuilds.
    return false;
  }

  protected override buildGraphData(state: OrgGraphViewState): OrgGraphData {
    const localState = this.getLocalState();
    const status: LocalGraphTargetStatus = this.controller?.getTargetStatus() ?? "ok";

    if (status === "no-focus" || (!localState.centerNodeId && !localState.centerFilePath)) {
      this.setEmptyMessage(this.t("graph.localNoFocus"));
      return buildLocalOrgGraph(this.localHost.vaultIndex.index, {
        centerNodeId: null,
        centerFilePath: null,
        granularity: state.granularity,
        depth: localState.depth,
        showIncoming: localState.showIncoming,
        showOutgoing: localState.showOutgoing,
        filter: state.filter,
        colorMode: state.colorMode,
        groups: state.groups,
      });
    }

    if (status === "target-missing") {
      this.setEmptyMessage(this.t("graph.localTargetMissing"));
      return buildLocalOrgGraph(this.localHost.vaultIndex.index, {
        centerNodeId: null,
        centerFilePath: null,
        granularity: state.granularity,
        depth: localState.depth,
        showIncoming: localState.showIncoming,
        showOutgoing: localState.showOutgoing,
        filter: state.filter,
        colorMode: state.colorMode,
        groups: state.groups,
      });
    }

    this.setEmptyMessage(null);
    if (this.localHost.buildLocalGraph) {
      return this.localHost.buildLocalGraph(state, localState, this.localHost.vaultIndex.index);
    }

    return buildLocalOrgGraph(this.localHost.vaultIndex.index, {
      centerNodeId: localState.centerNodeId,
      centerFilePath: localState.centerFilePath,
      granularity: state.granularity,
      depth: localState.depth,
      showIncoming: localState.showIncoming,
      showOutgoing: localState.showOutgoing,
      filter: state.filter,
      colorMode: state.colorMode,
      groups: state.groups,
    });
  }

  protected override async openGraphNode(node: OrgGraphNode): Promise<void> {
    if (this.baseHost.openNode) {
      await this.baseHost.openNode(node, { preserveLeaf: this.leaf });
      return;
    }
    if (this.controller) {
      await this.controller.openNodeFromGraph(node, this.graphData, this.leaf);
      return;
    }
    await super.openGraphNode(node);
  }

  protected override onAfterRenderUI(controls: OrgGraphControls): void {
    this.mountLocalHud(controls);
    this.mountLocalPanelControls(controls);
    this.initController();
    this.syncLocalHud();
  }

  private initController(): void {
    this.unsubscribeController?.();
    this.unsubscribeController = null;
    this.controller?.dispose();

    const localInitial = this.viewState.local ?? createDefaultLocalGraphState().local!;
    this.controller = new LocalGraphController({
      app: this.app,
      vaultIndex: this.localHost.vaultIndex,
      focusBus: this.localHost.focusBus,
      initialState: localInitial,
      subscribeToIndex: true,
      onChange: (snapshot) => {
        this.handleControllerSnapshot(snapshot);
      },
    });

    this.controller.start();
    const snap = this.controller.getSnapshot();
    this.viewState.local = { ...snap.state };
    this.lastRenderedCenterKey = snap.state.centerNodeId;
    this.lastRenderedCenterFile = snap.state.centerFilePath;
  }

  private handleControllerSnapshot(snapshot: LocalGraphSnapshot): void {
    if (!this.isOpen) return;

    this.viewState.local = { ...snapshot.state };
    this.syncLocalHud();

    const centerChanged =
      snapshot.state.centerNodeId !== this.lastRenderedCenterKey ||
      (!snapshot.state.centerNodeId &&
        snapshot.state.centerFilePath !== this.lastRenderedCenterFile);

    this.lastRenderedCenterKey = snapshot.state.centerNodeId;
    this.lastRenderedCenterFile = snapshot.state.centerFilePath;

    if (centerChanged) {
      this.resetInitialFitForCenterChange();
    }

    this.refreshGraph(true);
    this.controller?.setData(this.graphData);
    this.schedulePersistedState(false);
  }

  private resetInitialFitForCenterChange(): void {
    // Clearing selection when jumping to a brand new focus neighborhood keeps inspector tidy.
    if (this.getSelectedNodeId() && this.lastRenderedCenterKey) {
      this.selectNode(this.lastRenderedCenterKey);
    }
  }

  private mountLocalHud(controls: OrgGraphControls): void {
    const slot = controls.getLocalControlsSlot();
    slot.replaceChildren();

    this.focusBadgeEl = el("span", "org-graph-local-focus-badge");
    slot.appendChild(this.focusBadgeEl);

    this.lockBtnEl = el("button", "org-graph-lock-btn org-graph-hud-btn");
    this.lockBtnEl.type = "button";
    this.lockBtnEl.addEventListener("click", () => {
      this.controller?.toggleLock();
    });
    slot.appendChild(this.lockBtnEl);

    const depthGroup = el("div", "org-graph-depth-group");
    depthGroup.setAttribute("role", "group");
    depthGroup.setAttribute("aria-label", this.t("graph.depthLabel"));

    this.depthBtns.clear();
    for (const depth of [1, 2, 3] as const) {
      const btn = el("button", "org-graph-depth-btn", String(depth));
      btn.type = "button";
      btn.dataset.depth = String(depth);
      btn.addEventListener("click", () => {
        this.controller?.setDepth(depth);
      });
      depthGroup.appendChild(btn);
      this.depthBtns.set(depth, btn);
    }
    slot.appendChild(depthGroup);
  }

  private mountLocalPanelControls(controls: OrgGraphControls): void {
    const panelSlot = controls.getLocalPanelSlot();
    panelSlot.replaceChildren();

    const section = el("div", "org-graph-panel-section");
    section.appendChild(el("div", "org-graph-panel-heading", this.t("graph.localHeading")));

    const makeToggle = (labelText: string, onChange: (checked: boolean) => void) => {
      const row = el("label", "org-graph-toggle-row");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.addEventListener("change", () => onChange(input.checked));
      row.appendChild(input);
      row.appendChild(el("span", "org-graph-toggle-label", labelText));
      section.appendChild(row);
      return input;
    };

    this.incomingCheckEl = makeToggle(this.t("graph.showIncoming"), (checked) => {
      this.controller?.setShowIncoming(checked);
    });
    this.outgoingCheckEl = makeToggle(this.t("graph.showOutgoing"), (checked) => {
      this.controller?.setShowOutgoing(checked);
    });
    this.followCheckEl = makeToggle(this.t("graph.followReader"), (checked) => {
      if (checked) this.controller?.unlockFocus();
      else this.controller?.lockFocus();
    });

    panelSlot.appendChild(section);
  }

  private resolveFocusLabel(localState: OrgGraphLocalState, status: LocalGraphTargetStatus): string {
    if (status === "no-focus") return this.t("graph.followingBadge");
    if (status === "target-missing") return this.t("graph.localTargetMissing");

    const centerId = localState.centerNodeId;
    if (centerId?.startsWith("id:")) {
      const orgId = centerId.slice(3).trim();
      const res = this.localHost.vaultIndex.index.resolveId(orgId);
      if (res.status === "found") return res.node.title;
      if (res.status === "duplicate") return res.nodes[0].title;
      return orgId;
    }
    if (localState.centerFilePath) {
      return (
        this.localHost.vaultIndex.index.getFileIndexData(localState.centerFilePath)?.fileTitle ??
        localState.centerFilePath.split("/").pop() ??
        localState.centerFilePath
      );
    }
    return this.t("graph.localTitle");
  }

  private syncLocalHud(): void {
    const localState = this.getLocalState();
    const status: LocalGraphTargetStatus = this.controller?.getTargetStatus() ?? "no-focus";
    const locked = !localState.followReader;

    if (this.focusBadgeEl) {
      const focusName = this.resolveFocusLabel(localState, status);
      const modeTag = locked ? this.t("graph.lockedBadge") : this.t("graph.followingBadge");
      this.focusBadgeEl.textContent = `${modeTag}: ${focusName}`;
      this.focusBadgeEl.classList.toggle("is-locked", locked);
      this.focusBadgeEl.classList.toggle("is-missing", status === "target-missing");
    }

    if (this.lockBtnEl) {
      const title = locked ? this.t("graph.unlockFocus") : this.t("graph.lockFocus");
      setIcon(this.lockBtnEl, locked ? "lock" : "unlock");
      this.lockBtnEl.classList.toggle("is-locked", locked);
      this.lockBtnEl.classList.toggle("is-active", locked);
      this.lockBtnEl.setAttribute("aria-label", title);
      this.lockBtnEl.setAttribute("aria-pressed", locked ? "true" : "false");
      this.lockBtnEl.title = title;
    }

    for (const [depth, btn] of this.depthBtns.entries()) {
      const active = localState.depth === depth;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }

    if (this.incomingCheckEl) this.incomingCheckEl.checked = localState.showIncoming;
    if (this.outgoingCheckEl) this.outgoingCheckEl.checked = localState.showOutgoing;
    if (this.followCheckEl) this.followCheckEl.checked = localState.followReader;
  }

  override async setState(state: unknown, result: unknown): Promise<void> {
    await super.setState(state, result);
    const local = (state as { local?: Partial<OrgGraphLocalState> } | null)?.local;
    if (local && this.controller) {
      if (local.depth === 1 || local.depth === 2 || local.depth === 3) {
        this.controller.setDepth(local.depth);
      }
      if (typeof local.showIncoming === "boolean") {
        this.controller.setShowIncoming(local.showIncoming);
      }
      if (typeof local.showOutgoing === "boolean") {
        this.controller.setShowOutgoing(local.showOutgoing);
      }
      if (local.followReader === false) {
        this.controller.lockFocus(local.lockedNodeId ?? local.centerNodeId);
      } else if (local.followReader === true) {
        this.controller.unlockFocus();
      }
      this.syncLocalHud();
      this.refreshGraph(true);
    }
  }

  override async onClose(): Promise<void> {
    this.unsubscribeController?.();
    this.unsubscribeController = null;
    this.controller?.dispose();
    this.controller = null;
    this.focusBadgeEl = null;
    this.lockBtnEl = null;
    this.depthBtns.clear();
    this.incomingCheckEl = null;
    this.outgoingCheckEl = null;
    this.followCheckEl = null;
    await super.onClose();
  }
}
