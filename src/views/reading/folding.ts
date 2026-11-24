import type { FoldLevelMode } from "../../core/model/types";

export interface ReadingFoldSnapshot {
  folded: Set<number>;
  bodyFolded: Set<number>;
  foldedKeys?: Set<string>;
  bodyFoldedKeys?: Set<string>;
  drawerStates?: Map<string, boolean>;
}

function sectionStableKey(sec: HTMLElement): string | null {
  const orgId = sec.dataset.orgId?.trim();
  if (orgId) return `id:${orgId}`;
  const customId = sec.dataset.customId?.trim();
  if (customId) return `custom:${customId}`;
  const slug = sec.dataset.slug?.trim();
  if (slug) return `slug:${slug}`;
  return null;
}

function syncSectionFoldState(sectionEl: HTMLElement): void {
  const children = Array.from(sectionEl.children);
  const heading = children.find((el): el is HTMLElement =>
    el.classList.contains("org-heading-preview")
  );
  if (!heading) return;

  const bodyEl = children.find((el) => el.classList.contains("org-section-body"));
  const childrenEl = children.find((el) => el.classList.contains("org-section-children"));
  const childCount = childrenEl
    ? Array.from(childrenEl.children).filter((el) => el.classList.contains("org-section")).length
    : 0;

  const isFolded = sectionEl.classList.contains("is-folded");
  const isBodyFolded = sectionEl.classList.contains("is-body-folded");
  const collapsed = isFolded || isBodyFolded;

  const btn = heading.querySelector<HTMLButtonElement>(".org-fold-btn");
  if (btn) {
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.classList.toggle("is-collapsed", collapsed);
  }

  const ellipsis = heading.querySelector<HTMLButtonElement>(".org-fold-ellipsis");
  if (ellipsis) {
    ellipsis.setAttribute("aria-hidden", collapsed ? "false" : "true");
    ellipsis.tabIndex = collapsed ? 0 : -1;
  }

  if (isFolded && (bodyEl || childCount > 0)) {
    heading.dataset.foldedSummary = childCount > 0 ? `⋯ ${childCount}` : "⋯";
  } else if (isBodyFolded && bodyEl) {
    heading.dataset.foldedSummary = "⋯";
  } else {
    delete heading.dataset.foldedSummary;
  }
}

/** Unfold a single Reading View section cleanly. */
export function unfoldReadingSection(sectionEl: HTMLElement): void {
  sectionEl.classList.remove("is-folded", "is-body-folded");
  syncSectionFoldState(sectionEl);
}

/** Toggle a single Reading View section between folded and unfolded. */
export function toggleReadingSection(sectionEl: HTMLElement): boolean {
  if (sectionEl.classList.contains("is-folded")) {
    sectionEl.classList.remove("is-folded");
    sectionEl.classList.remove("is-body-folded");
    syncSectionFoldState(sectionEl);
    return false;
  }
  if (sectionEl.classList.contains("is-body-folded")) {
    sectionEl.classList.remove("is-body-folded");
    syncSectionFoldState(sectionEl);
    return false;
  }
  sectionEl.classList.add("is-folded");
  syncSectionFoldState(sectionEl);
  return true;
}

/** Apply document-wide folding mode (`overview`, `content`, or `all`). */
export function setReadingFoldLevel(root: HTMLElement, mode: FoldLevelMode): void {
  const sections = Array.from(root.querySelectorAll<HTMLElement>(".org-section"));
  for (const sec of sections) {
    sec.classList.remove("is-folded", "is-body-folded");
    if (mode === "overview") {
      const isTopLevel = !sec.parentElement?.closest(".org-section");
      if (isTopLevel) sec.classList.add("is-folded");
    } else if (mode === "content") {
      sec.classList.add("is-body-folded");
    }
    syncSectionFoldState(sec);
  }
}

/** Apply Org `#+STARTUP:` fold directives if present. */
export function applyStartupFolding(root: HTMLElement, startup: string[]): void {
  let mode: FoldLevelMode | null = null;
  for (const token of startup) {
    const t = token.toLowerCase();
    if (t === "overview") mode = "overview";
    else if (t === "content") mode = "content";
    else if (t === "showall" || t === "showeverything" || t === "nofold") mode = "all";
  }
  if (mode) setReadingFoldLevel(root, mode);
}

/**
 * Unfold all ancestor sections covering `lineIndex` so the target section
 * or line becomes visible, returning the target element if found.
 */
export function revealReadingLine(root: HTMLElement, lineIndex: number): HTMLElement | null {
  const sections = Array.from(root.querySelectorAll<HTMLElement>(".org-section"));
  let best: HTMLElement | null = null;
  for (const sec of sections) {
    const start = Number(sec.dataset.line);
    const end = Number(sec.dataset.endLine);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (lineIndex >= start && lineIndex <= end) {
      best = sec;
    }
  }
  if (!best) return null;

  let cur: HTMLElement | null = best;
  while (cur) {
    if (cur.classList.contains("org-section")) {
      cur.classList.remove("is-folded", "is-body-folded");
      syncSectionFoldState(cur);
    }
    cur = cur.parentElement;
  }
  return best;
}

/** Capture folded heading line indices, stable keys, and drawer open states prior to a re-render. */
export function getReadingFoldSnapshot(root: HTMLElement): ReadingFoldSnapshot {
  const folded = new Set<number>();
  const bodyFolded = new Set<number>();
  const foldedKeys = new Set<string>();
  const bodyFoldedKeys = new Set<string>();
  const drawerStates = new Map<string, boolean>();

  for (const sec of root.querySelectorAll<HTMLElement>(".org-section")) {
    const line = Number(sec.dataset.line);
    const key = sectionStableKey(sec);
    if (sec.classList.contains("is-folded")) {
      if (Number.isFinite(line)) folded.add(line);
      if (key) foldedKeys.add(key);
    } else if (sec.classList.contains("is-body-folded")) {
      if (Number.isFinite(line)) bodyFolded.add(line);
      if (key) bodyFoldedKeys.add(key);
    }
  }

  for (const details of root.querySelectorAll<HTMLDetailsElement>(
    "details.org-properties[data-drawer-key]"
  )) {
    const drawerKey = details.dataset.drawerKey;
    if (drawerKey) drawerStates.set(drawerKey, details.open);
  }

  return { folded, bodyFolded, foldedKeys, bodyFoldedKeys, drawerStates };
}

/** Restore folded heading state and property drawer open states after a re-render. */
export function restoreReadingFoldSnapshot(
  root: HTMLElement,
  snapshot: ReadingFoldSnapshot
): void {
  const hasKeySets = snapshot.foldedKeys !== undefined && snapshot.bodyFoldedKeys !== undefined;

  for (const sec of root.querySelectorAll<HTMLElement>(".org-section")) {
    const line = Number(sec.dataset.line);
    const key = sectionStableKey(sec);
    sec.classList.remove("is-folded", "is-body-folded");

    let isFolded = false;
    let isBodyFolded = false;
    if (hasKeySets && key) {
      isFolded = snapshot.foldedKeys!.has(key);
      isBodyFolded = !isFolded && snapshot.bodyFoldedKeys!.has(key);
    } else if (Number.isFinite(line)) {
      isFolded = snapshot.folded.has(line);
      isBodyFolded = !isFolded && snapshot.bodyFolded.has(line);
    }

    if (isFolded) sec.classList.add("is-folded");
    else if (isBodyFolded) sec.classList.add("is-body-folded");
    syncSectionFoldState(sec);
  }

  if (snapshot.drawerStates && snapshot.drawerStates.size > 0) {
    for (const details of root.querySelectorAll<HTMLDetailsElement>(
      "details.org-properties[data-drawer-key]"
    )) {
      const drawerKey = details.dataset.drawerKey;
      if (drawerKey && snapshot.drawerStates.has(drawerKey)) {
        details.open = snapshot.drawerStates.get(drawerKey)!;
      }
    }
  }
}
