import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMockApp } from "./mocks/obsidian";
import { DEFAULT_SETTINGS } from "../src/settings";
import { extractOrgFileIndexData, OrgIdIndex } from "../src/core/index/orgIdIndex";
import { renderOrgPreview } from "../src/views/reading/render";

describe("OrgIdIndex & cross-file node navigation", () => {
  it("extracts file-level and heading-level :ID: and :CUSTOM_ID: properties", () => {
    const doc = [
      ":PROPERTIES:",
      ":id: file-node-001",
      ":CUSTOM_ID: file-root",
      ":END:",
      "#+TITLE: Knowledge Base",
      "",
      "* TODO Alpha Node",
      "SCHEDULED: <2026-11-24 Tue>",
      ":PROPERTIES:",
      ":ID: alpha-node-123",
      ":CUSTOM_ID: alpha-custom",
      ":END:",
      "See [[id:beta-node-456][Beta]].",
    ].join("\n");

    const data = extractOrgFileIndexData("notes/alpha.org", doc);
    expect(data.nodes).toHaveLength(2);
    expect(data.nodes[0]).toMatchObject({
      id: "file-node-001",
      customId: "file-root",
      filePath: "notes/alpha.org",
      line: 0,
      level: 0,
    });
    expect(data.nodes[1]).toMatchObject({
      id: "alpha-node-123",
      customId: "alpha-custom",
      filePath: "notes/alpha.org",
      line: 6,
      level: 1,
      title: "Alpha Node",
    });
    expect(data.links).toHaveLength(1);
    expect(data.links[0]).toMatchObject({
      sourcePath: "notes/alpha.org",
      line: 12,
      targetId: "beta-node-456",
      desc: "Beta",
    });
  });

  it("never indexes fake :ID: drawers or [[id:...]] links inside code, example, comment, math, or verbatim", () => {
    const doc = [
      "* Real Heading",
      ":PROPERTIES:",
      ":ID: real-id-1",
      ":END:",
      "",
      "Inline example ~[[id:fake-inline-code]]~ and =[[id:fake-verbatim]]=",
      "",
      "#+BEGIN_SRC org",
      "* Fake Heading in Code",
      ":PROPERTIES:",
      ":ID: fake-src-id",
      ":END:",
      "[[id:fake-src-link]]",
      "#+END_SRC",
      "",
      "#+BEGIN_EXAMPLE",
      ":PROPERTIES:",
      ":ID: fake-example-id",
      ":END:",
      "[[id:fake-example-link]]",
      "#+END_EXAMPLE",
      "",
      "#+BEGIN_COMMENT",
      "[[id:fake-comment-link]]",
      "#+END_COMMENT",
      "",
      "# [[id:fake-comment-line]]",
      "$$[[id:fake-math-block]]$$",
      "",
      "Real link to [[id:target-ok]].",
    ].join("\n");

    const data = extractOrgFileIndexData("code-immunity.org", doc);
    expect(data.nodes.map((n) => n.id)).toEqual(["real-id-1"]);
    expect(data.links.map((l) => l.targetId)).toEqual(["target-ok"]);
  });

  it("keeps resolving [[id:...]] after a heading node moves to another file", () => {
    const index = new OrgIdIndex();
    const movingNode = [
      "** Moving Memory Node",
      ":PROPERTIES:",
      ":ID: vla-mem-42",
      ":END:",
      "Content moves cleanly.",
    ].join("\n");

    const sourceBefore = `* Inbox\n\n${movingNode}\n`;
    const targetBefore = "* Archive\nExisting item.\n";
    const referencer = "* Index\nReference to [[id:vla-mem-42][Memory Node]].\n";

    index.upsertFile("inbox.org", sourceBefore);
    index.upsertFile("archive.org", targetBefore);
    index.upsertFile("index.org", referencer);

    const beforeRes = index.resolveId("vla-mem-42");
    expect(beforeRes.status).toBe("found");
    if (beforeRes.status === "found") {
      expect(beforeRes.node.filePath).toBe("inbox.org");
      expect(beforeRes.node.line).toBe(2);
    }
    expect(index.getBrokenIdLinks()).toHaveLength(0);

    // Move node from inbox.org into archive.org
    index.upsertFile("inbox.org", "* Inbox\nEmpty now.\n");
    index.upsertFile("archive.org", `${targetBefore}\n${movingNode}\n`);

    const afterRes = index.resolveId("vla-mem-42");
    expect(afterRes.status).toBe("found");
    if (afterRes.status === "found") {
      expect(afterRes.node.filePath).toBe("archive.org");
      expect(afterRes.node.line).toBe(3);
    }
    expect(index.getBacklinks("vla-mem-42")).toHaveLength(1);
    expect(index.getBacklinks("vla-mem-42")[0].sourcePath).toBe("index.org");
    expect(index.getBrokenIdLinks()).toHaveLength(0);
  });

  it("handles file rename, delete, duplicate ID detection, and broken link diagnostics", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "a.org",
      "* A\n:PROPERTIES:\n:ID: shared-id\n:END:\nLink [[id:missing-id]] and [[id:later-id]]."
    );
    index.upsertFile(
      "b.org",
      "* B\n:PROPERTIES:\n:ID: shared-id\n:END:\n"
    );

    const diag1 = index.getDiagnostics();
    expect(diag1.duplicates).toHaveLength(1);
    expect(diag1.duplicates[0].id).toBe("shared-id");
    expect(diag1.duplicates[0].nodes.map((n) => n.filePath)).toEqual(["a.org", "b.org"]);
    expect(diag1.brokenLinks.map((b) => b.link.targetId)).toEqual(["missing-id", "later-id"]);

    // Rename b.org -> c.org updates duplicate paths cleanly
    index.renameFile("b.org", "c.org");
    expect(index.getDuplicateIds()[0].nodes.map((n) => n.filePath)).toEqual(["a.org", "c.org"]);

    // Adding later-id clears that broken link diagnostic
    index.upsertFile("c.org", "* C\n:PROPERTIES:\n:ID: later-id\n:END:\n");
    expect(index.getDuplicateIds()).toHaveLength(0);
    expect(index.getBrokenIdLinks().map((b) => b.link.targetId)).toEqual(["missing-id"]);

    // Removing a.org clears broken links originating from a.org
    index.removeFile("a.org");
    expect(index.getDiagnostics().brokenLinks).toHaveLength(0);
  });

  it("annotates Reading View links with found, duplicate, and broken status classes", () => {
    const index = new OrgIdIndex();
    index.upsertFile("a.org", "* A\n:PROPERTIES:\n:ID: ok-1\n:END:\n");
    index.upsertFile("b1.org", "* B1\n:PROPERTIES:\n:ID: dup-1\n:END:\n");
    index.upsertFile("b2.org", "* B2\n:PROPERTIES:\n:ID: dup-1\n:END:\n");

    const source = [
      "* Links",
      "Valid: [[id:ok-1][OK]]",
      "Duplicate: [[id:dup-1][Dup]]",
      "Broken: [[id:nope-404][Missing]]",
    ].join("\n");

    const app = createMockApp() as unknown as import("obsidian").App;
    const root = renderOrgPreview(source, app, "links.org", {
      settings: DEFAULT_SETTINGS,
      resolveIdStatus: (id) => index.getNodeStatus(id),
    });

    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a.org-link-id"));
    expect(links).toHaveLength(3);
    expect(links[0].classList.contains("org-link-broken")).toBe(false);
    expect(links[0].classList.contains("org-link-duplicate")).toBe(false);
    expect(links[1].classList.contains("org-link-duplicate")).toBe(true);
    expect(links[2].classList.contains("org-link-broken")).toBe(true);
  });

  it("indexes the isolated test-vault corpus accurately with expected diagnostics", () => {
    const vaultDir = path.resolve(process.cwd(), "test-vault");
    const orgFiles = fs
      .readdirSync(vaultDir)
      .filter((f) => f.endsWith(".org"))
      .sort();
    expect(orgFiles).toHaveLength(6);

    const index = new OrgIdIndex();
    for (const file of orgFiles) {
      index.upsertFile(file, fs.readFileSync(path.join(vaultDir, file), "utf8"));
    }

    // Fake ID inside #+BEGIN_SRC org in 02-math-code-and-tables.org & 06-transclusion-demo.org must NOT be indexed
    expect(index.resolveId("fake-id-must-not-be-indexed").status).toBe("missing");
    expect(index.resolveId("fake-transclude-target-id").status).toBe("missing");

    // Cross-file nodes in 01..06 must resolve cleanly
    for (const id of [
      "org-native-welcome-root",
      "welcome-core-idea",
      "vla-memory-overview",
      "node-episodic-memory",
      "node-semantic-graph",
      "node-kv-compression",
      "transclusion-nested-parent",
      "transclusion-cycle-a",
      "transclusion-cycle-b",
    ]) {
      expect(index.resolveId(id).status).toBe("found");
    }

    const diag = index.getDiagnostics();
    expect(diag.fileCount).toBe(6);
    expect(diag.duplicates.map((d) => d.id)).toEqual(["demo-duplicate-id"]);
    expect(diag.brokenLinks.map((b) => b.link.targetId)).toEqual([
      "missing-demo-404",
      "missing-transclude-404",
    ]);
  });
});
