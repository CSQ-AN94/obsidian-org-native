import {
  extractNodePreviewDetail,
  formatHeadingHierarchy,
  formatNodeBreadcrumb,
  formatNodeLevelBadge,
} from "../../core/index/nodeUtils";
import type { IdResolution } from "../../core/index/orgIdIndex";
import type { VaultIndexService } from "../../core/index/vaultIndexService";
import type { OrgNodeEntry } from "../../core/model/types";
import type { UiLanguage } from "../../i18n";
import { parseOrgIdTarget } from "../../util/links";
import { nodeLabel, type NodeLabelKey } from "./nodeLabels";

export interface NodeHoverPreviewOptions {
  resolveId: (id: string) => IdResolution;
  readFile: (filePath: string) => Promise<string | null> | string | null;
  onOpenNode?: (node: OrgNodeEntry) => Promise<void> | void;
  onMissingId?: (id: string, anchor: HTMLElement) => void;
  language?: UiLanguage;
  hoverDelayMs?: number;
  /** Alias for `hoverDelayMs`. */
  delayMs?: number;
  hideDelayMs?: number;
  maxLines?: number;
  /** Alias for `maxLines`. */
  maxPreviewLines?: number;
  maxChars?: number;
  hostContainer?: HTMLElement;
  /** Alias for `hostContainer`. */
  container?: HTMLElement;
}

export function createHoverPreviewOptions(
  service: VaultIndexService,
  overrides: Partial<NodeHoverPreviewOptions> = {}
): NodeHoverPreviewOptions {
  return {
    resolveId: (id) => service.index.resolveId(id),
    readFile: (filePath) => service.readFileReadOnly(filePath),
    onOpenNode: (node) => service.openNode(node),
    onMissingId: (id) => {
      service.recordNodeNotFound(id, "id-not-indexed");
    },
    language: service.getUiLanguage(),
    ...overrides,
  };
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function findIdAnchor(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const candidate = target.closest<HTMLElement>("a.org-link-id[data-org-id], .org-link-id");
  if (!candidate || !root.contains(candidate)) return null;
  return candidate;
}

function extractOrgIdFromAnchor(anchor: HTMLElement): string | null {
  const direct = anchor.dataset.orgId;
  if (direct !== undefined) {
    return direct.trim();
  }
  const dataHref = anchor.dataset.href ?? anchor.getAttribute("href") ?? "";
  const fromHref = parseOrgIdTarget(dataHref.replace(/^#/, ""));
  if (fromHref !== null) return fromHref;

  const title = anchor.getAttribute("title") ?? "";
  const fromTitle = /^(?:Missing Org ID:|Duplicate Org ID:|Org ID:)\s*(.+)$/i.exec(title);
  if (fromTitle) {
    const raw = fromTitle[1].trim();
    return parseOrgIdTarget(raw) ?? raw;
  }
  return parseOrgIdTarget(title);
}

/**
 * Attach a strictly read-only, non-executing hover/focus preview popover
 * for `[[id:...]]` links inside `root`.
 */
export function attachNodeHoverPreview(
  root: HTMLElement,
  options: NodeHoverPreviewOptions
): () => void {
  const doc = root.ownerDocument ?? document;
  const hoverDelayMs = Math.max(0, options.hoverDelayMs ?? options.delayMs ?? 120);
  const hideDelayMs = Math.max(
    0,
    options.hideDelayMs ?? (hoverDelayMs === 0 ? 0 : 120)
  );
  const maxLines = options.maxLines ?? options.maxPreviewLines ?? 8;
  const maxChars = options.maxChars ?? 480;
  const language: UiLanguage = options.language ?? "en";
  const hostContainer = options.hostContainer ?? options.container;
  const label = (key: NodeLabelKey) => nodeLabel(language, key);

  let popoverEl: HTMLElement | null = null;
  let activeAnchor: HTMLElement | null = null;
  let showTimer: number | null = null;
  let hideTimer: number | null = null;
  let requestSeq = 0;
  let disposed = false;

  const clearTimers = () => {
    if (showTimer !== null) {
      window.clearTimeout(showTimer);
      showTimer = null;
    }
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const removePopover = () => {
    requestSeq++;
    activeAnchor = null;
    if (popoverEl) {
      popoverEl.remove();
      popoverEl = null;
    }
  };

  const scheduleHide = () => {
    if (disposed) return;
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    if (hideDelayMs <= 0) {
      removePopover();
      return;
    }
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      removePopover();
    }, hideDelayMs);
  };

  const ensurePopover = (): HTMLElement => {
    if (popoverEl && popoverEl.isConnected) return popoverEl;

    const el = createEl("div", "org-node-hover-popover");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-live", "polite");

    el.addEventListener("mouseenter", () => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    });

    el.addEventListener("mouseleave", (event) => {
      const related = event.relatedTarget as Node | null;
      if (related && activeAnchor && activeAnchor.contains(related)) return;
      scheduleHide();
    });

    const host = hostContainer ?? doc.body ?? root;
    host.appendChild(el);
    popoverEl = el;
    return el;
  };

  const setStatusClass = (el: HTMLElement, status: "found" | "duplicate" | "missing") => {
    el.classList.remove("is-found", "is-duplicate", "is-missing");
    el.classList.add(`is-${status}`);
    el.dataset.status = status;
  };

  const positionPopover = (el: HTMLElement, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect?.() ?? {
      left: 0,
      top: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
    };
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth || 1024 : 1024;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight || 768 : 768;
    const widthEstimate = 380;

    const left = Math.max(12, Math.min(rect.left, viewportWidth - widthEstimate - 12));
    const preferTop = rect.bottom + 8;
    const top =
      preferTop + 220 > viewportHeight && rect.top > 240
        ? Math.max(12, rect.top - 220)
        : Math.max(12, preferTop);

    el.style.position = "fixed";
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  };

  const renderFooter = (el: HTMLElement, primaryNode?: OrgNodeEntry) => {
    const footer = createEl("div", "org-node-hover-footer");
    footer.appendChild(
      createEl("span", "org-node-hover-readonly", label("hover.readOnly"))
    );

    if (primaryNode && options.onOpenNode) {
      const openBtn = createEl("button", "org-node-hover-open-btn", label("hover.openSource"));
      openBtn.type = "button";
      openBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        removePopover();
        void options.onOpenNode?.(primaryNode);
      });
      footer.appendChild(openBtn);
    }

    el.appendChild(footer);
  };

  const renderMissing = (el: HTMLElement, id: string, anchor: HTMLElement) => {
    el.replaceChildren();
    setStatusClass(el, "missing");
    el.dataset.orgId = id;

    const header = createEl("div", "org-node-hover-header is-error");
    header.appendChild(
      createEl("span", "org-node-hover-status-pill is-missing", label("hover.missingTitle"))
    );
    if (id) {
      header.appendChild(createEl("code", "org-node-hover-id", id));
    }
    el.appendChild(header);

    el.appendChild(createEl("div", "org-node-hover-body is-empty", label("hover.missingHint")));
    renderFooter(el);

    if (id) {
      options.onMissingId?.(id, anchor);
    }
  };

  const renderFoundHeader = (el: HTMLElement, node: OrgNodeEntry, id: string) => {
    setStatusClass(el, "found");
    el.dataset.orgId = id;

    const header = createEl("div", "org-node-hover-header");
    header.appendChild(
      createEl("span", "org-node-hover-level", formatNodeLevelBadge(node))
    );

    const titleBtn = createEl("button", "org-node-hover-title-btn", node.title);
    titleBtn.type = "button";
    titleBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removePopover();
      void options.onOpenNode?.(node);
    });
    header.appendChild(titleBtn);
    el.appendChild(header);

    const meta = createEl("div", "org-node-hover-meta");
    meta.appendChild(
      createEl(
        "span",
        "org-node-hover-breadcrumb",
        `${formatNodeBreadcrumb(node)} · L${node.line + 1}`
      )
    );
    if (node.id) {
      meta.appendChild(createEl("code", "org-node-hover-id", node.id));
    }
    el.appendChild(meta);
  };

  const renderExcerptInto = (bodyEl: HTMLElement, source: string | null, node: OrgNodeEntry) => {
    bodyEl.replaceChildren();
    bodyEl.classList.remove("is-loading", "is-empty", "is-error");

    if (source === null) {
      bodyEl.classList.add("is-error");
      bodyEl.textContent = label("hover.fileMissing");
      return;
    }

    const detail = extractNodePreviewDetail(source, node, {
      maxLines,
      maxChars,
      includeHeading: false,
    });

    if (!detail.text) {
      bodyEl.classList.add("is-empty");
      bodyEl.textContent = label("hover.noExcerpt");
      return;
    }

    const pre = createEl("div", "org-node-hover-excerpt");
    pre.textContent = detail.text;
    bodyEl.appendChild(pre);
  };

  const showForAnchor = async (anchor: HTMLElement) => {
    if (disposed) return;
    const id = extractOrgIdFromAnchor(anchor);
    if (id === null) return;

    const seq = ++requestSeq;
    activeAnchor = anchor;
    const el = ensurePopover();
    positionPopover(el, anchor);

    if (!id) {
      renderMissing(el, "", anchor);
      return;
    }

    const res = options.resolveId(id);

    if (res.status === "missing") {
      renderMissing(el, id, anchor);
      return;
    }

    if (res.status === "duplicate") {
      el.replaceChildren();
      setStatusClass(el, "duplicate");
      el.dataset.orgId = id;

      const header = createEl("div", "org-node-hover-header is-warning");
      header.appendChild(
        createEl(
          "span",
          "org-node-hover-status-pill is-duplicate",
          `${label("hover.duplicateTitle")} (${res.nodes.length})`
        )
      );
      header.appendChild(createEl("code", "org-node-hover-id", id));
      el.appendChild(header);

      el.appendChild(
        createEl("div", "org-node-hover-duplicate-hint", label("hover.duplicateHint"))
      );

      const listEl = createEl("ul", "org-node-hover-dup-list");
      for (const candidate of res.nodes) {
        const li = document.createElement("li");
        const btn = createEl("button", "org-node-hover-dup-item");
        btn.type = "button";

        const itemTop = createEl("div", "org-node-hover-dup-top");
        itemTop.appendChild(
          createEl("span", "org-node-hover-level", formatNodeLevelBadge(candidate))
        );
        itemTop.appendChild(createEl("span", "org-node-hover-dup-title", candidate.title));
        btn.appendChild(itemTop);

        const hierarchy = formatHeadingHierarchy(candidate);
        btn.appendChild(
          createEl(
            "div",
            "org-node-hover-dup-loc",
            `${candidate.filePath}:${candidate.line + 1} · ${hierarchy}`
          )
        );
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          removePopover();
          void options.onOpenNode?.(candidate);
        });
        li.appendChild(btn);
        listEl.appendChild(li);
      }
      el.appendChild(listEl);

      const previewBody = createEl("div", "org-node-hover-body is-loading", label("hover.loading"));
      el.appendChild(previewBody);
      renderFooter(el, res.nodes[0]);

      const source = await Promise.resolve(options.readFile(res.nodes[0].filePath));
      if (disposed || seq !== requestSeq) return;
      renderExcerptInto(previewBody, source, res.nodes[0]);
      return;
    }

    const node = res.node;
    el.replaceChildren();
    renderFoundHeader(el, node, id);

    const body = createEl("div", "org-node-hover-body is-loading", label("hover.loading"));
    el.appendChild(body);
    renderFooter(el, node);

    const source = await Promise.resolve(options.readFile(node.filePath));
    if (disposed || seq !== requestSeq) return;
    renderExcerptInto(body, source, node);
  };

  const onMouseOver = (event: MouseEvent) => {
    if (disposed) return;
    const anchor = findIdAnchor(event.target, root);
    if (!anchor) return;

    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }

    if (activeAnchor === anchor && popoverEl?.isConnected) return;

    if (showTimer !== null) {
      window.clearTimeout(showTimer);
      showTimer = null;
    }

    if (hoverDelayMs <= 0) {
      void showForAnchor(anchor);
      return;
    }

    showTimer = window.setTimeout(() => {
      showTimer = null;
      void showForAnchor(anchor);
    }, hoverDelayMs);
  };

  const onMouseOut = (event: MouseEvent) => {
    if (disposed) return;
    const anchor = findIdAnchor(event.target, root);
    if (!anchor) return;

    const related = event.relatedTarget as Node | null;
    if (related && (anchor.contains(related) || popoverEl?.contains(related))) {
      return;
    }

    if (showTimer !== null) {
      window.clearTimeout(showTimer);
      showTimer = null;
    }
    scheduleHide();
  };

  const onFocusIn = (event: FocusEvent) => {
    if (disposed) return;
    const anchor = findIdAnchor(event.target, root);
    if (!anchor) return;
    clearTimers();
    void showForAnchor(anchor);
  };

  const onFocusOut = (event: FocusEvent) => {
    if (disposed) return;
    const anchor = findIdAnchor(event.target, root);
    if (!anchor) return;
    const related = event.relatedTarget as Node | null;
    if (related && (anchor.contains(related) || popoverEl?.contains(related))) {
      return;
    }
    scheduleHide();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      clearTimers();
      removePopover();
    }
  };

  root.addEventListener("mouseover", onMouseOver);
  root.addEventListener("mouseout", onMouseOut);
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", onFocusOut);
  doc.addEventListener("keydown", onKeyDown);

  return () => {
    disposed = true;
    clearTimers();
    removePopover();
    root.removeEventListener("mouseover", onMouseOver);
    root.removeEventListener("mouseout", onMouseOut);
    root.removeEventListener("focusin", onFocusIn);
    root.removeEventListener("focusout", onFocusOut);
    doc.removeEventListener("keydown", onKeyDown);
  };
}
