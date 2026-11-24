# Roadmap

## Sprint 01 Alpha (Delivered — `v0.1.0-alpha.1`)

- [x] Upstream audit & baseline verification (`RESEARCH.md`, `BASELINE.md`, `THIRD_PARTY_NOTICES.md`)
- [x] Modular architecture (`core/model`, `core/parser`, `core/index`, `core/safety`, `core/transclusion`, `views/reading`, `views/editor`)
- [x] Native `.org` registration with **Reading / Live Preview / Source** modes
- [x] Nested Reading View `<section>` folding & CM6 subtree/block/drawer folding (`overview` / `content` / `all`, `#+STARTUP:`)
- [x] Property Drawer collapsed by default with expandable raw `:PROPERTIES:` view
- [x] Incremental Vault `OrgIdIndex`, cross-file `[[id:...]]` jump, duplicate-ID & broken-link diagnostics
- [x] `FileSyncGuard` external-edit conflict protection & CRLF line-ending preservation
- [x] Automated unit, DOM, CM6 folding, and data-safety regression test suite + isolated `test-vault/`

---

## Sprint 02 Alpha (Delivered — `v0.2.0-alpha.1`)

- [x] **Reading & Editing UX (`feat/reading-ux`)**: Refined H1–H6 typography hierarchy, configurable reading column width / line height / font scale / CJK+Latin layout, copy-code controls, enhanced fold indicators, responsive split panes, and Live Preview cursor/syntax polish.
- [x] **Backlinks & Node Navigation (`feat/node-navigation`)**: Dedicated Org Backlinks sidebar panel (`OrgBacklinksView`), Quick Open Org Node fuzzy switcher (`OrgNodeSwitcherModal`), HTML-escaped Hover Preview popover (`attachNodeHoverPreview`), heading breadcrumbs, node-move stability, and enriched diagnostics.
- [x] **Clean-Room Read-Only `#+transclude:` Expansion (`feat/transclusion`)**: `OrgTransclusionEngine` + Reading View DOM hydration supporting `[[id:...]]`, in-vault `[[file:...]]`, `::*Heading`, `::#custom-id`, `::name` / `<<target>>`, `:level`, bare `:level`, `:only-contents`, `:exclude-elements`, `:lines`, cycle/depth/budget/security guards, explicit warnings on unsupported options, and live refresh on referenced source file edits.
- [x] **QA Harness & Data-Safety Regression Suite (`test/gui-regression`)**: Isolated `test-vault/` manual GUI smoke checklist (`NOT_VERIFIED`), vault-guarded CDP smoke script (`scripts/qa-cdp-smoke.mjs`), `06-transclusion-demo.org` showcase note, and Sprint 02 data-safety + integrated E2E tests.

---

## Sprint 03 Beta (Delivered — `v0.2.0-beta.1`)

- [x] **Real Obsidian Electron GUI Sign-Off (`PASS 12/12`)**: Executed full live Electron CDP verification (`scripts/qa-cdp-sprint03.mjs`) against isolated `test-vault/` across Light & Dark themes, 390px narrow panes, MathJax/Prism/aligned tables/local SVG, Hover Preview, Backlinks, Quick Open, Diagnostics, 4-level Transclusion, CRLF edit round-trips, Emacs external conflict banners, multi-pane same-file splits, and plugin reload lifecycle with `0` page/console errors ([tests/qa/GUI_SMOKE_TEST_CHECKLIST.md](tests/qa/GUI_SMOKE_TEST_CHECKLIST.md)).
- [x] **Reading & CJK UX Refinement**: Full-width CJK punctuation support around inline code/emphasis (`2ce8b76`), Hover Preview multi-line title clipping fix (`6b9a0d6`), softened `.org-transclusion` surface blend, synchronized `.org-transclusion-readonly-badge`, and 3-line backlink context clamp.
- [x] **Data Integrity & Lifecycle Hardening**: Added `VaultIndexService.dispose()`, `TransclusionRefreshController.reset()`, dependency-filtered `OrgView` index refresh, and `14`-test concurrency/reliability stress suite ([tests/qa/sprint03-reliability.test.ts](tests/qa/sprint03-reliability.test.ts)).
- [x] **Synthetic Scale & Performance Benchmarks**: Benchmarked `100` / `1,000` / `5,000` synthetic nodes, ~3,000-line academic papers, ~2,500-line CJK documents, and 20-slot + 4-level transclusion chains ([scripts/bench-synthetic.mjs](scripts/bench-synthetic.mjs), [tests/qa/sprint03-perf.test.ts](tests/qa/sprint03-perf.test.ts)).

---

## Sprint 04 Beta (Delivered — `v0.3.0-beta.1`)

- [x] **Built-in Org Knowledge Graph (`d3-force` + `d3-quadtree` + HiDPI Canvas2D)**: Pure MIT/ISC engine ([docs/GRAPH_ENGINE_EVALUATION.md](docs/GRAPH_ENGINE_EVALUATION.md)) built strictly on official Obsidian `ItemView`/`Workspace` APIs, reusing `OrgIdIndex` as the single source of truth with zero writes to `.org` files.
- [x] **Global Org Graph (`feat/graph-data`, `feat/graph-ui`)**: Heading-level (`id:<orgId>`) Node Graph and `.org` File Graph granularities; distinct `reference` (solid arrow), `transclusion` (dashed curve), and `structural` (dotted, hidden by default) edges with parallel-edge separation; search queries (`tag:`, `file:`, `path:`, `todo:`, `id:`, text), tag/folder/property filters, orphan & unresolved toggles, duplicate `:ID:` rings, color groups, physics/display sliders, Dark & Light themes, and persisted state.
- [x] **Local Graph & Reader Bidirectional Sync (`feat/graph-local-sync`)**: Depth `1/2/3` hops, incoming/outgoing toggles, auto-follow on Reader heading click, cursor move, and file switch with scroll-jitter suppression, Lock focus toggle, HTML-escaped Hover Popover + Inspector card, and Graph → Reader jump preserving Graph panes with `.org-heading-jump-highlight`.
- [x] **Real Obsidian Electron GUI Validation (`PASS 12/12`)**: Verified `G1`–`G12` end-to-end against isolated `test-vault/` via live Electron CDP (`scripts/qa-cdp-sprint04.mjs`) with `0` page/console errors and `7` visually verified screenshots ([SPRINT_04_REPORT.md](SPRINT_04_REPORT.md)).
- [x] **Graph Scale Optimization & Benchmarks**: Benchmarked incremental diffing, warm-start stabilization, and `d3-quadtree` hit-testing at `100`, `1,000`, and `5,000` synthetic Org nodes ([scripts/bench-graph.mjs](scripts/bench-graph.mjs), [tests/qa/sprint04-graph-qa.test.ts](tests/qa/sprint04-graph-qa.test.ts)).

---

## Phase 5: Future Ecosystem & UX Candidates

- [ ] **Live Preview `#+transclude:` Inline Cards**: Optional hover card or read-only widget preview when hovering/moving near `#+transclude:` directives in Live Preview.
- [ ] **Incremental / Viewport-Paged Reading Rendering for Ultra-Long Documents (>5,000 lines)**: Chunked section hydration or idle scheduling if documents exceed ~3,000–5,000 lines with heavy math/tables.
- [ ] **Configurable Callout Cards / Visual Presets**: Custom reading styles (callout blocks, theme presets) purely in `views/reading` and CSS without altering `.org` source syntax.
- [ ] **Extension Seams (Out of Scope for Reading Layer Core)**: Clean plugin hooks on `OrgSectionTree` and `OrgIdIndex` for external exporters or node composers.
