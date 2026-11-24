#!/usr/bin/env node
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
    Element: win.Element,
    Node: win.Node,
    DocumentFragment: win.DocumentFragment,
    Text: win.Text,
    Comment: win.Comment,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
  };
  for (const [key, value] of Object.entries(bindings)) {
    if (typeof globalThis[key] === "undefined") {
      globalThis[key] = value;
    }
  }
  return win;
}

async function loadBundledOrgModules(tmpDir) {
  const obsidianMockPath = path.join(ROOT_DIR, "tests", "mocks", "obsidian.ts");
  const outfile = path.join(tmpDir, "org-bench-bundle.mjs");

  const entrySource = `
    export { parseOrgDoc } from "./src/core/parser/parse.ts";
    export { buildSectionTree } from "./src/core/parser/sectionTree.ts";
    export { OrgIdIndex, extractOrgFileIndexData } from "./src/core/index/orgIdIndex.ts";
    export { OrgTransclusionEngine } from "./src/core/transclusion/engine.ts";
    export { createMemoryTransclusionProvider } from "./src/core/transclusion/provider.ts";
    export { renderOrgPreview } from "./src/views/reading/render.ts";
    export { hydrateTransclusionsInDom } from "./src/views/transclusion/renderTransclusion.ts";
    export { DEFAULT_SETTINGS } from "./src/settings.ts";
    export { createMockApp } from "./tests/mocks/obsidian.ts";
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

/**
 * Generate a deterministic multi-file synthetic Org corpus with:
 * - Exact `totalNodes` heading nodes across `fileCount` files
 * - Headings up to 6 levels deep
 * - `:PROPERTIES:` drawers with `:ID:` and `:CUSTOM_ID:`
 * - Dense cross-file `[[id:...]]` links (including heavy backlinks into corpus-000.org)
 * - Tables, display math, inline math, code blocks, and task checklists
 */
function buildSyntheticScaleCorpus(totalNodes, fileCount) {
  if (totalNodes % fileCount !== 0) {
    throw new Error(`totalNodes (${totalNodes}) must be divisible by fileCount (${fileCount})`);
  }
  const nodesPerFile = totalNodes / fileCount;
  const tag = `s${totalNodes}`;
  const files = new Map();
  let totalLines = 0;
  let totalLinks = 0;

  const nodeId = (globalIndex) => `syn-${tag}-${globalIndex}`;
  const fileName = (fileIdx) => `notes/corpus-${padNum(fileIdx, 3)}.org`;

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

      const hubFileTarget = f === 0 ? nodesPerFile + k : k;
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
        `Cross-file refs: [[id:${nodeId(hubFileTarget)}][Hub ${hubFileTarget}]], ` +
          `[[id:${nodeId(neighborTarget)}][Peer ${neighborTarget}]], ` +
          `[[id:${nodeId(strideTarget)}][Bridge ${strideTarget}]]. ` +
          `Inline math $f_${k}(x) = \\alpha x + ${g}$ and ~sym_${g}~. `
      );
      totalLinks += 3;

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
        lines.push(`- [${k % 2 === 0 ? "X" : " "}] Checklist item for *node ${g}* /cluster ${f % 8}/`);
      }
      lines.push("");
    }

    const content = lines.join("\n");
    totalLines += lines.length;
    files.set(fileName(f), content);
  }

  const alphaPerFile = nodesPerFile >= 20 ? 2 : 1;

  return {
    files,
    fileCount,
    nodeCount: totalNodes,
    nodesPerFile,
    totalLines,
    totalLinks,
    expectedAlphaMatches: fileCount * alphaPerFile,
    hubFilePath: fileName(0),
    hubFileVariantB: buildMutatedHubFile(totalNodes, fileCount, nodesPerFile),
  };
}

function buildMutatedHubFile(totalNodes, fileCount, nodesPerFile) {
  const tag = `s${totalNodes}`;
  const nodeId = (g) => `syn-${tag}-${g}`;
  const lines = [
    `#+TITLE: Synthetic Corpus File 1/${fileCount} (Incremental Update)`,
    `#+FILETAGS: :synthetic:scale${totalNodes}:updated:`,
    "",
  ];

  for (let k = 0; k < nodesPerFile; k++) {
    const g = k;
    const level = (k % 6) + 1;
    const stars = "*".repeat(level);
    const isAlphaLeaf = k === 5 || (nodesPerFile >= 20 && k === 17);
    const title =
      g === 5
        ? "Alpha Updated Hub"
        : isAlphaLeaf
        ? `Alpha Research Node ${g}`
        : `Updated Node ${g}`;
    const target1 = nodesPerFile + k;
    const target2 = ((2 % fileCount) * nodesPerFile) + ((k + 1) % nodesPerFile);
    const target3 = (Math.max(1, Math.floor(fileCount / 2)) * nodesPerFile) + ((k + 2) % nodesPerFile);

    lines.push(`${stars} TODO ${title} :updated:`);
    lines.push(":PROPERTIES:");
    lines.push(`:ID: ${nodeId(g)}`);
    lines.push(`:CUSTOM_ID: custom-${tag}-${g}`);
    lines.push(":END:");
    lines.push(
      `Incremental revision linking [[id:${nodeId(target1)}]], [[id:${nodeId(target2)}]], and [[id:${nodeId(target3)}]].`
    );
    lines.push("");
  }

  return lines.join("\n");
}

function buildNormalNote() {
  const lines = [
    "#+TITLE: Normal Benchmark Note",
    "#+FILETAGS: :bench:normal:",
    "",
    "* Overview :intro:",
    ":PROPERTIES:",
    ":ID: normal-overview",
    ":END:",
    "A realistic medium-sized Org note with *bold*, /italic/, ~code~, and $E = mc^2$.",
    "",
  ];
  let sectionCount = 1;

  for (let i = 1; i <= 6; i++) {
    sectionCount++;
    lines.push(`** Section ${i} Analysis :topic${i}:`);
    lines.push(":PROPERTIES:");
    lines.push(`:ID: normal-sec-${i}`);
    lines.push(":END:", "");
    lines.push(`Paragraph ${i} referencing [[id:normal-overview][Overview]] and footnote [fn:n${i}].`);
    lines.push(`- [ ] Task ${i}.1 verify invariant`);
    lines.push(`- [X] Task ${i}.2 check output`);
    if (i % 2 === 0) {
      lines.push("| Key | Value |");
      lines.push("|-----+-------|");
      lines.push(`| k${i} | ${i * 10} |`);
    }
    if (i === 3) {
      lines.push("#+BEGIN_SRC typescript");
      lines.push("export const square = (n: number): number => n * n;");
      lines.push("#+END_SRC");
    }
    lines.push("");
  }
  for (let i = 1; i <= 6; i++) {
    lines.push(`[fn:n${i}] Footnote explanation ${i}.`, "");
  }
  return {
    path: "bench/normal-note.org",
    content: lines.join("\n"),
    lineCount: lines.length,
    expectedSectionCount: sectionCount,
  };
}

/**
 * Build a ~3,000-line synthetic academic paper with nested sections,
 * math blocks, code blocks, aligned tables, and footnotes.
 */
function buildSyntheticAcademicPaper() {
  const lines = [
    "#+TITLE: Deterministic Read-Only Transclusion and Incremental Indexing for Local Org Graphs",
    "#+AUTHOR: Synthetic Benchmark Suite",
    "#+DATE: 2026-11-25",
    "#+STARTUP: showall",
    "#+FILETAGS: :paper:systems:orgmode:",
    "",
    "#+BEGIN_QUOTE",
    "This synthetic ~3,000-line academic manuscript evaluates parser throughput, section tree construction, and Reading View DOM rendering.",
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
      `Section ${c + 1} establishes invariant $\\mathcal{I}_{${c + 1}}$ over local Org AST nodes ` +
        `with cross-reference [[id:paper-ch-1][Chapter 1]] and citation [fn:${++fnCounter}].`
    );
    lines.push("");

    for (let s = 1; s <= 4; s++) {
      sectionCount++;
      lines.push(`** Section ${c + 1}.${s} Formalization :sub${s}:`);
      lines.push(":PROPERTIES:");
      lines.push(`:ID: paper-sec-${c + 1}-${s}`);
      lines.push(":END:");
      lines.push(
        `Let $G = (V, E)$ denote the vault graph where $|V|$ scales to $5\\times 10^3$ nodes. ` +
          `Incremental updates preserve *byte-level immutability* and ~O(deg(v))~ re-indexing [fn:${++fnCounter}].`
      );
      lines.push("");

      for (let sub = 1; sub <= 2; sub++) {
        sectionCount++;
        lines.push(`*** Subsection ${c + 1}.${s}.${sub} Lemma & Proof`);
        lines.push(
          `For depth $d \\le d_{\\max}$, traversal halts deterministically without mutating source files.`
        );
        lines.push("1. Parse raw lines into structural tokens with exact UTF-16 offsets.");
        lines.push("2. Construct hierarchical section trees preserving preamble and drawer ranges.");
        lines.push("3. Render sanitized DOM nodes without executing inline scripts.");
        lines.push("");

        if (sub === 1) {
          lines.push("\\begin{align}");
          lines.push(
            `T_{\\text{index}}(N) &= \\sum_{i=1}^{N} c_i \\cdot \\log(1 + d_i) + ${c + s} \\\\`
          );
          lines.push(
            `M_{\\text{heap}}(N) &= \\alpha N + \\beta |E| + \\gamma_{${c + 1},${s}}`
          );
          lines.push("\\end{align}");
          lines.push("");
        } else {
          lines.push("| Pipeline Stage | Complexity | Mean (ms) | Status |");
          lines.push("|----------------+------------+-----------+--------|");
          lines.push("| <l>            | <c>        | <r>       | <c>    |");
          lines.push(`| Parse-${c + 1}.${s} | O(L) | ${(1.2 + s * 0.3).toFixed(1)} | pass |`);
          lines.push(`| Tree-${c + 1}.${s}  | O(H) | ${(0.4 + c * 0.1).toFixed(1)} | pass |`);
          lines.push(`| Render-${c + 1}.${s} | O(L) | ${(3.1 + sub * 0.5).toFixed(1)} | pass |`);
          lines.push("");
        }

        if ((c + s + sub) % 3 === 0) {
          lines.push("#+BEGIN_SRC python");
          lines.push(`def verify_step_${c + 1}_${s}_${sub}(nodes, edges):`);
          lines.push("    visited = set()");
          lines.push("    for node in nodes:");
          lines.push("        if node.id not in visited:");
          lines.push("            visited.add(node.id)");
          lines.push("    return len(visited) == len(nodes)");
          lines.push("#+END_SRC");
          lines.push("");
        }

        lines.push(
          `**** Remark ${c + 1}.${s}.${sub}: Detailed experimental observation ` +
            `confirming stable latency under mixed math $\\sum_{k=1}^m x_k$ and verbatim ~parseOrgDoc~.`
        );
        sectionCount++;
        lines.push(
          `Extensive empirical prose paragraph ${c + 1}.${s}.${sub} documenting how deterministic ` +
            `section boundaries, property drawers, and table alignments interact in long-form academic manuscripts.`
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
    lines.push(`[fn:${i}] Synthetic proof note ${i}: invariant verified across all tree depths.`, "");
  }
  while (lines.length < 2999) {
    lines.push(
      `Supplementary remark line ${lines.length + 1}: verifying zero truncation at tail of ~3,000-line manuscript.`
    );
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

/**
 * Build a ~2,500-line CJK+Latin mixed Org document with Chinese TODO keywords,
 * tags, :ID: drawers, aligned tables, lists, and code blocks.
 */
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
      `本章讨论在 Obsidian 与 Emacs 协同场景下，如何保持 ~.org~ 源文件作为唯一事实来源` +
        `（Single Source of Truth），并通过 [[id:cjk-topic-1][第一章架构说明]] 建立双向追溯。`
    );
    lines.push("");

    for (let j = 1; j <= 5; j++) {
      sectionCount++;
      const subKw = j % 2 === 0 ? "完成" : "待办";
      lines.push(`** ${subKw} 第 ${i + 1}.${j} 节：混排性能与内存边界 :性能:CJK:`);
      lines.push(":PROPERTIES:");
      lines.push(`:ID: cjk-sec-${i + 1}-${j}`);
      lines.push(":END:");
      // Wrapped consecutive CJK lines to exercise CJK newline joining in renderOrgPreview
      lines.push("第一行中文叙述在渲染时不应在换行处插入多余空格，同时需正确处理");
      lines.push("第二行中文与 English 术语（如 TypeScript 与 Virtual DOM）的间距。");
      lines.push(
        `内联强调测试：*关键约束*、/局部状态/、~buildSectionTree~，以及公式 $T(n) = O(n \\log n)$ 和脚注 [fn:cn${i * 5 + j}]。`
      );
      lines.push("");

      sectionCount++;
      lines.push(`*** 子节 ${i + 1}.${j}.1 实验指标与任务清单 :清单:`);
      lines.push(`- [X] 验证节点 ${i + 1}.${j} 的 ~:PROPERTIES:~ 抽屉解析与只读折叠`);
      lines.push(`- [ ] 检查跨文件 [[id:cjk-topic-1]] 反向链接与悬停预览延迟`);
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

      lines.push(
        `**** 补充说明 ${i + 1}.${j}.1.1：在持续高频编辑场景下保持解析器无副作用输出。`
      );
      sectionCount++;
      lines.push("补充正文段落：确保中文标点符号、表格边框以及代码块在折叠和切换视图后均完整保留。");
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

/**
 * Build a multi-transclusion stress corpus:
 * - Host file with 20 #+TRANSCLUDE: slots
 * - Slot #20 triggers a 4-level nested chain (depth 0 -> 1 -> 2 -> 3)
 * - 23 total expanded .org-transclusion blocks under default transclusionMaxDepth=4
 */
function buildSyntheticTransclusionStressCorpus(OrgIdIndex) {
  const files = new Map();
  const index = new OrgIdIndex();

  // 4-level nested chain files (depth 0 -> 1 -> 2 -> 3)
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

  // 14 ID-based snippet nodes across 4 snippet files + 5 file/subpath/named/line targets
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
        lines.push(`SCHEDULED: <2026-11-25 Wed>`);
        lines.push(
          `Content for slot ${slotNum} with *emphasis*, inline math $v_${slotNum} = ${slotNum * 2}$, and task:`
        );
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
    hostSource: files.get(hostPath),
    topLevelSlots: 20,
    expectedTotalHydrated: 23,
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

async function measureAsync(name, fn, warmRuns, prepareRun) {
  if (typeof globalThis.gc === "function") globalThis.gc();
  const memBefore = process.memoryUsage();
  const coldCtx = prepareRun ? prepareRun(0) : undefined;
  const t0 = performance.now();
  const coldResult = await fn(coldCtx);
  const coldMs = performance.now() - t0;
  const memAfter = process.memoryUsage();

  const warmTimes = [];
  for (let i = 0; i < warmRuns; i++) {
    const ctx = prepareRun ? prepareRun(i + 1) : undefined;
    const start = performance.now();
    await fn(ctx);
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
  const win = setupDomEnvironment();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-native-bench-"));

  try {
    const mod = await loadBundledOrgModules(tmpDir);
    const {
      parseOrgDoc,
      buildSectionTree,
      OrgIdIndex,
      OrgTransclusionEngine,
      createMemoryTransclusionProvider,
      renderOrgPreview,
      hydrateTransclusionsInDom,
      DEFAULT_SETTINGS,
      createMockApp,
    } = mod;

    const app = createMockApp();
    const benchResults = [];

    // 1. Scale 1 / 2 / 3 index build benchmarks (100 / 1,000 / 5,000 nodes)
    const scaleConfigs = [
      { nodes: 100, files: 10, warmRuns: 10 },
      { nodes: 1000, files: 50, warmRuns: 5 },
      { nodes: 5000, files: 200, warmRuns: 3 },
    ];

    let corpus5000 = null;
    let retainedIndex5000 = null;

    for (const cfg of scaleConfigs) {
      const corpus = buildSyntheticScaleCorpus(cfg.nodes, cfg.files);
      const run = measureSync(
        `OrgIdIndex build (${cfg.nodes} nodes / ${cfg.files} files)`,
        () => {
          const index = new OrgIdIndex();
          for (const [filePath, src] of corpus.files.entries()) {
            index.upsertFile(filePath, src);
          }
          index.markInitialized();
          return index;
        },
        cfg.warmRuns
      );
      const diag = run.result.getDiagnostics();
      if (diag.nodeCount !== cfg.nodes || diag.fileCount !== cfg.files) {
        throw new Error(
          `Expected ${cfg.nodes} nodes/${cfg.files} files, got ${diag.nodeCount}/${diag.fileCount}`
        );
      }
      if (diag.duplicates.length !== 0 || diag.brokenLinks.length !== 0) {
        throw new Error(
          `Unexpected diagnostics: duplicates=${diag.duplicates.length}, broken=${diag.brokenLinks.length}`
        );
      }
      benchResults.push({
        id: `index_build_${cfg.nodes}`,
        name: `OrgIdIndex build (${cfg.nodes} nodes / ${cfg.files} files)`,
        metrics: run.metrics,
        detail: `${corpus.totalLines} lines, ${corpus.totalLinks} links, 0 errors`,
      });
      if (cfg.nodes === 5000) {
        corpus5000 = corpus;
        retainedIndex5000 = run.result;
      }
    }

    // 2. Single incremental upsertFile on existing 5,000-node index
    const hubOriginal = corpus5000.files.get(corpus5000.hubFilePath);
    const hubVariantB = corpus5000.hubFileVariantB;
    const upsertBench = measureSync(
      "Incremental upsertFile (1 file on 5,000-node index)",
      (nextSource) => {
        const res = retainedIndex5000.upsertFile(corpus5000.hubFilePath, nextSource);
        if (!res.changed) {
          throw new Error("Incremental upsertFile unexpectedly skipped unchanged hash");
        }
        return res;
      },
      20,
      (iter) => (iter % 2 === 0 ? hubVariantB : hubOriginal)
    );
    // Restore original hub file after alternating benchmark
    retainedIndex5000.upsertFile(corpus5000.hubFilePath, hubOriginal);
    benchResults.push({
      id: "index_upsert_single_5000",
      name: "Incremental upsertFile (1 file on 5,000-node index)",
      metrics: upsertBench.metrics,
      detail: `changed=true, affectedNodes=${upsertBench.result.affectedNodeIds.size}`,
    });

    // 3. searchNodes("alpha") on 5,000-node index
    const searchBench = measureSync(
      'searchNodes("alpha") on 5,000-node index',
      () => retainedIndex5000.searchNodes("alpha"),
      25
    );
    if (searchBench.result.length !== corpus5000.expectedAlphaMatches) {
      throw new Error(
        `Expected ${corpus5000.expectedAlphaMatches} alpha matches, got ${searchBench.result.length}`
      );
    }
    benchResults.push({
      id: "index_search_alpha_5000",
      name: 'searchNodes("alpha") (5,000 nodes)',
      metrics: searchBench.metrics,
      detail: `${searchBench.result.length} matches`,
    });

    // 4. getBacklinksForFile on 5,000-node index
    const backlinksBench = measureSync(
      "getBacklinksForFile (5,000-node index)",
      () => retainedIndex5000.getBacklinksForFile(corpus5000.hubFilePath),
      25
    );
    const totalBacklinksReturned = backlinksBench.result.reduce(
      (sum, entry) => sum + entry.backlinks.length,
      0
    );
    if (totalBacklinksReturned <= 0) {
      throw new Error("Expected positive incoming backlinks on hub file");
    }
    benchResults.push({
      id: "index_backlinks_file_5000",
      name: "getBacklinksForFile (corpus-000.org on 5,000 nodes)",
      metrics: backlinksBench.metrics,
      detail: `${backlinksBench.result.length} nodes, ${totalBacklinksReturned} backlinks`,
    });

    // 5. First-open parseOrgDoc + buildSectionTree + renderOrgPreview benchmarks
    const normalDoc = buildNormalNote();
    const paperDoc = buildSyntheticAcademicPaper();
    const chineseDoc = buildSyntheticChineseDocument();

    const docsToBench = [
      { key: "normal", label: "Normal note", doc: normalDoc, parseWarm: 20, renderWarm: 10 },
      { key: "paper_3000", label: "Academic paper (~3,000 lines)", doc: paperDoc, parseWarm: 10, renderWarm: 5 },
      { key: "chinese_2500", label: "Chinese doc (~2,500 lines)", doc: chineseDoc, parseWarm: 10, renderWarm: 5 },
    ];

    for (const item of docsToBench) {
      const parseRun = measureSync(
        `parseOrgDoc + buildSectionTree (${item.label})`,
        () => {
          const parsed = parseOrgDoc(item.doc.content);
          const tree = buildSectionTree(parsed);
          return { parsed, tree };
        },
        item.parseWarm
      );
      benchResults.push({
        id: `parse_tree_${item.key}`,
        name: `parseOrgDoc + buildSectionTree (${item.label})`,
        metrics: parseRun.metrics,
        detail: `${item.doc.lineCount} lines, ${item.doc.expectedSectionCount} sections`,
      });

      const renderRun = measureSync(
        `renderOrgPreview (${item.label})`,
        () =>
          renderOrgPreview(item.doc.content, app, item.doc.path, {
            settings: { ...DEFAULT_SETTINGS },
          }),
        item.renderWarm
      );
      const renderedSections = renderRun.result.querySelectorAll(".org-section").length;
      if (renderedSections !== item.doc.expectedSectionCount) {
        throw new Error(
          `${item.label}: expected ${item.doc.expectedSectionCount} .org-section elements, got ${renderedSections}`
        );
      }
      benchResults.push({
        id: `render_preview_${item.key}`,
        name: `renderOrgPreview (${item.label})`,
        metrics: renderRun.metrics,
        detail: `${item.doc.lineCount} lines, ${renderedSections} .org-section`,
      });
    }

    // 6. Multi-transclusion stress: 20 slots + 4-level nested chain
    const txStress = buildSyntheticTransclusionStressCorpus(OrgIdIndex);
    const txProvider = createMemoryTransclusionProvider(txStress.files, txStress.index);
    const txEngine = new OrgTransclusionEngine(txProvider);
    const txSettings = {
      ...DEFAULT_SETTINGS,
      enableTransclusion: true,
      transclusionMaxDepth: 4,
    };

    const hydrateOnlyRun = await measureAsync(
      "OrgTransclusionEngine + hydrateTransclusionsInDom (20 slots + 4-level)",
      async (root) => {
        await hydrateTransclusionsInDom(root, {
          app,
          sourcePath: txStress.hostPath,
          resolver: txEngine,
          settings: txSettings,
        });
        const okCount = root.querySelectorAll('.org-transclusion[data-transclusion-status="ok"]').length;
        const errCount = root.querySelectorAll(".org-transclusion-error").length;
        const leftoverSlots = root.querySelectorAll(".org-transclude-slot").length;
        if (okCount !== txStress.expectedTotalHydrated || errCount !== 0 || leftoverSlots !== 0) {
          throw new Error(
            `Transclusion stress mismatch: ok=${okCount}, err=${errCount}, leftover=${leftoverSlots}`
          );
        }
        return root;
      },
      5,
      () => renderOrgPreview(txStress.hostSource, app, txStress.hostPath, { settings: txSettings })
    );
    benchResults.push({
      id: "transclusion_hydrate_20x4",
      name: "hydrateTransclusionsInDom (20 slots + 4-level chain)",
      metrics: hydrateOnlyRun.metrics,
      detail: `${txStress.topLevelSlots} top slots, ${txStress.expectedTotalHydrated} hydrated, 0 errors`,
    });

    const e2eTxRun = await measureAsync(
      "renderOrgPreview + hydrateTransclusionsInDom (20 slots + 4-level e2e)",
      async () => {
        const root = renderOrgPreview(txStress.hostSource, app, txStress.hostPath, {
          settings: txSettings,
        });
        await hydrateTransclusionsInDom(root, {
          app,
          sourcePath: txStress.hostPath,
          resolver: txEngine,
          settings: txSettings,
        });
        return root;
      },
      5
    );
    benchResults.push({
      id: "transclusion_e2e_20x4",
      name: "renderOrgPreview + hydrate (20 slots + 4-level e2e)",
      metrics: e2eTxRun.metrics,
      detail: `depth 0..3 verified`,
    });

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
      corpora: {
        scale100: { files: 10, nodes: 100 },
        scale1000: { files: 50, nodes: 1000 },
        scale5000: { files: 200, nodes: 5000, lines: corpus5000.totalLines, links: corpus5000.totalLinks },
        normalNote: { lines: normalDoc.lineCount, sections: normalDoc.expectedSectionCount },
        academicPaper: { lines: paperDoc.lineCount, sections: paperDoc.expectedSectionCount },
        chineseDoc: { lines: chineseDoc.lineCount, sections: chineseDoc.expectedSectionCount },
        transclusionStress: {
          topLevelSlots: txStress.topLevelSlots,
          maxDepth: 4,
          expectedHydrated: txStress.expectedTotalHydrated,
        },
      },
      benchmarks: benchResults,
    };

    if (jsonOnly) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `# Org Native Synthetic Benchmark Report\n\n` +
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
