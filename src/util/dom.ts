import { sanitizeHTMLToDom } from "obsidian";

type ObsidianEl = HTMLElement & {
  createEl?: <K extends keyof HTMLElementTagNameMap>(tag: K) => HTMLElementTagNameMap[K];
  createDiv?: (opts?: { cls?: string }) => ObsidianEl;
};

let detachedHost: ObsidianEl | null = null;

function getDetachedHost(): ObsidianEl | null {
  if (detachedHost) return detachedHost;
  if (typeof document === "undefined" || !document.body) return null;
  const body = document.body as ObsidianEl;
  if (typeof body.createDiv === "function") {
    detachedHost = body.createDiv({ cls: "org-native-detached-host" });
    return detachedHost;
  }
  return null;
}

export function createDetachedEl<K extends keyof HTMLElementTagNameMap>(
  tag: K
): HTMLElementTagNameMap[K] {
  const host = getDetachedHost();
  if (host && typeof host.createEl === "function") {
    return host.createEl(tag);
  }
  return document.createElement(tag);
}

/**
 * Strip dangerous tags/attributes when running outside Obsidian (e.g. unit tests)
 * where Obsidian's native sanitizeHTMLToDom may be mocked or unavailable.
 */
function fallbackSanitizeFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const blockedTags = new Set(["script", "iframe", "object", "embed", "style"]);
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (blockedTags.has(child.tagName.toLowerCase())) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();
        if (
          name.startsWith("on") ||
          ((name === "href" || name === "src") &&
            (val.startsWith("javascript:") || val.startsWith("vbscript:") || val.startsWith("data:text/html")))
        ) {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };
  walk(template.content as unknown as Element);
  return template.content;
}

function toSafeDom(html: string): DocumentFragment {
  if (typeof sanitizeHTMLToDom === "function") {
    try {
      return sanitizeHTMLToDom(html);
    } catch {
      return fallbackSanitizeFragment(html);
    }
  }
  return fallbackSanitizeFragment(html);
}

export function appendSanitizedHtml(parent: HTMLElement, html: string): void {
  parent.appendChild(toSafeDom(html));
}

export function replaceWithSanitizedHtml(parent: HTMLElement, html: string): void {
  parent.replaceChildren(toSafeDom(html));
}
