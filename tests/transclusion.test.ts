import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OrgIdIndex } from "../src/core/index/orgIdIndex";
import {
  OrgTransclusionEngine,
  buildLocationCanonicalKey,
  createMemoryTransclusionProvider,
  extractAndTransformTransclusion,
  findTransclusionDirectives,
  parseTransclusionDirective,
  resolveSafeVaultPath,
  truncateOrgContentSafely,
} from "../src/core/transclusion";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures/transclusion");

function loadFixtureCorpus() {
  const files = new Map<string, string>();
  const index = new OrgIdIndex();

  const paths = [
    "01-knowledge-nodes.org",
    "02-assembled-article.org",
    "03-edge-and-errors.org",
    "sub/04-nested-leaf.org",
  ];

  for (const rel of paths) {
    const content = fs.readFileSync(path.join(FIXTURES_DIR, rel), "utf8");
    files.set(rel, content);
    index.upsertFile(rel, content);
  }

  return { files, index };
}

describe("resolveSafeVaultPath", () => {
  it("resolves valid relative and in-vault parent paths cleanly", () => {
    expect(resolveSafeVaultPath("file:01-knowledge-nodes.org", "02-assembled-article.org")).toEqual({
      ok: true,
      vaultPath: "01-knowledge-nodes.org",
    });
    expect(resolveSafeVaultPath("./leaf.org", "sub/nested.org")).toEqual({
      ok: true,
      vaultPath: "sub/leaf.org",
    });
    expect(resolveSafeVaultPath("../01-knowledge-nodes.org", "sub/04-nested-leaf.org")).toEqual({
      ok: true,
      vaultPath: "01-knowledge-nodes.org",
    });
    expect(resolveSafeVaultPath("file:notes/deep/node.org", "index.org")).toEqual({
      ok: true,
      vaultPath: "notes/deep/node.org",
    });
  });

  it("blocks traversal escapes, absolute/OS paths, URI schemes, percent-encoding, and hidden folders", () => {
    const hostile = [
      "",
      "   ",
      "../../../etc/passwd",
      "file:../../outside.org",
      "../../escape.org",
      "/etc/passwd",
      "file:/etc/passwd",
      "file:///etc/passwd",
      "file:file:///etc/passwd",
      "~/secret.org",
      "~/.ssh/id_rsa",
      "~alice/.bashrc",
      "C:\\Windows\\win.ini",
      "D:/secrets/notes.org",
      "\\\\server\\share\\file.org",
      "//server/share/file.org",
      ".obsidian/app.json",
      "sub/../.obsidian/plugins/x/data.json",
      ".git/config",
      "%2e%2e/%2e%2e/secret.org",
      "sub/%2e%2e/%2e%2e/%2e%2e/secret.org",
      "%E0%A4%A", // malformed percent encoding
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://example.com/remote.org",
      "notes/dir/",
      "bad\u0000path.org",
    ];

    for (const candidate of hostile) {
      const res = resolveSafeVaultPath(candidate, "sub/doc.org");
      expect(res.ok, `Expected blocked path for: ${candidate}`).toBe(false);
    }
    expect(resolveSafeVaultPath("../escape.org", "doc.org").ok).toBe(false);
    expect(resolveSafeVaultPath("sub/%2e%2e/%2e%2e/secret.org", "doc.org").ok).toBe(false);
  });
});

describe("parseTransclusionDirective & findTransclusionDirectives", () => {
  it("parses id, file, subpaths, :level, :only-contents, :exclude-elements, :lines, and unsupported params", () => {
    const d1 = parseTransclusionDirective(
      "#+transclude: [[id:node-a]] :level 2 :only-contents",
      "article.org",
      10,
      1
    )!;
    expect(d1.targetType).toBe("id");
    expect(d1.target).toBe("node-a");
    expect(d1.parentLevel).toBe(1);
    expect(d1.options).toEqual({
      level: 2,
      levelAuto: false,
      onlyContents: true,
      unsupportedParams: [],
    });

    const d2 = parseTransclusionDirective(
      "#+TRANSCLUDE: [[file:notes/kb.org::*Deep Topic]] :level :exclude-elements \"drawer planning\" :lines 3-15",
      "article.org",
      20,
      2
    )!;
    expect(d2.targetType).toBe("file");
    expect(d2.target).toBe("notes/kb.org");
    expect(d2.subpath).toEqual({ kind: "heading", value: "Deep Topic" });
    expect(d2.options.levelAuto).toBe(true);
    expect(d2.options.level).toBeUndefined();
    expect(d2.options.excludeElements).toEqual(["drawer", "planning"]);
    expect(d2.options.lines).toEqual({ start: 3, end: 15 });
    expect(d2.options.unsupportedParams).toEqual([]);

    const d3 = parseTransclusionDirective(
      "#+transclude: [[#local-custom]] :level auto :lines -5 :expand-links :end \"Stop\" :foo",
      "article.org",
      30,
      1
    )!;
    expect(d3.targetType).toBe("file");
    expect(d3.target).toBe("article.org");
    expect(d3.subpath).toEqual({ kind: "custom-id", value: "local-custom" });
    expect(d3.options.levelAuto).toBe(true);
    expect(d3.options.lines).toEqual({ start: undefined, end: 5 });
    expect(d3.options.unsupportedParams).toEqual([
      ":expand-links",
      ':end "Stop"',
      ":foo",
    ]);

    const d4 = parseTransclusionDirective(
      "#+transclude: [[file:a.org::named-table]] :lines 10-",
      "article.org",
      40,
      0
    )!;
    expect(d4.targetType).toBe("file");
    expect(d4.target).toBe("a.org");
    expect(d4.subpath).toBeUndefined();
    expect(d4.options.lines).toEqual({ start: 10, end: undefined });
  });

  it("ignores fake #+transclude: inside src, example, comment, math, and drawer blocks", () => {
    const doc = [
      "#+TITLE: Code Immunity",
      "#+transclude: [[id:real-preamble]]",
      "",
      "* Real Section",
      "#+transclude: [[id:real-in-section]]",
      "",
      "#+BEGIN_SRC org",
      "#+transclude: [[id:fake-src]]",
      "#+END_SRC",
      "",
      "#+BEGIN_EXAMPLE",
      "#+transclude: [[id:fake-example]]",
      "#+END_EXAMPLE",
      "",
      "#+BEGIN_COMMENT",
      "#+transclude: [[id:fake-comment-block]]",
      "#+END_COMMENT",
      "",
      "# #+transclude: [[id:fake-comment-line]]",
      "",
      ":NOTES:",
      "#+transclude: [[id:fake-drawer]]",
      ":END:",
      "",
      "$$",
      "#+transclude: [[id:fake-math]]",
      "$$",
    ].join("\n");

    const found = findTransclusionDirectives(doc, "immunity.org");
    expect(found.map((d) => ({ target: d.target, parentLevel: d.parentLevel }))).toEqual([
      { target: "real-preamble", parentLevel: 0 },
      { target: "real-in-section", parentLevel: 1 },
    ]);
  });
});

describe("extractAndTransformTransclusion & OrgTransclusionEngine", () => {
  it("transforms heading levels, :only-contents, :exclude-elements, and :lines without altering code blocks", () => {
    const sample = [
      "* Parent Heading",
      ":PROPERTIES:",
      ":ID: test-node",
      ":CUSTOM_ID: test-custom",
      ":END:",
      "SCHEDULED: <2026-11-24 Tue>",
      ":LOGBOOK:",
      "- Note taken",
      ":END:",
      "Intro paragraph.",
      "#+BEGIN_SRC org",
      "* Star in src must stay level 1",
      "#+END_SRC",
      "** Subheading",
      "Sub body.",
    ].join("\n");

    // Promote/demote to level 3: Parent -> ***, Subheading -> ****, src line unchanged
    const shifted = extractAndTransformTransclusion(
      sample,
      { kind: "file", filePath: "sample.org", subpath: { kind: "heading", value: "Parent Heading" } },
      { level: 3, unsupportedParams: [] }
    );
    expect(shifted.ok).toBe(true);
    if (shifted.ok) {
      expect(shifted.content).toContain("*** Parent Heading");
      expect(shifted.content).toContain("**** Subheading");
      expect(shifted.content).toContain("* Star in src must stay level 1");
      // Default excludes property-drawer while keeping LOGBOOK & SCHEDULED
      expect(shifted.content).not.toContain(":ID: test-node");
      expect(shifted.content).toContain(":LOGBOOK:");
      expect(shifted.content).toContain("SCHEDULED:");
    }

    // :only-contents strips Parent Heading & its :PROPERTIES:, preserves Subheading & body
    const onlyContents = extractAndTransformTransclusion(
      sample,
      { kind: "file", filePath: "sample.org", subpath: { kind: "custom-id", value: "test-custom" } },
      { onlyContents: true, level: 2, excludeElements: ["drawer", "planning"], unsupportedParams: [] }
    );
    expect(onlyContents.ok).toBe(true);
    if (onlyContents.ok) {
      expect(onlyContents.content).not.toContain("Parent Heading");
      expect(onlyContents.content).not.toContain(":LOGBOOK:");
      expect(onlyContents.content).not.toContain("SCHEDULED:");
      expect(onlyContents.content).toContain("Intro paragraph.");
      expect(onlyContents.content).toContain("** Subheading");
    }

    // :lines uses 1-based line offsets before element exclusion
    const sliced = extractAndTransformTransclusion(
      sample,
      { kind: "file", filePath: "sample.org" },
      { lines: { start: 10, end: 15 }, unsupportedParams: [] }
    );
    expect(sliced.ok).toBe(true);
    if (sliced.ok) {
      expect(sliced.content.startsWith("Intro paragraph.")).toBe(true);
      expect(sliced.content).toContain("Sub body.");
      expect(sliced.content).not.toContain("SCHEDULED:");
    }
  });

  it("reuses OrgIdIndex to resolve IDs, files, duplicate warnings, cycles, depth, budgets, and size caps", async () => {
    const { files, index } = loadFixtureCorpus();
    const provider = createMemoryTransclusionProvider(files, index);
    const engine = new OrgTransclusionEngine(provider, { defaultMaxDepth: 4 });

    // Resolve ID node
    const episodicDir = parseTransclusionDirective(
      "#+transclude: [[id:node-episodic]] :level 2",
      "02-assembled-article.org",
      5,
      1
    )!;
    const res1 = await engine.resolve(episodicDir);
    expect(res1.status).toBe("ok");
    if (res1.status === "ok") {
      expect(res1.resolvedPath).toBe("01-knowledge-nodes.org");
      expect(res1.resolvedLine).toBe(5);
      expect(res1.readOnly).toBe(true);
      expect(res1.content).toContain("** Episodic Memory Buffer");
      expect(res1.content).toContain("*** Retrieval Scoring");
    }

    // Duplicate ID resolves first match with explicit warning
    const dupDir = parseTransclusionDirective(
      "#+transclude: [[id:dup-node-id]]",
      "03-edge-and-errors.org",
      10,
      1
    )!;
    const dupRes = await engine.resolve(dupDir);
    expect(dupRes.status).toBe("ok");
    if (dupRes.status === "ok") {
      expect(dupRes.duplicateId).toBe(true);
      expect(dupRes.content).toContain("First definition of a duplicate ID node.");
      expect(dupRes.warnings.some((w) => w.includes("Duplicate Org ID"))).toBe(true);
    }

    // Mixed id: + file:::*Heading cycle caught via locationKey
    const graphNodeRes = await engine.resolve(
      parseTransclusionDirective("#+transclude: [[id:node-graph]]", "a.org", 0, 0)!
    );
    expect(graphNodeRes.status).toBe("ok");
    if (graphNodeRes.status === "ok") {
      const locationKey = buildLocationCanonicalKey(graphNodeRes.resolvedPath, graphNodeRes.resolvedLine);
      const mixedCycleRes = await engine.resolve(
        parseTransclusionDirective(
          "#+transclude: [[file:01-knowledge-nodes.org::*Semantic Task Graph]]",
          "a.org",
          1,
          0
        )!,
        { visitedKeys: [graphNodeRes.canonicalKey, locationKey], depth: 1 }
      );
      expect(mixedCycleRes.status).toBe("cycle");
    }

    // Depth guard
    const depthRes = await engine.resolve(
      parseTransclusionDirective("#+transclude: [[id:node-deep-5]]", "01-knowledge-nodes.org", 0, 1)!,
      { depth: 4, maxDepth: 4 }
    );
    expect(depthRes.status).toBe("depth-exceeded");

    // Expansion budget guard
    const budgetRes = await engine.resolve(episodicDir, { budget: { remaining: 0 } });
    expect(budgetRes.status).toBe("depth-exceeded");

    // Security block for external/traversal targets
    const secRes = await engine.resolve(
      parseTransclusionDirective("#+transclude: [[file:../../../etc/passwd]]", "03-edge-and-errors.org", 1, 1)!
    );
    expect(secRes.status).toBe("security-blocked");

    // Unsupported remote URL
    const unsupportedRes = await engine.resolve(
      parseTransclusionDirective("#+transclude: [[https://example.com/remote.org]]", "03-edge-and-errors.org", 2, 1)!
    );
    expect(unsupportedRes.status).toBe("unsupported");
  });

  it("truncates oversized transclusions cleanly while closing open code/drawer/math blocks", async () => {
    const bigSrc = [
      "* Huge Node",
      ":PROPERTIES:",
      ":ID: huge-node",
      ":END:",
      "#+BEGIN_SRC python",
      ...Array.from({ length: 120 }, (_, i) => `x_${i} = ${i} * 2`),
      "#+END_SRC",
    ].join("\n");

    const truncated = truncateOrgContentSafely(bigSrc, 180);
    expect(truncated.truncated).toBe(true);
    expect(truncated.content.endsWith("#+END_SRC")).toBe(true);

    const files = new Map([["big.org", bigSrc]]);
    const index = new OrgIdIndex();
    index.upsertFile("big.org", bigSrc);
    const engine = new OrgTransclusionEngine(createMemoryTransclusionProvider(files, index), {
      maxSingleExpansionChars: 160,
    });

    const res = await engine.resolve(
      parseTransclusionDirective("#+transclude: [[id:huge-node]]", "host.org", 0, 0)!
    );
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.content).toContain("#+END_SRC");
      expect(res.warnings.some((w) => w.includes("truncated"))).toBe(true);
    }
  });
});
