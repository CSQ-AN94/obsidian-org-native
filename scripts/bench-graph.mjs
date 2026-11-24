#!/usr/bin/env node
/**
 * Sprint 04 Synthetic Knowledge Graph Performance Benchmark.
 *
 * Strictly synthetic in-memory Org corpora (zero real user notes) across
 * 100 / 1,000 / 5,000 Org nodes covering:
 * - buildOrgGraph (Node mode & File mode)
 * - buildLocalOrgGraph (Depth 1, Depth 2, Depth 3)
 * - diffOrgGraphs (incremental patch)
 * - OrgGraphSimulation initial warm-up (warmUp ticks) & incremental setGraph + tick
 * - d3-quadtree build & 100 spatial hit-test lookups
 * - Heap & RSS memory deltas (heapDeltaMB, rssDeltaMB)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const { Window } = require("happy-dom");

function setupDomEnvironment() {
  if (typeof document !== "undefined" && typeof window !== "undefined") {
    return null;
  }
  const win = new Window({ url: "https://localhost/" });
  const bindings = {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    HTMLAnchorElement: win.HTMLAnchorElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLCanvasElement: win.HTMLCanvasElement,
    Element: win.Element,
    Node: win.Node,
    DocumentFragment: win.DocumentFragment,
    Text: win.Text,
    Comment: win.Comment,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    PointerEvent: win.PointerEvent ?? win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
    WheelEvent: win.WheelEvent ?? win.Event,
    MutationObserver: win.MutationObserver,
  };
  for (const [key, value] of Object.entries(bindings)) {
    if (typeof globalThis[key] === "undefined" && value !== undefined) {
      globalThis[key] = value;
    }
  }
  return win;
}

async function loadBundledGraphModules(tmpDir) {
  const obsidianMockPath = path.join(ROOT_DIR, "tests", "mocks", "obsidian.ts");
  const outfile = path.join(tmpDir, "org-graph-bench-bundle.mjs");

  const entrySource = `
    export { OrgIdIndex } from "./src/core/index/orgIdIndex.ts";
    export { buildOrgGraph, diffOrgGraphs } from "./src/core/graph/graphAdapter.ts";
    export { buildLocalOrgGraph } from "./src/core/graph/localGraph.ts";
    export { canonicalOrgNodeKey } from "./src/core/graph/types.ts";
    export { OrgGraphSimulation } from "./src/views/graph/simulation.ts";
    export { OrgGraphCanvasRenderer } from "./src/views/graph/canvasRenderer.ts";
    export { quadtree as d3Quadtree } from "d3-quadtree";
  `;

  await esbuild.build({
    stdin: {
      contents: entrySource,
      resolveDir: ROOT_DIR,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    outfile,
    logLevel: "silent",
    plugins: [
      {
        name: "alias-obsidian-mock",
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({
            path: obsidianMockPath,
          }));
        },
      },
    ],
  });

  return import(pathToFileURL(outfile).href);
}

function padNum(n, width) {
  return String(n).padStart(width, "0");
}

function buildFileContent(f, fileCount, nodesPerFile, totalNodes, mutatedHub) {
  const tag = `g${totalNodes}`;
  const nodeId = (g) => `syn-${tag}-${g}`;
  const lines = [
    `#+TITLE: Synthetic Graph File ${f + 1}/${fileCount}${mutatedHub ? " (Patched)" : ""}`,
    `#+FILETAGS: :synthetic:scale${totalNodes}:cluster${f % 8}:`,
    "",
  ];

  for (let k = 0; k < nodesPerFile; k++) {
    const g = f * nodesPerFile + k;
    const level = (k % 3) + 1;
    const stars = "*".repeat(level);
    const title = mutatedHub && k === 0 ? `Updated Hub Node ${g}` : `Synthetic Graph Node ${g}`;

    const nextInChain = (g + 1) % totalNodes;
    const crossFile = (g + nodesPerFile + 3) % totalNodes;
    const stride = (g + Math.max(7, Math.floor(totalNodes / 5))) % totalNodes;

    lines.push(`${stars} ${title} :lvl${level}:c${f % 10}:`);
    lines.push(":PROPERTIES:");
    lines.push(`:ID: ${nodeId(g)}`);
    lines.push(`:CUSTOM_ID: custom-${tag}-${g}`);
    lines.push(":END:");
    lines.push(
      `Links: [[id:${nodeId(nextInChain)}][Next ${nextInChain}]], ` +
        `[[id:${nodeId(crossFile)}][Cross ${crossFile}]].`
    );

    if (mutatedHub && k % 2 === 0) {
      const patchTarget = (g + nodesPerFile * 2 + 5) % totalNodes;
      lines.push(`Patched ref: [[id:${nodeId(patchTarget)}][Patch ${patchTarget}]].`);
    }

    if (k % 5 === 0 || (mutatedHub && k === 1)) {
      lines.push(`#+TRANSCLUDE: [[id:${nodeId(stride)}]] :only-contents`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate a deterministic multi-file synthetic Org corpus at exact `totalNodes`
 * with multi-level headings, reference links, and #+TRANSCLUDE: embeds.
 */
function buildSyntheticGraphCorpus(totalNodes, fileCount) {
  if (totalNodes % fileCount !== 0) {
    throw new Error(`totalNodes (${totalNodes}) must be divisible by fileCount (${fileCount})`);
  }
  const nodesPerFile = totalNodes / fileCount;
  const tag = `g${totalNodes}`;
  const files = new Map();
  const fileName = (f) => `graph/corpus-${padNum(f, 3)}.org`;

  for (let f = 0; f < fileCount; f++) {
    files.set(fileName(f), buildFileContent(f, fileCount, nodesPerFile, totalNodes, false));
  }

  return {
    files,
    fileCount,
    nodeCount: totalNodes,
    nodesPerFile,
    centerId: `syn-${tag}-0`,
    hubFilePath: fileName(0),
    hubFileVariantB: buildFileContent(0, fileCount, nodesPerFile, totalNodes, true),
  };
}

function summarizeTimings(coldMs, warmTimesMs, memBefore, memAfter) {
  const sorted = [...warmTimesMs].sort((a, b) => a - b);
  const sum = warmTimesMs.reduce((acc, v) => acc + v, 0);
  const warmAvgMs = warmTimesMs.length > 0 ? sum / warmTimesMs.length : coldMs;
  const warmMinMs = sorted[0] ?? coldMs;
  const warmMaxMs = sorted[sorted.length - 1] ?? coldMs;
  const p95Idx = sorted.length > 0 ? Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95)) : 0;
  const warmP95Ms = sorted[p95Idx] ?? coldMs;

  return {
    coldMs: Number(coldMs.toFixed(3)),
    warmRuns: warmTimesMs.length,
    warmAvgMs: Number(warmAvgMs.toFixed(3)),
    warmMinMs: Number(warmMinMs.toFixed(3)),
    warmMaxMs: Number(warmMaxMs.toFixed(3)),
    warmP95Ms: Number(warmP95Ms.toFixed(3)),
    heapDeltaBytes: memAfter.heapUsed - memBefore.heapUsed,
    heapDeltaMB: Number(((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2)),
    rssDeltaBytes: memAfter.rss - memBefore.rss,
    rssDeltaMB: Number(((memAfter.rss - memBefore.rss) / (1024 * 1024)).toFixed(2)),
  };
}

function measureSync(name, fn, warmRuns, prepareRun) {
  if (typeof globalThis.gc === "function") globalThis.gc();
  const memBefore = process.memoryUsage();
  const coldCtx = prepareRun ? prepareRun(0) : undefined;
  const t0 = performance.now();
  const coldResult = fn(coldCtx);
  const coldMs = performance.now() - t0;
  const memAfter = process.memoryUsage();

  const warmTimes = [];
  for (let i = 0; i < warmRuns; i++) {
    const ctx = prepareRun ? prepareRun(i + 1) : undefined;
    const start = performance.now();
    fn(ctx);
    warmTimes.push(performance.now() - start);
  }

  return {
    name,
    result: coldResult,
    metrics: summarizeTimings(coldMs, warmTimes, memBefore, memAfter),
  };
}

function formatMarkdownTable(rows) {
  const header = [
    "| Benchmark | Cold (ms) | Warm Avg (ms) | Min (ms) | Max (ms) | Heap Delta (MB) | RSS Delta (MB) | Details |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const row of rows) {
    const m = row.metrics;
    header.push(
      `| ${row.name} | ${m.coldMs.toFixed(2)} | ${m.warmAvgMs.toFixed(2)} | ${m.warmMinMs.toFixed(2)} | ${m.warmMaxMs.toFixed(2)} | ${m.heapDeltaMB.toFixed(2)} | ${m.rssDeltaMB.toFixed(2)} | ${row.detail} |`
    );
  }
  return header.join("\n");
}

async function main() {
  const jsonOnly = process.argv.includes("--json");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-graph-bench-"));
  let win = null;

  try {
    // Load bundle before creating happy-dom window so d3-timer binds Node setTimeout
    // rather than a happy-dom requestAnimationFrame that win.close() would cancel mid-flight.
    const mod = await loadBundledGraphModules(tmpDir);
    win = setupDomEnvironment();
    const {
      OrgIdIndex,
      buildOrgGraph,
      diffOrgGraphs,
      buildLocalOrgGraph,
      canonicalOrgNodeKey,
      OrgGraphSimulation,
      OrgGraphCanvasRenderer,
      d3Quadtree,
    } = mod;

    const scaleConfigs = [
      { nodes: 100, files: 10, warmRuns: 10, simWarmRuns: 5, warmUpTicks: 70 },
      { nodes: 1000, files: 50, warmRuns: 5, simWarmRuns: 3, warmUpTicks: 45 },
      { nodes: 5000, files: 200, warmRuns: 3, simWarmRuns: 2, warmUpTicks: 24 },
    ];

    const benchResults = [];
    const corporaSummary = {};

    for (const cfg of scaleConfigs) {
      const corpus = buildSyntheticGraphCorpus(cfg.nodes, cfg.files);
      const index = new OrgIdIndex();
      for (const [filePath, src] of corpus.files.entries()) {
        index.upsertFile(filePath, src);
      }
      index.markInitialized();
      const centerKey = canonicalOrgNodeKey(corpus.centerId);

      // 1. buildOrgGraph (Node mode)
      const globalNodeRun = measureSync(
        `buildOrgGraph Node (${cfg.nodes} nodes)`,
        () => buildOrgGraph(index, { granularity: "node" }),
        cfg.warmRuns
      );
      const nodeGraphA = globalNodeRun.result;
      if (nodeGraphA.nodes.length !== cfg.nodes) {
        throw new Error(`Expected ${cfg.nodes} nodes in Node graph, got ${nodeGraphA.nodes.length}`);
      }
      benchResults.push({
        id: `graph_build_node_${cfg.nodes}`,
        name: `buildOrgGraph Node (${cfg.nodes} nodes / ${cfg.files} files)`,
        metrics: globalNodeRun.metrics,
        detail: `${nodeGraphA.stats.nodeCount} nodes, ${nodeGraphA.stats.edgeCount} edges (${nodeGraphA.stats.transclusionEdges} transclude)`,
      });

      // 2. buildOrgGraph (File mode)
      const globalFileRun = measureSync(
        `buildOrgGraph File (${cfg.nodes} nodes / ${cfg.files} files)`,
        () => buildOrgGraph(index, { granularity: "file" }),
        cfg.warmRuns
      );
      if (globalFileRun.result.nodes.length !== cfg.files) {
        throw new Error(`Expected ${cfg.files} file nodes, got ${globalFileRun.result.nodes.length}`);
      }
      benchResults.push({
        id: `graph_build_file_${cfg.nodes}`,
        name: `buildOrgGraph File (${cfg.files} files from ${cfg.nodes} nodes)`,
        metrics: globalFileRun.metrics,
        detail: `${globalFileRun.result.stats.nodeCount} files, ${globalFileRun.result.stats.edgeCount} edges`,
      });

      // 3. buildLocalOrgGraph (Depth 1, Depth 2, Depth 3)
      let prevLocalNodes = 0;
      for (const depth of [1, 2, 3]) {
        const localRun = measureSync(
          `buildLocalOrgGraph Depth ${depth} (${cfg.nodes}-node index)`,
          () =>
            buildLocalOrgGraph(index, {
              centerNodeId: centerKey,
              depth,
              granularity: "node",
            }),
          cfg.warmRuns
        );
        const lNodes = localRun.result.nodes.length;
        if (lNodes <= 1 || lNodes < prevLocalNodes) {
          throw new Error(
            `Unexpected Local Graph depth=${depth} size ${lNodes} (prev=${prevLocalNodes})`
          );
        }
        prevLocalNodes = lNodes;
        benchResults.push({
          id: `graph_local_d${depth}_${cfg.nodes}`,
          name: `buildLocalOrgGraph Depth ${depth} (${cfg.nodes}-node index)`,
          metrics: localRun.metrics,
          detail: `${lNodes} nodes, ${localRun.result.stats.edgeCount} edges`,
        });
      }

      // 4. diffOrgGraphs (incremental patch between graphA and mutated graphB)
      const hubOrig = corpus.files.get(corpus.hubFilePath);
      index.upsertFile(corpus.hubFilePath, corpus.hubFileVariantB);
      const nodeGraphB = buildOrgGraph(index, { granularity: "node" });
      index.upsertFile(corpus.hubFilePath, hubOrig);

      const diffRun = measureSync(
        `diffOrgGraphs (${cfg.nodes} nodes)`,
        (iter) => (iter % 2 === 0 ? diffOrgGraphs(nodeGraphA, nodeGraphB) : diffOrgGraphs(nodeGraphB, nodeGraphA)),
        cfg.warmRuns,
        (iter) => iter
      );
      const patch = diffRun.result;
      if (patch.addedEdges.length === 0 && patch.updatedNodes.length === 0) {
        throw new Error(`Expected non-empty diffOrgGraphs patch at scale ${cfg.nodes}`);
      }
      benchResults.push({
        id: `graph_diff_${cfg.nodes}`,
        name: `diffOrgGraphs (${cfg.nodes} nodes)`,
        metrics: diffRun.metrics,
        detail: `+${patch.addedEdges.length} edges, ${patch.updatedNodes.length} updated nodes`,
      });

      // 5. OrgGraphSimulation initial warmUp(ticks)
      const extraWarmSims = [];
      const simWarmRun = measureSync(
        `OrgGraphSimulation warmUp (${cfg.nodes} nodes, ${cfg.warmUpTicks} ticks)`,
        (sim) => {
          sim.setGraph(nodeGraphA, undefined, { preserveLayout: false, warmUpTicks: 0 });
          const executed = sim.warmUp(cfg.warmUpTicks, Infinity);
          return { executed, sim };
        },
        cfg.simWarmRuns,
        (iter) => {
          const sim = new OrgGraphSimulation();
          if (iter > 0) extraWarmSims.push(sim);
          return sim;
        }
      );
      for (const s of extraWarmSims) s.dispose();
      const settledSim = simWarmRun.result.sim;
      for (const n of settledSim.getNodes()) {
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
          throw new Error(`Non-finite simulation coordinates at scale ${cfg.nodes}`);
        }
      }
      benchResults.push({
        id: `sim_warmup_${cfg.nodes}`,
        name: `OrgGraphSimulation warmUp (${cfg.nodes} nodes, ${cfg.warmUpTicks} ticks)`,
        metrics: simWarmRun.metrics,
        detail: `${simWarmRun.result.executed} ticks, alpha=${settledSim.getAlpha().toFixed(3)}`,
      });

      // 6. OrgGraphSimulation incremental setGraph (coordinate preservation) + tick
      const anchorBefore = settledSim.getPosition(centerKey);
      const simIncRun = measureSync(
        `OrgGraphSimulation incremental setGraph + tick (${cfg.nodes} nodes)`,
        (iter) => {
          const targetGraph = iter % 2 === 0 ? nodeGraphB : nodeGraphA;
          settledSim.setGraph(targetGraph, undefined, {
            preserveLayout: true,
            warmUpTicks: 0,
          });
          const alphaAfterSet = settledSim.getAlpha();
          settledSim.step(1);
          return { alphaAfterSet, anchorAfter: settledSim.getPosition(centerKey) };
        },
        cfg.warmRuns,
        (iter) => iter
      );
      if (
        !anchorBefore ||
        !simIncRun.result.anchorAfter ||
        simIncRun.result.alphaAfterSet > 0.141
      ) {
        throw new Error(`Incremental simulation coordinate preservation failed at scale ${cfg.nodes}`);
      }
      const drift = Math.hypot(
        simIncRun.result.anchorAfter.x - anchorBefore.x,
        simIncRun.result.anchorAfter.y - anchorBefore.y
      );
      benchResults.push({
        id: `sim_incremental_${cfg.nodes}`,
        name: `OrgGraphSimulation incremental setGraph + tick (${cfg.nodes} nodes)`,
        metrics: simIncRun.metrics,
        detail: `alpha=${simIncRun.result.alphaAfterSet.toFixed(2)}, centerDrift=${drift.toFixed(2)}px`,
      });

      // 7. d3-quadtree build & 100 spatial hit-test lookups via OrgGraphCanvasRenderer
      const container = document.createElement("div");
      Object.defineProperty(container, "clientWidth", { value: 1280, configurable: true });
      Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
      document.body.appendChild(container);
      const renderer = new OrgGraphCanvasRenderer(container);
      renderer.setData(nodeGraphA, settledSim.getNodes(), settledSim.getLinks());
      renderer.fitToView();

      const simNodes = settledSim.getNodes();
      const lookupPoints = [];
      for (let i = 0; i < 100; i++) {
        const node = simNodes[Math.floor((i * simNodes.length) / 100)];
        lookupPoints.push(renderer.worldToScreen(node.x, node.y));
      }

      const quadtreeRun = measureSync(
        `d3-quadtree build + 100 hitTests (${cfg.nodes} nodes)`,
        () => {
          renderer.markPositionsDirty();
          const tree = renderer.getQuadtree();
          let hits = 0;
          for (let i = 0; i < lookupPoints.length; i++) {
            const pt = lookupPoints[i];
            if (renderer.hitTest(pt.x, pt.y)) hits++;
          }
          return { treeSize: tree.size(), hits };
        },
        cfg.warmRuns
      );
      if (quadtreeRun.result.treeSize !== cfg.nodes || quadtreeRun.result.hits === 0) {
        throw new Error(
          `Quadtree benchmark mismatch at scale ${cfg.nodes}: size=${quadtreeRun.result.treeSize}, hits=${quadtreeRun.result.hits}`
        );
      }
      benchResults.push({
        id: `quadtree_hittest_${cfg.nodes}`,
        name: `d3-quadtree build + 100 hitTests (${cfg.nodes} nodes)`,
        metrics: quadtreeRun.metrics,
        detail: `size=${quadtreeRun.result.treeSize}, hits=${quadtreeRun.result.hits}/100`,
      });

      renderer.dispose();
      container.remove();
      settledSim.dispose();

      corporaSummary[`scale${cfg.nodes}`] = {
        files: cfg.files,
        nodes: cfg.nodes,
        edgesNodeMode: nodeGraphA.stats.edgeCount,
        transclusionEdges: nodeGraphA.stats.transclusionEdges,
        edgesFileMode: globalFileRun.result.stats.edgeCount,
      };
    }

    const report = {
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        gcExposed: typeof globalThis.gc === "function",
      },
      corpora: corporaSummary,
      benchmarks: benchResults,
    };

    if (jsonOnly) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `# Org Native Sprint 04 Knowledge Graph Benchmark Report\n\n` +
          `- Node: \`${report.environment.node}\` (${report.environment.platform}/${report.environment.arch}, ${report.environment.cpus}x ${report.environment.cpuModel})\n` +
          `- GC Exposed: \`${report.environment.gcExposed}\`\n\n` +
          `## Summary Table\n\n` +
          `${formatMarkdownTable(benchResults)}\n\n` +
          `## Structured JSON\n\n` +
          `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (win && typeof win.close === "function") {
      await win.close();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
