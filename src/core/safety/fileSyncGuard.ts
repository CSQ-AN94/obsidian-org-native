export type DiskUpdateResult =
  | { action: "replace-editor"; content: string }
  | { action: "ignore-echo" }
  | { action: "noop" }
  | { action: "reload-external"; content: string }
  | { action: "conflict"; localContent: string; diskContent: string };

export interface LocalEditResult {
  shouldSave: boolean;
  blockedByConflict: boolean;
}

export type PrepareSaveResult =
  | { allowSave: false }
  | { allowSave: true; content: string };

/**
 * Pure state machine guarding `.org` buffers against unnecessary writes on
 * read-only close and silent overwrites when Emacs edits the file on disk.
 */
export class FileSyncGuard {
  private lastDiskContent: string | null = null;
  private lastSavedContent: string | null = null;
  private dirty = false;
  private conflicted = false;
  private externalDiskContent: string | null = null;

  reset(diskContent: string): void {
    this.lastDiskContent = diskContent;
    this.lastSavedContent = null;
    this.dirty = false;
    this.conflicted = false;
    this.externalDiskContent = null;
  }

  onDiskUpdate(
    diskContent: string,
    currentEditorContent: string,
    clear: boolean
  ): DiskUpdateResult {
    if (clear) {
      this.reset(diskContent);
      return { action: "replace-editor", content: diskContent };
    }

    if (this.lastSavedContent !== null && diskContent === this.lastSavedContent) {
      this.lastDiskContent = diskContent;
      this.lastSavedContent = null;
      return { action: "ignore-echo" };
    }

    if (diskContent === currentEditorContent) {
      this.lastDiskContent = diskContent;
      this.dirty = false;
      this.conflicted = false;
      this.externalDiskContent = null;
      return { action: "noop" };
    }

    if (!this.dirty) {
      this.lastDiskContent = diskContent;
      this.conflicted = false;
      this.externalDiskContent = null;
      return { action: "reload-external", content: diskContent };
    }

    this.conflicted = true;
    this.externalDiskContent = diskContent;
    return {
      action: "conflict",
      localContent: currentEditorContent,
      diskContent,
    };
  }

  onLocalEdit(editorContent: string): LocalEditResult {
    if (!this.conflicted && this.lastDiskContent !== null && editorContent === this.lastDiskContent) {
      this.dirty = false;
      return { shouldSave: false, blockedByConflict: false };
    }
    this.dirty = true;
    if (this.conflicted) {
      return { shouldSave: false, blockedByConflict: true };
    }
    return { shouldSave: true, blockedByConflict: false };
  }

  prepareSave(editorContent: string): PrepareSaveResult {
    if (!this.dirty || this.conflicted) {
      return { allowSave: false };
    }
    this.lastSavedContent = editorContent;
    this.lastDiskContent = editorContent;
    this.dirty = false;
    return { allowSave: true, content: editorContent };
  }

  shouldSaveOnClose(): boolean {
    return this.dirty && !this.conflicted;
  }

  resolveAcceptDisk(): string | null {
    if (this.externalDiskContent === null) return null;
    const disk = this.externalDiskContent;
    this.reset(disk);
    return disk;
  }

  resolveKeepLocal(): void {
    this.conflicted = false;
    this.externalDiskContent = null;
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  isConflicted(): boolean {
    return this.conflicted;
  }

  getExternalDiskContent(): string | null {
    return this.externalDiskContent;
  }

  getLastDiskContent(): string | null {
    return this.lastDiskContent;
  }
}
