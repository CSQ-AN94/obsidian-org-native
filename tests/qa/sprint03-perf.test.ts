import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { createMockApp } from "../mocks/obsidian";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { parseOrgDoc } from "../../src/core/parser/parse";
import { buildSectionTree } from "../../src/core/parser/sectionTree";
import { OrgIdIndex } from "../../src/core/index/orgIdIndex";
import {
  createMemoryTransclusionProvider,
  OrgTransclusionEngine,
} from "../../src/core/transclusion";
import { renderOrgPreview } from "../../src/views/reading/render";
import { hydrateTransclusionsInDom } from "../../src/views/transclusion/renderTransclusion";

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function padNum(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

interface SyntheticScaleCorpus {
  files: Map<string, string>;
  fileCount: number;
  nodeCount: number;
  nodesPerFile: number;
  expectedAlphaMatches: number;
  hubFilePath: string;
}

function buildSyntheticScaleCorpus(
  totalNodes: number,
  fileCount: number
): SyntheticScaleCorpus {
  const nodesPerFile = totalNodes / fileCount;
  const tag = `s${totalNodes}`;
  const files = new Map<string, string>();
  const nodeId = (g: number) => `syn-${tag}-${g}`;
  const fileName = (f: number) => `notes/corpus-${padNum(f, 3)}.org`;

  for (let f = 0; f < fileCount; f++) {
    const lines = [
      `#+TITLE: Synthetic Corpus File ${f + 1}/${fileCount}`,
      `#+FILETAGS: :synthetic:scale${totalNodes}:cluster${f % 8}:`,
      "",
    ];

    for (let k = 0; k < nodesPerFile; k++) {
      const g = f * nodesPerFile + k;
      const level = (k % 6) + 1;
      const stars = "*".repeat(level);
      const kw = k % 4 === 0 ? "TODO " : k % 4 === 2 ? "DONE " : "";
      const prio = k % 6 === 0 ? "[#A] " : "";
      const isAlphaLeaf = k === 5 || (nodesPerFile >= 20 && k === 17);
      const title =
        g === 5
          ? "Alpha"
          : isAlphaLeaf
          ? `Alpha Research Node ${g}`
          : `Synthetic Knowledge Node ${g}`;

      const hubTarget = f === 0 ? nodesPerFile + k : k;
      const neighborFile = (f + 1 + (k % 3)) % fileCount;
      const neighborTarget = neighborFile * nodesPerFile + ((k + 1) % nodesPerFile);
      const strideFile = (f + Math.max(1, Math.floor(fileCount / 3))) % fileCount;
      const strideTarget = strideFile * nodesPerFile + ((k + 2) % nodesPerFile);

      lines.push(`${stars} ${kw}${prio}${title} :lvl${level}:c${f % 10}:`);
      lines.push(":PROPERTIES:");
      lines.push(`:ID: ${nodeId(g)}`);
      lines.push(`:CUSTOM_ID: custom-${tag}-${g}`);
      lines.push(`:CLUSTER: cluster-${f % 8}`);
      lines.push(":END:");
      lines.push(
        `Cross-file refs: [[id:${nodeId(hubTarget)}][Hub ${hubTarget}]], ` +
          `[[id:${nodeId(neighborTarget)}][Peer ${neighborTarget}]], ` +
          `[[id:${nodeId(strideTarget)}][Bridge ${strideTarget}]]. ` +
          `Inline math $f_${k}(x) = \\alpha x + ${g}$ and ~sym_${g}~.`
      );

      if (k % 5 === 0) {
        lines.push("| Metric | Value | Note |");
        lines.push("|--------+-------+------|");
        lines.push("| <l>    | <r>   | <l>  |");
        lines.push(`| Node-${g} | ${100 + k} | ok |`);
      } else if (k % 5 === 2) {
        lines.push("$$");
        lines.push(`L_{${g}}(\\theta) = \\sum_{i=1}^{${level + 2}} (y_i - \\hat{y}_i)^2`);
        lines.push("$$");
      } else if (k % 5 === 4) {
        lines.push("#+BEGIN_SRC typescript");
        lines.push(`export function nodeMetric_${g}(x: number): number {`);
        lines.push(`  return x * ${level} + ${k};`);
        lines.push("}");
        lines.push("#+END_SRC");
      } else {
        lines.push(`- [${k % 2 === 0 ? "X" : " "}] Checklist item for *node ${g}*`);
      }
      lines.push("");
    }

    files.set(fileName(f), lines.join("\n"));
  }

  const alphaPerFile = nodesPerFile >= 20 ? 2 : 1;
  return {
    files,
    fileCount,
    nodeCount: totalNodes,
    nodesPerFile,
    expectedAlphaMatches: fileCount * alphaPerFile,
    hubFilePath: fileName(0),
  };
}

function buildSyntheticAcademicPaper() {
  const lines = [
    "#+TITLE: Deterministic Read-Only Transclusion and Incremental Indexing for Local Org Graphs",
    "#+AUTHOR: Synthetic Benchmark Suite",
    "#+DATE: 2026-11-25",
    "#+STARTUP: showall",
    "#+FILETAGS: :paper:systems:orgmode:",
    "",
    "#+BEGIN_QUOTE",
    "Synthetic ~3,000-line academic paper evaluating parser throughput and DOM rendering.",
    "#+END_QUOTE",
    "",
  ];

  let sectionCount = 0;
  let fnCounter = 0;
  const chapters = [
    "Introduction and Motivation",
    "Background and Related Work",
    "Formal Data Model",
    "Incremental Indexing Architecture",
    "Bounded Graph Transclusion",
    "Typography and Layout Engine",
    "Experimental Methodology",
    "Empirical Performance Evaluation",
    "Threats to Validity and Discussion",
    "Conclusion and Future Work",
  ];

  for (let c = 0; c < chapters.length; c++) {
    sectionCount++;
    lines.push(`* ${chapters[c]} :ch${c + 1}:`);
    lines.push(":PROPERTIES:");
    lines.push(`:ID: paper-ch-${c + 1}`);
    lines.push(`:CUSTOM_ID: ch-${c + 1}`);
    lines.push(":END:");
    lines.push(
      `Section ${c + 1} establishes invariant $\\mathcal{I}_{${c + 1}}$ with [[id:paper-ch-1][Chapter 1]] [fn:${++fnCounter}].`
    );
    lines.push("");

    for (let s = 1; s <= 4; s++) {
      sectionCount++;
      lines.push(`** Section ${c + 1}.${s} Formalization :sub${s}:`);
      lines.push(":PROPERTIES:");
      lines.push(`:ID: paper-sec-${c + 1}-${s}`);
      lines.push(":END:");
      lines.push(
        `Let $G = (V, E)$ denote the graph. Updates preserve *byte-level immutability* and ~O(deg(v))~ indexing [fn:${++fnCounter}].`
      );
      lines.push("");

      for (let sub = 1; sub <= 2; sub++) {
        sectionCount++;
        lines.push(`*** Subsection ${c + 1}.${s}.${sub} Lemma & Proof`);
        lines.push("1. Parse raw lines into structural tokens with exact offsets.");
        lines.push("2. Construct hierarchical section trees preserving drawers.");
        lines.push("3. Render sanitized DOM nodes without executing scripts.");
        lines.push("");

        if (sub === 1) {
          lines.push("\\begin{align}");
          lines.push(`T(N) &= \\sum_{i=1}^{N} c_i \\cdot \\log(1 + d_i) + ${c + s} \\\\`);
          lines.push(`M(N) &= \\alpha N + \\beta |E| + \\gamma_{${c + 1},${s}}`);
          lines.push("\\end{align}");
          lines.push("");
        } else {
          lines.push("| Pipeline Stage | Complexity | Mean (ms) | Status |");
          lines.push("|----------------+------------+-----------+--------|");
          lines.push("| <l>            | <c>        | <r>       | <c>    |");
          lines.push(`| Parse-${c + 1}.${s} | O(L) | ${(1.2 + s * 0.3).toFixed(1)} | pass |`);
          lines.push(`| Render-${c + 1}.${s} | O(L) | ${(3.1 + sub * 0.5).toFixed(1)} | pass |`);
          lines.push("");
        }

        if ((c + s + sub) % 3 === 0) {
          lines.push("#+BEGIN_SRC python");
          lines.push(`def verify_step_${c + 1}_${s}_${sub}(nodes):`);
          lines.push("    return len({n.id for n in nodes}) == len(nodes)");
          lines.push("#+END_SRC");
          lines.push("");
        }

        sectionCount++;
        lines.push(
          `**** Remark ${c + 1}.${s}.${sub}: Observation under $\\sum_{k=1}^m x_k$ and ~parseOrgDoc~.`
        );
        lines.push(
          `Empirical prose paragraph ${c + 1}.${s}.${sub} documenting deterministic section boundaries.`
        );
        lines.push("");
      }
    }
  }

  sectionCount++;
  lines.push("* Appendix: Footnotes and Formal Proofs :appendix:");
  lines.push(":PROPERTIES:");
  lines.push(":ID: paper-appendix");
  lines.push(":END:");
  for (let i = 1; i <= fnCounter; i++) {
    lines.push(`[fn:${i}] Synthetic proof note ${i}: invariant verified across depths.`, "");
  }
  while (lines.length < 2999) {
    lines.push(`Supplementary remark line ${lines.length + 1}: verifying zero truncation.`);
  }
  lines.push("Final paper conclusion marker: END_OF_ACADEMIC_PAPER.");

  return {
    path: "bench/long-academic-paper.org",
    content: lines.join("\n"),
    lineCount: lines.length,
    expectedSectionCount: sectionCount,
    footnoteCount: fnCounter,
  };
}

function buildSyntheticChineseDocument() {
  const lines = [
    "#+TITLE: 面向大规模知识库的本地 Org 架构与双语排版规范",
    "#+TODO: 待办(t) 进行中(p@) | 完成(d!) 取消(c)",
    "#+FILETAGS: :中文文档:系统架构:OrgNative:",
    "#+STARTUP: showall",
    "",
  ];

  let sectionCount = 0;
  const topics = [
    "系统总体架构与零数据丢失原则",
    "增量索引器设计与冲突诊断",
    "只读嵌入引擎与安全边界",
    "中文与拉丁字母混排渲染",
    "折叠状态保持与大纲同步",
    "表格对齐与行内公式解析",
    "性能基线测试与内存控制",
    "多端协作与外部编辑检测",
  ];

  for (let i = 0; i < topics.length; i++) {
    sectionCount++;
    const topKw = i % 3 === 0 ? "进行中" : i % 3 === 1 ? "完成" : "待办";
    lines.push(`* ${topKw} [#A] ${topics[i]} :核心模块:阶段${i + 1}:`);
    lines.push(":PROPERTIES:");
    lines.push(`:ID: cjk-topic-${i + 1}`);
    lines.push(`:CUSTOM_ID: cn-topic-${i + 1}`);
    lines.push(":END:");
    lines.push(
      `本章讨论在 Obsidian 与 Emacs 协同场景下保持 ~.org~ 为唯一事实来源，并链接 [[id:cjk-topic-1][第一章]]。`
    );
    lines.push("");

    for (let j = 1; j <= 5; j++) {
      sectionCount++;
      const subKw = j % 2 === 0 ? "完成" : "待办";
      lines.push(`** ${subKw} 第 ${i + 1}.${j} 节：混排性能与内存边界 :性能:CJK:`);
      lines.push(":PROPERTIES:");
      lines.push(`:ID: cjk-sec-${i + 1}-${j}`);
      lines.push(":END:");
      lines.push("第一行中文叙述在渲染时不应在换行处插入多余空格，同时需正确处理");
      lines.push("第二行中文与 English 术语（如 TypeScript 与 Virtual DOM）的间距。");
      lines.push(
        `内联强调：*关键约束*、/局部状态/、~buildSectionTree~，公式 $T(n) = O(n \\log n)$ 与脚注 [fn:cn${i * 5 + j}]。`
      );
      lines.push("");

      sectionCount++;
      lines.push(`*** 子节 ${i + 1}.${j}.1 实验指标与任务清单 :清单:`);
      lines.push(`- [X] 验证节点 ${i + 1}.${j} 的 ~:PROPERTIES:~ 抽屉解析`);
      lines.push(`- [ ] 检查跨文件 [[id:cjk-topic-1]] 反向链接延迟`);
      lines.push(`- [-] 跟踪内存增量与长文档首屏渲染耗时`);
      lines.push("");

      if (j % 2 === 1) {
        lines.push("| 模块名称 | 延迟目标 (ms) | 内存上限 | 状态 |");
        lines.push("|----------+---------------+----------+------|");
        lines.push("| <l>      | <r>           | <r>      | <c>  |");
        lines.push(`| 索引构建-${i + 1}.${j} | ${15 + j} | 64MB | 正常 |`);
        lines.push(`| 视图渲染-${i + 1}.${j} | ${25 + i} | 48MB | 正常 |`);
        lines.push("");
      } else {
        lines.push("#+BEGIN_SRC typescript");
        lines.push(`export function renderCjkBlock_${i + 1}_${j}(text: string): number {`);
        lines.push("  return text.trim().length;");
        lines.push("}");
        lines.push("#+END_SRC");
        lines.push("");
      }

      sectionCount++;
      lines.push(`**** 补充说明 ${i + 1}.${j}.1.1：在持续高频编辑场景下保持解析器无副作用输出。`);
      lines.push("补充正文段落：确保中文标点、表格边框及代码块在折叠和切换视图后均完整保留。");
      lines.push("");
    }
  }

  sectionCount++;
  lines.push("* 完成 附录：中文脚注与校验尾标 :附录:");
  lines.push(":PROPERTIES:");
  lines.push(":ID: cjk-appendix");
  lines.push(":END:");
  for (let k = 1; k <= 40; k++) {
    lines.push(`[fn:cn${k}] 中文脚注 ${k}：用于验证大规模混合文档脚注渲染完整性。`, "");
  }
  while (lines.length < 2499) {
    lines.push(`第 ${lines.length + 1} 行：中文长文档持续校验段落，验证无截断与完整渲染。`);
  }
  lines.push("中文长文档校验结束标记：END_OF_CHINESE_DOC。");

  return {
    path: "bench/large-chinese-doc.org",
    content: lines.join("\n"),
    lineCount: lines.length,
    expectedSectionCount: sectionCount,
  };
}

function buildSyntheticTransclusionStressCorpus() {
  const files = new Map<string, string>();
  const index = new OrgIdIndex();

  files.set(
    "tx/leaf-l4.org",
    [
      "* Level 4 Leaf Payload",
      ":PROPERTIES:",
      ":ID: tx-chain-l4",
      ":END:",
      "Chain level 4 leaf payload reached cleanly with math $z = x + y$.",
      "",
      "#+BEGIN_SRC typescript",
      "export const leafDepth = 4;",
      "#+END_SRC",
    ].join("\n")
  );

  files.set(
    "tx/node-l3.org",
    [
      "* Level 3 Intermediate",
      ":PROPERTIES:",
      ":ID: tx-chain-l3",
      ":END:",
      "Chain level 3 delegates to level 4:",
      "#+TRANSCLUDE: [[id:tx-chain-l4]] :level 4",
    ].join("\n")
  );

  files.set(
    "tx/node-l2.org",
    [
      "* Level 2 Intermediate",
      ":PROPERTIES:",
      ":ID: tx-chain-l2",
      ":END:",
      "Chain level 2 delegates to level 3:",
      "#+TRANSCLUDE: [[id:tx-chain-l3]] :level 3",
    ].join("\n")
  );

  files.set(
    "tx/node-l1.org",
    [
      "* Level 1 Entry",
      ":PROPERTIES:",
      ":ID: tx-chain-l1",
      ":END:",
      "Chain level 1 delegates to level 2:",
      "#+TRANSCLUDE: [[id:tx-chain-l2]] :level 2",
    ].join("\n")
  );

  for (let fileIdx = 1; fileIdx <= 5; fileIdx++) {
    const lines = [
      `#+TITLE: Snippet Pool ${fileIdx}`,
      `Line 2 preamble alpha for file ${fileIdx}`,
      `Line 3 preamble beta for file ${fileIdx}`,
      `Line 4 preamble gamma for file ${fileIdx}`,
      `Line 5 preamble delta for file ${fileIdx}`,
      `Line 6 preamble epsilon for file ${fileIdx}`,
      "",
    ];
    for (let j = 1; j <= 3; j++) {
      const slotNum = (fileIdx - 1) * 3 + j;
      if (slotNum <= 14) {
        lines.push(`* Snippet Node ${padNum(slotNum, 2)}`);
        lines.push(":PROPERTIES:");
        lines.push(`:ID: tx-slot-${padNum(slotNum, 2)}`);
        lines.push(`:CUSTOM_ID: custom-slot-${fileIdx}-${j}`);
        lines.push(":END:");
        lines.push("SCHEDULED: <2026-11-25 Wed>");
        lines.push(`Content for slot ${slotNum} with *emphasis* and $v_${slotNum} = ${slotNum * 2}$.`);
        lines.push(`- [ ] Read-only task inside slot ${slotNum}`);
        lines.push("");
      }
    }
    if (fileIdx === 3) {
      lines.push("#+NAME: bench-table");
      lines.push("| Slot | Mode | Latency |");
      lines.push("|------+------+---------|");
      lines.push("| 17   | ro   | 1.2ms   |");
      lines.push("");
    }
    files.set(`tx/snippets-0${fileIdx}.org`, lines.join("\n"));
  }

  const hostLines = [
    "#+TITLE: Transclusion Stress Host (20 Slots + 4-Level Nested Chain)",
    "#+STARTUP: showall",
    "",
    "* Direct ID Slots",
  ];
  for (let i = 1; i <= 14; i++) {
    const id = `tx-slot-${padNum(i, 2)}`;
    const opt =
      i % 4 === 0
        ? ":level 2"
        : i % 4 === 1
        ? ":only-contents"
        : i % 4 === 2
        ? ':exclude-elements "drawer planning"'
        : ":level";
    hostLines.push(`#+TRANSCLUDE: [[id:${id}]] ${opt}`);
  }
  hostLines.push("", "* File, Subpath, Named & Line-Sliced Slots");
  hostLines.push("#+TRANSCLUDE: [[file:snippets-01.org::*Snippet Node 01]] :level 2");
  hostLines.push("#+TRANSCLUDE: [[file:snippets-02.org::#custom-slot-2-1]] :only-contents");
  hostLines.push("#+TRANSCLUDE: [[file:snippets-03.org::bench-table]]");
  hostLines.push("#+TRANSCLUDE: [[file:snippets-04.org]] :lines 2-6");
  hostLines.push("#+TRANSCLUDE: [[file:snippets-05.org]] :only-contents :lines 2-5");
  hostLines.push("", "* 4-Level Nested Chain Slot");
  hostLines.push("#+TRANSCLUDE: [[id:tx-chain-l1]] :level 2");

  const hostPath = "tx/host-stress.org";
  files.set(hostPath, hostLines.join("\n"));

  for (const [p, src] of files.entries()) {
    index.upsertFile(p, src);
  }
  index.markInitialized();

  return {
    files,
    index,
    hostPath,
    hostSource: files.get(hostPath)!,
  };
}

describe("Sprint 03 Synthetic Performance & Scalability Regression", () => {
  it.each([
    { nodeCount: 100, fileCount: 10, buildCeilingMs: 1000 },
    { nodeCount: 1000, fileCount: 50, buildCeilingMs: 2000 },
    { nodeCount: 5000, fileCount: 200, buildCeilingMs: 5000 },
  ])(
    "indexes $nodeCount synthetic Org nodes across $fileCount files accurately within $buildCeilingMs ms",
    ({ nodeCount, fileCount, buildCeilingMs }) => {
      const corpus = buildSyntheticScaleCorpus(nodeCount, fileCount);
      const index = new OrgIdIndex();

      const buildStart = performance.now();
      for (const [filePath, src] of corpus.files.entries()) {
        index.upsertFile(filePath, src);
      }
      index.markInitialized();
      const buildMs = performance.now() - buildStart;

      const diag = index.getDiagnostics();
      expect(diag.fileCount).toBe(fileCount);
      expect(diag.nodeCount).toBe(nodeCount);
      expect(diag.duplicates).toHaveLength(0);
      expect(diag.brokenLinks).toHaveLength(0);

      // Verify ID resolution across first, middle, last, and level-6 deep nodes
      const tag = `s${nodeCount}`;
      const first = index.resolveId(`syn-${tag}-0`);
      const mid = index.resolveId(`syn-${tag}-${Math.floor(nodeCount / 2)}`);
      const last = index.resolveId(`syn-${tag}-${nodeCount - 1}`);
      const levelSix = index.resolveId(`syn-${tag}-5`);
      const missing = index.resolveId(`syn-${tag}-does-not-exist`);

      expect(first.status).toBe("found");
      expect(mid.status).toBe("found");
      expect(last.status).toBe("found");
      expect(levelSix.status).toBe("found");
      expect(missing.status).toBe("missing");
      if (levelSix.status === "found") {
        expect(levelSix.node.level).toBe(6);
        expect(levelSix.node.headingPath).toHaveLength(6);
        expect(levelSix.node.title).toBe("Alpha");
      }

      // Search correctness + timing
      const searchStart = performance.now();
      const alphaMatches = index.searchNodes("alpha");
      const searchMs = performance.now() - searchStart;
      expect(alphaMatches).toHaveLength(corpus.expectedAlphaMatches);
      expect(alphaMatches[0]?.title).toBe("Alpha");
      expect(
        alphaMatches.every((n) =>
          `${n.title} ${n.headingPath.join(" ")} ${n.id ?? ""}`.toLowerCase().includes("alpha")
        )
      ).toBe(true);

      // Backlinks lookup correctness + timing
      const backlinksStart = performance.now();
      const hubBacklinks = index.getBacklinksForFile(corpus.hubFilePath);
      const backlinksMs = performance.now() - backlinksStart;
      expect(hubBacklinks).toHaveLength(corpus.nodesPerFile);
      const totalBacklinks = hubBacklinks.reduce((acc, g) => acc + g.backlinks.length, 0);
      expect(totalBacklinks).toBeGreaterThanOrEqual((fileCount - 1) * corpus.nodesPerFile);
      for (const group of hubBacklinks) {
        expect(group.backlinks.every((b) => b.sourcePath !== corpus.hubFilePath)).toBe(true);
      }

      console.info(
        `[perf] scale=${nodeCount} files=${fileCount}: build=${buildMs.toFixed(2)}ms, search=${searchMs.toFixed(
          2
        )}ms (${alphaMatches.length} hits), backlinks=${backlinksMs.toFixed(2)}ms (${totalBacklinks} links)`
      );

      expect(buildMs).toBeLessThan(buildCeilingMs);
      expect(searchMs).toBeLessThan(500);
      expect(backlinksMs).toBeLessThan(500);
    }
  );

  it("performs accurate incremental single-file upsertFile on an existing 5,000-node index", () => {
    const corpus = buildSyntheticScaleCorpus(5000, 200);
    const index = new OrgIdIndex();
    for (const [filePath, src] of corpus.files.entries()) {
      index.upsertFile(filePath, src);
    }
    index.markInitialized();

    const originalHub = corpus.files.get(corpus.hubFilePath)!;
    const noopRes = index.upsertFile(corpus.hubFilePath, originalHub);
    expect(noopRes.changed).toBe(false);

    const beforeOldTargetBacklinks = index.getBacklinks("syn-s5000-26").length;
    const beforeNewTargetBacklinks = index.getBacklinks("syn-s5000-4999").length;

    // Modify hub file: rename node 0, swap link syn-s5000-26 -> syn-s5000-4999, and append a new node
    const updatedHub =
      originalHub.replace("Synthetic Knowledge Node 0", "Alpha Updated Hub")
        .replace("[[id:syn-s5000-26][Peer 26]]", "[[id:syn-s5000-4999][Tail 4999]]") +
      "\n* Extra Incremental Node\n:PROPERTIES:\n:ID: syn-s5000-extra\n:END:\nAdded links [[id:syn-s5000-2500]].\n";

    const upsertStart = performance.now();
    const upsertRes = index.upsertFile(corpus.hubFilePath, updatedHub);
    const upsertMs = performance.now() - upsertStart;

    expect(upsertRes.changed).toBe(true);
    expect(upsertRes.affectedNodeIds.has("syn-s5000-0")).toBe(true);
    expect(upsertRes.affectedNodeIds.has("syn-s5000-extra")).toBe(true);

    const resolvedZero = index.resolveId("syn-s5000-0");
    expect(resolvedZero.status).toBe("found");
    if (resolvedZero.status === "found") {
      expect(resolvedZero.node.title).toBe("Alpha Updated Hub");
    }
    expect(index.resolveId("syn-s5000-extra").status).toBe("found");

    const diagAfter = index.getDiagnostics();
    expect(diagAfter.nodeCount).toBe(5001);
    expect(diagAfter.duplicates).toHaveLength(0);
    expect(diagAfter.brokenLinks).toHaveLength(0);

    expect(index.getBacklinks("syn-s5000-26")).toHaveLength(beforeOldTargetBacklinks - 1);
    expect(index.getBacklinks("syn-s5000-4999")).toHaveLength(beforeNewTargetBacklinks + 1);

    console.info(
      `[perf] incremental upsertFile (5,000-node index): ${upsertMs.toFixed(2)}ms, affectedNodes=${upsertRes.affectedNodeIds.size}`
    );
    expect(upsertMs).toBeLessThan(500);
  });

  it("parses and renders ~3,000-line academic paper completely without truncation and with exact section count", () => {
    const paper = buildSyntheticAcademicPaper();
    expect(paper.lineCount).toBeGreaterThanOrEqual(2950);
    expect(paper.lineCount).toBeLessThanOrEqual(3100);

    const app = createMockApp() as unknown as App;
    const parseStart = performance.now();
    const doc = parseOrgDoc(paper.content);
    const tree = buildSectionTree(doc);
    const parseMs = performance.now() - parseStart;

    const renderStart = performance.now();
    const root = renderOrgPreview(paper.content, app, paper.path, {
      settings: { ...DEFAULT_SETTINGS },
    });
    const renderMs = performance.now() - renderStart;

    expect(doc.lines).toHaveLength(paper.lineCount);
    expect(tree.sections.length).toBe(11);
    expect(root.querySelectorAll(".org-section")).toHaveLength(paper.expectedSectionCount);
    expect(root.querySelectorAll("table.org-table").length).toBeGreaterThanOrEqual(40);
    expect(root.querySelectorAll(".org-math-block").length).toBeGreaterThanOrEqual(40);
    expect(root.querySelectorAll(".org-code-block").length).toBeGreaterThanOrEqual(20);
    expect(root.querySelectorAll(".org-footnote-def")).toHaveLength(paper.footnoteCount);

    const text = root.textContent ?? "";
    expect(text).toContain("Deterministic Read-Only Transclusion");
    expect(text).toContain("Appendix: Footnotes and Formal Proofs");
    expect(text).toContain("END_OF_ACADEMIC_PAPER.");

    console.info(
      `[perf] academic paper (${paper.lineCount} lines, ${paper.expectedSectionCount} sections): parse+tree=${parseMs.toFixed(
        2
      )}ms, render=${renderMs.toFixed(2)}ms`
    );
    expect(parseMs).toBeLessThan(500);
    expect(renderMs).toBeLessThan(4000);
  });

  it("parses and renders ~2,500-line Chinese document completely with CJK typography and exact section count", () => {
    const cnDoc = buildSyntheticChineseDocument();
    expect(cnDoc.lineCount).toBeGreaterThanOrEqual(2450);
    expect(cnDoc.lineCount).toBeLessThanOrEqual(2600);

    const app = createMockApp() as unknown as App;
    const parseStart = performance.now();
    const doc = parseOrgDoc(cnDoc.content);
    const tree = buildSectionTree(doc);
    const parseMs = performance.now() - parseStart;

    const renderStart = performance.now();
    const root = renderOrgPreview(cnDoc.content, app, cnDoc.path, {
      settings: { ...DEFAULT_SETTINGS, cjkTypography: true },
    });
    const renderMs = performance.now() - renderStart;

    expect(doc.lines).toHaveLength(cnDoc.lineCount);
    expect(doc.todoActive.has("待办")).toBe(true);
    expect(doc.todoActive.has("进行中")).toBe(true);
    expect(doc.todoDone.has("完成")).toBe(true);
    expect(tree.sections.length).toBe(9);
    expect(root.dataset.cjkTypography).toBe("true");
    expect(root.querySelectorAll(".org-section")).toHaveLength(cnDoc.expectedSectionCount);
    expect(root.querySelectorAll('span.org-todo[data-todo="待办"]').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('span.org-todo[data-todo="完成"]').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('span.org-todo[data-todo="进行中"]').length).toBeGreaterThan(0);
    expect(root.querySelectorAll("table.org-table").length).toBeGreaterThanOrEqual(20);
    expect(root.querySelectorAll(".org-code-block").length).toBeGreaterThanOrEqual(15);
    expect(root.querySelectorAll(".org-footnote-def")).toHaveLength(40);

    const text = root.textContent ?? "";
    expect(text).toContain("不应在换行处插入多余空格，同时需正确处理第二行中文");
    expect(text).toContain("END_OF_CHINESE_DOC");

    console.info(
      `[perf] chinese doc (${cnDoc.lineCount} lines, ${cnDoc.expectedSectionCount} sections): parse+tree=${parseMs.toFixed(
        2
      )}ms, render=${renderMs.toFixed(2)}ms`
    );
    expect(parseMs).toBeLessThan(500);
    expect(renderMs).toBeLessThan(4000);
  });

  it("hydrates 20-slot + 4-level nested transclusion stress document cleanly with zero source mutation", async () => {
    const stress = buildSyntheticTransclusionStressCorpus();
    const beforeHashes = new Map<string, string>();
    for (const [p, src] of stress.files.entries()) {
      beforeHashes.set(p, sha256(src));
    }

    const app = createMockApp() as unknown as App;
    const provider = createMemoryTransclusionProvider(stress.files, stress.index);
    const engine = new OrgTransclusionEngine(provider);
    const settings = {
      ...DEFAULT_SETTINGS,
      enableTransclusion: true,
      transclusionMaxDepth: 4,
    };

    const t0 = performance.now();
    const root = renderOrgPreview(stress.hostSource, app, stress.hostPath, { settings });
    const initialSlotCount = root.querySelectorAll(".org-transclude-slot").length;
    expect(initialSlotCount).toBe(20);

    await hydrateTransclusionsInDom(root, {
      app,
      sourcePath: stress.hostPath,
      resolver: engine,
      settings,
    });
    const totalMs = performance.now() - t0;

    expect(root.querySelectorAll(".org-transclude-slot")).toHaveLength(0);
    expect(root.querySelectorAll(".org-transclusion-error")).toHaveLength(0);

    const hydrated = Array.from(
      root.querySelectorAll<HTMLElement>('.org-transclusion[data-transclusion-status="ok"]')
    );
    expect(hydrated).toHaveLength(23);
    expect(root.querySelectorAll('[data-transclusion-depth="0"]')).toHaveLength(20);
    expect(root.querySelectorAll('[data-transclusion-depth="1"]')).toHaveLength(1);
    expect(root.querySelectorAll('[data-transclusion-depth="2"]')).toHaveLength(1);
    expect(root.querySelectorAll('[data-transclusion-depth="3"]')).toHaveLength(1);

    const depth3Aside = root.querySelector<HTMLElement>('[data-transclusion-depth="3"]');
    expect(depth3Aside?.textContent).toContain("Chain level 4 leaf payload reached cleanly");
    expect(depth3Aside?.textContent).toContain("export const leafDepth = 4;");

    expect(hydrated.every((el) => el.dataset.readonly === "true")).toBe(true);
    const embeddedCheckboxes = Array.from(
      root.querySelectorAll<HTMLInputElement>(".org-transclusion input.org-task-checkbox")
    );
    expect(embeddedCheckboxes.length).toBeGreaterThanOrEqual(14);
    expect(embeddedCheckboxes.every((cb) => cb.disabled)).toBe(true);

    // Depth-exceeded guard still blocks depth >= 4
    const depthGuardRes = await engine.resolve(
      {
        sourcePath: stress.hostPath,
        line: 0,
        raw: "#+TRANSCLUDE: [[id:tx-chain-l4]]",
        targetType: "id",
        rawTarget: "id:tx-chain-l4",
        target: "tx-chain-l4",
        options: { unsupportedParams: [] },
      },
      { depth: 4, maxDepth: 4 }
    );
    expect(depthGuardRes.status).toBe("depth-exceeded");

    // Zero source mutation across entire corpus
    for (const [p, src] of stress.files.entries()) {
      expect(sha256(src)).toBe(beforeHashes.get(p));
    }

    console.info(
      `[perf] transclusion stress (20 slots + 4-level chain -> 23 hydrated): ${totalMs.toFixed(2)}ms`
    );
    expect(totalMs).toBeLessThan(3000);
  });
});
