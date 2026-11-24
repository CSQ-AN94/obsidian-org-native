import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { OrgIdIndex } from "../src/core/index/orgIdIndex";
import {
  ORG_GRAPH_PALETTE,
  assignNodeColors,
  buildLocalOrgGraph,
  buildOrgGraph,
  canonicalDuplicateNodeKey,
  canonicalFileNodeKey,
  canonicalOrgNodeKey,
  canonicalUnresolvedNodeKey,
  diffOrgGraphs,
  matchesGraphQuery,
  parseGraphQuery,
  type OrgGraphColorGroup,
} from "../src/core/graph";

describe("Org Knowledge Graph Data Layer", () => {
  it("builds Node Graph with multiple :ID: headings in one file and file anchors for non-ID sections", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "notes/multi.org",
      [
        "#+TITLE: Multi Node Doc",
        "#+FILETAGS: :knowledge:graph:",
        "",
        "* TODO Alpha Concept :vla:",
        ":PROPERTIES:",
        ":ID: alpha-1",
        ":CUSTOM_ID: custom-alpha",
        ":END:",
        "Refers to [[id:beta-2]] and [[id:gamma-3]].",
        "",
        "** Beta Subnode :memory:",
        ":PROPERTIES:",
        ":ID: beta-2",
        ":END:",
        "Transcludes child:",
        "#+TRANSCLUDE: [[id:gamma-3]]",
        "",
        "* Unindexed Section",
        "Plain section linking to [[id:alpha-1]].",
      ].join("\n")
    );
    index.upsertFile(
      "notes/gamma.org",
      [
        "* Gamma External",
        ":PROPERTIES:",
        ":ID: gamma-3",
        ":END:",
        "Standalone note.",
      ].join("\n")
    );

    const graph = buildOrgGraph(index);
    expect(graph.granularity).toBe("node");
    expect(graph.indexVersion).toBe(index.getVersion());

    const alpha = graph.nodeMap.get(canonicalOrgNodeKey("alpha-1"));
    const beta = graph.nodeMap.get(canonicalOrgNodeKey("beta-2"));
    const gamma = graph.nodeMap.get(canonicalOrgNodeKey("gamma-3"));
    const fileAnchor = graph.nodeMap.get(canonicalFileNodeKey("notes/multi.org"));

    expect(alpha).toBeDefined();
    expect(alpha).toMatchObject({
      kind: "org-node",
      orgId: "alpha-1",
      customId: "custom-alpha",
      todo: "TODO",
      tags: ["vla"],
      headingPath: ["Alpha Concept"],
      status: "found",
      inDegree: 1,
      outDegree: 2,
      degree: 3,
    });

    expect(beta).toBeDefined();
    expect(beta).toMatchObject({
      parentNodeId: "alpha-1",
      headingPath: ["Alpha Concept", "Beta Subnode"],
      tags: ["memory"],
      inDegree: 1,
      outDegree: 1,
      transcludeOut: 1,
      degree: 2,
    });

    expect(gamma).toBeDefined();
    expect(gamma).toMatchObject({
      inDegree: 2,
      transcludeIn: 1,
      outDegree: 0,
      degree: 2,
    });

    // Link from "* Unindexed Section" (no :ID: and no :ID: ancestor) attaches to file:<path>
    expect(fileAnchor).toBeDefined();
    expect(fileAnchor).toMatchObject({
      kind: "file",
      title: "Multi Node Doc",
      filePath: "notes/multi.org",
      outDegree: 1,
      inDegree: 0,
      degree: 1,
    });
    expect(graph.nodeMap.has(canonicalFileNodeKey("notes/gamma.org"))).toBe(false);

    expect(graph.stats).toMatchObject({
      nodeCount: 4,
      edgeCount: 4,
      referenceEdges: 3,
      transclusionEdges: 1,
      structuralEdges: 0,
      orphanCount: 0,
      duplicateCount: 0,
      unresolvedCount: 0,
      fileCount: 2,
    });
  });

  it("builds File Graph collapsing intra-file nodes, combining tags, and aggregating inter-file edges", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "a.org",
      [
        "#+TITLE: Alpha File",
        "#+FILETAGS: :root:",
        "* A1 :topicA:",
        ":PROPERTIES:",
        ":ID: a-1",
        ":END:",
        "Intra-file link [[id:a-2]] should be ignored in file graph.",
        "External 1 [[id:b-1]] and external 2 [[id:b-2]].",
        "",
        "* A2 :topicB:",
        ":PROPERTIES:",
        ":ID: a-2",
        ":END:",
        "#+TRANSCLUDE: [[id:b-1]]",
      ].join("\n")
    );
    index.upsertFile(
      "folder/no-title.org",
      [
        "* B1 :sub:",
        ":PROPERTIES:",
        ":ID: b-1",
        ":END:",
        "* B2",
        ":PROPERTIES:",
        ":ID: b-2",
        ":END:",
      ].join("\n")
    );

    const fileGraph = buildOrgGraph(index, { granularity: "file" });
    expect(fileGraph.granularity).toBe("file");
    expect(fileGraph.nodes).toHaveLength(2);

    const nodeA = fileGraph.nodeMap.get(canonicalFileNodeKey("a.org"))!;
    const nodeB = fileGraph.nodeMap.get(canonicalFileNodeKey("folder/no-title.org"))!;
    expect(nodeA.title).toBe("Alpha File");
    expect(nodeA.tags).toEqual(["topicA", "topicB"]);
    expect(nodeB.title).toBe("no-title.org");
    expect(nodeB.tags).toEqual(["sub"]);

    expect(fileGraph.edges).toHaveLength(2);
    const refEdge = fileGraph.edges.find((e) => e.kind === "reference")!;
    const transEdge = fileGraph.edges.find((e) => e.kind === "transclusion")!;
    expect(refEdge).toMatchObject({
      source: canonicalFileNodeKey("a.org"),
      target: canonicalFileNodeKey("folder/no-title.org"),
      weight: 2,
    });
    expect(refEdge.links).toHaveLength(2);
    expect(transEdge).toMatchObject({
      source: canonicalFileNodeKey("a.org"),
      target: canonicalFileNodeKey("folder/no-title.org"),
      weight: 1,
    });
    expect(nodeA.outDegree).toBe(2);
    expect(nodeA.transcludeOut).toBe(1);
    expect(nodeB.inDegree).toBe(2);
    expect(nodeB.transcludeIn).toBe(1);
  });

  it("distinguishes reference, transclusion, and structural edges (with structural hidden by default)", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "doc.org",
      [
        "#+TITLE: Hierarchy Doc",
        "* Top",
        ":PROPERTIES:",
        ":ID: top-1",
        ":END:",
        "Links [[id:ext-1]].",
        "** Child",
        ":PROPERTIES:",
        ":ID: child-1",
        ":END:",
        "#+TRANSCLUDE: [[id:ext-1]]",
      ].join("\n")
    );
    index.upsertFile(
      "plain.org",
      [
        "#+TITLE: Plain File",
        "No IDs here.",
      ].join("\n")
    );
    index.upsertFile(
      "ext.org",
      [
        "* Ext",
        ":PROPERTIES:",
        ":ID: ext-1",
        ":END:",
      ].join("\n")
    );

    const defaultGraph = buildOrgGraph(index);
    expect(defaultGraph.stats.structuralEdges).toBe(0);
    expect(defaultGraph.edges.map((e) => e.kind).sort()).toEqual([
      "reference",
      "transclusion",
    ]);
    expect(defaultGraph.nodeMap.has(canonicalFileNodeKey("plain.org"))).toBe(false);

    const withStructural = buildOrgGraph(index, {
      filter: { showStructural: true },
    });
    expect(withStructural.nodeMap.has(canonicalFileNodeKey("doc.org"))).toBe(true);
    expect(withStructural.nodeMap.has(canonicalFileNodeKey("plain.org"))).toBe(true);
    expect(withStructural.nodeMap.has(canonicalFileNodeKey("ext.org"))).toBe(true);

    const structuralIds = withStructural.edges
      .filter((e) => e.kind === "structural")
      .map((e) => e.id)
      .sort();
    expect(structuralIds).toEqual([
      `structural:${canonicalFileNodeKey("doc.org")}->${canonicalOrgNodeKey("top-1")}`,
      `structural:${canonicalFileNodeKey("ext.org")}->${canonicalOrgNodeKey("ext-1")}`,
      `structural:${canonicalOrgNodeKey("top-1")}->${canonicalOrgNodeKey("child-1")}`,
    ]);

    const onlyTransclusion = buildOrgGraph(index, {
      filter: { showReference: false, showTransclusion: true, showStructural: false },
    });
    expect(onlyTransclusion.stats.referenceEdges).toBe(0);
    expect(onlyTransclusion.stats.transclusionEdges).toBe(1);
    expect(onlyTransclusion.nodeMap.get(canonicalOrgNodeKey("top-1"))!.degree).toBe(0);
    expect(onlyTransclusion.nodeMap.get(canonicalOrgNodeKey("child-1"))!.transcludeOut).toBe(1);
  });

  it("assigns deterministic parallelIndex and parallelCount across same-pair reference, transclusion, and reverse edges", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "a.org",
      [
        "* A",
        ":PROPERTIES:",
        ":ID: node-a",
        ":END:",
        "First [[id:node-b]] and second [[id:node-b]].",
        "#+TRANSCLUDE: [[id:node-b]]",
      ].join("\n")
    );
    index.upsertFile(
      "b.org",
      [
        "* B",
        ":PROPERTIES:",
        ":ID: node-b",
        ":END:",
        "Back to [[id:node-a]] and solo [[id:node-c]].",
      ].join("\n")
    );
    index.upsertFile(
      "c.org",
      [
        "* C",
        ":PROPERTIES:",
        ":ID: node-c",
        ":END:",
      ].join("\n")
    );

    const graph = buildOrgGraph(index);
    const abEdges = graph.edges.filter(
      (e) =>
        (e.source === "id:node-a" && e.target === "id:node-b") ||
        (e.source === "id:node-b" && e.target === "id:node-a")
    );
    expect(abEdges).toHaveLength(3);
    expect(abEdges.every((e) => e.parallelCount === 3)).toBe(true);
    expect(abEdges.map((e) => e.parallelIndex).sort((a, b) => a! - b!)).toEqual([0, 1, 2]);

    const refAB = abEdges.find(
      (e) => e.source === "id:node-a" && e.target === "id:node-b" && e.kind === "reference"
    )!;
    expect(refAB.weight).toBe(2);
    expect(refAB.links).toHaveLength(2);

    const bcEdge = graph.edges.find(
      (e) => e.source === "id:node-b" && e.target === "id:node-c"
    )!;
    expect(bcEdge.parallelCount).toBe(1);
    expect(bcEdge.parallelIndex).toBe(0);
  });

  it("supports 1/2/3-hop Local Graph, incoming/outgoing direction toggles, search preservation, and safe empty fallback", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "chain.org",
      [
        "* P2 :cluster:",
        ":PROPERTIES:",
        ":ID: p2",
        ":END:",
        "[[id:p1]]",
        "* P1 :cluster:",
        ":PROPERTIES:",
        ":ID: p1",
        ":END:",
        "[[id:center]]",
        "* Center :focus:",
        ":PROPERTIES:",
        ":ID: center",
        ":END:",
        "[[id:n1]] and [[id:mutual]]",
        "* Mutual :cluster:",
        ":PROPERTIES:",
        ":ID: mutual",
        ":END:",
        "[[id:center]]",
        "* N1 :cluster:",
        ":PROPERTIES:",
        ":ID: n1",
        ":END:",
        "[[id:n2]]",
        "* N2 :keep:",
        ":PROPERTIES:",
        ":ID: n2",
        ":END:",
        "[[id:n3]]",
        "* N3",
        ":PROPERTIES:",
        ":ID: n3",
        ":END:",
        "Terminal.",
      ].join("\n")
    );

    const hop1 = buildLocalOrgGraph(index, { centerNodeId: "id:center", depth: 1 });
    expect(hop1.centerNodeId).toBe("id:center");
    expect(hop1.nodes.map((n) => n.id).sort()).toEqual([
      "id:center",
      "id:mutual",
      "id:n1",
      "id:p1",
    ]);
    expect(hop1.nodeMap.get("id:center")!.isCenter).toBe(true);
    expect(hop1.nodeMap.get("id:center")!.hopDistance).toBe(0);
    expect(hop1.nodeMap.get("id:n1")!.isCenter).toBe(false);
    expect(hop1.nodeMap.get("id:n1")!.hopDistance).toBe(1);

    const hop2 = buildLocalOrgGraph(index, { centerNodeId: "id:center", depth: 2 });
    expect(hop2.nodes.map((n) => n.id).sort()).toEqual([
      "id:center",
      "id:mutual",
      "id:n1",
      "id:n2",
      "id:p1",
      "id:p2",
    ]);
    expect(hop2.nodeMap.get("id:n2")!.hopDistance).toBe(2);
    expect(hop2.nodeMap.get("id:p2")!.hopDistance).toBe(2);

    const hop3 = buildLocalOrgGraph(index, { centerNodeId: "id:center", depth: 3 });
    expect(hop3.nodeMap.get("id:n3")!.hopDistance).toBe(3);

    const incomingOnly = buildLocalOrgGraph(index, {
      centerNodeId: "id:center",
      depth: 1,
      showIncoming: true,
      showOutgoing: false,
    });
    expect(incomingOnly.nodes.map((n) => n.id).sort()).toEqual([
      "id:center",
      "id:mutual",
      "id:p1",
    ]);
    expect(incomingOnly.edges.every((e) => e.target === "id:center")).toBe(true);

    const outgoingOnly = buildLocalOrgGraph(index, {
      centerNodeId: "id:center",
      depth: 2,
      showIncoming: false,
      showOutgoing: true,
    });
    expect(outgoingOnly.nodes.map((n) => n.id).sort()).toEqual([
      "id:center",
      "id:mutual",
      "id:n1",
      "id:n2",
    ]);
    expect(outgoingOnly.edges.some((e) => e.target === "id:center")).toBe(false);

    const neitherDir = buildLocalOrgGraph(index, {
      centerNodeId: "id:center",
      depth: 2,
      showIncoming: false,
      showOutgoing: false,
    });
    expect(neitherDir.nodes.map((n) => n.id)).toEqual(["id:center"]);
    expect(neitherDir.edges).toHaveLength(0);

    // Search preserves center node even if center does not match search tag
    const filteredLocal = buildLocalOrgGraph(index, {
      centerNodeId: "id:center",
      depth: 2,
      filter: { search: "tag:keep" },
    });
    expect(filteredLocal.nodes.map((n) => n.id).sort()).toEqual(["id:center", "id:n2"]);

    // Missing / empty centers never throw
    const missing = buildLocalOrgGraph(index, {
      centerNodeId: "id:does-not-exist",
      centerFilePath: "missing.org",
    });
    expect(missing.nodes).toHaveLength(0);
    expect(missing.edges).toHaveLength(0);
    expect(missing.centerNodeId).toBeUndefined();

    const emptyCall = buildLocalOrgGraph(index, {});
    expect(emptyCall.nodes).toHaveLength(0);

    // Fallback to centerFilePath when centerNodeId is absent
    const fileFallback = buildLocalOrgGraph(index, {
      centerNodeId: null,
      centerFilePath: "chain.org",
      filter: { showStructural: true },
    });
    expect(fileFallback.centerNodeId).toBe("file:chain.org");
    expect(fileFallback.nodeMap.get("file:chain.org")!.isCenter).toBe(true);
    expect(fileFallback.nodes.length).toBeGreaterThan(1);
  });

  it("handles duplicate :ID: occurrences deterministically across files and same file with zero crash", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "b.org",
      [
        "* Dup In B",
        ":PROPERTIES:",
        ":ID: shared-id",
        ":END:",
        "From B to [[id:sink-1]].",
      ].join("\n")
    );
    index.upsertFile(
      "a.org",
      [
        "* Dup First In A",
        ":PROPERTIES:",
        ":ID: shared-id",
        ":END:",
        "First definition.",
        "* Dup Second In A",
        ":PROPERTIES:",
        ":ID: shared-id",
        ":END:",
        "From A2 to [[id:sink-1]].",
      ].join("\n")
    );
    index.upsertFile(
      "c.org",
      [
        "* Referrer",
        ":PROPERTIES:",
        ":ID: ref-1",
        ":END:",
        "Points to [[id:shared-id]].",
        "* Sink",
        ":PROPERTIES:",
        ":ID: sink-1",
        ":END:",
      ].join("\n")
    );

    const graph = buildOrgGraph(index);
    const primaryKey = canonicalOrgNodeKey("shared-id");
    const dupAKey = canonicalDuplicateNodeKey("shared-id", "a.org", 5);
    const dupBKey = canonicalDuplicateNodeKey("shared-id", "b.org", 0);

    const primary = graph.nodeMap.get(primaryKey)!;
    const dupA = graph.nodeMap.get(dupAKey)!;
    const dupB = graph.nodeMap.get(dupBKey)!;

    expect(primary).toBeDefined();
    expect(dupA).toBeDefined();
    expect(dupB).toBeDefined();
    expect(primary.status).toBe("duplicate");
    expect(dupA.status).toBe("duplicate");
    expect(dupB.status).toBe("duplicate");
    expect(primary.duplicateCount).toBe(3);
    expect(dupA.duplicatePeers).toHaveLength(2);

    // Outgoing edges from duplicate occurrences stay attached to their exact node keys
    expect(graph.edges.some((e) => e.source === dupAKey && e.target === "id:sink-1")).toBe(true);
    expect(graph.edges.some((e) => e.source === dupBKey && e.target === "id:sink-1")).toBe(true);
    expect(graph.edges.some((e) => e.source === "id:ref-1" && e.target === primaryKey)).toBe(true);
    expect(graph.stats.duplicateCount).toBe(3);

    // Local graph centered on a dup:... key works cleanly
    const localDup = buildLocalOrgGraph(index, { centerNodeId: dupBKey, depth: 1 });
    expect(localDup.centerNodeId).toBe(dupBKey);
    expect(localDup.nodes.map((n) => n.id).sort()).toEqual([dupBKey, "id:sink-1"].sort());
  });

  it("tracks unresolved targets in stats and reveals missing:<id> nodes only when showUnresolved is true", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "links.org",
      [
        "* Source",
        ":PROPERTIES:",
        ":ID: src-1",
        ":END:",
        "Broken [[id:missing-404]] and broken [[id:missing-404]].",
        "#+TRANSCLUDE: [[id:missing-embed]]",
      ].join("\n")
    );

    const hidden = buildOrgGraph(index, { filter: { showUnresolved: false } });
    expect(hidden.nodes).toHaveLength(1);
    expect(hidden.edges).toHaveLength(0);
    expect(hidden.stats.unresolvedCount).toBe(2);

    const shown = buildOrgGraph(index, { filter: { showUnresolved: true } });
    expect(shown.stats.unresolvedCount).toBe(2);
    const missing404 = shown.nodeMap.get(canonicalUnresolvedNodeKey("missing-404"))!;
    expect(missing404).toMatchObject({
      kind: "unresolved",
      status: "missing",
      orgId: "missing-404",
      title: "missing-404",
      inDegree: 1,
    });
    expect(
      shown.edges.find((e) => e.target === canonicalUnresolvedNodeKey("missing-404"))?.weight
    ).toBe(2);

    // File granularity also surfaces missing:<id> when showUnresolved is true
    const fileShown = buildOrgGraph(index, {
      granularity: "file",
      filter: { showUnresolved: true },
    });
    expect(fileShown.nodeMap.has(canonicalUnresolvedNodeKey("missing-404"))).toBe(true);
    expect(fileShown.edges).toHaveLength(2);
  });

  it("preserves canonical id:<orgId> across cross-file node moves and diffs as updatedNodes", () => {
    const index = new OrgIdIndex();
    const moving = [
      "** Moving Memory",
      ":PROPERTIES:",
      ":ID: moving-42",
      ":END:",
      "Links [[id:anchor-1]].",
    ].join("\n");

    index.upsertFile("inbox.org", `* Inbox\n${moving}\n`);
    index.upsertFile("archive.org", "* Archive\nEmpty.\n");
    index.upsertFile("anchor.org", "* Anchor\n:PROPERTIES:\n:ID: anchor-1\n:END:\n");

    const before = buildOrgGraph(index);
    expect(before.nodeMap.get("id:moving-42")!.filePath).toBe("inbox.org");

    index.upsertFile("inbox.org", "* Inbox\nCleared.\n");
    index.upsertFile("archive.org", `* Archive\n\n${moving}\n`);

    const after = buildOrgGraph(index);
    expect(after.nodeMap.get("id:moving-42")!.filePath).toBe("archive.org");

    const patch = diffOrgGraphs(before, after);
    expect(patch.addedNodes).toHaveLength(0);
    expect(patch.removedNodeIds.size).toBe(0);
    expect(patch.updatedNodes.map((n) => n.id)).toEqual(["id:moving-42"]);
    expect(patch.addedEdges).toHaveLength(0);
    expect(patch.removedEdgeIds.size).toBe(0);
  });

  it("parses structured queries (tag:, file:, path:, id:, quoted & AND terms) and filters graph cleanly", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "research/vla/memory.org",
      [
        "* Episodic Memory :ai:vla:",
        ":PROPERTIES:",
        ":ID: vla-ep-1",
        ":CUSTOM_ID: ep-custom",
        ":END:",
        "** Retrieval Policy :memory_graph:",
        ":PROPERTIES:",
        ":ID: vla-ret-2",
        ":END:",
        "Uses [[id:vla-ep-1]].",
      ].join("\n")
    );
    index.upsertFile(
      "notes/other.org",
      [
        "* Cooking Recipe :vla_legacy:",
        ":PROPERTIES:",
        ":ID: cook-1",
        ":END:",
        "Refers to [[id:vla-ep-1]].",
      ].join("\n")
    );

    const parsed = parseGraphQuery('tag:#VLA path:research/vla id:vla-ep "Episodic Memory"');
    expect(parsed.tags).toEqual(["vla"]);
    expect(parsed.paths).toEqual(["research/vla"]);
    expect(parsed.ids).toEqual(["vla-ep"]);
    expect(parsed.terms).toEqual(["episodic memory"]);

    const full = buildOrgGraph(index);
    const ep = full.nodeMap.get("id:vla-ep-1")!;
    const ret = full.nodeMap.get("id:vla-ret-2")!;
    const cook = full.nodeMap.get("id:cook-1")!;

    expect(matchesGraphQuery(ep, parsed)).toBe(true);
    expect(matchesGraphQuery(ret, parsed)).toBe(false);
    expect(matchesGraphQuery(cook, parsed)).toBe(false);

    // Tag filter does not false-match "vla_legacy" for tag:vla, and supports nested tags like "ai/robotics"
    expect(matchesGraphQuery(cook, "tag:vla")).toBe(false);
    expect(matchesGraphQuery(ep, "tag:#ai")).toBe(true);
    expect(matchesGraphQuery({ ...ep, tags: ["ai/robotics"] }, "tag:#ai")).toBe(true);
    expect(matchesGraphQuery(ret, "file:memory.org Retrieval")).toBe(true);
    expect(matchesGraphQuery(ep, "id:ep-custom")).toBe(true);
    expect(matchesGraphQuery(ret, "Episodic")).toBe(true); // matches via headingPath!

    const filtered = buildOrgGraph(index, {
      filter: { search: "path:research/vla" },
    });
    expect(filtered.nodes.map((n) => n.id).sort()).toEqual(["id:vla-ep-1", "id:vla-ret-2"]);
    expect(filtered.edges).toHaveLength(1);
    expect(filtered.nodeMap.get("id:vla-ep-1")!.inDegree).toBe(1);
  });

  it("assigns accessible deterministic colors across none/file/folder/tag/level/custom schemes", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "dirA/one.org",
      [
        "* One :alpha:",
        ":PROPERTIES:",
        ":ID: n1",
        ":END:",
        "** Two",
        ":PROPERTIES:",
        ":ID: n2",
        ":END:",
      ].join("\n")
    );
    index.upsertFile(
      "dirA/two.org",
      [
        "* Three :beta:",
        ":PROPERTIES:",
        ":ID: n3",
        ":END:",
      ].join("\n")
    );
    index.upsertFile(
      "dirB/four.org",
      [
        "* Four :alpha:",
        ":PROPERTIES:",
        ":ID: n4",
        ":END:",
      ].join("\n")
    );

    // Palette validity check
    expect(ORG_GRAPH_PALETTE.length).toBeGreaterThanOrEqual(8);
    expect(ORG_GRAPH_PALETTE.every((c) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true);

    const base = buildOrgGraph(index, { colorMode: "none" });
    expect(base.nodes.every((n) => n.groupColor === undefined)).toBe(true);

    const groups: OrgGraphColorGroup[] = [
      { id: "g-alpha", query: "tag:alpha", color: "#ff0055", label: "Alpha" },
      { id: "g-dirB", query: "path:dirB", color: "#00aa88", label: "DirB" },
    ];

    // Ordered custom groups: n4 matches g-alpha first (before g-dirB)
    assignNodeColors(base.nodes, "custom", groups);
    expect(base.nodeMap.get("id:n1")!.groupColor).toBe("#ff0055");
    expect(base.nodeMap.get("id:n1")!.groupId).toBe("g-alpha");
    expect(base.nodeMap.get("id:n4")!.groupColor).toBe("#ff0055");
    expect(base.nodeMap.get("id:n2")!.groupColor).toBeUndefined();

    // "none" still respects matching custom groups and clears others
    assignNodeColors(base.nodes, "none", [groups[1]]);
    expect(base.nodeMap.get("id:n1")!.groupColor).toBeUndefined();
    expect(base.nodeMap.get("id:n4")!.groupColor).toBe("#00aa88");

    // "file" groups nodes in same file identically
    assignNodeColors(base.nodes, "file", []);
    expect(base.nodeMap.get("id:n1")!.groupColor).toBeDefined();
    expect(base.nodeMap.get("id:n1")!.groupColor).toBe(base.nodeMap.get("id:n2")!.groupColor);

    // "folder" groups files in same folder identically
    assignNodeColors(base.nodes, "folder", []);
    expect(base.nodeMap.get("id:n1")!.groupColor).toBe(base.nodeMap.get("id:n3")!.groupColor);
    expect(base.nodeMap.get("id:n1")!.groupId).toBe("folder:dirA");

    // "tag" colors tagged nodes and leaves untagged nodes undefined
    assignNodeColors(base.nodes, "tag", []);
    expect(base.nodeMap.get("id:n1")!.groupColor).toBe(base.nodeMap.get("id:n4")!.groupColor);
    expect(base.nodeMap.get("id:n2")!.groupColor).toBeUndefined();

    // "level" separates H1 vs H2 deterministically and custom rule overrides first
    assignNodeColors(base.nodes, "level", [groups[0]]);
    expect(base.nodeMap.get("id:n1")!.groupColor).toBe("#ff0055");
    expect(base.nodeMap.get("id:n2")!.groupId).toBe("level:2");
    expect(base.nodeMap.get("id:n3")!.groupId).toBe("level:1");
    expect(base.nodeMap.get("id:n2")!.groupColor).not.toBe(
      base.nodeMap.get("id:n3")!.groupColor
    );
  });

  it("filters orphan nodes when showOrphans is false and produces accurate diffOrgGraphs patches", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "graph.org",
      [
        "* A",
        ":PROPERTIES:",
        ":ID: a",
        ":END:",
        "[[id:b]]",
        "* B",
        ":PROPERTIES:",
        ":ID: b",
        ":END:",
        "* Orphan",
        ":PROPERTIES:",
        ":ID: orphan",
        ":END:",
      ].join("\n")
    );

    const withOrphans = buildOrgGraph(index, { filter: { showOrphans: true } });
    expect(withOrphans.stats.orphanCount).toBe(1);
    expect(withOrphans.nodes).toHaveLength(3);

    const noOrphans = buildOrgGraph(index, { filter: { showOrphans: false } });
    expect(noOrphans.stats.orphanCount).toBe(0);
    expect(noOrphans.nodes.map((n) => n.id).sort()).toEqual(["id:a", "id:b"]);

    const initialPatch = diffOrgGraphs(null, withOrphans);
    expect(initialPatch.addedNodes).toHaveLength(3);
    expect(initialPatch.addedEdges).toHaveLength(1);

    const samePatch = diffOrgGraphs(withOrphans, buildOrgGraph(index));
    expect(samePatch.addedNodes).toHaveLength(0);
    expect(samePatch.removedNodeIds.size).toBe(0);
    expect(samePatch.updatedNodes).toHaveLength(0);
    expect(samePatch.addedEdges).toHaveLength(0);
    expect(samePatch.removedEdgeIds.size).toBe(0);
    expect(samePatch.updatedEdges).toHaveLength(0);

    // Add node C, update A to link C, remove Orphan
    index.upsertFile(
      "graph.org",
      [
        "* A Renamed",
        ":PROPERTIES:",
        ":ID: a",
        ":END:",
        "[[id:b]] and [[id:c]]",
        "* B",
        ":PROPERTIES:",
        ":ID: b",
        ":END:",
        "* C",
        ":PROPERTIES:",
        ":ID: c",
        ":END:",
      ].join("\n")
    );

    const next = buildOrgGraph(index);
    const editPatch = diffOrgGraphs(withOrphans, next);
    expect(editPatch.addedNodes.map((n) => n.id)).toEqual(["id:c"]);
    expect(Array.from(editPatch.removedNodeIds)).toEqual(["id:orphan"]);
    expect(editPatch.updatedNodes.map((n) => n.id)).toEqual(["id:a"]);
    expect(editPatch.addedEdges.map((e) => e.id)).toEqual(["reference:id:a->id:c"]);
  });

  it("extracts 5,000-node Local Graph within <10ms using OrgIdIndex without scanning unrelated files", () => {
    const index = new OrgIdIndex();
    const fileCount = 200;
    const nodesPerFile = 25; // 200 * 25 = 5,000 nodes

    for (let f = 0; f < fileCount; f++) {
      const lines: string[] = [`#+TITLE: Synthetic File ${f}`];
      for (let n = 0; n < nodesPerFile; n++) {
        const globalIdx = f * nodesPerFile + n;
        const nextIdx = (globalIdx + 1) % (fileCount * nodesPerFile);
        const crossIdx = (globalIdx + 137) % (fileCount * nodesPerFile);
        lines.push(`* Node ${globalIdx} :batch${f % 5}:`);
        lines.push(":PROPERTIES:");
        lines.push(`:ID: syn-${globalIdx}`);
        lines.push(":END:");
        lines.push(`Links [[id:syn-${nextIdx}]] and [[id:syn-${crossIdx}]].`);
        if (n % 5 === 0) {
          lines.push(`#+TRANSCLUDE: [[id:syn-${(globalIdx + 7) % (fileCount * nodesPerFile)}]]`);
        }
      }
      index.upsertFile(`synthetic/file-${f}.org`, lines.join("\n"));
    }

    // Warmup JIT once, then measure 1/2/3-hop Local Graph builds
    buildLocalOrgGraph(index, { centerNodeId: "id:syn-500", depth: 1 });

    const t1Start = performance.now();
    const local1 = buildLocalOrgGraph(index, { centerNodeId: "id:syn-500", depth: 1 });
    const t1Ms = performance.now() - t1Start;

    const t2Start = performance.now();
    const local2 = buildLocalOrgGraph(index, { centerNodeId: "id:syn-500", depth: 2 });
    const t2Ms = performance.now() - t2Start;

    const t3Start = performance.now();
    const local3 = buildLocalOrgGraph(index, { centerNodeId: "id:syn-500", depth: 3 });
    const t3Ms = performance.now() - t3Start;

    expect(local1.centerNodeId).toBe("id:syn-500");
    expect(local1.nodes.length).toBeGreaterThanOrEqual(5);
    expect(local2.nodes.length).toBeGreaterThan(local1.nodes.length);
    expect(local3.nodes.length).toBeGreaterThan(local2.nodes.length);
    expect(t1Ms).toBeLessThan(10);
    expect(t2Ms).toBeLessThan(10);
    expect(t3Ms).toBeLessThan(10);

    // Also verify Global Graph on 5,000 nodes accurately builds all 5,000 nodes
    const globalGraph = buildOrgGraph(index);
    expect(globalGraph.stats.nodeCount).toBe(5000);
    expect(globalGraph.stats.fileCount).toBe(200);
    expect(globalGraph.stats.transclusionEdges).toBe(1000);
  });

  it("builds consistent Global & Local Graphs from the isolated test-vault corpus", () => {
    const vaultDir = path.resolve(process.cwd(), "test-vault");
    const orgFiles = fs
      .readdirSync(vaultDir)
      .filter((f) => f.endsWith(".org"))
      .sort();

    const index = new OrgIdIndex();
    for (const file of orgFiles) {
      index.upsertFile(file, fs.readFileSync(path.join(vaultDir, file), "utf8"));
    }

    const globalGraph = buildOrgGraph(index);
    expect(globalGraph.stats.duplicateCount).toBe(2);
    expect(globalGraph.stats.unresolvedCount).toBe(2);
    expect(globalGraph.nodeMap.get("id:demo-duplicate-id")?.status).toBe("duplicate");
    expect(globalGraph.stats.transclusionEdges).toBeGreaterThan(0);

    const localWelcome = buildLocalOrgGraph(index, {
      centerNodeId: "id:org-native-welcome-root",
      depth: 1,
    });
    expect(localWelcome.centerNodeId).toBe("id:org-native-welcome-root");
    expect(localWelcome.nodeMap.get("id:org-native-welcome-root")?.isCenter).toBe(true);
    expect(localWelcome.nodes.length).toBeGreaterThan(1);
  });

  it("supports Local Graph in file granularity, structural hierarchy, and showUnresolved", () => {
    const index = new OrgIdIndex();
    index.upsertFile(
      "a.org",
      [
        "#+TITLE: File A",
        "* A Root",
        ":PROPERTIES:",
        ":ID: a-root",
        ":END:",
        "** A Child",
        ":PROPERTIES:",
        ":ID: a-child",
        ":END:",
        "Links [[id:b-root]] and [[id:missing-local]].",
      ].join("\n")
    );
    index.upsertFile(
      "b.org",
      [
        "#+TITLE: File B",
        "* B Root",
        ":PROPERTIES:",
        ":ID: b-root",
        ":END:",
        "Links [[id:c-root]].",
      ].join("\n")
    );
    index.upsertFile(
      "c.org",
      [
        "#+TITLE: File C",
        "* C Root",
        ":PROPERTIES:",
        ":ID: c-root",
        ":END:",
      ].join("\n")
    );

    const localStructural = buildLocalOrgGraph(index, {
      centerNodeId: "id:a-child",
      depth: 1,
      filter: { showStructural: true, showUnresolved: true },
    });
    expect(localStructural.nodes.map((n) => n.id).sort()).toEqual([
      "id:a-child",
      "id:a-root",
      "id:b-root",
      "missing:missing-local",
    ]);
    expect(localStructural.stats.structuralEdges).toBe(1);
    expect(localStructural.stats.unresolvedCount).toBe(1);

    const localFile1 = buildLocalOrgGraph(index, {
      centerNodeId: "id:a-child",
      granularity: "file",
      depth: 1,
      filter: { showUnresolved: false },
    });
    expect(localFile1.centerNodeId).toBe("file:a.org");
    expect(localFile1.nodes.map((n) => n.id).sort()).toEqual(["file:a.org", "file:b.org"]);
    expect(localFile1.stats.unresolvedCount).toBe(1);

    const localFile2 = buildLocalOrgGraph(index, {
      centerFilePath: "a.org",
      granularity: "file",
      depth: 2,
      filter: { showUnresolved: true },
    });
    expect(localFile2.nodes.map((n) => n.id).sort()).toEqual([
      "file:a.org",
      "file:b.org",
      "file:c.org",
      "missing:missing-local",
    ]);
    expect(localFile2.nodeMap.get("file:c.org")?.hopDistance).toBe(2);
  });
});
