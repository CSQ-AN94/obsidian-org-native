# Org Native for Obsidian — Sprint 04 Report (`v0.3.0-beta.1`)

**Date:** 2026-11-25  
**Version:** `0.3.0-beta.1` (upgraded from `v0.2.0-beta.1` / `11ca8a8`)  
**Scope:** Built-in Org Knowledge Graph — Engine Evaluation, Global Graph (Node & File Granularities), Local Graph & Reader Bidirectional Sync, Real Obsidian Electron GUI Validation (`12/12 PASS`), and `100` / `1,000` / `5,000`-Node Synthetic Benchmarks.

---

## 1. Executive Summary

Sprint 04 delivered an Obsidian-native **Org Knowledge Graph** capable of treating every Org heading with `:ID:` as a first-class graph node alongside `.org` file-level views, while preserving the single-source-of-truth guarantee (**Org = Source of Truth, Emacs = Authoring, Obsidian = Reading & Interaction Layer**):

1. **Clean-License Graph Stack ([docs/GRAPH_ENGINE_EVALUATION.md](docs/GRAPH_ENGINE_EVALUATION.md))**: Selected **`d3-force@^3.0.1` + `d3-quadtree` (ISC License)** with a custom **Batched HiDPI HTML5 Canvas2D** renderer (`OrgGraphCanvasRenderer`), built strictly on Obsidian's public `ItemView` / `Workspace` / `Plugin` APIs without touching private core graph internals or mutating any `.org` files. Third-party attribution is documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
2. **Global & Local Graph Reusing `OrgIdIndex`**: Extended `OrgIdIndex` (`fileTitle`, `tags`, `todo`, `parentNodeId`, `getFileIndexData`, `getAllFileIndexData`, `findEnclosingNodeAtLine`) and `VaultIndexService` without building a second index. Added `OrgGraphAdapter` (`buildOrgGraph`, `buildLocalOrgGraph`, `diffOrgGraphs`, filtering/color groups), `OrgGlobalGraphView`, `OrgLocalGraphView`, `OrgReaderFocusBus`, and `LocalGraphController`.
3. **Three Semantic Relation Types & Parallel Edge Separation**: Cleanly distinguishes **reference** (`[[id:...]]`, solid directional edge), **transclusion** (`#+TRANSCLUDE:`, dashed curved edge), and **structural** (dotted containment/hierarchy edge, hidden by default), plus parallel-edge separation, orphan node toggles, unresolved target placeholders, and duplicate `:ID:` badges.
4. **Real Desktop Obsidian Electron GUI Validation (`PASS 12/12`)**: Verified `G1`–`G12` live against isolated `test-vault/` via Chrome DevTools Protocol (`scripts/qa-cdp-sprint04.mjs --port 9222 --expect-vault test-vault --screenshots --close-browser`) with **`0` `pageErrors` and `0` `consoleErrors`**, and visually inspected all `7` captured Light/Dark screenshots.
5. **Large-Scale Graph Performance (`100` / `1,000` / `5,000` Nodes)**: Benchmarked graph extraction, incremental diffing, warm-start layout preservation, and `d3-quadtree` spatial hit-testing via `scripts/bench-graph.mjs` (plus `12` QA tests in `tests/qa/sprint04-graph-qa.test.ts`).

---

## 2. Architecture & Ownership Summary

| Module | Purpose |
|---|---|
| `src/core/graph/` (`graphAdapter.ts`, `graphFilter.ts`, `localGraph.ts`, `types.ts`) | Maps `OrgIdIndex` into Node/File graphs, builds BFS `1/2/3`-hop local subgraphs, diffs graph updates incrementally, and evaluates search queries, filters, and color groups. |
| `src/views/graph/` (`simulation.ts`, `canvasRenderer.ts`, `graphControls.ts`, `OrgGraphBaseView.ts`, `OrgGlobalGraphView.ts`, `OrgLocalGraphView.ts`, `localGraphController.ts`, `readerFocusBus.ts`, `index.ts`) | `d3-force` simulation (`positionVersion` tracking), HiDPI Canvas2D + `d3-quadtree` hit-testing, hover popover & inspector card, sliders/filters/groups HUD, and bidirectional Reader ↔ Local Graph focus synchronization with Lock & scroll-jitter guards. |
| `src/views/OrgView.ts`, `src/views/editor/orgEditor.ts`, `src/core/index/vaultIndexService.ts` | Emits active reading/cursor node focus updates to `OrgReaderFocusBus` and applies `.org-heading-jump-highlight` on Graph → Reader navigation while keeping Graph panes intact. |

---

## 3. Real Obsidian Electron GUI Validation (`PASS 12/12`)

**Command:**
```bash
node scripts/qa-cdp-sprint04.mjs --port 9222 --expect-vault test-vault --screenshots --close-browser
```

Executed in an isolated temporary Electron profile (`app.vault.getName() === "test-vault"`, zero access to user vaults or Emacs configs). All `12` checks reported **`PASS`** (`pageErrors: []`, `consoleErrors: []`).

| Check | Title | Status | Verified Runtime Evidence (Live Electron `test-vault`) |
|---|---|---|---|
| `G1` | Global Graph opens with Canvas2D render (Node/File & Dark/Light) | `PASS` | Dark Node mode rendered `nodeCount: 19`, `edgeCount: 27` (`transclusionEdges: 12`), `hasHub: true`, `hasOrphan: true`, canvas `1592x1684` (`nonZeroPixels: 10392`); Light theme flipped cleanly (`themeFlippedLight: true`); File mode rendered `nodeCount: 7`, `edgeCount: 13`, `hasFile07: true`. |
| `G2` | Local Graph opens, switches depth 1/2/3 & incoming/outgoing, shows hover/inspector | `PASS` | Depth counts scaled cleanly (`d1: 4`, `d2: 10`, `d3: 14`); direction filters toggled (`bothCount: 4`, `outgoingOnlyCount: 2`, `incomingOnlyCount: 3`); hovering `id:graph-layer-core` hit `org-graph-canvas` and displayed both `.org-graph-inspector-card` and `.org-graph-hover-popover` (`status: "found"`, `popoverScripts: 0`). |
| `G3` | Graph → Reader jump opens target file, preserves Graph leaves & highlights heading | `PASS` | Clicking `id:vla-memory-overview` navigated to `03-vla-memory-notes.org`, kept `globalLeaves: 1` and `localLeaves: 1` open, and highlighted `TODO [#A] Embodied Memory for Vision-Language-Action Models #vla#reading`. |
| `G4` | Reader heading/file switches auto-follow in Local Graph with zero scroll jitter | `PASS` | Switching active headings focused `id:graph-layer-core` → `id:graph-layer-composer`, held `afterScroll: "id:graph-layer-composer"` on viewport scroll, and followed file switches to `03-vla-memory-notes.org` (`id:vla-memory-overview`). |
| `G5` | Local Graph Lock button freezes focus across Reader switches | `PASS` | Toggling Lock pressed (`pressed: "true"`, `followReader: false`, `lockedNodeId: "id:vla-memory-overview"`) froze center node across reader file switch, and unlocking restored auto-follow (`followAfterUnlock: true`). |
| `G6` | Incremental `[[id:...]]` edit updates edges cleanly while keeping node coordinates | `PASS` | Adding a reference edge updated `hasRefEdge: true` incrementally with warm restart (`alpha: 0.09407099651904796`, node coordinate drift `32.032571137387215` px instead of full graph explosion). |
| `G7` | Incremental `#+TRANSCLUDE:` adds distinct transclusion edge & parallel slot | `PASS` | Co-existing `[[id:...]]` and `#+TRANSCLUDE:` between the same pair rendered `pairKinds: ["reference", "transclusion"]` with `parallelCounts: [2, 2]` and `parallelIndices: [0, 1]`. |
| `G8` | Cross-file `:ID:` move preserves canonical `id:<orgId>` & updates `filePath` | `PASS` | Moving `:ID:` to `99-qa-graph-scratch-c.org` kept canonical node ID `id:qa-graph-scratch-b`, updated `filePath`, and preserved incoming reference (`hasIncomingRef: true`). |
| `G9` | Duplicate ID & `showUnresolved` toggle render cleanly with zero crash | `PASS` | Duplicate badge (`duplicateCount: 2`, `dupBadge: true`) and unresolved node (`hasMissing404: true`, `unresBadge: true`) displayed cleanly and hid when unchecked (`afterUncheck: false`). |
| `G10` | Multi-pane Global+Local+OrgView, Search, Color Groups & Dark/Light themes | `PASS` | Co-hosted `globalLeaves: 1`, `localLeaves: 1`, `orgLeaves: 1`; search narrowed cleanly to `searchCount: 2` (`searchMatchesLeaf: true`) and restored `19` nodes; color groups styled `#7c3aed` & `#0ea5e9` (`controlsOpen: true`); Dark/Light themes toggled cleanly. |
| `G11` | Strict SHA-256 zero disk mutation across `01`..`07` corpus files | `PASS` | Checked all `7` files (`checkedFiles: 7`, `diffs: []`). |
| `G12` | Plugin disable/re-enable stability & zero `pageErrors`/`consoleErrors` | `PASS` | Disabling and re-enabling restored `OrgGlobalGraphView` (`enabled: true`, `hasGraphHandle: true`, `reopenedNodes: 19`) with `pageErrors: []` and `consoleErrors: []`. |

### Saved Visual Screenshots (Visually Inspected)

All `7` captures reside under `tests/qa/screenshots/` (gitignored binaries) and were visually verified:

- `s4-global-node-dark.png` — Global Node Graph (Dark theme, `19` nodes, `27` edges, dashed purple transclusion arcs, amber duplicate rings, isolated orphan node)
- `s4-global-node-light.png` — Global Node Graph (Light theme contrast & crisp labels)
- `s4-global-file-dark.png` — Global File Graph (`7` file nodes, `13` inter-file edges)
- `s4-local-sync-dark.png` — Right-sidebar Local Graph synced to `Org Knowledge Graph Showcase Hub` (`1/2/3` hops, Lock toggle)
- `s4-local-hover-inspector.png` — Floating `.org-graph-hover-popover` and `.org-graph-inspector-card` both visible and unclipped
- `s4-controls-groups-dark.png` — Expanded Global Graph controls drawer (`tag:#graph` / `tag:#memory` color groups, centered slider thumbs)
- `s4-graph-to-reader-jump.png` — Graph → Reader navigation into `03-vla-memory-notes.org` with `.org-heading-jump-highlight` and preserved Global + Local Graph panes

---

## 4. Bug Fixes Grounded in Live CDP Inspection

1. **Quadtree Invalidation After `simulation.step()` (`src/views/graph/simulation.ts`, `src/views/graph/canvasRenderer.ts`, `tests/graphRenderer.test.ts`)**:
   - *Root Cause*: Calling `simulation.step()` mutated node `x`/`y` coordinates without changing edge counts or bumping a quadtree version, causing `OrgGraphCanvasRenderer.ensureQuadtree()` to return stale coordinates on `hitTest()` during `G2`/`G3`.
   - *Fix*: Added monotonically increasing `positionVersion` / `getPositionVersion()` on `OrgGraphSimulation` (incremented in `setGraph`, `warmUp`, `stepFrame`, `step`, and `dragTo`), wired it into `OrgGraphCanvasRenderer` (`lastQuadtreeVersion` check inside `ensureQuadtree()`), and increased `fitToView(padding = 64)` (`OrgGraphCanvasRenderer.ts` & `OrgGraphBaseView.ts`). Added regression unit coverage in `tests/graphRenderer.test.ts`.
2. **Range Slider Thumb Vertical Centering (`src/views/graph/graph.css`, `styles.css`)**:
   - *Fix*: Aligned `.org-graph-slider-input` height, margins, `vertical-align`, and `accent-color` so slider thumbs sit cleanly inside Obsidian's controls drawer (`s4-controls-groups-dark.png`).
3. **CDP Test Timing & Persisted Granularity Reset (`scripts/qa-cdp-sprint04.mjs`)**:
   - *Fix*: Reset persisted `graphGlobalState` / `graphLocalState` cleanly prior to plugin reload, awaited Obsidian `ResizeObserver` layout settlement after `revealLeaf()` before centering coordinates, scanned the full canvas bitmap in `G1`, and switched `G2` hover probe to two-step mouse `pointermove` + popover readiness wait.
4. **Custom Sidebar Icons, Collision-Free Labels, `forceCollide` & Redesigned Sliders**:
   - *Icons (`src/views/icons.ts`)*: Added distinct Lucide-weight custom SVG icons (`org-native-graph`, `org-native-local-graph`, `org-native-backlinks`) via Obsidian's `addIcon()` API.
   - *Label Overlap & Hover Polish (`canvasRenderer.ts`, `simulation.ts`)*: Removed the `< 12` collision bypass, added CJK-aware pixel measurement + 4-slot smart label placement (`below`/`above`/`right`/`left`) + node-circle obstacle avoidance + pill backdrop for emphasized labels, added `d3-force` `forceCollide` (disabled at `>= 2500` nodes) and 60fps hover scale/dimming easing.
   - *Controls Drawer & Precision Sliders (`graphControls.ts`, `OrgGraphBaseView.ts`, `graph.css`, `styles.css`)*: Upgraded to collapsible `<details>` sections, panel header with Restore Defaults (`rotate-ccw`) & close button, high-specificity full-width `--slider-pct` filled tracks with `14px` circular thumbs eliminating Obsidian default slider overlap, and double-click per-slider reset.

---

## 5. Synthetic Graph Scalability Benchmarks (`scripts/bench-graph.mjs`)

Measured via `node scripts/bench-graph.mjs --json` on **Node `v26.4.0` (`darwin/arm64`, 10 CPUs — `Apple M5`)**:

| Scale | Corpus Size | `buildOrgGraph` (Node) | `buildOrgGraph` (File) | `buildLocalOrgGraph` (D1 / D2 / D3 warm) | `diffOrgGraphs` | `OrgGraphSimulation` WarmUp | Incremental `setGraph` + Tick | `d3-quadtree` Build + 100 HitTests |
|---|---|---|---|---|---|---|---|---|
| **100 nodes** | `10` files, `100` nodes, `220` Node-edges (`20` transclude), `30` File-edges | cold `6.87 ms`, warm `0.375 ms`, p95 `0.851 ms` (heap `+0.55 MB`, rss `+2.53 MB`) | cold `0.781 ms`, warm `0.128 ms`, p95 `0.341 ms` (heap `+0.17 MB`, rss `+0.36 MB`) | `0.032 ms` (`7n/6e`) / `0.086 ms` (`25n/29e`) / `0.391 ms` (`55n/87e`) | cold `0.271 ms`, warm `0.082 ms` (`+6` edges, `16` updated) | `70` ticks: cold `14.065 ms`, warm `9.108 ms`, p95 `10.503 ms` (`alpha=0.116`) | cold `0.414 ms`, warm `0.189 ms` (`alpha=0.14`, drift `3.58 px`) | cold `0.615 ms`, warm `0.111 ms` (`hits=100/100`) |
| **1,000 nodes** | `50` files, `1,000` nodes, `2,200` Node-edges (`200` transclude), `150` File-edges | cold `3.734 ms`, warm `2.68 ms`, p95 `2.979 ms` (heap `-2.14 MB`, rss `+0.98 MB`) | cold `0.633 ms`, warm `0.745 ms`, p95 `0.946 ms` (heap `+1 MB`, rss `+0.59 MB`) | `0.024 ms` (`7n/6e`) / `0.074 ms` (`25n/29e`) / `0.3 ms` (`61n/81e`) | cold `0.589 ms`, warm `0.502 ms` (`+11` edges, `31` updated) | `45` ticks: cold `94.285 ms`, warm `81.982 ms`, p95 `89.619 ms` (`alpha=0.237`) | cold `2.136 ms`, warm `2.194 ms` (`alpha=0.14`, drift `4.45 px`) | cold `0.191 ms`, warm `0.17 ms` (`hits=100/100`) |
| **5,000 nodes** | `200` files, `5,000` nodes, `11,000` Node-edges (`1,000` transclude), `600` File-edges | cold `17.266 ms`, warm `14.519 ms`, p95 `15.969 ms` (heap `-4.77 MB`, rss `+7.02 MB`) | cold `5.265 ms`, warm `3.167 ms`, p95 `5.229 ms` (heap `+4.76 MB`, rss `+2.34 MB`) | `0.078 ms` (`7n/6e`) / `0.211 ms` (`25n/29e`) / `0.165 ms` (`61n/81e`) | cold `4.255 ms`, warm `1.804 ms` (`+14` edges, `39` updated) | `24` ticks: cold `328.311 ms`, warm `317.631 ms`, p95 `332.869 ms` (heap `+30.44 MB`, rss `+18.48 MB`, `alpha=0.430`) | cold `14.293 ms`, warm `14.202 ms`, p95 `14.843 ms` (heap `+4.88 MB`, rss `+1.89 MB`, `alpha=0.14`, drift `31.14 px`) | cold `1.037 ms`, warm `0.804 ms`, p95 `0.853 ms` (heap `+2.65 MB`, `hits=100/100`) |

---

## 6. Final Release Verification

Verified on `main` after all code, version bump (`0.3.0-beta.1`), and documentation updates:

- `npm run check` (`tsc --noEmit`): exit code `0`
- `npm test` (`vitest run`): **`15` test files passed, `134/134` tests passed** (`0` failed, `0` skipped)
- `npm run build`: clean production `main.js` bundle via `esbuild`
- `npm run deploy:test-vault`: deployed cleanly into `test-vault/.obsidian/plugins/org-native/`
