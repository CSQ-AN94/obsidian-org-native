import { App, FuzzyMatch, FuzzySuggestModal } from "obsidian";
import {
  formatNodeBreadcrumb,
  formatNodeLevelBadge,
} from "../../core/index/nodeUtils";
import type { OrgIdIndex } from "../../core/index/orgIdIndex";
import type { VaultIndexService } from "../../core/index/vaultIndexService";
import type { OrgNodeEntry, OrgViewMode } from "../../core/model/types";
import { resolveLanguage, translate, type TranslationKey, type UiLanguage } from "../../i18n";
import type OrgNativePlugin from "../../main";
import { nodeLabel } from "./nodeLabels";

export interface OrgNodeSwitcherPluginLike {
  vaultIndex: VaultIndexService;
  t: (key: TranslationKey) => string;
  uiLanguage?: UiLanguage;
}

export interface OrgNodeSwitcherOptions {
  /** When true, list only nodes carrying `:ID:` (excluding `:CUSTOM_ID:`-only headings). */
  idOnly?: boolean;
  /** Optional preferred view mode when opening a selected node. */
  preferredMode?: OrgViewMode;
}

/**
 * Re-resolve a previously indexed node entry against the live `OrgIdIndex` so that
 * nodes moved across files or renamed headings still open at their latest location.
 */
export function resolveNodeEntryForOpen(
  index: OrgIdIndex,
  item: OrgNodeEntry
): OrgNodeEntry | null {
  if (item.id) {
    const res = index.resolveId(item.id);
    if (res.status === "found") return res.node;
    if (res.status === "duplicate") {
      return (
        res.nodes.find((n) => n.filePath === item.filePath && n.line === item.line) ??
        res.nodes.find((n) => n.filePath === item.filePath) ??
        res.nodes[0]
      );
    }
    return null;
  }

  if (item.customId) {
    const res = index.resolveCustomId(item.customId, item.filePath);
    if (res.status === "found") return res.node;
    if (res.status === "duplicate") {
      return (
        res.nodes.find((n) => n.filePath === item.filePath && n.line === item.line) ??
        res.nodes[0]
      );
    }
    return null;
  }

  return item;
}

export class OrgNodeSwitcherModal extends FuzzySuggestModal<OrgNodeEntry> {
  private readonly vaultIndex: VaultIndexService;
  private readonly translateFn: (key: TranslationKey) => string;
  private readonly uiLanguage: UiLanguage;
  private readonly idOnly: boolean;
  private readonly preferredMode?: OrgViewMode;

  constructor(app: App, plugin: OrgNativePlugin, options?: OrgNodeSwitcherOptions);
  constructor(
    app: App,
    vaultIndex: VaultIndexService,
    plugin?: Pick<OrgNativePlugin, "t"> & { uiLanguage?: UiLanguage },
    options?: OrgNodeSwitcherOptions
  );
  constructor(
    app: App,
    pluginOrIndex: OrgNativePlugin | OrgNodeSwitcherPluginLike | VaultIndexService,
    maybePluginOrOptions?:
      | (Pick<OrgNativePlugin, "t"> & { uiLanguage?: UiLanguage })
      | OrgNodeSwitcherOptions,
    maybeOptions?: OrgNodeSwitcherOptions
  ) {
    super(app);

    let resolvedPlugin: (Pick<OrgNativePlugin, "t"> & { uiLanguage?: UiLanguage }) | undefined;
    let opts: OrgNodeSwitcherOptions = {};

    if ("index" in pluginOrIndex) {
      this.vaultIndex = pluginOrIndex;
      if (maybePluginOrOptions && "t" in maybePluginOrOptions) {
        resolvedPlugin = maybePluginOrOptions;
        opts = maybeOptions ?? {};
      } else {
        opts = (maybePluginOrOptions as OrgNodeSwitcherOptions | undefined) ?? {};
      }
      this.uiLanguage = resolvedPlugin?.uiLanguage ?? pluginOrIndex.getUiLanguage();
      this.translateFn = resolvedPlugin
        ? (key) => resolvedPlugin!.t(key)
        : (key) => translate(this.uiLanguage, key);
    } else {
      this.vaultIndex = pluginOrIndex.vaultIndex;
      this.uiLanguage =
        pluginOrIndex.uiLanguage ??
        pluginOrIndex.vaultIndex?.getUiLanguage?.() ??
        resolveLanguage("auto");
      this.translateFn = (key) => pluginOrIndex.t(key);
      opts = (maybePluginOrOptions as OrgNodeSwitcherOptions | undefined) ?? {};
    }

    this.idOnly = opts.idOnly ?? false;
    this.preferredMode = opts.preferredMode;

    this.setPlaceholder(this.translateFn("switcher.placeholder"));
    this.emptyStateText = this.translateFn("switcher.empty");
  }

  getItems(): OrgNodeEntry[] {
    return this.vaultIndex.index
      .getAllNodes()
      .filter((node) => (this.idOnly ? Boolean(node.id) : Boolean(node.id || node.customId)));
  }

  searchNodes(query: string): OrgNodeEntry[] {
    return this.vaultIndex.index
      .searchNodes(query)
      .filter((node) => (this.idOnly ? Boolean(node.id) : Boolean(node.id || node.customId)));
  }

  getItemText(item: OrgNodeEntry): string {
    const parts = [
      item.title,
      item.headingPath.join(" › "),
      item.headingPath.join(" / "),
      item.filePath,
      item.id ?? "",
      item.customId ?? "",
    ].filter((part) => part.length > 0);
    return parts.join(" · ");
  }

  renderSuggestion(match: FuzzyMatch<OrgNodeEntry>, el: HTMLElement): void {
    const item = match.item;
    el.replaceChildren();

    const container = document.createElement("div");
    container.className = "org-node-switcher-item";

    const topRow = document.createElement("div");
    topRow.className = "org-node-switcher-top";

    const levelEl = document.createElement("span");
    levelEl.className = `org-node-switcher-level is-level-${item.level}`;
    levelEl.textContent =
      item.level <= 0 ? nodeLabel(this.uiLanguage, "switcher.fileLevel") : formatNodeLevelBadge(item);
    topRow.appendChild(levelEl);

    const titleEl = document.createElement("span");
    titleEl.className = "org-node-switcher-title";
    titleEl.textContent = item.title;
    topRow.appendChild(titleEl);

    const status = item.id ? this.vaultIndex.index.getNodeStatus(item.id) : "found";
    if (status === "duplicate") {
      const dupBadge = document.createElement("span");
      dupBadge.className = "org-node-switcher-badge org-node-switcher-badge-dup";
      dupBadge.textContent = nodeLabel(this.uiLanguage, "switcher.duplicateBadge");
      topRow.appendChild(dupBadge);
    }

    if (item.id || item.customId) {
      const badgesEl = document.createElement("span");
      badgesEl.className = "org-node-switcher-badges";

      if (item.id) {
        const idBadge = document.createElement("code");
        idBadge.className = "org-node-switcher-badge org-node-switcher-id";
        idBadge.textContent = `ID: ${item.id}`;
        badgesEl.appendChild(idBadge);
      }

      if (item.customId) {
        const customBadge = document.createElement("code");
        customBadge.className = "org-node-switcher-badge org-node-switcher-custom-id";
        customBadge.textContent = `#${item.customId}`;
        badgesEl.appendChild(customBadge);
      }

      topRow.appendChild(badgesEl);
    }

    const metaRow = document.createElement("div");
    metaRow.className = "org-node-switcher-meta-row";

    const breadcrumbEl = document.createElement("span");
    breadcrumbEl.className = "org-node-switcher-breadcrumb";
    breadcrumbEl.textContent = formatNodeBreadcrumb(item);
    metaRow.appendChild(breadcrumbEl);

    const lineEl = document.createElement("span");
    lineEl.className = "org-node-switcher-line";
    lineEl.textContent = `L${item.line + 1}`;
    metaRow.appendChild(lineEl);

    container.appendChild(topRow);
    container.appendChild(metaRow);
    el.appendChild(container);
  }

  onChooseItem(item: OrgNodeEntry, _evt: MouseEvent | KeyboardEvent): void {
    const resolved = resolveNodeEntryForOpen(this.vaultIndex.index, item);
    if (resolved) {
      if (this.preferredMode !== undefined) {
        void this.vaultIndex.openNode(resolved, this.preferredMode);
      } else {
        void this.vaultIndex.openNode(resolved);
      }
      return;
    }

    if (item.id) {
      if (this.preferredMode !== undefined) {
        void this.vaultIndex.navigateToId(item.id, this.preferredMode);
      } else {
        void this.vaultIndex.navigateToId(item.id);
      }
      return;
    }

    if (this.preferredMode !== undefined) {
      void this.vaultIndex.openNode(item, this.preferredMode);
    } else {
      void this.vaultIndex.openNode(item);
    }
  }
}
