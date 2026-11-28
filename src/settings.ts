import type { LanguageSetting } from "./i18n";
import type { OrgGraphViewState } from "./core/graph/types";
import type {
  OrgViewMode,
  PropertiesDisplayMode,
  ReadingLineHeightMode,
  ReadingWidthMode,
} from "./core/model/types";

export interface OrgNativeSettings {
  /** UI language for settings, actions, commands, and diagnostics. */
  language: LanguageSetting;
  /** Default view mode when opening a new .org file. */
  defaultMode: OrgViewMode;
  /** Extra Org TODO keywords: "active1 active2 | done1 done2". */
  todoKeywords: string;
  /** Render tables as HTML tables outside the cursor in Live Preview. */
  renderTables: boolean;
  /** Render inline and display math using Obsidian's MathJax. */
  renderMath: boolean;
  /** How :PROPERTIES: drawers and metadata cards display in Reading View. */
  propertiesDisplay: PropertiesDisplayMode;
  /** Honor #+STARTUP: overview / content / showall directives when opening. */
  honorStartup: boolean;
  /** Bridge Org headings into Obsidian's core Outline view (guarded internal API). */
  enableOutlineBridge: boolean;
  /** Reading view column width preset. */
  readingWidth: ReadingWidthMode;
  /** Reading view line-height rhythm preset. */
  readingLineHeight: ReadingLineHeightMode;
  /** Reading view font scale multiplier (0.85 to 1.25). */
  readingFontScale: number;
  /** Optimize CJK + Latin mixed typography wrapping and spacing. */
  cjkTypography: boolean;
  /** Join single newlines in prose (true) or preserve explicit line breaks as <br> (false). */
  strictLineBreaks: boolean;
  /** Expand read-only #+transclude: directives in Reading View. */
  enableTransclusion: boolean;
  /** Maximum nested #+transclude: recursion depth (1 to 8). */
  transclusionMaxDepth: number;
  /** Persisted UI state for Global Org Knowledge Graph view. */
  graphGlobalState?: Partial<OrgGraphViewState>;
  /** Persisted UI state for Local Org Knowledge Graph view. */
  graphLocalState?: Partial<OrgGraphViewState>;
}

export const DEFAULT_SETTINGS: OrgNativeSettings = {
  language: "auto",
  defaultMode: "reading",
  todoKeywords: "",
  renderTables: true,
  renderMath: true,
  propertiesDisplay: "collapsed",
  honorStartup: true,
  enableOutlineBridge: true,
  readingWidth: "normal",
  readingLineHeight: "comfortable",
  readingFontScale: 1.0,
  cjkTypography: true,
  strictLineBreaks: false,
  enableTransclusion: true,
  transclusionMaxDepth: 4,
};
