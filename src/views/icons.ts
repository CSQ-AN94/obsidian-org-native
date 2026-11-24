import { addIcon } from "obsidian";

export const ICON_ORG_GRAPH = "org-native-graph";
export const ICON_ORG_LOCAL_GRAPH = "org-native-local-graph";
export const ICON_ORG_BACKLINKS = "org-native-backlinks";

/**
 * Custom 100x100 Lucide-weight SVG icons for Org Native.
 * Explicit inline `style="stroke-width: 7.5"` prevents Obsidian's `.svg-icon`
 * CSS (`--icon-stroke` calibrated for 24x24 Lucide viewBoxes) from thinning strokes.
 */
export const ORG_NATIVE_ICONS: Readonly<Record<string, string>> = {
  // Asymmetric 4-node Org constellation with bullseye hub + dashed transclusion arc
  [ICON_ORG_GRAPH]: [
    `<g fill="none" stroke="currentColor" stroke-width="7.5" style="stroke-width: 7.5" stroke-linecap="round" stroke-linejoin="round">`,
    `<line x1="26" y1="31" x2="30" y2="43" />`,
    `<line x1="45" y1="48" x2="68" y2="30" />`,
    `<line x1="46" y1="62" x2="66" y2="72" />`,
    `<line x1="77" y1="38" x2="76" y2="63" stroke-dasharray="7 8" />`,
    `<circle cx="34" cy="56" r="13" />`,
    `<circle cx="34" cy="56" r="4.2" fill="currentColor" stroke="none" style="stroke: none" />`,
    `<circle cx="23" cy="21" r="10" />`,
    `<circle cx="77" cy="24" r="10.5" />`,
    `<circle cx="76" cy="77" r="10.5" />`,
    `</g>`,
  ].join(""),

  // Centered bullseye Org focus node with 3 radial neighbor spokes
  [ICON_ORG_LOCAL_GRAPH]: [
    `<g fill="none" stroke="currentColor" stroke-width="7.5" style="stroke-width: 7.5" stroke-linecap="round" stroke-linejoin="round">`,
    `<line x1="50" y1="26" x2="50" y2="38" />`,
    `<line x1="26" y1="70" x2="39" y2="60" />`,
    `<line x1="74" y1="70" x2="61" y2="60" />`,
    `<circle cx="50" cy="52" r="14" />`,
    `<circle cx="50" cy="52" r="5" fill="currentColor" stroke="none" style="stroke: none" />`,
    `<circle cx="50" cy="17" r="8.5" />`,
    `<circle cx="19" cy="75" r="8.5" />`,
    `<circle cx="81" cy="75" r="8.5" />`,
    `</g>`,
  ].join(""),

  // Right bullseye target node receiving primary horizontal arrow + two curved neighbor incoming arcs
  [ICON_ORG_BACKLINKS]: [
    `<g fill="none" stroke="currentColor" stroke-width="7.5" style="stroke-width: 7.5" stroke-linecap="round" stroke-linejoin="round">`,
    `<line x1="12" y1="50" x2="50" y2="50" />`,
    `<polyline points="40,39 51,50 40,61" />`,
    `<path d="M 28 21 Q 50 21 63 37" />`,
    `<path d="M 28 79 Q 50 79 63 63" />`,
    `<circle cx="21" cy="21" r="7" />`,
    `<circle cx="21" cy="79" r="7" />`,
    `<circle cx="74" cy="50" r="14" />`,
    `<circle cx="74" cy="50" r="4.5" fill="currentColor" stroke="none" style="stroke: none" />`,
    `</g>`,
  ].join(""),
};

/**
 * Registers all Org Native custom icons via Obsidian's `addIcon` API.
 */
export function registerOrgNativeIcons(): void {
  if (typeof addIcon !== "function") {
    return;
  }
  for (const [iconId, svgContent] of Object.entries(ORG_NATIVE_ICONS)) {
    addIcon(iconId, svgContent);
  }
}
