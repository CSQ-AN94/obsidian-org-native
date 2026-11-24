import type { DrawerData, OrgDoc, OrgSectionNode, OrgSectionTree } from "../model/types";

function stripInlineFormattingForTitle(raw: string): string {
  return raw
    .replace(/\[\[([^[\]]*?)\]\[([^[\]]*?)\]\]/g, "$2")
    .replace(/\[\[([^[\]]*?)\]\]/g, "$1")
    .replace(/[*_/+=~]/g, "")
    .trim();
}

function makeUniqueSlug(rawTitle: string, counts: Map<string, number>): string {
  const base =
    rawTitle
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const seen = (counts.get(base) ?? 0) + 1;
  counts.set(base, seen);
  return seen === 1 ? base : `${base}-${seen}`;
}

function extractPropsFromDrawer(drawer: DrawerData | undefined): {
  id?: string;
  customId?: string;
} {
  if (!drawer || drawer.name.toUpperCase() !== "PROPERTIES") return {};
  let id: string | undefined;
  let customId: string | undefined;
  for (const entry of drawer.entries) {
    const key = entry.key.toUpperCase();
    const val = entry.value.trim();
    if (!val) continue;
    if (key === "ID" && !id) id = val;
    else if (key === "CUSTOM_ID" && !customId) customId = val;
  }
  return { id, customId };
}

function findLeadingPropertiesDrawer(
  doc: OrgDoc,
  lineIndices: number[],
  allowKeywords: boolean
): DrawerData | undefined {
  for (const idx of lineIndices) {
    const line = doc.lines[idx];
    if (!line) continue;
    if (line.kind === "blank" || line.kind === "comment" || line.kind === "planning") {
      continue;
    }
    if (allowKeywords && line.kind === "keyword") {
      continue;
    }
    if (line.kind === "drawer-start" && line.drawer?.name.toUpperCase() === "PROPERTIES") {
      return line.drawer;
    }
    // Any other non-empty content means no immediate header property drawer.
    return undefined;
  }
  return undefined;
}

/**
 * Convert flat `OrgDoc.lines` into a hierarchical `OrgSectionTree`.
 * Preserves exact line bounds and extracts immediate `:PROPERTIES:` `:ID:` / `:CUSTOM_ID:`.
 */
export function buildSectionTree(doc: OrgDoc): OrgSectionTree {
  const preambleLines: number[] = [];
  const sections: OrgSectionNode[] = [];
  const stack: OrgSectionNode[] = [];
  const slugCounts = new Map<string, number>();

  for (const line of doc.lines) {
    if (line.kind === "heading" && line.heading) {
      while (stack.length > 0 && stack[stack.length - 1].level >= line.heading.level) {
        const finished = stack.pop()!;
        finished.endLineIndex = Math.max(finished.headingLineIndex, line.index - 1);
      }

      const rawTitle = line.text.slice(
        line.heading.titleFrom - line.from,
        line.heading.titleTo - line.from
      );
      const titleText = stripInlineFormattingForTitle(rawTitle);
      const slug = makeUniqueSlug(titleText, slugCounts);

      const node: OrgSectionNode = {
        headingLineIndex: line.index,
        endLineIndex: doc.lines.length - 1,
        level: line.heading.level,
        titleText,
        slug,
        bodyLines: [],
        children: [],
      };

      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else {
        sections.push(node);
      }
      stack.push(node);
    } else if (stack.length === 0) {
      preambleLines.push(line.index);
    } else {
      stack[stack.length - 1].bodyLines.push(line.index);
    }
  }

  while (stack.length > 0) {
    const finished = stack.pop()!;
    finished.endLineIndex = Math.max(finished.headingLineIndex, doc.lines.length - 1);
  }

  const fileDrawer = findLeadingPropertiesDrawer(doc, preambleLines, true);
  const fileProps = extractPropsFromDrawer(fileDrawer);

  const populateProps = (node: OrgSectionNode) => {
    const drawer = findLeadingPropertiesDrawer(doc, node.bodyLines, false);
    const props = extractPropsFromDrawer(drawer);
    node.id = props.id;
    node.customId = props.customId;
    if (drawer) {
      node.drawerStartLine = drawer.startLine;
      node.drawerEndLine = drawer.endLine ?? drawer.startLine;
    }
    for (const child of node.children) populateProps(child);
  };
  for (const s of sections) populateProps(s);

  return {
    preambleLines,
    fileId: fileProps.id,
    fileCustomId: fileProps.customId,
    fileDrawerStartLine: fileDrawer?.startLine,
    fileDrawerEndLine: fileDrawer?.endLine,
    sections,
  };
}
