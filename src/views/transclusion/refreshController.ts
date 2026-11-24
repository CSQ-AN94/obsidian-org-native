import type { TransclusionResolution } from "../../core/transclusion/types";

export interface HydrationSession {
  signal: AbortSignal;
  isStale: () => boolean;
  onDependency: (dep: {
    filePath?: string;
    status: TransclusionResolution["status"];
  }) => void;
}

/**
 * Tracks resolved file dependencies and unresolved targets for an active Reading View
 * instance so edits to transcluded source files trigger an immediate, debounced-safe
 * re-render while unrelated file changes are ignored and stale async hydrations cancel.
 */
export class TransclusionRefreshController {
  private generation = 0;
  private abortController: AbortController | null = null;
  private dependencies = new Set<string>();
  private hasUnresolvedTargets = false;
  private disposed = false;

  constructor(private readonly onRefresh: () => void | Promise<void>) {}

  beginHydration(): HydrationSession {
    this.abortCurrent();
    const currentGen = ++this.generation;
    const controller = new AbortController();
    this.abortController = controller;
    this.dependencies.clear();
    this.hasUnresolvedTargets = false;

    return {
      signal: controller.signal,
      isStale: () =>
        this.disposed || currentGen !== this.generation || controller.signal.aborted,
      onDependency: (dep) => {
        if (this.disposed || currentGen !== this.generation) return;
        if (dep.filePath) {
          this.dependencies.add(dep.filePath);
        }
        if (dep.status === "missing") {
          this.hasUnresolvedTargets = true;
        }
      },
    };
  }

  getTrackedDependencies(): string[] {
    return Array.from(this.dependencies);
  }

  tracksUnresolvedTargets(): boolean {
    return this.hasUnresolvedTargets;
  }

  notifyFileChanged(changedPath: string): boolean {
    if (this.disposed) return false;
    if (!this.dependencies.has(changedPath) && !this.hasUnresolvedTargets) {
      return false;
    }
    void this.onRefresh();
    return true;
  }

  notifyIndexChanged(): boolean {
    if (this.disposed) return false;
    if (this.dependencies.size === 0 && !this.hasUnresolvedTargets) {
      return false;
    }
    void this.onRefresh();
    return true;
  }

  abortCurrent(): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    this.abortController = null;
  }

  reset(): void {
    this.disposed = false;
    this.generation++;
    this.abortCurrent();
    this.dependencies.clear();
    this.hasUnresolvedTargets = false;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.abortCurrent();
    this.dependencies.clear();
    this.hasUnresolvedTargets = false;
  }
}
