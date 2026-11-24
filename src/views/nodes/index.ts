import type { App, Plugin, WorkspaceLeaf } from "obsidian";
import { PLUGIN_ID, VIEW_TYPE_ORG_BACKLINKS } from "../../constants";
import type { VaultIndexService } from "../../core/index/vaultIndexService";
import { translate, type TranslationKey, type UiLanguage } from "../../i18n";
import { OrgBacklinksView, type OrgBacklinksHost } from "./OrgBacklinksView";
import {
  OrgNodeSwitcherModal,
  resolveNodeEntryForOpen,
  type OrgNodeSwitcherOptions,
  type OrgNodeSwitcherPluginLike,
} from "./OrgNodeSwitcherModal";
import {
  attachNodeHoverPreview,
  createHoverPreviewOptions,
  type NodeHoverPreviewOptions,
} from "./nodeHoverPreview";

export {
  OrgBacklinksView,
  type OrgBacklinksHost,
  OrgNodeSwitcherModal,
  resolveNodeEntryForOpen,
  type OrgNodeSwitcherOptions,
  type OrgNodeSwitcherPluginLike,
  attachNodeHoverPreview,
  createHoverPreviewOptions,
  type NodeHoverPreviewOptions,
};
export { nodeLabel, type NodeLabelKey } from "./nodeLabels";
export {
  extractNodePreview,
  extractNodePreviewDetail,
  formatContextExcerpt,
  formatHeadingHierarchy,
  formatNodeBreadcrumb,
  formatNodeLevelBadge,
  type NodePreviewDetail,
  type NodePreviewOptions,
} from "../../core/index/nodeUtils";

export interface RegisterNodeNavigationOptions {
  plugin: Plugin & {
    t?: (key: TranslationKey) => string;
    uiLanguage?: UiLanguage;
  };
  vaultIndex: VaultIndexService;
}

export interface NodeNavigationHandle {
  openNodeSwitcher: (options?: OrgNodeSwitcherOptions) => OrgNodeSwitcherModal;
  openBacklinksView: () => Promise<WorkspaceLeaf | null>;
  attachHoverPreview: (
    root: HTMLElement,
    overrides?: Partial<NodeHoverPreviewOptions>
  ) => () => void;
  getCommandNames: () => Record<string, string>;
  dispose: () => void;
}

/**
 * Reveal an existing Org Backlinks leaf or create one in the right sidebar.
 */
export async function activateOrgBacklinksView(app: App): Promise<WorkspaceLeaf | null> {
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_ORG_BACKLINKS);
  if (existing.length > 0) {
    app.workspace.revealLeaf(existing[0]);
    return existing[0];
  }

  const leaf = app.workspace.getRightLeaf(false) ?? app.workspace.getLeaf(true);
  if (!leaf) return null;

  await leaf.setViewState({
    type: VIEW_TYPE_ORG_BACKLINKS,
    active: true,
  });
  app.workspace.revealLeaf(leaf);
  return leaf;
}

/**
 * Self-contained registration helper for Lead Agent integration in `src/main.ts`
 * and `src/views/OrgView.ts`. Registers the Backlinks sidebar view, Node Switcher
 * & Backlinks commands, and tracks hover preview disposers for clean unload.
 */
export function registerNodeNavigation({
  plugin,
  vaultIndex,
}: RegisterNodeNavigationOptions): NodeNavigationHandle {
  const getLanguage = (): UiLanguage => plugin.uiLanguage ?? vaultIndex.getUiLanguage();
  const translateFn = (key: TranslationKey): string =>
    typeof plugin.t === "function" ? plugin.t(key) : translate(getLanguage(), key);

  const host: OrgBacklinksHost = {
    vaultIndex,
    get uiLanguage() {
      return getLanguage();
    },
    t: translateFn,
  };

  const hoverDisposers = new Set<() => void>();

  plugin.registerView(
    VIEW_TYPE_ORG_BACKLINKS,
    (leaf) => new OrgBacklinksView(leaf, host)
  );

  const openNodeSwitcher = (options?: OrgNodeSwitcherOptions): OrgNodeSwitcherModal => {
    const modal = new OrgNodeSwitcherModal(
      plugin.app,
      vaultIndex,
      { t: translateFn, uiLanguage: getLanguage() },
      options
    );
    modal.open();
    return modal;
  };

  const openBacklinksView = async (): Promise<WorkspaceLeaf | null> => {
    return activateOrgBacklinksView(plugin.app);
  };

  plugin.addCommand({
    id: "quick-open-node",
    name: translateFn("command.quickOpenNode"),
    callback: () => {
      openNodeSwitcher();
    },
  });

  plugin.addCommand({
    id: "open-backlinks",
    name: translateFn("command.openBacklinks"),
    callback: () => {
      void openBacklinksView();
    },
  });

  const attachHoverPreview = (
    root: HTMLElement,
    overrides: Partial<NodeHoverPreviewOptions> = {}
  ): (() => void) => {
    const disposer = attachNodeHoverPreview(
      root,
      createHoverPreviewOptions(vaultIndex, overrides)
    );
    hoverDisposers.add(disposer);
    return () => {
      hoverDisposers.delete(disposer);
      disposer();
    };
  };

  const getCommandNames = (): Record<string, string> => ({
    [`${PLUGIN_ID}:quick-open-node`]: translateFn("command.quickOpenNode"),
    [`${PLUGIN_ID}:open-backlinks`]: translateFn("command.openBacklinks"),
  });

  const dispose = (): void => {
    for (const disposer of Array.from(hoverDisposers)) {
      disposer();
    }
    hoverDisposers.clear();
    plugin.app.workspace.detachLeavesOfType(VIEW_TYPE_ORG_BACKLINKS);
  };

  return {
    openNodeSwitcher,
    openBacklinksView,
    attachHoverPreview,
    getCommandNames,
    dispose,
  };
}
