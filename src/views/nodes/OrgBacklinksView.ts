import { EventRef, ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_ORG_BACKLINKS } from "../../constants";
import { formatNodeBreadcrumb } from "../../core/index/nodeUtils";
import type {
  OrgBacklinkEntry,
  OrgFileBacklinkGroup,
  OrgFileLinkIssue,
} from "../../core/index/orgIdIndex";
import type {
  VaultIndexChangeEvent,
  VaultIndexService,
} from "../../core/index/vaultIndexService";
import { translate, type TranslationKey, type UiLanguage } from "../../i18n";
import type OrgNativePlugin from "../../main";
import { nodeLabel, type NodeLabelKey } from "./nodeLabels";

export type OrgBacklinksHost = Pick<OrgNativePlugin, "t"> & {
  vaultIndex?: OrgNativePlugin["vaultIndex"];
  uiLanguage?: UiLanguage;
};

function createDomEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function normalizeOrgPath(filePath: string | null): string | null {
  if (!filePath) return null;
  return filePath.toLowerCase().endsWith(".org") ? filePath : null;
}

function setsIntersect(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

export class OrgBacklinksView extends ItemView {
  private readonly host: OrgBacklinksHost;
  private targetFilePath: string | null = null;
  private hasExplicitTarget = false;
  private unsubscribeIndex: (() => void) | null = null;
  private workspaceEventRefs: EventRef[] = [];
  private isOpen = false;

  private filterQuery = "";
  private showSearchBar = false;
  private showContext = true;
  private collapsedNodes = new Set<string>();
  private issuesCollapsed = false;

  private trackedNodeIds = new Set<string>();
  private trackedOutgoingIds = new Set<string>();
  private renderCount = 0;

  private searchInputEl: HTMLInputElement | null = null;
  private bodyEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    pluginOrService: OrgBacklinksHost | VaultIndexService
  ) {
    super(leaf);
    if ("index" in pluginOrService) {
      this.host = {
        vaultIndex: pluginOrService,
        uiLanguage: pluginOrService.getUiLanguage(),
        t: (key: TranslationKey) => pluginOrService.translate(key),
      };
    } else {
      this.host = pluginOrService;
    }
  }

  private get uiLanguage(): UiLanguage {
    return (
      this.host.uiLanguage ??
      this.host.vaultIndex?.getUiLanguage?.() ??
      "en"
    );
  }

  private t(key: TranslationKey): string {
    return typeof this.host.t === "function"
      ? this.host.t(key)
      : translate(this.uiLanguage, key);
  }

  private label(key: NodeLabelKey): string {
    return nodeLabel(this.uiLanguage, key);
  }

  getViewType(): string {
    return VIEW_TYPE_ORG_BACKLINKS;
  }

  getDisplayText(): string {
    return this.t("backlinks.title");
  }

  getIcon(): string {
    return "links-going-in";
  }

  getTargetFile(): string | null {
    return this.targetFilePath;
  }

  getRenderCount(): number {
    return this.renderCount;
  }

  setTargetFile(filePath: string | null): void {
    this.hasExplicitTarget = true;
    this.targetFilePath = normalizeOrgPath(filePath);
    this.refresh();
  }

  setFilterQuery(query: string): void {
    this.filterQuery = query;
    if (query.trim() && !this.showSearchBar) {
      this.showSearchBar = true;
    }
    if (this.searchInputEl && this.searchInputEl.value !== query) {
      this.searchInputEl.value = query;
    }
    this.renderBody();
  }

  setShowContext(show: boolean): void {
    this.showContext = show;
    this.refresh();
  }

  setAllCollapsed(collapsed: boolean): void {
    if (!this.targetFilePath || !this.host.vaultIndex) return;
    const groups = this.host.vaultIndex.index.getFileBacklinkGroups(this.targetFilePath);
    this.collapsedNodes.clear();
    if (collapsed) {
      for (const group of groups) {
        this.collapsedNodes.add(this.groupKey(group));
      }
    }
    this.refresh();
  }

  async onOpen(): Promise<void> {
    this.cleanupListeners();
    this.isOpen = true;

    if (!this.hasExplicitTarget) {
      this.targetFilePath = this.resolveActiveOrgFile(null) ?? null;
    }

    const activeLeafRef = this.app.workspace.on("active-leaf-change", (leaf) => {
      if (!this.isOpen) return;
      const next = this.resolveActiveOrgFile(leaf);
      if (next !== undefined && next !== this.targetFilePath) {
        this.hasExplicitTarget = false;
        this.targetFilePath = next;
        this.refresh();
      }
    });
    this.workspaceEventRefs.push(activeLeafRef);
    this.registerEvent(activeLeafRef);

    const fileOpenRef = this.app.workspace.on("file-open", (file) => {
      if (!this.isOpen) return;
      if (file instanceof TFile) {
        const normalized = normalizeOrgPath(file.path);
        if (normalized !== this.targetFilePath) {
          this.hasExplicitTarget = false;
          this.targetFilePath = normalized;
          this.refresh();
        }
      }
    });
    this.workspaceEventRefs.push(fileOpenRef);
    this.registerEvent(fileOpenRef);

    if (this.host.vaultIndex) {
      this.unsubscribeIndex = this.host.vaultIndex.onDidChange((event) => {
        if (!this.isOpen) return;
        this.handleIndexChange(event);
      });
    }

    this.refresh();
  }

  async onClose(): Promise<void> {
    this.isOpen = false;
    this.cleanupListeners();
    this.searchInputEl = null;
    this.bodyEl = null;
    this.contentEl.replaceChildren();
  }

  private handleIndexChange(event?: VaultIndexChangeEvent): void {
    if (!event || event.kind === "full") {
      this.refresh();
      return;
    }

    if (event.kind === "rename" && event.oldPath && event.oldPath === this.targetFilePath) {
      this.targetFilePath = normalizeOrgPath(event.filePath ?? null);
      this.refresh();
      return;
    }

    if (!this.targetFilePath) {
      return;
    }

    if (event.filePath === this.targetFilePath) {
      this.refresh();
      return;
    }

    if (event.affectedNodeIds && event.affectedTargetIds) {
      const touchesTargetNodes = setsIntersect(this.trackedNodeIds, event.affectedTargetIds);
      const touchesDuplicates = setsIntersect(this.trackedNodeIds, event.affectedNodeIds);
      const touchesOutgoingLinks = setsIntersect(this.trackedOutgoingIds, event.affectedNodeIds);
      if (!touchesTargetNodes && !touchesDuplicates && !touchesOutgoingLinks) {
        return;
      }
    }

    this.refresh();
  }

  refresh(): void {
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add("org-backlinks-view", "org-node-backlinks-pane");
    this.renderCount++;

    const headerEl = createDomEl("div", "org-backlinks-header");

    const titleLine = createDomEl("div", "org-node-backlinks-header-top");
    titleLine.appendChild(createDomEl("div", "org-backlinks-title", this.t("backlinks.title")));

    const index = this.host.vaultIndex?.index;
    const groups =
      this.targetFilePath && index ? index.getFileBacklinkGroups(this.targetFilePath) : [];
    const issues =
      this.targetFilePath && index ? index.getFileLinkIssues(this.targetFilePath) : [];

    this.updateTrackedIds(groups);

    const allCollapsed =
      groups.length > 0 && groups.every((g) => this.collapsedNodes.has(this.groupKey(g)));

    const toolbar = createDomEl("div", "org-node-backlinks-toolbar");

    const filterBtn = createDomEl("button", "org-node-backlinks-tool-btn is-filter");
    filterBtn.type = "button";
    filterBtn.title = this.label("backlinks.toggleFilter");
    filterBtn.setAttribute("aria-label", this.label("backlinks.toggleFilter"));
    filterBtn.setAttribute("aria-pressed", String(this.showSearchBar));
    filterBtn.textContent = "⌕";
    if (this.showSearchBar) filterBtn.classList.add("is-active");
    filterBtn.addEventListener("click", () => {
      this.showSearchBar = !this.showSearchBar;
      if (!this.showSearchBar && this.filterQuery) {
        this.filterQuery = "";
      }
      this.refresh();
      if (this.showSearchBar) {
        this.searchInputEl?.focus();
      }
    });
    toolbar.appendChild(filterBtn);

    const collapseBtn = createDomEl("button", "org-node-backlinks-tool-btn is-collapse");
    collapseBtn.type = "button";
    const collapseLabel = allCollapsed
      ? this.label("backlinks.expandAll")
      : this.label("backlinks.collapseAll");
    collapseBtn.title = collapseLabel;
    collapseBtn.setAttribute("aria-label", collapseLabel);
    collapseBtn.textContent = allCollapsed ? "▸" : "▾";
    collapseBtn.addEventListener("click", () => {
      this.setAllCollapsed(!allCollapsed);
    });
    toolbar.appendChild(collapseBtn);

    const contextBtn = createDomEl("button", "org-node-backlinks-tool-btn is-context");
    contextBtn.type = "button";
    const ctxLabel = this.showContext
      ? this.label("backlinks.hideContext")
      : this.label("backlinks.showContext");
    contextBtn.title = ctxLabel;
    contextBtn.setAttribute("aria-label", ctxLabel);
    contextBtn.setAttribute("aria-pressed", String(this.showContext));
    contextBtn.textContent = "≡";
    if (this.showContext) contextBtn.classList.add("is-active");
    contextBtn.addEventListener("click", () => {
      this.setShowContext(!this.showContext);
    });
    toolbar.appendChild(contextBtn);

    const dupCount = groups.filter((g) => g.status === "duplicate").length;
    const totalWarnings = issues.length + dupCount;
    const diagBtn = createDomEl(
      "button",
      `org-node-backlinks-tool-btn is-diagnostics${totalWarnings > 0 ? " has-warnings" : ""}`
    );
    diagBtn.type = "button";
    diagBtn.title = this.label("backlinks.showIssues");
    diagBtn.setAttribute("aria-label", this.label("backlinks.showIssues"));
    diagBtn.textContent = totalWarnings > 0 ? `! ${totalWarnings}` : "✓";
    diagBtn.addEventListener("click", () => {
      this.host.vaultIndex?.openDiagnosticsModal();
    });
    toolbar.appendChild(diagBtn);

    titleLine.appendChild(toolbar);
    headerEl.appendChild(titleLine);

    if (!this.targetFilePath) {
      root.appendChild(headerEl);
      root.appendChild(
        createDomEl("div", "org-backlinks-empty", this.t("backlinks.noActiveOrg"))
      );
      return;
    }

    const totalIncoming = groups.reduce((sum, group) => sum + group.backlinks.length, 0);
    const metaEl = createDomEl("div", "org-backlinks-meta");
    metaEl.appendChild(createDomEl("span", "org-backlinks-file", this.targetFilePath));
    metaEl.appendChild(
      createDomEl(
        "span",
        "org-backlinks-count",
        `${this.t("backlinks.incomingCount")}: ${totalIncoming}`
      )
    );
    headerEl.appendChild(metaEl);

    const searchRow = createDomEl(
      "div",
      `org-node-backlinks-search-wrap${this.showSearchBar ? "" : " is-hidden"}`
    );
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "org-node-backlinks-search-input";
    searchInput.placeholder = this.label("backlinks.filterPlaceholder");
    searchInput.value = this.filterQuery;
    searchInput.addEventListener("input", () => {
      this.filterQuery = searchInput.value;
      this.renderBody();
    });
    searchRow.appendChild(searchInput);
    headerEl.appendChild(searchRow);
    this.searchInputEl = searchInput;

    root.appendChild(headerEl);

    const bodyEl = createDomEl("div", "org-node-backlinks-body");
    this.bodyEl = bodyEl;
    root.appendChild(bodyEl);

    this.renderBody(groups, issues);
  }

  private renderBody(
    precomputedGroups?: OrgFileBacklinkGroup[],
    precomputedIssues?: OrgFileLinkIssue[]
  ): void {
    const bodyEl = this.bodyEl;
    if (!bodyEl || !this.targetFilePath) return;
    bodyEl.replaceChildren();

    const index = this.host.vaultIndex?.index;
    const groups = precomputedGroups ?? (index ? index.getFileBacklinkGroups(this.targetFilePath) : []);
    const issues = precomputedIssues ?? (index ? index.getFileLinkIssues(this.targetFilePath) : []);

    const q = this.filterQuery.trim().toLowerCase();
    const visibleGroups: OrgFileBacklinkGroup[] = [];

    for (const group of groups) {
      const hasConflict = group.status === "duplicate";
      if (group.backlinks.length === 0 && !hasConflict) continue;

      if (!q) {
        visibleGroups.push(group);
        continue;
      }

      const nodeMatches =
        group.node.title.toLowerCase().includes(q) ||
        (group.node.id ?? "").toLowerCase().includes(q) ||
        group.node.headingPath.join(" / ").toLowerCase().includes(q);

      const matchingBacklinks = nodeMatches
        ? group.backlinks
        : group.backlinks.filter((entry) => this.matchesBacklinkQuery(entry, q));

      if (matchingBacklinks.length > 0 || (hasConflict && nodeMatches)) {
        visibleGroups.push({
          ...group,
          backlinks: matchingBacklinks,
        });
      }
    }

    const visibleIssues = q
      ? issues.filter((issue) => this.matchesIssueQuery(issue, q))
      : issues;

    if (visibleGroups.length === 0 && visibleIssues.length === 0) {
      const hasAnyRaw =
        groups.some((g) => g.backlinks.length > 0 || g.status === "duplicate") || issues.length > 0;
      const emptyMsg =
        q && hasAnyRaw ? this.label("backlinks.noMatches") : this.t("backlinks.empty");
      bodyEl.appendChild(createDomEl("div", "org-backlinks-empty", emptyMsg));
      return;
    }

    if (visibleGroups.length > 0) {
      const groupsContainer = createDomEl("div", "org-backlinks-groups");
      for (const group of visibleGroups) {
        groupsContainer.appendChild(this.renderGroup(group));
      }
      bodyEl.appendChild(groupsContainer);
    }

    if (visibleIssues.length > 0) {
      bodyEl.appendChild(this.renderIssuesSection(visibleIssues));
    }
  }

  private renderGroup(group: OrgFileBacklinkGroup): HTMLElement {
    const { node, status, duplicatePeers, backlinks } = group;
    const key = this.groupKey(group);
    const isCollapsed = this.collapsedNodes.has(key);

    const groupEl = createDomEl(
      "section",
      `org-backlinks-group${isCollapsed ? " is-collapsed" : ""}${
        status === "duplicate" ? " is-duplicate" : ""
      }`
    );

    const nodeHeaderEl = createDomEl("div", "org-backlinks-node-header");
    const titleRowEl = createDomEl("div", "org-backlinks-node-title-row");

    const collapseBtn = createDomEl("button", "org-node-backlinks-collapse-btn");
    collapseBtn.type = "button";
    collapseBtn.setAttribute("aria-expanded", String(!isCollapsed));
    collapseBtn.textContent = isCollapsed ? "▸" : "▾";
    collapseBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.collapsedNodes.has(key)) this.collapsedNodes.delete(key);
      else this.collapsedNodes.add(key);
      this.renderBody();
    });
    titleRowEl.appendChild(collapseBtn);

    const nodeTitleLink = createDomEl("a", "org-backlinks-node-title", node.title);
    nodeTitleLink.href = "#";
    nodeTitleLink.addEventListener("click", (event) => {
      event.preventDefault();
      void this.host.vaultIndex?.openNode(node);
    });
    titleRowEl.appendChild(nodeTitleLink);

    if (node.id) {
      titleRowEl.appendChild(createDomEl("code", "org-backlinks-id-badge", node.id));
    }

    titleRowEl.appendChild(
      createDomEl("span", "org-node-backlinks-group-count", String(backlinks.length))
    );

    nodeHeaderEl.appendChild(titleRowEl);
    nodeHeaderEl.appendChild(
      createDomEl("div", "org-backlinks-node-breadcrumb", formatNodeBreadcrumb(node))
    );
    groupEl.appendChild(nodeHeaderEl);

    if (status === "duplicate" && duplicatePeers.length > 0) {
      const dupBanner = createDomEl("div", "org-node-backlinks-dup-warning");
      dupBanner.appendChild(
        createDomEl("div", "org-node-backlinks-dup-label", this.label("backlinks.duplicateWarning"))
      );
      const peerList = createDomEl("ul", "org-node-backlinks-dup-peers");
      for (const peer of duplicatePeers) {
        const peerLi = document.createElement("li");
        const peerLink = createDomEl(
          "a",
          "org-node-backlinks-peer-link",
          `${peer.filePath}:L${peer.line + 1} — ${peer.title}`
        );
        peerLink.href = "#";
        peerLink.addEventListener("click", (event) => {
          event.preventDefault();
          void this.host.vaultIndex?.openNode(peer);
        });
        peerLi.appendChild(peerLink);
        peerList.appendChild(peerLi);
      }
      dupBanner.appendChild(peerList);
      groupEl.appendChild(dupBanner);
    }

    if (!isCollapsed && backlinks.length > 0) {
      const listEl = createDomEl("ul", "org-backlinks-list");
      for (const entry of backlinks) {
        listEl.appendChild(this.renderBacklinkItem(entry));
      }
      groupEl.appendChild(listEl);
    }

    return groupEl;
  }

  private renderBacklinkItem(entry: OrgBacklinkEntry): HTMLElement {
    const { link, sourceHeadingPath, sourceNode, excerpt } = entry;
    const itemEl = createDomEl("li", "org-backlinks-item");
    const itemRowEl = createDomEl("div", "org-backlinks-item-row");

    const linkEl = createDomEl(
      "a",
      "org-backlinks-link",
      `${link.sourcePath}:${link.line + 1}`
    );
    linkEl.href = "#";
    linkEl.addEventListener("click", (event) => {
      event.preventDefault();
      void this.host.vaultIndex?.openLocation(link.sourcePath, link.line);
    });
    itemRowEl.appendChild(linkEl);

    const relation = link.relation ?? "link";
    itemRowEl.appendChild(
      createDomEl("span", `org-backlinks-relation is-${relation}`, relation)
    );

    if (link.desc) {
      itemRowEl.appendChild(createDomEl("span", "org-backlinks-desc", link.desc));
    }

    itemEl.appendChild(itemRowEl);

    const pathLabel =
      sourceHeadingPath.length > 0
        ? sourceHeadingPath.join(" › ")
        : this.label("backlinks.sourceRoot");
    const sourcePathEl = createDomEl("div", "org-node-backlinks-source-path", pathLabel);
    if (sourceNode?.id) {
      sourcePathEl.appendChild(
        createDomEl("code", "org-node-backlinks-source-id", sourceNode.id)
      );
    }
    itemEl.appendChild(sourcePathEl);

    if (this.showContext) {
      const ctxText = excerpt || link.context || "";
      if (ctxText) {
        itemEl.appendChild(createDomEl("div", "org-backlinks-context", ctxText));
      }
    }

    return itemEl;
  }

  private renderIssuesSection(issues: OrgFileLinkIssue[]): HTMLElement {
    const section = createDomEl(
      "section",
      `org-node-backlinks-issues${this.issuesCollapsed ? " is-collapsed" : ""}`
    );

    const header = createDomEl("div", "org-node-backlinks-issues-header");
    const collapseBtn = createDomEl("button", "org-node-backlinks-collapse-btn");
    collapseBtn.type = "button";
    collapseBtn.setAttribute("aria-expanded", String(!this.issuesCollapsed));
    collapseBtn.textContent = this.issuesCollapsed ? "▸" : "▾";
    collapseBtn.addEventListener("click", () => {
      this.issuesCollapsed = !this.issuesCollapsed;
      this.renderBody();
    });
    header.appendChild(collapseBtn);

    header.appendChild(
      createDomEl("span", "org-node-backlinks-issues-title", this.label("backlinks.issuesHeading"))
    );
    header.appendChild(
      createDomEl("span", "org-node-backlinks-group-count", String(issues.length))
    );
    section.appendChild(header);

    if (!this.issuesCollapsed) {
      const list = createDomEl("ul", "org-node-backlinks-issues-list");
      for (const issue of issues) {
        const li = createDomEl("li", `org-node-backlinks-issue is-${issue.kind}`);
        const row = createDomEl("div", "org-backlinks-item-row");

        const kindText =
          issue.kind === "broken"
            ? this.label("backlinks.issueBroken")
            : issue.kind === "duplicate"
            ? this.label("backlinks.issueDuplicate")
            : this.label("backlinks.issueInvalid");
        row.appendChild(createDomEl("span", `org-node-backlinks-issue-badge is-${issue.kind}`, kindText));

        const jumpLink = createDomEl(
          "a",
          "org-backlinks-link",
          `${issue.link.sourcePath}:${issue.link.line + 1}`
        );
        jumpLink.href = "#";
        jumpLink.addEventListener("click", (event) => {
          event.preventDefault();
          void this.host.vaultIndex?.openLocation(issue.link.sourcePath, issue.link.line);
        });
        row.appendChild(jumpLink);

        row.appendChild(
          createDomEl(
            "code",
            "org-node-backlinks-issue-target",
            issue.link.targetId || this.label("backlinks.emptyIdTarget")
          )
        );
        li.appendChild(row);

        if (issue.sourceHeadingPath.length > 0) {
          li.appendChild(
            createDomEl("div", "org-node-backlinks-source-path", issue.sourceHeadingPath.join(" › "))
          );
        }

        if (this.showContext && issue.link.context) {
          li.appendChild(createDomEl("div", "org-backlinks-context", issue.link.context));
        }
        list.appendChild(li);
      }
      section.appendChild(list);
    }

    return section;
  }

  private matchesBacklinkQuery(entry: OrgBacklinkEntry, q: string): boolean {
    const haystack = [
      entry.link.sourcePath,
      entry.link.targetId,
      entry.link.desc ?? "",
      entry.link.context ?? "",
      entry.excerpt,
      entry.sourceHeadingPath.join(" › "),
      entry.sourceNode?.id ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  }

  private matchesIssueQuery(issue: OrgFileLinkIssue, q: string): boolean {
    const haystack = [
      issue.kind,
      issue.link.sourcePath,
      issue.link.targetId,
      issue.link.context ?? "",
      issue.sourceHeadingPath.join(" › "),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  }

  private groupKey(group: OrgFileBacklinkGroup): string {
    return `${group.node.filePath}#${group.node.line}:${group.node.id ?? ""}`;
  }

  private updateTrackedIds(groups: OrgFileBacklinkGroup[]): void {
    this.trackedNodeIds = new Set<string>();
    for (const group of groups) {
      if (group.node.id) this.trackedNodeIds.add(group.node.id);
    }
    this.trackedOutgoingIds =
      this.targetFilePath && this.host.vaultIndex
        ? this.host.vaultIndex.index.getFileOutgoingTargetIds(this.targetFilePath)
        : new Set<string>();
  }

  private resolveActiveOrgFile(leaf?: WorkspaceLeaf | null): string | null | undefined {
    if (leaf && leaf.view === this) return undefined;

    const viewFile = (leaf?.view as { file?: TFile | null } | undefined)?.file;
    if (viewFile instanceof TFile) {
      return normalizeOrgPath(viewFile.path);
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      return normalizeOrgPath(activeFile.path);
    }

    return null;
  }

  private cleanupListeners(): void {
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = null;

    for (const ref of this.workspaceEventRefs) {
      this.app.workspace.offref(ref);
    }
    this.workspaceEventRefs = [];
  }
}
