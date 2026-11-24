import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMockApp, TFile } from "./mocks/obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";
import { OrgIdIndex } from "../src/core/index/orgIdIndex";
import {
  OrgTransclusionEngine,
  createMemoryTransclusionProvider,
  createVaultTransclusionProvider,
} from "../src/core/transclusion";
import {
  TransclusionRefreshController,
  renderOrgPreviewWithTransclusions,
} from "../src/views/transclusion";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures/transclusion");

const FIXTURE_PATHS = [
  "01-knowledge-nodes.org",
  "02-assembled-article.org",
  "03-edge-and-errors.org",
  "sub/04-nested-leaf.org",
] as const;

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function loadDiskCorpus() {
  const files = new Map<string, string>();
  const hashes = new Map<string, string>();
  const index = new OrgIdIndex();

  for (const rel of FIXTURE_PATHS) {
    const full = path.join(FIXTURES_DIR, rel);
    const content = fs.readFileSync(full, "utf8");
    files.set(rel, content);
    hashes.set(rel, sha256(content));
    index.upsertFile(rel, content);
  }

  return { files, hashes, index };
}

describe("Transclusion Reading Renderer & Refresh Controller", () => {
  it("expands assembled article seamlessly with adjusted headings, math, lists, code, tables, nested nodes, and jump links", async () => {
    const { files, hashes, index } = loadDiskCorpus();
    const provider = createMemoryTransclusionProvider(files, index);
    const engine = new OrgTransclusionEngine(provider);
    const app = createMockApp() as unknown as import("obsidian").App;
    const onOpenSource = vi.fn();

    const articleSource = files.get("02-assembled-article.org")!;
    const root = await renderOrgPreviewWithTransclusions(
      articleSource,
      app,
      "02-assembled-article.org",
      {
        settings: { ...DEFAULT_SETTINGS, enableTransclusion: true, transclusionMaxDepth: 4 },
        fallbackTitle: "Assembled Article",
        resolveIdStatus: (id) => index.getNodeStatus(id),
      },
      {
        resolver: engine,
        onOpenSource,
      }
    );

    // No unhydrated slots should remain
    expect(root.querySelectorAll(".org-transclude-slot")).toHaveLength(0);

    // Top-of-file transclusion renders in preamble before the first section (not inside metadata)
    const sizer = root.querySelector(".markdown-preview-sizer")!;
    const sizerChildren = Array.from(sizer.children) as HTMLElement[];
    const firstSection = sizerChildren.find((el) => el.classList.contains("org-section"));
    const firstTransclusion = sizerChildren.find((el) => el.classList.contains("org-transclusion"));
    expect(firstTransclusion).toBeTruthy();
    expect(firstSection).toBeTruthy();
    expect(sizerChildren.indexOf(firstTransclusion!)).toBeLessThan(
      sizerChildren.indexOf(firstSection!)
    );
    expect(firstTransclusion?.textContent).toContain("Retains attention sinks");
    expect(firstTransclusion?.querySelector(".org-transclusion-sizer")).toBeTruthy();

    // Rich content from node-episodic renders naturally
    expect(root.textContent).toContain("An episodic buffer stores compact keyframe embeddings");
    expect(root.querySelectorAll(".org-math .mjx-container").length).toBeGreaterThanOrEqual(2);
    expect(root.querySelector("table.org-table")?.textContent).toContain("Recall");
    expect(root.querySelector("pre > code.language-python")?.textContent).toContain("def score_episode");

    // Embedded checkboxes are strictly read-only
    const checkboxes = Array.from(root.querySelectorAll<HTMLInputElement>(".org-transclusion input.org-task-checkbox"));
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    expect(checkboxes.every((cb) => cb.disabled)).toBe(true);

    // Heading levels adjusted for :level 2, bare :level under ** (3), and :only-contents :level 3
    const demotedGraph = Array.from(root.querySelectorAll<HTMLElement>(".org-transclusion")).find(
      (el) => el.dataset.canonicalKey === "id:node-graph"
    );
    expect(demotedGraph?.querySelector("h2.org-heading-preview")?.getAttribute("data-level")).toBe("2");

    const autoKv = Array.from(root.querySelectorAll<HTMLElement>(".org-transclusion")).find(
      (el) =>
        el.dataset.canonicalKey === "id:node-kv" &&
        el.dataset.rawDirective?.includes(":level") &&
        !el.dataset.rawDirective?.includes(":level 2")
    );
    expect(autoKv?.querySelector("h3.org-heading-preview")?.getAttribute("data-level")).toBe("3");

    const onlyContentsSubtree = Array.from(root.querySelectorAll<HTMLElement>(".org-transclusion")).find(
      (el) =>
        el.dataset.canonicalKey === "id:node-episodic" &&
        el.dataset.rawDirective?.includes(":only-contents")
    );
    expect(onlyContentsSubtree?.querySelector(".org-transclusion-body")?.textContent).not.toContain(
      "Episodic Memory Buffer"
    );
    expect(onlyContentsSubtree?.querySelector("h3.org-heading-preview")?.textContent).toContain(
      "Retrieval Scoring"
    );

    // :exclude-elements "drawer planning" omits LOGBOOK and SCHEDULED
    const filteredEpisodic = Array.from(root.querySelectorAll<HTMLElement>(".org-transclusion")).find(
      (el) => el.dataset.rawDirective?.includes(':exclude-elements "drawer planning"')
    );
    expect(filteredEpisodic?.textContent).not.toContain("SCHEDULED:");
    expect(filteredEpisodic?.textContent).not.toContain("logbook");

    // :lines 1-6, #+NAME: table, and <<key-claim>> dedicated target all expand
    const linesSliceEl = Array.from(root.querySelectorAll<HTMLElement>(".org-transclusion")).find(
      (el) => el.dataset.rawDirective?.includes(":lines 1-6")
    );
    expect(linesSliceEl?.textContent).toContain("Line 1: Leaf fixture preamble alpha");
    expect(linesSliceEl?.textContent).toContain("Line 6: Leaf fixture preamble zeta");
    expect(linesSliceEl?.textContent).not.toContain("Aggregated leaf latency");

    const tableSliceEl = Array.from(root.querySelectorAll<HTMLElement>(".org-transclusion")).find(
      (el) => el.dataset.rawDirective?.includes("::metric-table")
    );
    expect(tableSliceEl?.textContent).toContain("Replan");

    const dedicatedSliceEl = Array.from(root.querySelectorAll<HTMLElement>(".org-transclusion")).find(
      (el) => el.dataset.rawDirective?.includes("::key-claim")
    );
    expect(dedicatedSliceEl?.textContent).toContain("invariant causal dependencies");
    expect(dedicatedSliceEl?.textContent).not.toContain("<<key-claim>>");

    // 4-level nested chain (depth 0 -> 1 -> 2 -> 3) expands completely
    expect(root.querySelector('[data-transclusion-depth="0"]')).toBeTruthy();
    expect(root.querySelector('[data-transclusion-depth="1"]')).toBeTruthy();
    expect(root.querySelector('[data-transclusion-depth="2"]')).toBeTruthy();
    expect(root.querySelector('[data-transclusion-depth="3"]')).toBeTruthy();
    expect(root.textContent).toContain("Aggregated leaf latency is 1.9 ms per step.");

    // Fake #+transclude: inside src/example/comment stays literal and unexpanded
    const srcText = Array.from(root.querySelectorAll("pre > code.language-org"))
      .map((el) => el.textContent ?? "")
      .join("\n");
    expect(srcText).toContain("#+transclude: [[id:node-graph]]");

    // Clicking source link triggers jump-to-source with exact file path and 0-based line
    const firstSourceLink = firstTransclusion!.querySelector<HTMLAnchorElement>(".org-transclusion-source-link");
    expect(firstSourceLink).toBeTruthy();
    firstSourceLink!.click();
    expect(onOpenSource).toHaveBeenCalledTimes(1);
    expect(onOpenSource.mock.calls[0][0]).toBe("01-knowledge-nodes.org");
    expect(onOpenSource.mock.calls[0][1]).toBe(57);

    // Fixture files on disk are byte-for-byte untouched
    for (const rel of FIXTURE_PATHS) {
      const current = fs.readFileSync(path.join(FIXTURES_DIR, rel), "utf8");
      expect(sha256(current)).toBe(hashes.get(rel));
    }
  });

  it("renders inert keywords when enableTransclusion is false", async () => {
    const { files, index } = loadDiskCorpus();
    const engine = new OrgTransclusionEngine(createMemoryTransclusionProvider(files, index));
    const app = createMockApp() as unknown as import("obsidian").App;

    const root = await renderOrgPreviewWithTransclusions(
      "* Section\n#+transclude: [[id:node-kv]]",
      app,
      "disabled.org",
      { settings: { ...DEFAULT_SETTINGS, enableTransclusion: false } },
      { resolver: engine }
    );

    expect(root.querySelectorAll(".org-transclusion")).toHaveLength(0);
    expect(root.querySelector(".org-keyword-line")?.textContent).toContain("TRANSCLUDE");
  });

  it("isolates cycles, depth overflow, missing targets, security blocks, unsupported params, and XSS while keeping rest of article intact", async () => {
    const { files, index } = loadDiskCorpus();
    const engine = new OrgTransclusionEngine(createMemoryTransclusionProvider(files, index));
    const app = createMockApp() as unknown as import("obsidian").App;

    const errorDoc = files.get("03-edge-and-errors.org")!;
    const root = await renderOrgPreviewWithTransclusions(
      errorDoc,
      app,
      "03-edge-and-errors.org",
      { settings: { ...DEFAULT_SETTINGS, enableTransclusion: true, transclusionMaxDepth: 4 } },
      { resolver: engine }
    );

    expect(root.querySelectorAll(".org-transclusion-error-cycle").length).toBeGreaterThanOrEqual(2);
    expect(root.querySelectorAll(".org-transclusion-error-depth-exceeded").length).toBeGreaterThanOrEqual(1);
    expect(root.querySelectorAll(".org-transclusion-error-missing").length).toBeGreaterThanOrEqual(3);
    expect(root.querySelectorAll(".org-transclusion-error-security-blocked").length).toBeGreaterThanOrEqual(9);
    expect(root.querySelectorAll(".org-transclusion-error-unsupported").length).toBeGreaterThanOrEqual(1);

    // Unsupported params warning rendered visibly
    const unsupportedWarning = root.querySelector(".org-transclusion-warning.is-unsupported");
    expect(unsupportedWarning?.textContent).toContain(":expand-links");
    expect(unsupportedWarning?.textContent).toContain(":unknown-flag");

    // XSS payloads inside transcluded content are sanitized completely
    expect(root.querySelectorAll("script")).toHaveLength(0);
    expect(root.querySelectorAll("[onerror]")).toHaveLength(0);
    for (const anchor of Array.from(root.querySelectorAll("a"))) {
      const href = (anchor.getAttribute("href") ?? "").toLowerCase();
      expect(href.startsWith("javascript:")).toBe(false);
      expect(href.startsWith("data:")).toBe(false);
    }
    expect(root.querySelectorAll(".org-link-unsafe").length).toBeGreaterThanOrEqual(2);

    // Trailing healthy section is unaffected
    expect(root.textContent).toContain("Trailing Healthy Section");
    expect(root.textContent).toContain("Final paragraph remains intact after all errors above.");
  });

  it("refreshes rendered Reading View when a transcluded source node changes and cancels stale hydrations", async () => {
    const { files, index } = loadDiskCorpus();
    const baseApp = createMockApp();
    const tfiles = new Map<string, TFile>();
    for (const rel of FIXTURE_PATHS) {
      tfiles.set(rel, new TFile(rel));
    }
    const obsidianApp = {
      ...baseApp,
      vault: {
        ...baseApp.vault,
        getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
        getFiles: () => Array.from(tfiles.values()),
        cachedRead: async (f: TFile) => files.get(f.path) ?? "",
      },
    } as unknown as import("obsidian").App;
    const provider = createVaultTransclusionProvider(obsidianApp, index);
    const engine = new OrgTransclusionEngine(provider);

    const hostDoc = "* Host\n#+transclude: [[id:node-kv]] :level 2\n";
    let renderedRoot!: HTMLElement;
    const refreshSpy = vi.fn(async () => {
      const session = controller.beginHydration();
      renderedRoot = await renderOrgPreviewWithTransclusions(
        hostDoc,
        obsidianApp,
        "host.org",
        { settings: { ...DEFAULT_SETTINGS, enableTransclusion: true } },
        {
          resolver: engine,
          signal: session.signal,
          isStale: session.isStale,
          onDependency: session.onDependency,
        }
      );
    });
    const controller = new TransclusionRefreshController(refreshSpy);

    await refreshSpy();
    expect(renderedRoot.textContent).toContain("Retains attention sinks");
    expect(controller.getTrackedDependencies()).toEqual(["01-knowledge-nodes.org"]);

    // Unrelated file change must not trigger a re-render
    expect(controller.notifyFileChanged("unrelated-note.org")).toBe(false);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // Mutate in-memory source (simulating Emacs edit on disk) and update index
    const updatedSource = files
      .get("01-knowledge-nodes.org")!
      .replace(
        "Retains attention sinks and salient visual tokens",
        "UPDATED_IN_EMACS: Retains hybrid streaming sinks and salient tokens"
      );
    files.set("01-knowledge-nodes.org", updatedSource);
    index.upsertFile("01-knowledge-nodes.org", updatedSource);

    expect(controller.notifyFileChanged("01-knowledge-nodes.org")).toBe(true);
    await vi.waitFor(() => {
      expect(renderedRoot.textContent).toContain("UPDATED_IN_EMACS:");
    });
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    // Starting a new hydration cancels previous session cleanly
    const s1 = controller.beginHydration();
    const s2 = controller.beginHydration();
    expect(s1.signal.aborted).toBe(true);
    expect(s1.isStale()).toBe(true);
    expect(s2.signal.aborted).toBe(false);
    expect(s2.isStale()).toBe(false);

    controller.dispose();
    expect(s2.signal.aborted).toBe(true);
  });

  it("blocks same-file self-section and whole-file cycles while allowing sibling section transclusion and enforcing DOM budgets", async () => {
    const sameFileDoc = [
      "* Alpha Section",
      ":PROPERTIES:",
      ":ID: local-alpha",
      ":END:",
      "Alpha content.",
      "#+transclude: [[id:local-alpha]]",
      "",
      "* Beta Section",
      "Sibling pulls Alpha cleanly:",
      "#+transclude: [[id:local-alpha]] :only-contents",
      "#+transclude: [[file:same-file.org]]",
    ].join("\n");

    const files = new Map<string, string>([
      ["same-file.org", sameFileDoc],
      ["leaf.org", "* Leaf\n:PROPERTIES:\n:ID: leaf-1\n:END:\n" + "X".repeat(120)],
    ]);
    const index = new OrgIdIndex();
    for (const [p, content] of files) index.upsertFile(p, content);

    const app = createMockApp() as unknown as import("obsidian").App;
    const engine = new OrgTransclusionEngine(createMemoryTransclusionProvider(files, index));

    const root = await renderOrgPreviewWithTransclusions(
      sameFileDoc,
      app,
      "same-file.org",
      { settings: { ...DEFAULT_SETTINGS, enableTransclusion: true } },
      { resolver: engine }
    );

    const sections = Array.from(root.querySelectorAll<HTMLElement>(".org-section"));
    const alphaSec = sections.find((s) => s.dataset.orgId === "local-alpha")!;
    const betaSec = sections.find((s) => s.dataset.title === "beta section")!;

    // Self-section transclusion under Alpha is blocked as cycle
    expect(alphaSec.querySelectorAll(".org-transclusion-error-cycle")).toHaveLength(1);
    // Sibling transclusion under Beta succeeds (and blocks Alpha's nested self-cycle at depth 1),
    // while whole-file self-transclusion directly under Beta is blocked at depth 0
    expect(betaSec.querySelectorAll('.org-transclusion[data-transclusion-status="ok"]')).toHaveLength(1);
    expect(betaSec.querySelector('.org-transclusion[data-transclusion-status="ok"]')?.textContent).toContain(
      "Alpha content."
    );
    expect(
      betaSec.querySelectorAll('.org-transclusion-error-cycle[data-transclusion-depth="0"]')
    ).toHaveLength(1);
    expect(
      betaSec.querySelectorAll('.org-transclusion-error-cycle[data-transclusion-depth="1"]')
    ).toHaveLength(1);

    // Budget caps across multiple slots stop cleanly without crashing
    const manySlots = [
      "#+transclude: [[id:leaf-1]]",
      "#+transclude: [[id:leaf-1]]",
      "#+transclude: [[id:leaf-1]]",
    ].join("\n");
    const budgetedRoot = await renderOrgPreviewWithTransclusions(
      manySlots,
      app,
      "budget.org",
      { settings: { ...DEFAULT_SETTINGS, enableTransclusion: true } },
      { resolver: engine, maxExpansions: 2, maxTotalChars: 200 }
    );
    expect(
      budgetedRoot.querySelectorAll('.org-transclusion[data-transclusion-status="ok"]')
    ).toHaveLength(2);
    expect(budgetedRoot.querySelectorAll(".org-transclusion-error-depth-exceeded")).toHaveLength(1);
  });
});
