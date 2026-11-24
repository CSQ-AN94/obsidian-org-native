import type { WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_ORG_GRAPH } from "../../constants";
import type { OrgIdIndex } from "../../core/index/orgIdIndex";
import type { VaultIndexService } from "../../core/index/vaultIndexService";
import { buildOrgGraph } from "../../core/graph/graphAdapter";
import {
  createDefaultGlobalGraphState,
  mergeGraphViewState,
  type OrgGraphData,
  type OrgGraphViewState,
} from "../../core/graph/types";
import { OrgGraphBaseView, type OrgGraphBaseHost } from "./OrgGraphBaseView";
import { ICON_ORG_GRAPH } from "../icons";

export interface OrgGlobalGraphHost extends Omit<OrgGraphBaseHost, "buildGraphData"> {
  vaultIndex: VaultIndexService;
  /** Optional custom builder for testing; defaults to `buildOrgGraph`. */
  buildGlobalGraph?: (state: OrgGraphViewState, index: OrgIdIndex) => OrgGraphData;
  initialState?: Partial<OrgGraphViewState>;
}

/**
 * Global Org Knowledge Graph ItemView supporting both Node and File granularities.
 */
export class OrgGlobalGraphView extends OrgGraphBaseView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly globalHost: OrgGlobalGraphHost
  ) {
    super(
      leaf,
      mergeGraphViewState(
        createDefaultGlobalGraphState(),
        globalHost.initialState
      ),
      globalHost
    );
  }

  getViewType(): string {
    return VIEW_TYPE_ORG_GRAPH;
  }

  getDisplayText(): string {
    return this.t("graph.globalTitle");
  }

  getIcon(): string {
    return ICON_ORG_GRAPH;
  }

  protected override buildGraphData(state: OrgGraphViewState): OrgGraphData {
    const idx = this.globalHost.vaultIndex.index;
    if (this.globalHost.buildGlobalGraph) {
      return this.globalHost.buildGlobalGraph(state, idx);
    }
    return buildOrgGraph(idx, {
      granularity: state.granularity,
      filter: state.filter,
      colorMode: state.colorMode,
      groups: state.groups,
    });
  }
}
