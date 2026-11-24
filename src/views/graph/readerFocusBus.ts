import type { OrgIdIndex } from "../../core/index/orgIdIndex";
import {
  canonicalFileNodeKey,
  canonicalOrgNodeKey,
  type OrgReaderFocusEvent,
  type OrgReaderFocusReason,
} from "../../core/graph/types";

export class OrgReaderFocusBus {
  private current: OrgReaderFocusEvent | null = null;
  private listeners = new Set<(event: OrgReaderFocusEvent) => void>();

  getCurrent(): OrgReaderFocusEvent | null {
    return this.current;
  }

  subscribe(listener: (event: OrgReaderFocusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: OrgReaderFocusEvent): boolean {
    const prev = this.current;
    if (
      prev &&
      event.reason !== "manual" &&
      prev.filePath === event.filePath &&
      prev.nodeKey === event.nodeKey &&
      prev.orgId === event.orgId
    ) {
      return false;
    }

    this.current = event;
    for (const listener of Array.from(this.listeners)) {
      listener(event);
    }
    return true;
  }

  resolveFocusForFileLine(
    index: OrgIdIndex,
    filePath: string,
    line: number,
    reason: OrgReaderFocusReason
  ): OrgReaderFocusEvent {
    const enclosing = index.findEnclosingNodeAtLine(filePath, line);
    const fileTitle = index.getFileIndexData(filePath)?.fileTitle;
    if (enclosing?.id) {
      return {
        filePath: enclosing.filePath,
        line: enclosing.line,
        nodeKey: canonicalOrgNodeKey(enclosing.id),
        orgId: enclosing.id,
        title: enclosing.title,
        reason,
        timestamp: Date.now(),
      };
    }
    return {
      filePath,
      line: Math.max(0, line),
      nodeKey: canonicalFileNodeKey(filePath),
      orgId: null,
      title: enclosing?.title ?? fileTitle ?? filePath,
      reason,
      timestamp: Date.now(),
    };
  }

  clear(): void {
    this.current = null;
    this.listeners.clear();
  }
}
