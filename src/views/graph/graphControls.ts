import { setIcon } from "obsidian";
import {
  extractNodePreviewDetail,
  formatNodeBreadcrumb,
  formatNodeLevelBadge,
} from "../../core/index/nodeUtils";
import type { OrgNodeEntry } from "../../core/model/types";
import {
  createDefaultDisplayConfig,
  createDefaultForceConfig,
  createDefaultLocalGraphState,
  type OrgGraphColorGroup,
  type OrgGraphColorSchemeMode,
  type OrgGraphDisplayConfig,
  type OrgGraphFilterState,
  type OrgGraphForceConfig,
  type OrgGraphGranularity,
  type OrgGraphNode,
  type OrgGraphStats,
  type OrgGraphViewState,
} from "../../core/graph/types";
import type { TranslationKey, UiLanguage } from "../../i18n";
import { nodeLabel } from "../nodes/nodeLabels";
import type { GraphHoverAnchor } from "./canvasRenderer";

export interface OrgGraphControlsCallbacks {
  t: (key: TranslationKey) => string;
  getUiLanguage: () => UiLanguage;
  onChangeGranularity: (granularity: OrgGraphGranularity) => void;
  onChangeFilter: (patch: Partial<OrgGraphFilterState>) => void;
  onChangeColorMode: (mode: OrgGraphColorSchemeMode) => void;
  onChangeGroups: (groups: OrgGraphColorGroup[]) => void;
  onChangeDisplay: (patch: Partial<OrgGraphDisplayConfig>) => void;
  onChangeForces: (patch: Partial<OrgGraphForceConfig>) => void;
  onToggleControlsOpen: (open: boolean) => void;
  onResetDefaults?: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToView: () => void;
  onRelayout: () => void;
  onOpenNode: (node: OrgGraphNode) => void;
  onCloseInspector: () => void;
  onFocusInLocalGraph?: (node: OrgGraphNode) => void;
  readFile?: (filePath: string) => Promise<string | null> | string | null;
  hoverDelayMs?: number;
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

function graphNodeToEntry(node: OrgGraphNode): OrgNodeEntry {
  return {
    id: node.orgId,
    customId: node.customId,
    filePath: node.filePath,
    line: node.line,
    endLine: node.endLine,
    level: node.level,
    title: node.title,
    headingPath: node.headingPath,
    drawerStartLine: node.line,
    drawerEndLine: node.line,
    tags: node.tags,
    todo: node.todo,
    parentNodeId: node.parentNodeId,
  };
}

function nextCustomGroupColor(index: number): string {
  const palette = [
    "#7c3aed",
    "#0ea5e9",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#ec4899",
    "#14b8a6",
  ];
  return palette[index % palette.length];
}

interface SliderBinding {
  input: HTMLInputElement;
  valueEl: HTMLElement;
  format: (val: number) => string;
  updateTrackPct: (val: number) => void;
}

/**
 * Native Obsidian HUD overlays for Org Knowledge Graph (top-left granularity + stats + local slot,
 * top-right collapsible gear panel, bottom-right mini zoom toolbar, bottom-left inspector card,
 * empty overlay, and read-only hover preview popover).
 */
export class OrgGraphControls {
  private readonly topLeftEl: HTMLElement;
  private readonly nodeBtn: HTMLButtonElement;
  private readonly fileBtn: HTMLButtonElement;
  private readonly statsPillEl: HTMLElement;
  private readonly localSlotEl: HTMLElement;

  private readonly topRightEl: HTMLElement;
  private readonly gearBtn: HTMLButtonElement;
  private readonly panelEl: HTMLElement;
  private readonly searchInputEl: HTMLInputElement;
  private readonly filterCheckboxes = new Map<keyof Omit<OrgGraphFilterState, "search">, HTMLInputElement>();
  private readonly localPanelSlotEl: HTMLElement;
  private readonly colorSelectEl: HTMLSelectElement;
  private readonly groupsEditorEl: HTMLElement;
  private readonly groupsListEl: HTMLElement;
  private readonly displayCheckboxes = new Map<"showArrows" | "showLabels", HTMLInputElement>();
  private readonly sliders = new Map<string, SliderBinding>();

  private readonly zoomToolbarEl: HTMLElement;
  private readonly inspectorEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly emptyCardEl: HTMLElement;

  private state: OrgGraphViewState;
  private customEmptyMessage: string | null = null;
  private selectedNode: OrgGraphNode | null = null;
  private lastStats: OrgGraphStats = {
    nodeCount: 0,
    edgeCount: 0,
    referenceEdges: 0,
    transclusionEdges: 0,
    structuralEdges: 0,
    orphanCount: 0,
    duplicateCount: 0,
    unresolvedCount: 0,
    fileCount: 0,
  };

  // Hover preview state
  private readonly hoverDelayMs: number;
  private hoverPopoverEl: HTMLElement | null = null;
  private hoverShowTimer: number | null = null;
  private hoverHideTimer: number | null = null;
  private hoverNodeId: string | null = null;
  private hoverSeq = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    initialState: OrgGraphViewState,
    private readonly callbacks: OrgGraphControlsCallbacks
  ) {
    this.state = initialState;
    this.hoverDelayMs = Math.max(0, callbacks.hoverDelayMs ?? 160);

    // 1. Top-left HUD bar
    this.topLeftEl = el("div", "org-graph-hud-top-left");
    const segGroup = el("div", "org-graph-granularity-toggle");
    segGroup.setAttribute("role", "group");

    this.nodeBtn = el(
      "button",
      "org-graph-seg-btn",
      callbacks.t("graph.granularityNodes")
    );
    this.nodeBtn.type = "button";
    this.nodeBtn.dataset.granularity = "node";
    this.nodeBtn.addEventListener("click", () => {
      if (this.state.granularity !== "node") {
        this.callbacks.onChangeGranularity("node");
      }
    });

    this.fileBtn = el(
      "button",
      "org-graph-seg-btn",
      callbacks.t("graph.granularityFiles")
    );
    this.fileBtn.type = "button";
    this.fileBtn.dataset.granularity = "file";
    this.fileBtn.addEventListener("click", () => {
      if (this.state.granularity !== "file") {
        this.callbacks.onChangeGranularity("file");
      }
    });

    segGroup.appendChild(this.nodeBtn);
    segGroup.appendChild(this.fileBtn);
    this.topLeftEl.appendChild(segGroup);

    this.statsPillEl = el("div", "org-graph-stats-pill");
    this.topLeftEl.appendChild(this.statsPillEl);

    this.localSlotEl = el("div", "org-graph-local-slot");
    this.topLeftEl.appendChild(this.localSlotEl);
    this.container.appendChild(this.topLeftEl);

    // 2. Top-right collapsible gear panel
    this.topRightEl = el("div", "org-graph-hud-top-right");
    this.gearBtn = el("button", "org-graph-gear-btn org-graph-hud-btn");
    this.gearBtn.type = "button";
    this.gearBtn.setAttribute("aria-label", callbacks.t("graph.toggleControls"));
    this.gearBtn.title = callbacks.t("graph.toggleControls");
    setIcon(this.gearBtn, "settings");
    this.gearBtn.addEventListener("click", () => {
      this.callbacks.onToggleControlsOpen(!this.state.controlsOpen);
    });
    this.topRightEl.appendChild(this.gearBtn);

    this.panelEl = el("div", "org-graph-controls-panel");

    const panelHeader = el("div", "org-graph-panel-header");
    panelHeader.appendChild(
      el("span", "org-graph-panel-header-title", callbacks.t("graph.toggleControls"))
    );
    const headerActions = el("div", "org-graph-panel-header-actions");
    const resetBtn = el("button", "org-graph-panel-icon-btn");
    resetBtn.type = "button";
    resetBtn.dataset.action = "reset-defaults";
    resetBtn.setAttribute("aria-label", callbacks.t("graph.resetDefaults"));
    resetBtn.title = callbacks.t("graph.resetDefaults");
    setIcon(resetBtn, "rotate-ccw");
    resetBtn.addEventListener("click", () => {
      this.callbacks.onResetDefaults?.();
    });
    headerActions.appendChild(resetBtn);

    const closePanelBtn = el("button", "org-graph-panel-icon-btn");
    closePanelBtn.type = "button";
    closePanelBtn.dataset.action = "close-controls";
    closePanelBtn.setAttribute("aria-label", callbacks.t("graph.closeControls"));
    closePanelBtn.title = callbacks.t("graph.closeControls");
    setIcon(closePanelBtn, "x");
    closePanelBtn.addEventListener("click", () => {
      this.callbacks.onToggleControlsOpen(false);
    });
    headerActions.appendChild(closePanelBtn);
    panelHeader.appendChild(headerActions);
    this.panelEl.appendChild(panelHeader);

    const createCollapsibleSection = (titleText: string) => {
      const sectionEl = el("details", "org-graph-panel-section");
      sectionEl.open = true;
      const summaryEl = el("summary", "org-graph-section-summary");
      const chevronEl = el("span", "org-graph-section-chevron");
      setIcon(chevronEl, "chevron-down");
      summaryEl.appendChild(chevronEl);
      summaryEl.appendChild(el("span", "org-graph-section-title", titleText));
      sectionEl.appendChild(summaryEl);
      const bodyEl = el("div", "org-graph-panel-section-body");
      sectionEl.appendChild(bodyEl);
      return { sectionEl, bodyEl };
    };

    const localDefaults = initialState.local ? createDefaultLocalGraphState() : null;
    const defaultDisplay = localDefaults?.display ?? createDefaultDisplayConfig();
    const defaultForces = localDefaults?.forces ?? createDefaultForceConfig();

    // Filters section
    const { sectionEl: filterSec, bodyEl: filterBody } = createCollapsibleSection(
      callbacks.t("graph.filterHeading")
    );

    this.searchInputEl = el("input", "org-graph-search-input");
    this.searchInputEl.type = "search";
    this.searchInputEl.placeholder = callbacks.t("graph.searchPlaceholder");
    this.searchInputEl.setAttribute("aria-label", callbacks.t("graph.searchPlaceholder"));
    this.searchInputEl.addEventListener("input", () => {
      this.callbacks.onChangeFilter({ search: this.searchInputEl.value });
    });
    filterBody.appendChild(this.searchInputEl);

    const filterKeys: Array<{
      key: keyof Omit<OrgGraphFilterState, "search">;
      labelKey: TranslationKey;
    }> = [
      { key: "showReference", labelKey: "graph.showReference" },
      { key: "showTransclusion", labelKey: "graph.showTransclusion" },
      { key: "showStructural", labelKey: "graph.showStructural" },
      { key: "showOrphans", labelKey: "graph.showOrphans" },
      { key: "showUnresolved", labelKey: "graph.showUnresolved" },
    ];
    for (const item of filterKeys) {
      const row = el("label", "org-graph-checkbox-row");
      const input = el("input");
      input.type = "checkbox";
      input.dataset.filterKey = item.key;
      input.addEventListener("change", () => {
        this.callbacks.onChangeFilter({ [item.key]: input.checked });
      });
      row.appendChild(input);
      row.appendChild(el("span", "org-graph-checkbox-label", callbacks.t(item.labelKey)));
      filterBody.appendChild(row);
      this.filterCheckboxes.set(item.key, input);
    }
    this.panelEl.appendChild(filterSec);

    // Optional Local Graph panel slot
    this.localPanelSlotEl = el("div", "org-graph-local-panel-slot");
    this.panelEl.appendChild(this.localPanelSlotEl);

    // Color Groups section
    const { sectionEl: groupsSec, bodyEl: groupsBody } = createCollapsibleSection(
      callbacks.t("graph.groupsHeading")
    );
    const schemeRow = el("label", "org-graph-select-row");
    schemeRow.appendChild(el("span", "org-graph-select-label", callbacks.t("graph.colorScheme")));
    this.colorSelectEl = el("select", "org-graph-color-select");
    const colorOptions: Array<{ value: OrgGraphColorSchemeMode; labelKey: TranslationKey }> = [
      { value: "none", labelKey: "graph.colorNone" },
      { value: "file", labelKey: "graph.colorFile" },
      { value: "folder", labelKey: "graph.colorFolder" },
      { value: "tag", labelKey: "graph.colorTag" },
      { value: "level", labelKey: "graph.colorLevel" },
      { value: "custom", labelKey: "graph.colorCustom" },
    ];
    for (const opt of colorOptions) {
      const optionEl = el("option", undefined, callbacks.t(opt.labelKey));
      optionEl.value = opt.value;
      this.colorSelectEl.appendChild(optionEl);
    }
    this.colorSelectEl.addEventListener("change", () => {
      this.callbacks.onChangeColorMode(this.colorSelectEl.value as OrgGraphColorSchemeMode);
    });
    schemeRow.appendChild(this.colorSelectEl);
    groupsBody.appendChild(schemeRow);

    this.groupsEditorEl = el("div", "org-graph-groups-editor");
    this.groupsListEl = el("div", "org-graph-groups-list");
    this.groupsEditorEl.appendChild(this.groupsListEl);
    const addGroupBtn = el(
      "button",
      "org-graph-group-add-btn",
      callbacks.t("graph.addGroup")
    );
    addGroupBtn.type = "button";
    addGroupBtn.addEventListener("click", () => {
      const nextGroups: OrgGraphColorGroup[] = [
        ...this.state.groups.map((g) => ({ ...g })),
        {
          id: `group-${Date.now()}-${this.state.groups.length}`,
          query: "",
          color: nextCustomGroupColor(this.state.groups.length),
        },
      ];
      if (this.state.colorMode !== "custom") {
        this.callbacks.onChangeColorMode("custom");
      }
      this.callbacks.onChangeGroups(nextGroups);
    });
    this.groupsEditorEl.appendChild(addGroupBtn);
    groupsBody.appendChild(this.groupsEditorEl);
    this.panelEl.appendChild(groupsSec);

    // Display section
    const { sectionEl: displaySec, bodyEl: displayBody } = createCollapsibleSection(
      callbacks.t("graph.displayHeading")
    );

    const displayChecks: Array<{ key: "showArrows" | "showLabels"; labelKey: TranslationKey }> = [
      { key: "showArrows", labelKey: "graph.showArrows" },
      { key: "showLabels", labelKey: "graph.showLabels" },
    ];
    for (const item of displayChecks) {
      const row = el("label", "org-graph-checkbox-row");
      const input = el("input");
      input.type = "checkbox";
      input.dataset.displayKey = item.key;
      input.addEventListener("change", () => {
        this.callbacks.onChangeDisplay({ [item.key]: input.checked });
      });
      row.appendChild(input);
      row.appendChild(el("span", "org-graph-checkbox-label", callbacks.t(item.labelKey)));
      displayBody.appendChild(row);
      this.displayCheckboxes.set(item.key, input);
    }

    displayBody.appendChild(
      this.createSliderRow(
        "display.labelFadeThreshold",
        callbacks.t("graph.labelFade"),
        0.1,
        2.5,
        0.05,
        defaultDisplay.labelFadeThreshold,
        (v) => v.toFixed(2),
        (v) => this.callbacks.onChangeDisplay({ labelFadeThreshold: v })
      )
    );
    displayBody.appendChild(
      this.createSliderRow(
        "display.nodeSizeScale",
        callbacks.t("graph.nodeSize"),
        0.5,
        2.0,
        0.05,
        defaultDisplay.nodeSizeScale,
        (v) => `${v.toFixed(2)}×`,
        (v) => this.callbacks.onChangeDisplay({ nodeSizeScale: v })
      )
    );
    displayBody.appendChild(
      this.createSliderRow(
        "display.linkThickness",
        callbacks.t("graph.linkThickness"),
        0.4,
        3.0,
        0.1,
        defaultDisplay.linkThickness,
        (v) => `${v.toFixed(1)}×`,
        (v) => this.callbacks.onChangeDisplay({ linkThickness: v })
      )
    );
    this.panelEl.appendChild(displaySec);

    // Forces section
    const { sectionEl: forcesSec, bodyEl: forcesBody } = createCollapsibleSection(
      callbacks.t("graph.forcesHeading")
    );
    forcesBody.appendChild(
      this.createSliderRow(
        "forces.centerStrength",
        callbacks.t("graph.centerStrength"),
        0.0,
        0.6,
        0.01,
        defaultForces.centerStrength,
        (v) => v.toFixed(2),
        (v) => this.callbacks.onChangeForces({ centerStrength: v })
      )
    );
    forcesBody.appendChild(
      this.createSliderRow(
        "forces.repelStrength",
        callbacks.t("graph.repelStrength"),
        40,
        800,
        10,
        defaultForces.repelStrength,
        (v) => `${Math.round(v)}`,
        (v) => this.callbacks.onChangeForces({ repelStrength: v })
      )
    );
    forcesBody.appendChild(
      this.createSliderRow(
        "forces.linkStrength",
        callbacks.t("graph.linkStrength"),
        0.05,
        1.0,
        0.05,
        defaultForces.linkStrength,
        (v) => v.toFixed(2),
        (v) => this.callbacks.onChangeForces({ linkStrength: v })
      )
    );
    forcesBody.appendChild(
      this.createSliderRow(
        "forces.linkDistance",
        callbacks.t("graph.linkDistance"),
        30,
        300,
        5,
        defaultForces.linkDistance,
        (v) => `${Math.round(v)}px`,
        (v) => this.callbacks.onChangeForces({ linkDistance: v })
      )
    );
    this.panelEl.appendChild(forcesSec);

    this.topRightEl.appendChild(this.panelEl);
    this.container.appendChild(this.topRightEl);

    // 3. Bottom-right mini zoom toolbar
    this.zoomToolbarEl = el("div", "org-graph-zoom-toolbar");
    const zoomActions: Array<{
      action: string;
      icon: string;
      labelKey: TranslationKey;
      handler: () => void;
    }> = [
      { action: "zoom-in", icon: "plus", labelKey: "graph.zoomIn", handler: callbacks.onZoomIn },
      { action: "zoom-out", icon: "minus", labelKey: "graph.zoomOut", handler: callbacks.onZoomOut },
      { action: "fit-view", icon: "maximize-2", labelKey: "graph.fitView", handler: callbacks.onFitToView },
      { action: "relayout", icon: "rotate-ccw", labelKey: "graph.relayout", handler: callbacks.onRelayout },
    ];
    for (const item of zoomActions) {
      const btn = el("button", "org-graph-zoom-btn org-graph-hud-btn");
      btn.type = "button";
      btn.dataset.action = item.action;
      const label = callbacks.t(item.labelKey);
      btn.setAttribute("aria-label", label);
      btn.title = label;
      setIcon(btn, item.icon);
      btn.addEventListener("click", item.handler);
      this.zoomToolbarEl.appendChild(btn);
    }
    this.container.appendChild(this.zoomToolbarEl);

    // 4. Bottom-left selected node card
    this.inspectorEl = el("div", "org-graph-inspector-card is-hidden");
    this.container.appendChild(this.inspectorEl);

    // 5. Empty state overlay
    this.emptyEl = el("div", "org-graph-empty-state is-hidden");
    this.emptyCardEl = el("div", "org-graph-empty-card", callbacks.t("graph.empty"));
    this.emptyEl.appendChild(this.emptyCardEl);
    this.container.appendChild(this.emptyEl);

    this.syncState(initialState);
    this.updateStats(this.lastStats);
  }

  private createSliderRow(
    key: string,
    label: string,
    min: number,
    max: number,
    step: number,
    defaultValue: number,
    format: (v: number) => string,
    onChange: (v: number) => void
  ): HTMLElement {
    const row = el("div", "org-graph-slider-row");
    const top = el("div", "org-graph-slider-top");
    top.appendChild(el("span", "org-graph-slider-label", label));
    const valueEl = el("span", "org-graph-slider-value");
    valueEl.title = this.callbacks.t("graph.sliderResetHint");
    top.appendChild(valueEl);
    row.appendChild(top);

    const input = el("input", "org-graph-slider-input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset.sliderKey = key;
    input.setAttribute("aria-label", label);
    input.title = this.callbacks.t("graph.sliderResetHint");

    const updateTrackPct = (val: number) => {
      const ratio = max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0;
      input.style.setProperty("--slider-pct", `${(ratio * 100).toFixed(2)}%`);
    };

    input.addEventListener("input", () => {
      const v = Number.parseFloat(input.value);
      if (Number.isFinite(v)) {
        valueEl.textContent = format(v);
        updateTrackPct(v);
        onChange(v);
      }
    });

    const resetSingle = () => {
      input.value = String(defaultValue);
      valueEl.textContent = format(defaultValue);
      updateTrackPct(defaultValue);
      onChange(defaultValue);
    };
    input.addEventListener("dblclick", resetSingle);
    valueEl.addEventListener("dblclick", resetSingle);

    row.appendChild(input);

    this.sliders.set(key, { input, valueEl, format, updateTrackPct });
    return row;
  }

  getLocalControlsSlot(): HTMLElement {
    return this.localSlotEl;
  }

  getLocalPanelSlot(): HTMLElement {
    return this.localPanelSlotEl;
  }

  syncState(nextState: OrgGraphViewState): void {
    this.state = nextState;

    const isNode = nextState.granularity === "node";
    this.nodeBtn.classList.toggle("is-active", isNode);
    this.nodeBtn.setAttribute("aria-pressed", String(isNode));
    this.fileBtn.classList.toggle("is-active", !isNode);
    this.fileBtn.setAttribute("aria-pressed", String(!isNode));

    this.gearBtn.classList.toggle("is-active", nextState.controlsOpen);
    this.gearBtn.setAttribute("aria-expanded", String(nextState.controlsOpen));
    this.panelEl.classList.toggle("is-open", nextState.controlsOpen);

    if (this.searchInputEl.value !== nextState.filter.search) {
      this.searchInputEl.value = nextState.filter.search;
    }

    for (const [key, input] of this.filterCheckboxes.entries()) {
      input.checked = Boolean(nextState.filter[key]);
    }

    this.colorSelectEl.value = nextState.colorMode;
    this.groupsEditorEl.classList.toggle(
      "is-hidden",
      nextState.colorMode !== "custom" && nextState.groups.length === 0
    );
    this.renderGroupRows(nextState.groups);

    for (const [key, input] of this.displayCheckboxes.entries()) {
      input.checked = Boolean(nextState.display[key]);
    }

    const sliderValues: Record<string, number> = {
      "display.labelFadeThreshold": nextState.display.labelFadeThreshold,
      "display.nodeSizeScale": nextState.display.nodeSizeScale,
      "display.linkThickness": nextState.display.linkThickness,
      "forces.centerStrength": nextState.forces.centerStrength,
      "forces.repelStrength": nextState.forces.repelStrength,
      "forces.linkStrength": nextState.forces.linkStrength,
      "forces.linkDistance": nextState.forces.linkDistance,
    };

    for (const [key, val] of Object.entries(sliderValues)) {
      const binding = this.sliders.get(key);
      if (!binding) continue;
      binding.input.value = String(val);
      binding.valueEl.textContent = binding.format(val);
      binding.updateTrackPct(val);
    }
  }

  private renderGroupRows(groups: OrgGraphColorGroup[]): void {
    this.groupsListEl.replaceChildren();
    groups.forEach((group, index) => {
      const row = el("div", "org-graph-group-row");
      const colorInput = el("input", "org-graph-group-color");
      colorInput.type = "color";
      colorInput.value = group.color || nextCustomGroupColor(index);
      colorInput.addEventListener("input", () => {
        const next = this.state.groups.map((g, i) =>
          i === index ? { ...g, color: colorInput.value } : { ...g }
        );
        this.callbacks.onChangeGroups(next);
      });

      const queryInput = el("input", "org-graph-group-query");
      queryInput.type = "text";
      queryInput.value = group.query;
      queryInput.placeholder = this.callbacks.t("graph.groupQueryPlaceholder");
      queryInput.addEventListener("input", () => {
        const next = this.state.groups.map((g, i) =>
          i === index ? { ...g, query: queryInput.value } : { ...g }
        );
        this.callbacks.onChangeGroups(next);
      });

      const removeBtn = el("button", "org-graph-group-remove", "×");
      removeBtn.type = "button";
      removeBtn.addEventListener("click", () => {
        const next = this.state.groups
          .filter((_, i) => i !== index)
          .map((g) => ({ ...g }));
        this.callbacks.onChangeGroups(next);
      });

      row.appendChild(colorInput);
      row.appendChild(queryInput);
      row.appendChild(removeBtn);
      this.groupsListEl.appendChild(row);
    });
  }

  updateStats(stats: OrgGraphStats): void {
    this.lastStats = stats;
    const lang = this.callbacks.getUiLanguage();
    const nodeWord = lang === "zh" ? "节点" : stats.nodeCount === 1 ? "node" : "nodes";
    const edgeWord = lang === "zh" ? "连线" : stats.edgeCount === 1 ? "edge" : "edges";
    this.statsPillEl.textContent = `${stats.nodeCount} ${nodeWord} · ${stats.edgeCount} ${edgeWord}`;
    this.updateEmptyStateVisibility();
  }

  setEmptyMessage(message: string | null): void {
    this.customEmptyMessage = message;
    this.emptyCardEl.textContent = message ?? this.callbacks.t("graph.empty");
    this.updateEmptyStateVisibility();
  }

  private updateEmptyStateVisibility(): void {
    const show = this.lastStats.nodeCount === 0;
    this.emptyEl.classList.toggle("is-hidden", !show);
    if (show && !this.customEmptyMessage) {
      this.emptyCardEl.textContent = this.callbacks.t("graph.empty");
    }
  }

  setSelectedNode(node: OrgGraphNode | null): void {
    this.selectedNode = node;
    this.inspectorEl.replaceChildren();

    if (!node) {
      this.inspectorEl.classList.add("is-hidden");
      return;
    }

    this.inspectorEl.classList.remove("is-hidden");

    const header = el("div", "org-graph-inspector-header");
    const badgeText =
      node.kind === "unresolved"
        ? "?"
        : formatNodeLevelBadge(graphNodeToEntry(node));
    header.appendChild(el("span", "org-graph-inspector-level", badgeText));
    header.appendChild(el("div", "org-graph-inspector-title", node.title || node.id));

    const closeBtn = el("button", "org-graph-inspector-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", () => {
      this.callbacks.onCloseInspector();
    });
    header.appendChild(closeBtn);
    this.inspectorEl.appendChild(header);

    if (node.status === "duplicate" || node.kind === "unresolved") {
      const statusRow = el("div", "org-graph-inspector-badges");
      if (node.status === "duplicate") {
        statusRow.appendChild(
          el(
            "span",
            "org-graph-status-badge is-duplicate",
            this.callbacks.t("graph.duplicateBadge")
          )
        );
      }
      if (node.kind === "unresolved") {
        statusRow.appendChild(
          el(
            "span",
            "org-graph-status-badge is-unresolved",
            this.callbacks.t("graph.unresolvedBadge")
          )
        );
      }
      this.inspectorEl.appendChild(statusRow);
    }

    if (node.orgId) {
      const idRow = el("div", "org-graph-inspector-id-row");
      idRow.appendChild(el("span", "org-graph-inspector-id-label", ":ID:"));
      idRow.appendChild(el("code", "org-graph-inspector-id", node.orgId));
      this.inspectorEl.appendChild(idRow);
    }

    if (node.filePath) {
      this.inspectorEl.appendChild(
        el("div", "org-graph-inspector-file", node.filePath)
      );
    }

    if (node.headingPath.length > 0) {
      this.inspectorEl.appendChild(
        el(
          "div",
          "org-graph-inspector-breadcrumb",
          node.headingPath.join(" › ")
        )
      );
    }

    const lang = this.callbacks.getUiLanguage();
    const counts = el("div", "org-graph-inspector-counts");
    const inText = lang === "zh" ? `入链 ${node.inDegree}` : `In ${node.inDegree}`;
    const outText = lang === "zh" ? `出链 ${node.outDegree}` : `Out ${node.outDegree}`;
    const transTotal = node.transcludeIn + node.transcludeOut;
    const transText =
      lang === "zh"
        ? `嵌入 ${transTotal}`
        : `Transclude ${transTotal}`;

    counts.appendChild(el("span", "org-graph-count-pill", inText));
    counts.appendChild(el("span", "org-graph-count-pill", outText));
    counts.appendChild(el("span", "org-graph-count-pill", transText));
    this.inspectorEl.appendChild(counts);

    if (node.kind !== "unresolved") {
      const actions = el("div", "org-graph-inspector-actions");
      const openBtn = el(
        "button",
        "org-graph-inspector-btn is-primary",
        this.callbacks.t("graph.openSource")
      );
      openBtn.type = "button";
      openBtn.addEventListener("click", () => {
        this.callbacks.onOpenNode(node);
      });
      actions.appendChild(openBtn);

      if (this.callbacks.onFocusInLocalGraph) {
        const focusBtn = el(
          "button",
          "org-graph-inspector-btn",
          this.callbacks.t("graph.focusLocal")
        );
        focusBtn.type = "button";
        focusBtn.addEventListener("click", () => {
          this.callbacks.onFocusInLocalGraph?.(node);
        });
        actions.appendChild(focusBtn);
      }
      this.inspectorEl.appendChild(actions);
    }
  }

  handleHoverAnchor(anchor: GraphHoverAnchor | null): void {
    if (this.disposed) return;

    if (!anchor) {
      this.clearHoverShowTimer();
      this.scheduleHoverHide();
      return;
    }

    this.clearHoverHideTimer();
    if (this.hoverNodeId === anchor.node.id && this.hoverPopoverEl?.isConnected) {
      this.positionHoverPopover(this.hoverPopoverEl, anchor);
      return;
    }

    this.clearHoverShowTimer();
    if (this.hoverDelayMs <= 0) {
      void this.showHoverPopover(anchor);
      return;
    }

    this.hoverShowTimer = window.setTimeout(() => {
      this.hoverShowTimer = null;
      void this.showHoverPopover(anchor);
    }, this.hoverDelayMs);
  }

  private clearHoverShowTimer(): void {
    if (this.hoverShowTimer !== null) {
      window.clearTimeout(this.hoverShowTimer);
      this.hoverShowTimer = null;
    }
  }

  private clearHoverHideTimer(): void {
    if (this.hoverHideTimer !== null) {
      window.clearTimeout(this.hoverHideTimer);
      this.hoverHideTimer = null;
    }
  }

  private scheduleHoverHide(): void {
    this.clearHoverHideTimer();
    if (!this.hoverPopoverEl) return;
    if (this.hoverDelayMs <= 0) {
      this.removeHoverPopover();
      return;
    }
    this.hoverHideTimer = window.setTimeout(() => {
      this.hoverHideTimer = null;
      this.removeHoverPopover();
    }, 120);
  }

  removeHoverPopover(): void {
    this.hoverSeq++;
    this.hoverNodeId = null;
    if (this.hoverPopoverEl) {
      this.hoverPopoverEl.remove();
      this.hoverPopoverEl = null;
    }
  }

  private ensureHoverPopover(): HTMLElement {
    if (this.hoverPopoverEl && this.hoverPopoverEl.isConnected) {
      return this.hoverPopoverEl;
    }
    const popover = el("div", "org-node-hover-popover org-graph-hover-popover");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-live", "polite");
    popover.addEventListener("mouseenter", () => {
      this.clearHoverHideTimer();
    });
    popover.addEventListener("mouseleave", () => {
      this.scheduleHoverHide();
    });
    this.container.appendChild(popover);
    this.hoverPopoverEl = popover;
    return popover;
  }

  private positionHoverPopover(popover: HTMLElement, anchor: GraphHoverAnchor): void {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    const boxW = 340;
    const boxH = 220;
    const left = Math.max(12, Math.min(anchor.screenX + 16, w - boxW - 12));
    const preferTop = anchor.screenY + 14;
    const top =
      preferTop + boxH > h && anchor.screenY > boxH + 16
        ? Math.max(12, anchor.screenY - boxH - 12)
        : Math.max(12, Math.min(preferTop, h - boxH - 12));

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  private async showHoverPopover(anchor: GraphHoverAnchor): Promise<void> {
    if (this.disposed) return;
    const seq = ++this.hoverSeq;
    const node = anchor.node;
    this.hoverNodeId = node.id;

    const lang = this.callbacks.getUiLanguage();
    const label = (key: Parameters<typeof nodeLabel>[1]) => nodeLabel(lang, key);
    const popover = this.ensureHoverPopover();
    popover.replaceChildren();
    this.positionHoverPopover(popover, anchor);

    if (node.kind === "unresolved") {
      popover.dataset.status = "missing";
      const header = el("div", "org-node-hover-header is-error");
      header.appendChild(
        el("span", "org-node-hover-status-pill is-missing", label("hover.missingTitle"))
      );
      if (node.orgId) {
        header.appendChild(el("code", "org-node-hover-id", node.orgId));
      }
      popover.appendChild(header);
      popover.appendChild(el("div", "org-node-hover-body is-empty", label("hover.missingHint")));
      const footer = el("div", "org-node-hover-footer");
      footer.appendChild(el("span", "org-node-hover-readonly", label("hover.readOnly")));
      popover.appendChild(footer);
      return;
    }

    popover.dataset.status = node.status === "duplicate" ? "duplicate" : "found";
    const entry = graphNodeToEntry(node);

    const header = el("div", "org-node-hover-header");
    header.appendChild(el("span", "org-node-hover-level", formatNodeLevelBadge(entry)));
    const titleBtn = el("button", "org-node-hover-title-btn", node.title || node.id);
    titleBtn.type = "button";
    titleBtn.addEventListener("click", () => {
      this.removeHoverPopover();
      this.callbacks.onOpenNode(node);
    });
    header.appendChild(titleBtn);
    popover.appendChild(header);

    const meta = el("div", "org-node-hover-meta");
    meta.appendChild(
      el(
        "span",
        "org-node-hover-breadcrumb",
        `${formatNodeBreadcrumb(entry)} · L${node.line + 1}`
      )
    );
    if (node.orgId) {
      meta.appendChild(el("code", "org-node-hover-id", node.orgId));
    }
    popover.appendChild(meta);

    const body = el("div", "org-node-hover-body is-loading", label("hover.loading"));
    popover.appendChild(body);

    const footer = el("div", "org-node-hover-footer");
    footer.appendChild(el("span", "org-node-hover-readonly", label("hover.readOnly")));
    const openBtn = el("button", "org-node-hover-open-btn", label("hover.openSource"));
    openBtn.type = "button";
    openBtn.addEventListener("click", () => {
      this.removeHoverPopover();
      this.callbacks.onOpenNode(node);
    });
    footer.appendChild(openBtn);
    popover.appendChild(footer);

    if (!this.callbacks.readFile || !node.filePath) {
      body.classList.remove("is-loading");
      body.classList.add("is-empty");
      body.textContent = label("hover.noExcerpt");
      return;
    }

    const source = await Promise.resolve(this.callbacks.readFile(node.filePath));
    if (this.disposed || seq !== this.hoverSeq) return;

    body.replaceChildren();
    body.classList.remove("is-loading", "is-empty", "is-error");

    if (source === null) {
      body.classList.add("is-error");
      body.textContent = label("hover.fileMissing");
      return;
    }

    const detail = extractNodePreviewDetail(source, entry, {
      maxLines: 6,
      maxChars: 360,
      includeHeading: false,
    });

    if (!detail.text) {
      body.classList.add("is-empty");
      body.textContent = label("hover.noExcerpt");
      return;
    }

    const excerptEl = el("div", "org-node-hover-excerpt");
    excerptEl.textContent = detail.text;
    body.appendChild(excerptEl);
  }

  dispose(): void {
    this.disposed = true;
    this.clearHoverShowTimer();
    this.clearHoverHideTimer();
    this.removeHoverPopover();
    this.topLeftEl.remove();
    this.topRightEl.remove();
    this.zoomToolbarEl.remove();
    this.inspectorEl.remove();
    this.emptyEl.remove();
  }
}
