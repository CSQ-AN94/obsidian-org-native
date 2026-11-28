import { App, TFile } from "obsidian";

const EXTERNAL = /^(https?|ftp|mailto):/i;
const UNSAFE_SCHEME = /^(javascript|vbscript|data):/i;

export interface LinkCallbacks {
  onOpenId?: (id: string) => void;
  onOpenCustomId?: (customId: string) => void;
  onOpenHeading?: (headingTitle: string) => void;
}

export function isUnsafeUriScheme(target: string): boolean {
  // Strip ASCII control characters and whitespace before scheme inspection.
  const normalized = target.replace(/[\u0000-\u0020]+/g, "");
  return UNSAFE_SCHEME.test(normalized);
}

export function parseOrgIdTarget(target: string): string | null {
  const m = /^id:(.+)$/i.exec(target.trim());
  return m ? m[1].trim() : null;
}

export function stripFilePrefix(target: string): string {
  return target.replace(/^file:/i, "").trim();
}

/** Open an Org link target inside (or outside) the vault safely. */
export function openOrgLink(
  app: App,
  target: string,
  sourcePath: string,
  callbacks: LinkCallbacks = {}
): void {
  const trimmed = target.trim();
  if (!trimmed || isUnsafeUriScheme(trimmed)) return;

  const idTarget = parseOrgIdTarget(trimmed);
  if (idTarget && callbacks.onOpenId) {
    callbacks.onOpenId(idTarget);
    return;
  }

  if (trimmed.startsWith("#") && callbacks.onOpenCustomId) {
    callbacks.onOpenCustomId(trimmed.slice(1).trim());
    return;
  }

  if (trimmed.startsWith("*") && callbacks.onOpenHeading) {
    callbacks.onOpenHeading(trimmed.slice(1).trim());
    return;
  }

  const cleaned = stripFilePrefix(trimmed);
  if (!cleaned) return;
  if (EXTERNAL.test(cleaned)) {
    window.open(cleaned, "_blank", "noopener,noreferrer");
    return;
  }

  void app.workspace
    .openLinkText(cleaned, sourcePath, false)
    .catch((error) => console.warn("Org Native: could not open link", error));
}

export function openTagSearch(app: App, tag: string): void {
  try {
    const search = (
      app as unknown as {
        internalPlugins?: {
          getPluginById?: (id: string) => { instance?: { openGlobalSearch?: (q: string) => void } };
        };
      }
    ).internalPlugins?.getPluginById?.("global-search")?.instance;
    search?.openGlobalSearch?.(`:${tag}:`);
  } catch {
    // Search is an optional core plugin; safely ignore if unavailable.
  }
}

export function wireLinks(
  root: HTMLElement,
  app: App,
  sourcePath: string,
  callbacks: LinkCallbacks = {}
): void {
  root.querySelectorAll<HTMLAnchorElement>("a[data-href]").forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openOrgLink(
        app,
        anchor.dataset.href ?? anchor.getAttribute("href") ?? "",
        sourcePath,
        callbacks
      );
    });
  });
  root.querySelectorAll<HTMLAnchorElement>("a.tag").forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const name = (anchor.getAttribute("href") ?? "").replace(/^#/, "");
      if (name) openTagSearch(app, name);
    });
  });
}

function resolveVaultRelativePath(rawPath: string, sourcePath: string): string | null {
  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    const stripped = normalized.replace(/^\/+/, "");
    return stripped || null;
  }

  const baseDir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const baseParts = baseDir ? baseDir.split("/").filter(Boolean) : [];
  const relParts = normalized.split("/");
  const stack = [...baseParts];

  for (const part of relParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.length > 0 ? stack.join("/") : null;
}

export function resolveResourcePath(app: App, target: string, sourcePath: string): string | null {
  if (isUnsafeUriScheme(target)) return null;
  let path = stripFilePrefix(target);
  if (!path) return null;
  const subpathIndex = path.indexOf("::");
  if (subpathIndex >= 0) path = path.slice(0, subpathIndex);

  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return `file:///${path.replace(/\\/g, "/").replace(/ /g, "%20")}`;
  }

  const vaultRel = resolveVaultRelativePath(path, sourcePath);
  if (vaultRel === null) return null;
  const getByPath = (app.vault as { getAbstractFileByPath?: (p: string) => unknown })
    ?.getAbstractFileByPath;
  const direct = typeof getByPath === "function" ? getByPath.call(app.vault, vaultRel) : null;
  if (direct instanceof TFile) {
    return app.vault.adapter.getResourcePath(direct.path);
  }

  const cleanLink = path.replace(/^(?:\.\/)+/, "");
  const abstract =
    app.metadataCache.getFirstLinkpathDest(cleanLink, sourcePath) ??
    (cleanLink !== path ? app.metadataCache.getFirstLinkpathDest(path, sourcePath) : null);
  if (abstract instanceof TFile) {
    return app.vault.adapter.getResourcePath(abstract.path);
  }
  try {
    const fallbackPath =
      sourcePath.includes("/") || /^\.\.?[\\/]/.test(path) ? vaultRel : cleanLink || path;
    return app.vault.adapter.getResourcePath(fallbackPath);
  } catch {
    return null;
  }
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(stripFilePrefix(path));
}
