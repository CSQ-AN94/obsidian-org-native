import { App, EventRef, Plugin, TFile } from "obsidian";
import { VIEW_TYPE_ORG } from "../constants";
import { parseOrgDoc } from "../core/parser/parse";

/**
 * Guarded bridge injecting Org headings into Obsidian's core Outline view.
 * Can be disabled in Settings; automatically degrades to a no-op if Obsidian's
 * internal Outline view shape changes, and restores original methods on unload.
 */

interface PositionLike {
  line: number;
  col: number;
  offset: number;
}

interface HeadingCacheLike {
  heading: string;
  level: number;
  position: { start: PositionLike; end: PositionLike };
}

interface OutlineItemLike {
  heading?: HeadingCacheLike;
  selfEl?: HTMLElement;
}

interface OutlineViewLike {
  file?: TFile;
  containerEl: HTMLElement;
  cachedHeadingDom?: OutlineItemLike[];
  getHeadings?: (...args: unknown[]) => HeadingCacheLike[];
  update?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

interface PatchRecord {
  originalGetHeadings: (...args: unknown[]) => HeadingCacheLike[];
  originalUpdate?: (...args: unknown[]) => unknown;
  onClick: (event: MouseEvent) => void;
}

function extractOrgHeadings(source: string): HeadingCacheLike[] {
  const doc = parseOrgDoc(source);
  const headings: HeadingCacheLike[] = [];

  for (const line of doc.lines) {
    if (line.kind !== "heading" || !line.heading) continue;
    const heading = line.heading;
    const title = line.text
      .slice(heading.titleFrom - line.from, heading.titleTo - line.from)
      .trim();
    if (!title) continue;

    const label = heading.keyword ? `${heading.keyword.text} ${title}` : title;
    headings.push({
      heading: label,
      level: heading.level,
      position: {
        start: { line: line.index, col: 0, offset: line.from },
        end: { line: line.index, col: line.text.length, offset: line.to },
      },
    });
  }

  return headings;
}

export class OrgOutlineBridge {
  private headings = new Map<string, HeadingCacheLike[]>();
  private patched = new Set<OutlineViewLike>();
  private records = new WeakMap<OutlineViewLike, PatchRecord>();
  private enabled = true;

  constructor(
    private app: App,
    private plugin: Plugin
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.destroy();
    } else {
      this.patchAll();
    }
  }

  start(): void {
    this.app.workspace.onLayoutReady(() => {
      if (this.enabled) this.patchAll();
    });

    this.register(
      this.app.workspace.on("layout-change", () => {
        if (this.enabled) this.patchAll();
      })
    );
    this.register(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.enabled) this.patchAll();
      })
    );
    this.register(
      this.app.workspace.on("file-open", (file) => {
        if (!this.enabled) return;
        this.patchAll();
        if (file?.extension === "org") this.refresh(file.path);
      })
    );
    this.register(
      this.app.vault.on("delete", (file) => {
        this.headings.delete(file.path);
        this.refresh(file.path);
      })
    );
    this.register(
      this.app.vault.on("rename", (file, oldPath) => {
        const cached = this.headings.get(oldPath);
        if (cached) {
          this.headings.delete(oldPath);
          this.headings.set(file.path, cached);
        }
        this.refresh(file.path);
        if (oldPath !== file.path) this.refresh(oldPath);
      })
    );
  }

  destroy(): void {
    for (const view of this.patched) {
      const record = this.records.get(view);
      if (!record) continue;
      view.getHeadings = record.originalGetHeadings;
      if (record.originalUpdate) view.update = record.originalUpdate;
      view.containerEl.removeEventListener("click", record.onClick, true);
      this.records.delete(view);
      try {
        view.update?.();
      } catch {
        // Ignore teardown refresh failures.
      }
    }
    this.patched.clear();
  }

  updateFile(file: TFile | null | undefined, source: string): void {
    if (!file) return;
    this.headings.set(file.path, extractOrgHeadings(source));
    if (this.enabled) this.refresh(file.path);
  }

  private register(ref: EventRef): void {
    this.plugin.registerEvent(ref);
  }

  private patchAll(): void {
    if (!this.enabled) return;
    for (const leaf of this.app.workspace.getLeavesOfType("outline")) {
      this.patch(leaf.view as unknown as OutlineViewLike);
    }
  }

  private patch(view: OutlineViewLike): void {
    if (!view?.containerEl || this.patched.has(view)) return;
    const originalGetHeadings = view.getHeadings;
    if (typeof originalGetHeadings !== "function") return;

    const originalUpdate = view.update;

    view.getHeadings = () => {
      const file = view.file;
      if (this.enabled && file?.extension === "org") {
        return this.headings.get(file.path) ?? [];
      }
      return originalGetHeadings.call(view);
    };

    if (typeof originalUpdate === "function") {
      view.update = () => {
        const result = originalUpdate.call(view);
        this.decorate(view);
        return result;
      };
    }

    const onClick = (event: MouseEvent): void => {
      if (!this.enabled) return;
      const target = event.target as HTMLElement | null;
      const item = target?.closest(".tree-item-self") as HTMLElement | null;
      if (!item || !view.containerEl.contains(item)) return;
      const line = item.dataset.orgLine;
      if (line == null) return;
      const file = view.file;
      if (!file || file.extension !== "org") return;
      event.preventDefault();
      event.stopPropagation();
      void this.navigate(file, Number(line));
    };

    view.containerEl.addEventListener("click", onClick, true);
    this.records.set(view, { originalGetHeadings, originalUpdate, onClick });
    this.patched.add(view);

    try {
      view.update?.();
    } catch (error) {
      console.warn("Org Native: outline update failed", error);
    }
    this.decorate(view);
  }

  private decorate(view: OutlineViewLike): void {
    const items = view.cachedHeadingDom;
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const element = item?.selfEl;
      const line = item?.heading?.position?.start?.line;
      if (element && typeof line === "number") {
        element.dataset.orgLine = String(line);
      }
    }
  }

  private refresh(path: string | undefined): void {
    if (!path) return;
    for (const view of this.patched) {
      if (view.file?.path !== path) continue;
      try {
        view.update?.();
      } catch (error) {
        console.warn("Org Native: outline refresh failed", error);
      }
      this.decorate(view);
    }
  }

  private async navigate(file: TFile, line: number): Promise<void> {
    let leaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_ORG)
      .find((candidate) => (candidate.view as unknown as OutlineViewLike).file?.path === file.path);

    if (!leaf) {
      leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }

    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const view = leaf.view as unknown as {
      jumpToLine?: (line: number) => void;
      setEphemeralState?: (state: { line: number }) => void;
    };

    if (typeof view.jumpToLine === "function") {
      view.jumpToLine(line);
    } else if (typeof view.setEphemeralState === "function") {
      view.setEphemeralState({ line });
    }
  }
}
