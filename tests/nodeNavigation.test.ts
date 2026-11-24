import { describe, expect, it, vi } from "vitest";
import { VIEW_TYPE_ORG_BACKLINKS } from "../src/constants";
import {
  extractNodePreview,
  extractNodePreviewDetail,
  formatNodeBreadcrumb,
} from "../src/core/index/nodeUtils";
import { OrgIdIndex } from "../src/core/index/orgIdIndex";
import { OrgDiagnosticsModal, VaultIndexService } from "../src/core/index/vaultIndexService";
import { translate, type TranslationKey } from "../src/i18n";
import type OrgNativePlugin from "../src/main";
import {
  attachNodeHoverPreview,
  createHoverPreviewOptions,
  OrgBacklinksView,
  OrgNodeSwitcherModal,
  registerNodeNavigation,
  resolveNodeEntryForOpen,
} from "../src/views/nodes";
import { createMockApp, TFile } from "./mocks/obsidian";

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Agent B — Node Navigation (search, backlinks, hover preview, diagnostics, performance)", () => {
  it("populates headingPath, endLine, search ranking, breadcrumbs, and property-free excerpts", () => {
    const index = new OrgIdIndex();
    const architectureDoc = [
      ":PROPERTIES:",
      ":ID: root-arch-id",
      ":END:",
      "#+TITLE: System Architecture",
      "",
      "* Core Engine",
      "** Memory Subsystem",
      ":PROPERTIES:",
      ":ID: mem-sub-001",
      ":CUSTOM_ID: memory-subsystem",
      ":END:",
      "First paragraph of memory subsystem.",
      "Second line of body content.",
      "*** KV Cache Compression",
      ":PROPERTIES:",
      ":ID: kv-comp-002",
      ":END:",
      "Compresses long-horizon context cleanly.",
      "",
      "* Appendix",
      "Trailing notes.",
    ].join("\n");

    index.upsertFile("docs/arch.org", architectureDoc);

    const nodes = index.getNodesInFile("docs/arch.org");
    expect(nodes.map((n) => n.id)).toEqual(["root-arch-id", "mem-sub-001", "kv-comp-002"]);
    expect(nodes[0]).toMatchObject({
      line: 0,
      endLine: 20,
      headingPath: [],
    });
    expect(nodes[1]).toMatchObject({
      line: 6,
      endLine: 18,
      headingPath: ["Core Engine", "Memory Subsystem"],
    });
    expect(nodes[2]).toMatchObject({
      line: 13,
      endLine: 18,
      headingPath: ["Core Engine", "Memory Subsystem", "KV Cache Compression"],
    });

    expect(formatNodeBreadcrumb(nodes[0])).toBe("docs/arch.org");
    expect(formatNodeBreadcrumb(nodes[2])).toBe(
      "docs/arch.org › Core Engine › Memory Subsystem › KV Cache Compression"
    );

    const excerpt = extractNodePreview(architectureDoc, nodes[1], 4);
    expect(excerpt).not.toContain(":PROPERTIES:");
    expect(excerpt).not.toContain("mem-sub-001");
    expect(excerpt).toContain("** Memory Subsystem");
    expect(excerpt).toContain("First paragraph of memory subsystem.");
    expect(excerpt).toContain("Second line of body content.");
    expect(excerpt.split("\n").length).toBeLessThanOrEqual(4);

    // Search ranks exact ID/title matches ahead of path/multi-term matches
    expect(index.searchNodes("kv-comp-002")[0].id).toBe("kv-comp-002");
    expect(index.searchNodes("memory-subsystem")[0].id).toBe("mem-sub-001");
    expect(index.searchNodes("Core Engine KV").map((n) => n.id)).toEqual(["kv-comp-002"]);
    expect(index.searchNodes("Core Engine").map((n) => n.id)).toEqual([
      "mem-sub-001",
      "kv-comp-002",
    ]);
  });

  it("tracks both link and transclude backlinks with source heading paths across node moves", () => {
    const index = new OrgIdIndex();
    const movingSubtree = [
      "** Portable Memory Note",
      ":PROPERTIES:",
      ":ID: portable-mem-99",
      ":END:",
      "Important invariant that moves across files.",
    ].join("\n");

    index.upsertFile("inbox.org", `* Inbox\n\n${movingSubtree}\n`);
    index.upsertFile("archive.org", "* Archive\nInitial archive line.\n");
    index.upsertFile(
      "overview.org",
      [
        "* Overview",
        "** Weekly Synthesis",
        ":PROPERTIES:",
        ":ID: weekly-synth-1",
        ":END:",
        "Direct reference to [[id:portable-mem-99][Portable Memory]].",
        "#+TRANSCLUDE: [[id:portable-mem-99]] :level 2",
      ].join("\n")
    );

    const beforeGroups = index.getBacklinksForFile("inbox.org");
    expect(beforeGroups).toHaveLength(1);
    expect(beforeGroups[0].backlinks.map((b) => b.relation)).toEqual(["link", "transclude"]);
    expect(index.getBacklinksForFile("archive.org")).toHaveLength(0);

    const richBefore = index.getBacklinkEntries("portable-mem-99");
    expect(richBefore).toHaveLength(2);
    expect(richBefore[0].sourceHeadingPath).toEqual(["Overview", "Weekly Synthesis"]);
    expect(richBefore[0].sourceNode?.id).toBe("weekly-synth-1");
    expect(richBefore[0].excerpt).toContain("Portable Memory");

    // Move node from inbox.org -> archive.org and rename heading
    index.upsertFile("inbox.org", "* Inbox\nMoved out.\n");
    index.upsertFile(
      "archive.org",
      `* Archive\nInitial archive line.\n\n${movingSubtree.replace(
        "Portable Memory Note",
        "Archived Memory Node"
      )}\n`
    );

    expect(index.getBacklinksForFile("inbox.org")).toHaveLength(0);
    const afterGroups = index.getBacklinksForFile("archive.org");
    expect(afterGroups).toHaveLength(1);
    expect(afterGroups[0].node.filePath).toBe("archive.org");
    expect(afterGroups[0].node.line).toBe(3);
    expect(afterGroups[0].node.headingPath).toEqual(["Archive", "Archived Memory Node"]);
    expect(afterGroups[0].backlinks).toHaveLength(2);
    expect(afterGroups[0].backlinks[1]).toMatchObject({
      sourcePath: "overview.org",
      line: 6,
      relation: "transclude",
      context: "#+TRANSCLUDE: [[id:portable-mem-99]] :level 2",
    });
  });

  it("supports searching, ranking, duplicate badging, and live ID re-resolution in OrgNodeSwitcherModal", async () => {
    const app = createMockApp() as unknown as import("obsidian").App;
    const pluginStub = {
      t: (key: TranslationKey) => translate("en", key),
      uiLanguage: "en" as const,
    } as unknown as OrgNativePlugin;
    const service = new VaultIndexService(app, pluginStub);
    const openNodeSpy = vi.spyOn(service, "openNode").mockResolvedValue();

    service.index.upsertFile(
      "a.org",
      "* Top\n** Brain Node\n:PROPERTIES:\n:ID: id-brain-1\n:CUSTOM_ID: custom-brain\n:END:\nBody.\n"
    );
    service.index.upsertFile(
      "b.org",
      "* Other\n:PROPERTIES:\n:ID: id-other-2\n:END:\nBody.\n"
    );
    service.index.upsertFile(
      "c.org",
      "* 中文父级\n** 注意力压缩\n:PROPERTIES:\n:ID: cjk-attn-3\n:END:\n内容。\n"
    );

    const modal = new OrgNodeSwitcherModal(app, service, pluginStub);
    const filterItems = (q: string) =>
      (
        modal as unknown as {
          filterItems: (query: string) => ReturnType<OrgNodeSwitcherModal["getItems"]>;
        }
      ).filterItems(q);

    expect(modal.getItems().map((n) => n.id)).toEqual([
      "id-brain-1",
      "id-other-2",
      "cjk-attn-3",
    ]);
    expect(filterItems("custom-brain").map((n) => n.id)).toEqual(["id-brain-1"]);
    expect(filterItems("Top").map((n) => n.id)).toEqual(["id-brain-1"]);
    expect(filterItems("中文父级").map((n) => n.id)).toEqual(["cjk-attn-3"]);

    const suggestionHost = document.createElement("div");
    const brainNodeBeforeMove = modal.getItems().find((n) => n.id === "id-brain-1")!;
    modal.renderSuggestion(
      { item: brainNodeBeforeMove, match: { score: 0, matches: [] } },
      suggestionHost
    );
    expect(suggestionHost.textContent).toContain("H2");
    expect(suggestionHost.textContent).toContain("Brain Node");
    expect(suggestionHost.textContent).toContain("a.org › Top › Brain Node");
    expect(suggestionHost.textContent).toContain("ID: id-brain-1");
    expect(suggestionHost.textContent).toContain("#custom-brain");

    // Simulate moving & renaming Brain Node AFTER modal list was fetched (stale item object)
    service.index.upsertFile("a.org", "* Top\n");
    service.index.upsertFile(
      "b.org",
      "* Other\n:PROPERTIES:\n:ID: id-other-2\n:END:\n\n** Renamed Brain Node\n:PROPERTIES:\n:ID: id-brain-1\n:CUSTOM_ID: custom-brain\n:END:\n"
    );

    // Live resolution via stale OrgNodeEntry still resolves to b.org + Renamed Brain Node
    const resolved = resolveNodeEntryForOpen(service.index, brainNodeBeforeMove);
    expect(resolved?.filePath).toBe("b.org");
    expect(resolved?.title).toBe("Renamed Brain Node");

    modal.onChooseItem(brainNodeBeforeMove, new MouseEvent("click"));
    expect(openNodeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "id-brain-1",
        filePath: "b.org",
        title: "Renamed Brain Node",
        line: 5,
      })
    );

    // Duplicate badge renders when ID becomes duplicated
    service.index.upsertFile(
      "dup.org",
      "* Duplicate Brain\n:PROPERTIES:\n:ID: id-brain-1\n:END:\n"
    );
    const dupHost = document.createElement("div");
    modal.renderSuggestion(
      { item: resolved!, match: { score: 0, matches: [] } },
      dupHost
    );
    expect(dupHost.querySelector(".org-node-switcher-badge-dup")).toBeTruthy();
  });

  it("renders OrgBacklinksView with source paths, filter, duplicate/invalid issues, incremental refresh, and cleanup", async () => {
    const baseApp = createMockApp();
    const handlers: {
      activeLeaf: ((leaf: unknown) => void) | null;
      fileOpen: ((file: unknown) => void) | null;
    } = { activeLeaf: null, fileOpen: null };
    const offrefSpy = vi.fn();

    const app = {
      ...baseApp,
      workspace: {
        ...baseApp.workspace,
        getActiveFile: () => new TFile("target.org"),
        on: vi.fn((event: string, cb: (arg: unknown) => void) => {
          if (event === "active-leaf-change") handlers.activeLeaf = cb;
          if (event === "file-open") handlers.fileOpen = cb;
          return { event };
        }),
        offref: offrefSpy,
      },
    };

    const pluginStub = {
      t: (key: TranslationKey) => translate("en", key),
      uiLanguage: "en" as const,
    } as unknown as OrgNativePlugin;

    const service = new VaultIndexService(app as unknown as import("obsidian").App, pluginStub);
    service.upsertContent(
      "target.org",
      [
        "* Target Section",
        ":PROPERTIES:",
        ":ID: target-node-1",
        ":END:",
        "Target body.",
        "Broken outgoing [[id:missing-target-999][Missing]].",
        "Malformed empty [[id:]].",
      ].join("\n")
    );
    service.upsertContent(
      "dup-peer.org",
      "* Peer Section\n:PROPERTIES:\n:ID: target-node-1\n:END:\n"
    );
    service.upsertContent(
      "lonely.org",
      "* Lonely Section\n:PROPERTIES:\n:ID: lonely-1\n:END:\n"
    );
    service.upsertContent(
      "referrer.org",
      [
        "* Chapter 1",
        "** Subchapter A",
        "See [[id:target-node-1][Target]] for details.",
        "#+transclude: [[id:target-node-1]] :only-contents",
      ].join("\n")
    );

    const openLocationSpy = vi.spyOn(service, "openLocation").mockResolvedValue();
    const openNodeSpy = vi.spyOn(service, "openNode").mockResolvedValue();
    const view = new OrgBacklinksView(
      { app } as unknown as import("obsidian").WorkspaceLeaf,
      {
        t: (key: TranslationKey) => translate("en", key),
        uiLanguage: "en",
        vaultIndex: service,
      }
    );

    expect(view.getViewType()).toBe(VIEW_TYPE_ORG_BACKLINKS);
    expect(view.getDisplayText()).toBe("Org Backlinks");

    await view.onOpen();

    expect(view.contentEl.textContent).toContain("target.org");
    expect(view.contentEl.textContent).toContain("target-node-1");
    expect(view.contentEl.textContent).toContain("referrer.org:3");
    expect(view.contentEl.textContent).toContain("referrer.org:4");
    expect(view.contentEl.textContent).toContain("Chapter 1 › Subchapter A");

    // Duplicate conflict callout + clickable peer
    const dupWarning = view.contentEl.querySelector(".org-node-backlinks-dup-warning");
    expect(dupWarning?.textContent).toContain("dup-peer.org:L1");
    const peerLink = dupWarning?.querySelector<HTMLAnchorElement>("a.org-node-backlinks-peer-link");
    peerLink?.click();
    expect(openNodeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "dup-peer.org", id: "target-node-1" })
    );

    // Outgoing broken & invalid link issues in target.org
    const issuesEl = view.contentEl.querySelector(".org-node-backlinks-issues");
    expect(issuesEl?.textContent).toContain("missing-target-999");
    expect(issuesEl?.textContent).toContain("Invalid [[id:]]");

    const relationBadges = Array.from(view.contentEl.querySelectorAll(".org-backlinks-relation")).map(
      (el) => el.textContent
    );
    expect(relationBadges).toEqual(["link", "transclude"]);

    const links = Array.from(view.contentEl.querySelectorAll<HTMLAnchorElement>("a.org-backlinks-link"));
    links[1].click();
    expect(openLocationSpy).toHaveBeenCalledWith("referrer.org", 3);

    // Incremental update optimization: editing an unrelated file does NOT re-render the sidebar
    const rendersBeforeUnrelated = view.getRenderCount();
    service.upsertContent("unrelated.org", "* Unrelated\n:PROPERTIES:\n:ID: unrel-1\n:END:\nNo links here.\n");
    expect(view.getRenderCount()).toBe(rendersBeforeUnrelated);

    // Filter query narrows visible items without losing structure
    view.setFilterQuery("transclude");
    expect(view.contentEl.querySelectorAll(".org-backlinks-item")).toHaveLength(1);
    view.setFilterQuery("");
    expect(view.contentEl.querySelectorAll(".org-backlinks-item")).toHaveLength(2);

    // Context toggle hides and restores excerpt elements
    view.setShowContext(false);
    expect(view.contentEl.querySelectorAll(".org-backlinks-context")).toHaveLength(0);
    view.setShowContext(true);
    expect(view.contentEl.querySelectorAll(".org-backlinks-context").length).toBeGreaterThan(0);

    // Switch active leaf to an .org file with zero incoming backlinks
    handlers.activeLeaf?.({ view: { file: new TFile("lonely.org") } });
    expect(view.getTargetFile()).toBe("lonely.org");
    expect(view.contentEl.textContent).toContain(translate("en", "backlinks.empty"));

    // Rename active file in index -> Backlinks view follows new path
    service.index.renameFile("lonely.org", "lonely-renamed.org");
    // Simulate service rename event via vault or explicit setTargetFile -> fileOpen
    handlers.fileOpen?.(new TFile("lonely-renamed.org"));
    expect(view.getTargetFile()).toBe("lonely-renamed.org");

    // Switch active leaf to a non-.org file
    handlers.activeLeaf?.({ view: { file: new TFile("notes/readme.md") } });
    expect(view.getTargetFile()).toBeNull();
    expect(view.contentEl.textContent).toContain(translate("en", "backlinks.noActiveOrg"));

    await view.onClose();
    expect(offrefSpy).toHaveBeenCalledTimes(2);

    // Index updates after close must not re-populate contentEl
    service.upsertContent("another.org", "* Another\n[[id:lonely-1]]\n");
    expect(view.contentEl.childElementCount).toBe(0);
  });

  it("displays safe, non-executing, zero-mutation hover previews with click-to-open and race guards", async () => {
    const index = new OrgIdIndex();
    const files: Record<string, string> = {
      "safe.org": [
        "* Root Topic",
        '** Safe <script>alert("xss")</script> Title',
        ":PROPERTIES:",
        ":ID: safe-preview-1",
        ":END:",
        ":LOGBOOK:",
        "- State \"DONE\" from \"TODO\"",
        ":END:",
        'Line with <img src="x" onerror="alert(1)"> literal text.',
        "#+BEGIN_SRC bash",
        "echo should_never_execute",
        "#+END_SRC",
      ].join("\n"),
      "dup-a.org": "* Dup A\n:PROPERTIES:\n:ID: dup-preview-2\n:END:\nFirst duplicate body.\n",
      "dup-b.org": "* Dup B\n:PROPERTIES:\n:ID: dup-preview-2\n:END:\nSecond duplicate body.\n",
    };

    for (const [p, content] of Object.entries(files)) {
      index.upsertFile(p, content);
    }

    const writeSpy = vi.fn();
    const openNodeSpy = vi.fn();
    const missingSpy = vi.fn();

    const root = document.createElement("div");
    const popoverHost = document.createElement("div");

    const linkValid = document.createElement("a");
    linkValid.className = "internal-link org-link org-link-id";
    linkValid.dataset.orgId = "safe-preview-1";
    linkValid.textContent = "Safe target";

    const linkDup = document.createElement("a");
    linkDup.className = "internal-link org-link org-link-id org-link-duplicate";
    linkDup.dataset.orgId = "dup-preview-2";
    linkDup.textContent = "Dup target";

    const linkMissing = document.createElement("a");
    linkMissing.className = "internal-link org-link org-link-id org-link-broken";
    linkMissing.dataset.orgId = "missing-404";
    linkMissing.textContent = "Missing target";

    const linkUnreadable = document.createElement("a");
    linkUnreadable.className = "internal-link org-link org-link-id";
    linkUnreadable.dataset.orgId = "ghost-file-node";
    linkUnreadable.textContent = "Ghost file node";
    index.upsertFile(
      "deleted-on-disk.org",
      "* Vanished\n:PROPERTIES:\n:ID: ghost-file-node\n:END:\nGone.\n"
    );

    root.append(linkValid, linkDup, linkMissing, linkUnreadable);
    document.body.append(root, popoverHost);

    const dispose = attachNodeHoverPreview(root, {
      resolveId: (id) => index.resolveId(id),
      readFile: async (filePath) => files[filePath] ?? null,
      onOpenNode: openNodeSpy,
      onMissingId: missingSpy,
      delayMs: 0,
      container: popoverHost,
    });

    // 1. Valid ID hover + XSS escaping + non-execution + zero-mutation + click to open
    linkValid.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await flushMicrotasks();

    const validPopover = popoverHost.querySelector<HTMLElement>(".org-node-hover-popover");
    expect(validPopover).toBeTruthy();
    expect(validPopover?.dataset.status).toBe("found");
    expect(validPopover?.textContent).toContain("safe.org › Root Topic");
    expect(validPopover?.textContent).toContain("echo should_never_execute");
    expect(validPopover?.querySelectorAll("script")).toHaveLength(0);
    expect(validPopover?.querySelectorAll("[onerror]")).toHaveLength(0);
    expect(validPopover?.textContent).not.toContain(":ID: safe-preview-1");
    expect(validPopover?.textContent).not.toContain("LOGBOOK");
    expect(writeSpy).not.toHaveBeenCalled();

    // Clicking "Open source node" navigates and closes popover
    const openBtn = validPopover?.querySelector<HTMLButtonElement>(".org-node-hover-open-btn");
    expect(openBtn).toBeTruthy();
    openBtn?.click();
    expect(openNodeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "safe-preview-1", filePath: "safe.org", line: 1 })
    );
    expect(popoverHost.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);

    // 2. Duplicate ID keyboard focus check + click on second definition
    linkDup.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await flushMicrotasks();
    const dupPopover = popoverHost.querySelector<HTMLElement>(".org-node-hover-popover.is-duplicate");
    expect(dupPopover).toBeTruthy();
    expect(dupPopover?.textContent).toContain("Duplicate :ID:");
    expect(dupPopover?.textContent).toContain("dup-a.org:1");
    expect(dupPopover?.textContent).toContain("dup-b.org:1");

    const dupItems = dupPopover?.querySelectorAll<HTMLButtonElement>(".org-node-hover-dup-item");
    expect(dupItems).toHaveLength(2);
    dupItems?.[1].click();
    expect(openNodeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dup-preview-2", filePath: "dup-b.org" })
    );

    // 3. Missing ID hover check + onMissingId callback + Escape key dismissal
    linkMissing.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await flushMicrotasks();
    const missingPopover = popoverHost.querySelector<HTMLElement>(".org-node-hover-popover.is-missing");
    expect(missingPopover).toBeTruthy();
    expect(missingPopover?.textContent).toContain("missing-404");
    expect(missingSpy).toHaveBeenCalledWith("missing-404", linkMissing);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popoverHost.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);

    // 4. Unreadable target file reports clear error instead of crashing
    linkUnreadable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await flushMicrotasks();
    const unreadablePopover = popoverHost.querySelector<HTMLElement>(".org-node-hover-popover");
    expect(unreadablePopover?.querySelector(".org-node-hover-body.is-error")).toBeTruthy();

    dispose();
    expect(popoverHost.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);

    // Hovering after dispose must do nothing
    linkValid.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await flushMicrotasks();
    expect(popoverHost.querySelectorAll(".org-node-hover-popover")).toHaveLength(0);

    root.remove();
    popoverHost.remove();
  });

  it("reports Duplicate ID, Broken ID Link, Node Not Found, and Index Outdated diagnostics and avoids full vault rescans", async () => {
    const baseApp = createMockApp();
    const filesMap = new Map<string, { file: TFile; content: string; mtime: number; size: number }>();
    const vaultHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

    const addDiskFile = (filePath: string, content: string, mtime = 1000) => {
      const f = new TFile(filePath) as TFile & { stat: { mtime: number; size: number } };
      f.stat = { mtime, size: content.length };
      filesMap.set(filePath, { file: f, content, mtime, size: content.length });
      return f;
    };

    const untouchedFile = addDiskFile(
      "untouched.org",
      "* Untouched\n:PROPERTIES:\n:ID: untouched-1\n:END:\nStable.\n"
    );
    const dup1File = addDiskFile(
      "dup1.org",
      "* Section A\n** Sub A\n:PROPERTIES:\n:ID: dup-xyz\n:END:\n"
    );
    const dup2File = addDiskFile(
      "dup2.org",
      "* Section B\n:PROPERTIES:\n:ID: dup-xyz\n:END:\n"
    );
    const brokenFile = addDiskFile(
      "broken.org",
      "* Refs\n#+TRANSCLUDE: [[id:ghost-node-404]] :level 2\nEmpty: [[id:]]\n"
    );

    const readSpy = vi.fn(async (file: TFile) => {
      return filesMap.get(file.path)?.content ?? "";
    });

    const app = {
      ...baseApp,
      vault: {
        ...baseApp.vault,
        getFiles: () => Array.from(filesMap.values()).map((entry) => entry.file),
        getAbstractFileByPath: (p: string) => filesMap.get(p)?.file ?? null,
        cachedRead: readSpy,
        on: (event: string, cb: (...args: unknown[]) => void) => {
          (vaultHandlers[event] ??= []).push(cb);
          return { event, cb };
        },
      },
    };

    const pluginStub = {
      t: (key: TranslationKey) => translate("en", key),
      uiLanguage: "en" as const,
      registerEvent: () => {},
    } as unknown as OrgNativePlugin;

    const service = new VaultIndexService(
      app as unknown as import("obsidian").App,
      pluginStub,
      { debounceMs: 15, batchSize: 2 }
    );
    service.start();

    // Before initialize(): indexOutdated is true
    expect(service.getExtendedDiagnostics().indexOutdated.isOutdated).toBe(true);

    await service.initialize();
    expect(service.index.getMetrics().fullScans).toBe(1);
    expect(service.getExtendedDiagnostics().indexOutdated.isOutdated).toBe(false);

    // Opening or navigating to a missing ID records Node Not Found WITHOUT doing a full scan
    readSpy.mockClear();
    const foundMissing = await service.navigateToId("never-existed-999");
    expect(foundMissing).toBe(false);
    expect(service.index.getMetrics().fullScans).toBe(1);
    expect(readSpy).not.toHaveBeenCalled();

    // Attempting to open a node whose backing file vanished records file-missing
    await service.openNode({
      id: "vanished-id",
      filePath: "missing-file.org",
      line: 0,
      endLine: 0,
      level: 1,
      title: "Vanished",
      headingPath: ["Vanished"],
      drawerStartLine: 1,
      drawerEndLine: 3,
    });

    // External disk edit changes mtime/size without firing vault event -> Index Outdated detects modified file
    const brokenEntry = filesMap.get("broken.org")!;
    brokenEntry.content = "* Refs\n#+TRANSCLUDE: [[id:ghost-node-404]] :level 2\nEmpty: [[id:]]\nUpdated.\n";
    brokenEntry.mtime = 2500;
    (brokenEntry.file as TFile & { stat: { mtime: number; size: number } }).stat = {
      mtime: 2500,
      size: brokenEntry.content.length,
    };

    // Also add an unindexed file on disk
    addDiskFile("late.org", "* Late Node\n:PROPERTIES:\n:ID: late-node-7\n:END:\nLate.\n");

    const extDiag = service.getExtendedDiagnostics();
    expect(extDiag.duplicates.map((d) => d.id)).toEqual(["dup-xyz"]);
    expect(extDiag.brokenLinks.map((b) => b.link.targetId)).toEqual(["ghost-node-404"]);
    expect(extDiag.invalidIdLinks).toHaveLength(1);
    expect(extDiag.nodeNotFound.map((n) => n.reason)).toEqual(
      expect.arrayContaining(["id-not-indexed", "file-missing"])
    );
    expect(extDiag.indexOutdated.isOutdated).toBe(true);
    expect(extDiag.indexOutdated.outdatedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: "broken.org", reason: "modified" }),
        expect.objectContaining({ filePath: "late.org", reason: "unindexed" }),
      ])
    );

    // Modal renders all 4 diagnostic sections & "Refresh Outdated" incrementally updates ONLY outdated files
    const modal = new OrgDiagnosticsModal(
      app as unknown as import("obsidian").App,
      pluginStub,
      service
    );
    modal.open();
    expect(modal.contentEl.querySelector(".org-diagnostics-outdated-list")).toBeTruthy();
    expect(modal.contentEl.querySelector(".org-diagnostics-duplicates-list")).toBeTruthy();
    expect(modal.contentEl.querySelector(".org-diagnostics-broken-list")).toBeTruthy();
    expect(modal.contentEl.querySelector(".org-diagnostics-invalid-list")).toBeTruthy();
    expect(modal.contentEl.querySelector(".org-diagnostics-notfound-list")).toBeTruthy();

    readSpy.mockClear();
    const refreshBtn = modal.contentEl.querySelector<HTMLButtonElement>(".org-diagnostics-refresh-btn");
    refreshBtn?.click();
    await flushMicrotasks();

    // Untouched files (untouched.org, dup1.org, dup2.org) MUST NOT be re-read!
    const readPaths = readSpy.mock.calls.map((call) => call[0].path);
    expect(readPaths.sort()).toEqual(["broken.org", "late.org"]);
    expect(readPaths).not.toContain(untouchedFile.path);
    expect(readPaths).not.toContain(dup1File.path);
    expect(readPaths).not.toContain(dup2File.path);
    expect(service.index.getMetrics().fullScans).toBe(1);
    expect(service.index.resolveId("late-node-7").status).toBe("found");

    // Debounced modify coalesces rapid edits into a single incremental upsert
    readSpy.mockClear();
    const lateEntry = filesMap.get("late.org")!;
    lateEntry.content = "* Late Node Renamed\n:PROPERTIES:\n:ID: late-node-7\n:END:\nEdit 1\n";
    vaultHandlers.modify?.forEach((cb) => cb(lateEntry.file));
    lateEntry.content = "* Late Node Final\n:PROPERTIES:\n:ID: late-node-7\n:END:\nEdit 2\n";
    vaultHandlers.modify?.forEach((cb) => cb(lateEntry.file));

    expect(service.getExtendedDiagnostics().indexOutdated.outdatedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: "late.org", reason: "pending-update" }),
      ])
    );

    await waitMs(40);
    expect(readSpy).toHaveBeenCalledTimes(1);
    const lateNode = service.index.resolveId("late-node-7");
    expect(lateNode.status).toBe("found");
    if (lateNode.status === "found") {
      expect(lateNode.node.title).toBe("Late Node Final");
    }

    // Hover preview options helper uses read-only readFile without mutating
    const hoverOpts = createHoverPreviewOptions(service);
    expect(await hoverOpts.readFile("late.org")).toContain("Edit 2");

    // Unchanged content upsert is skipped via content hash
    const skipsBefore = service.index.getMetrics().skippedUnchanged;
    service.index.upsertFile(brokenFile.path, brokenEntry.content);
    expect(service.index.getMetrics().skippedUnchanged).toBe(skipsBefore + 1);

    service.destroy();
  });

  it("handles 500+ nodes incrementally across edits, renames, moves, and deletes without full rescans", () => {
    const index = new OrgIdIndex();
    const fileCount = 50;
    const nodesPerFile = 10;

    for (let f = 0; f < fileCount; f++) {
      const lines: string[] = [`#+TITLE: Corpus ${f}`];
      for (let n = 0; n < nodesPerFile; n++) {
        const id = `node-${f}-${n}`;
        const nextId = `node-${(f + 1) % fileCount}-${n}`;
        lines.push(
          `* Heading ${f}.${n}`,
          ":PROPERTIES:",
          `:ID: ${id}`,
          ":END:",
          `References [[id:${nextId}]] in corpus.`
        );
      }
      index.upsertFile(`corpus/file-${f}.org`, lines.join("\n"));
    }
    index.markInitialized(Date.now(), false);

    expect(index.getDiagnostics().fileCount).toBe(50);
    expect(index.getDiagnostics().nodeCount).toBe(500);
    expect(index.getBrokenIdLinks()).toHaveLength(0);

    // Rename file-10.org -> archive/file-10.org and verify backlinks + node resolution remain intact
    index.renameFile("corpus/file-10.org", "archive/file-10.org");
    const movedTarget = index.resolveId("node-10-3");
    expect(movedTarget.status).toBe("found");
    if (movedTarget.status === "found") {
      expect(movedTarget.node.filePath).toBe("archive/file-10.org");
    }
    expect(index.getBacklinks("node-10-3")).toHaveLength(1);
    expect(index.getBacklinks("node-11-3")[0].sourcePath).toBe("archive/file-10.org");

    // Delete file-20.org -> outgoing links from file-19 referencing node-20-* become broken
    index.removeFile("corpus/file-20.org");
    expect(index.resolveId("node-20-0").status).toBe("missing");
    expect(index.getBrokenIdLinks()).toHaveLength(nodesPerFile);

    // Move node-20-0 into file-21.org -> node-20-0 is restored while 20-1..20-9 stay broken
    index.upsertFile(
      "corpus/file-21.org",
      "* Restored\n:PROPERTIES:\n:ID: node-20-0\n:END:\n"
    );
    expect(index.resolveId("node-20-0").status).toBe("found");
    expect(index.getBrokenIdLinks()).toHaveLength(nodesPerFile - 1);
    expect(index.getMetrics().fullScans).toBe(0);
  });

  it("registers view, commands, and hover preview lifecycle cleanly via registerNodeNavigation", async () => {
    const baseApp = createMockApp();
    const detachSpy = vi.fn();
    const revealSpy = vi.fn();
    const setViewStateSpy = vi.fn(async () => {});
    const registeredViews = new Map<string, (leaf: unknown) => unknown>();
    const registeredCommands = new Map<string, { id: string; name: string; callback?: () => void }>();

    const app = {
      ...baseApp,
      workspace: {
        ...baseApp.workspace,
        getRightLeaf: () => ({ setViewState: setViewStateSpy, openFile: async () => {} }),
        revealLeaf: revealSpy,
        detachLeavesOfType: detachSpy,
      },
    };

    const pluginStub = {
      app,
      uiLanguage: "zh" as const,
      t: (key: TranslationKey) => translate("zh", key),
      registerView: (type: string, creator: (leaf: unknown) => unknown) => {
        registeredViews.set(type, creator);
      },
      addCommand: (cmd: { id: string; name: string; callback?: () => void }) => {
        registeredCommands.set(cmd.id, cmd);
      },
    } as unknown as OrgNativePlugin;

    const service = new VaultIndexService(app as unknown as import("obsidian").App, pluginStub);
    const handle = registerNodeNavigation({ plugin: pluginStub, vaultIndex: service });

    expect(registeredViews.has(VIEW_TYPE_ORG_BACKLINKS)).toBe(true);
    expect(registeredCommands.has("quick-open-node")).toBe(true);
    expect(registeredCommands.has("open-backlinks")).toBe(true);
    expect(handle.getCommandNames()["org-native:quick-open-node"]).toBe(
      translate("zh", "command.quickOpenNode")
    );

    await handle.openBacklinksView();
    expect(setViewStateSpy).toHaveBeenCalledWith({
      type: VIEW_TYPE_ORG_BACKLINKS,
      active: true,
    });
    expect(revealSpy).toHaveBeenCalled();

    const root = document.createElement("div");
    const host = document.createElement("div");
    const link = document.createElement("a");
    link.className = "org-link-id";
    link.dataset.orgId = "missing-in-reg";
    root.appendChild(link);
    document.body.append(root, host);

    handle.attachHoverPreview(root, { hoverDelayMs: 0, hostContainer: host });
    link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await flushMicrotasks();
    expect(host.querySelector(".org-node-hover-popover")).toBeTruthy();

    handle.dispose();
    expect(detachSpy).toHaveBeenCalledWith(VIEW_TYPE_ORG_BACKLINKS);
    expect(host.querySelector(".org-node-hover-popover")).toBeNull();

    // Ensure extractNodePreviewDetail handles missing direct body by surfacing child outline
    const parentOnlyDoc = "* Parent\n:PROPERTIES:\n:ID: p1\n:END:\n** Child One\n** Child Two\n";
    const idx = new OrgIdIndex();
    idx.upsertFile("p.org", parentOnlyDoc);
    const pNode = idx.getNodesInFile("p.org")[0];
    const detail = extractNodePreviewDetail(parentOnlyDoc, pNode, { includeHeading: false });
    expect(detail.text).toContain("** Child One");

    root.remove();
    host.remove();
  });
});
