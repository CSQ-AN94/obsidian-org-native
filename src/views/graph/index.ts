import type { App, Plugin, WorkspaceLeaf } from "obsidian";
import {
  PLUGIN_ID,
  VIEW_TYPE_ORG,
  VIEW_TYPE_ORG_GRAPH,
  VIEW_TYPE_ORG_LOCAL_GRAPH,
} from "../../constants";
import type { OrgGraphNode, OrgGraphViewState } from "../../core/graph/types";
import { buildOrgGraph } from "../../core/graph/graphAdapter";
import { buildLocalOrgGraph } from "../../core/graph/localGraph";
import type { VaultIndexService } from "../../core/index/vaultIndexService";
import { translate, type TranslationKey, type UiLanguage } from "../../i18n";
import type { OrgNativeSettings } from "../../settings";
import { OrgGlobalGraphView, type OrgGlobalGraphHost } from "./OrgGlobalGraphView";
import { OrgGraphBaseView, type OrgGraphBaseHost } from "./OrgGraphBaseView";
import { OrgGraphCanvasRenderer, resolveGraphTheme } from "./canvasRenderer";
import { OrgGraphControls } from "./graphControls";
import {
  OrgLocalGraphView,
  type OrgLocalGraphHost,
} from "./OrgLocalGraphView";
import {
  LocalGraphController,
  resolveGraphNodeToOpenTarget,
} from "./localGraphController";
import { OrgReaderFocusBus } from "./readerFocusBus";
import { OrgGraphSimulation } from "./simulation";
import { ICON_ORG_GRAPH } from "../icons";

export {
  OrgGraphBaseView,
  OrgGlobalGraphView,
  OrgLocalGraphView,
  OrgGraphCanvasRenderer,
  OrgGraphControls,
  OrgGraphSimulation,
  LocalGraphController,
  OrgReaderFocusBus,
  resolveGraphNodeToOpenTarget,
  resolveGraphTheme,
  type OrgGraphBaseHost,
  type OrgGlobalGraphHost,
  type OrgLocalGraphHost,
};

export interface RegisterOrgGraphOptions {
  plugin: Plugin & {
    settings: OrgNativeSettings;
    t?: (key: TranslationKey) => string;
    uiLanguage?: UiLanguage;
    saveData: (data: unknown) => Promise<void>;
  };
  vaultIndex: VaultIndexService;
}

export interface OrgGraphHandle {
  focusBus: OrgReaderFocusBus;
  openGlobalGraph: () => Promise<WorkspaceLeaf | null>;
  openLocalGraph: (options?: {
    focusNodeKey?: string;
    filePath?: string | null;
  }) => Promise<WorkspaceLeaf | null>;
  focusActiveNodeInLocalGraph: () => Promise<WorkspaceLeaf | null>;
  getCommandNames: () => Record<string, string>;
  dispose: () => void;
}

export async function activateOrgGlobalGraphView(
  app: App
): Promise<WorkspaceLeaf | null> {
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_ORG_GRAPH);
  if (existing.length > 0) {
    app.workspace.revealLeaf(existing[0]);
    return existing[0];
  }

  const ws = app.workspace as {
    getLeaf: (newLeaf?: boolean | "tab" | "split" | "window") => WorkspaceLeaf;
  };
  const leaf = ws.getLeaf("tab") ?? ws.getLeaf(true);
  if (!leaf) return null;

  await leaf.setViewState({
    type: VIEW_TYPE_ORG_GRAPH,
    active: true,
  });
  app.workspace.revealLeaf(leaf);
  return leaf;
}

export async function activateOrgLocalGraphView(
  app: App
): Promise<WorkspaceLeaf | null> {
  const existing = app.workspace.getLeavesOfType(VIEW_TYPE_ORG_LOCAL_GRAPH);
  if (existing.length > 0) {
    app.workspace.revealLeaf(existing[0]);
    return existing[0];
  }

  const leaf = app.workspace.getRightLeaf(false) ?? app.workspace.getLeaf(true);
  if (!leaf) return null;

  await leaf.setViewState({
    type: VIEW_TYPE_ORG_LOCAL_GRAPH,
    active: true,
  });
  app.workspace.revealLeaf(leaf);
  return leaf;
}

/**
 * Registers built-in Global and Local Org Knowledge Graph ItemViews,
 * commands, ribbon launcher, and shared `OrgReaderFocusBus`.
 */
export function registerOrgGraph({
  plugin,
  vaultIndex,
}: RegisterOrgGraphOptions): OrgGraphHandle {
  const focusBus = new OrgReaderFocusBus();
  const getLanguage = (): UiLanguage =>
    plugin.uiLanguage ?? vaultIndex.getUiLanguage();
  const translateFn = (key: TranslationKey): string =>
    typeof plugin.t === "function" ? plugin.t(key) : translate(getLanguage(), key);

  const persistGlobalState = async (state: OrgGraphViewState): Promise<void> => {
    plugin.settings.graphGlobalState = state;
    await plugin.saveData(plugin.settings);
  };

  const persistLocalState = async (state: OrgGraphViewState): Promise<void> => {
    plugin.settings.graphLocalState = state;
    await plugin.saveData(plugin.settings);
  };

  const focusGraphNodeInLocalGraph = async (node: OrgGraphNode): Promise<void> => {
    await openLocalGraph({
      focusNodeKey: node.id,
      filePath: node.filePath || null,
    });
  };

  const openGlobalGraph = async (): Promise<WorkspaceLeaf | null> => {
    return activateOrgGlobalGraphView(plugin.app);
  };

  const openLocalGraph = async (options?: {
    focusNodeKey?: string;
    filePath?: string | null;
  }): Promise<WorkspaceLeaf | null> => {
    const leaf = await activateOrgLocalGraphView(plugin.app);
    const view = leaf?.view;
    if (options?.focusNodeKey && view instanceof OrgLocalGraphView) {
      view.focusNode(options.focusNodeKey, options.filePath);
    }
    return leaf;
  };

  const focusActiveNodeInLocalGraph = async (): Promise<WorkspaceLeaf | null> => {
    const activeLeaf = (
      plugin.app.workspace as { activeLeaf?: WorkspaceLeaf | null }
    ).activeLeaf;
    const view = activeLeaf?.view as
      | {
          getViewType?: () => string;
          file?: { path?: string } | null;
          getEphemeralState?: () => { line?: number };
        }
      | undefined;

    if (view?.getViewType?.() === VIEW_TYPE_ORG && view.file?.path) {
      const line = view.getEphemeralState?.()?.line ?? 0;
      const focusEvent = focusBus.resolveFocusForFileLine(
        vaultIndex.index,
        view.file.path,
        line,
        "manual"
      );
      focusBus.emit(focusEvent);
      return openLocalGraph(
        focusEvent.nodeKey
          ? { focusNodeKey: focusEvent.nodeKey, filePath: focusEvent.filePath }
          : undefined
      );
    }

    const activeFile = plugin.app.workspace.getActiveFile?.();
    if (activeFile?.path.toLowerCase().endsWith(".org")) {
      const focusEvent = focusBus.resolveFocusForFileLine(
        vaultIndex.index,
        activeFile.path,
        0,
        "manual"
      );
      focusBus.emit(focusEvent);
      return openLocalGraph(
        focusEvent.nodeKey
          ? { focusNodeKey: focusEvent.nodeKey, filePath: focusEvent.filePath }
          : undefined
      );
    }

    return openLocalGraph();
  };

  plugin.registerView(VIEW_TYPE_ORG_GRAPH, (leaf) => {
    return new OrgGlobalGraphView(leaf, {
      vaultIndex,
      t: translateFn,
      uiLanguage: getLanguage,
      initialState: plugin.settings.graphGlobalState,
      buildGlobalGraph: (state, index) =>
        buildOrgGraph(index, {
          granularity: state.granularity,
          filter: state.filter,
          colorMode: state.colorMode,
          groups: state.groups,
        }),
      focusInLocalGraph: focusGraphNodeInLocalGraph,
      saveState: persistGlobalState,
    });
  });

  plugin.registerView(VIEW_TYPE_ORG_LOCAL_GRAPH, (leaf) => {
    return new OrgLocalGraphView(leaf, {
      vaultIndex,
      focusBus,
      t: translateFn,
      uiLanguage: getLanguage,
      initialState: plugin.settings.graphLocalState,
      buildLocalGraph: (state, localState, index) =>
        buildLocalOrgGraph(index, {
          centerNodeId: localState.centerNodeId,
          centerFilePath: localState.centerFilePath,
          granularity: state.granularity,
          depth: localState.depth,
          showIncoming: localState.showIncoming,
          showOutgoing: localState.showOutgoing,
          filter: state.filter,
          colorMode: state.colorMode,
          groups: state.groups,
        }),
      focusInLocalGraph: focusGraphNodeInLocalGraph,
      saveState: persistLocalState,
    });
  });

  plugin.addCommand({
    id: "open-global-graph",
    name: translateFn("command.openGlobalGraph"),
    callback: () => {
      void openGlobalGraph();
    },
  });

  plugin.addCommand({
    id: "open-local-graph",
    name: translateFn("command.openLocalGraph"),
    callback: () => {
      void focusActiveNodeInLocalGraph();
    },
  });

  plugin.addCommand({
    id: "focus-local-graph",
    name: translateFn("command.focusLocalGraph"),
    callback: () => {
      void focusActiveNodeInLocalGraph();
    },
  });

  plugin.addRibbonIcon?.(ICON_ORG_GRAPH, translateFn("command.openGlobalGraph"), () => {
    void openGlobalGraph();
  });

  const getCommandNames = (): Record<string, string> => ({
    [`${PLUGIN_ID}:open-global-graph`]: translateFn("command.openGlobalGraph"),
    [`${PLUGIN_ID}:open-local-graph`]: translateFn("command.openLocalGraph"),
    [`${PLUGIN_ID}:focus-local-graph`]: translateFn("command.focusLocalGraph"),
  });

  const dispose = (): void => {
    focusBus.clear();
    plugin.app.workspace.detachLeavesOfType(VIEW_TYPE_ORG_GRAPH);
    plugin.app.workspace.detachLeavesOfType(VIEW_TYPE_ORG_LOCAL_GRAPH);
  };

  return {
    focusBus,
    openGlobalGraph,
    openLocalGraph,
    focusActiveNodeInLocalGraph,
    getCommandNames,
    dispose,
  };
}
