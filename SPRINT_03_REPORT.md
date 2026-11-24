# Org Native for Obsidian — Sprint 03 Report (`v0.2.0-beta.1`)

**Date:** 2026-11-25  
**Version:** `0.2.0-beta.1` (upgraded from `v0.2.0-alpha.1` / `5978e6e`)  
**Scope:** Real Obsidian Electron GUI Validation, Reading & Editing UX Polish, Data Integrity & Concurrency Hardening, Lifecycle Bug Fixes, and Synthetic Scale Benchmarks.

---

## 1. Executive Summary

Sprint 03 promoted `Org Native for Obsidian` from an automated Alpha build (`v0.2.0-alpha.1`) to a real-GUI-verified Beta candidate (`v0.2.0-beta.1`):

1. **Real Desktop Obsidian Electron GUI Validation (`PASS 12/12`)**: Executed all `12` end-to-end checks (`C1`–`C12`) against isolated `test-vault/` via live Obsidian Electron Chrome DevTools Protocol (`scripts/qa-cdp-sprint03.mjs --port 9222 --expect-vault test-vault --screenshots --close-browser`), with **`0` `pageErrors` and `0` `consoleErrors`**, and visually inspected all `11` captured Light/Dark/split-pane PNG screenshots under `tests/qa/screenshots/`.
2. **Reading & Editing UX Fixes Grounded in Real Electron Rendering**: Fixed full-width CJK punctuation boundary matching around inline formatting (`2ce8b76`), fixed Hover Preview button title clipping on both edges (`6b9a0d6`), softened transclusion visual surface blending, synchronized `.org-transclusion-readonly-badge`, and clamped backlink context snippets to 3 lines.
3. **Runtime Lifecycle & Reliability Hardening (`f791f64`, `f458bf1`)**: Fixed `VaultIndexService.dispose()`, `TransclusionRefreshController.reset()`, DOM/vault-listener cleanup across reopen, and dependency-filtered `OrgView` refresh; added `14` stress & concurrency regression tests in `tests/qa/sprint03-reliability.test.ts`.
4. **Synthetic Performance & Scalability Benchmarks (`4727775`)**: Measured cold/warm latencies and memory deltas up to **`5,000` synthetic Org nodes (`200` files / `54,600` lines / `15,000` links)**, **`~3,000`-line** academic papers, **`~2,500`-line** CJK documents, and **20-slot + 4-level transclusion** chains via `scripts/bench-synthetic.mjs` and `tests/qa/sprint03-perf.test.ts` (`7` tests). Zero real user notes were accessed.

---

## 2. Environment Isolation & Safety Audit

The GUI checks ran in a dedicated Electron profile with the repository's `test-vault/`. The script checked the vault name and path before running the suite. The QA session closed with `--close-browser`, and its temporary profile was removed afterward.

---

## 3. Real Obsidian Electron GUI Validation (`PASS 12/12`)

**Command:**
```bash
node scripts/qa-cdp-sprint03.mjs --port 9222 --expect-vault test-vault --screenshots --close-browser
```

All `12` live Electron checks reported **`PASS`** (`pageErrors: []`, `consoleErrors: []`). Full checklist status updates are recorded in [tests/qa/GUI_SMOKE_TEST_CHECKLIST.md](tests/qa/GUI_SMOKE_TEST_CHECKLIST.md).

| CDP Check | Checklist Mapping | Status | Verified Runtime Evidence (Live Electron `test-vault`) |
|---|---|---|---|
| `C1` | `P0-1` | `PASS` | Opened, closed, and reopened all `6` sample `.org` files (`01`–`06`) inside `org-native-view`; `hashesMatch: true` (SHA-256 unchanged). |
| `C2` | `P0-2` | `PASS` | `3` mode transitions (`Reading -> Live Preview -> Source -> Reading`) + header toolbar toggles; `dirty: false` throughout. |
| `C3` | `P0-3` | `PASS` | Folding chevrons toggled cleanly (`beforeExpanded: "true"` -> `afterExpanded: "false"`), `preservedFolded: true` across mode switches, `#+STARTUP: content` collapsed `3/3` sections (`dirty: false`). |
| `C4` | `P0-4` | `PASS` | MathJax rendered (`mjxCount: 4`, `priceEscapedCorrectly: true`), Prism highlighted (`prismTokens: 41`, `copyBtns: 3`), aligned table rendered `20` cells, local SVG `assets/org-native-architecture.svg` loaded (`720x220`, `complete: true`), Property Drawer collapsed on open & toggled cleanly with raw view, footnote superscript/definition rendered (`1`/`1`). |
| `C5` | `P0-7`, `S2-5` | `PASS` | Dark (`rgb(28, 28, 28)` bg) & Light (`rgb(255, 255, 255)` bg) theme switch; `readingWidth: "normal"`, `readingLineHeight: "comfortable"`, `cjkTypography: "true"`, `lineBreak: "strict"`; 390px narrow split pane reported `scrollWidth: 307 === clientWidth: 307` (`overflowXZero: true`). |
| `C6` | `P0-5` | `PASS` | Clicking `[[id:vla-memory-overview]]` in `01-welcome-and-reading.org` navigated cleanly to `03-vla-memory-notes.org`. |
| `C7` | `P0-5`, `S2-1`, `S2-2`, `S2-3` | `PASS` | Backlinks sidebar showed `10` incoming references (`5 transclude`, `5 link`); Hover Popover rendered on `a.org-link-id` (`status: "found"`, `textLen: 266`, `scriptCount: 0`); Quick Open listed `11` nodes (`leaksFakeId: false`); Diagnostics modal flagged `demo-duplicate-id`, `missing-demo-404`, and `missing-transclude-404` (`leaksFakeId: false`, `remainingModals: 0`). |
| `C8` | `S2-4` | `PASS` | Expanded all `16` transclusion slots on `06-transclusion-demo.org` (`remainingSlots: 0`, `readonlyBadges: 16`, `sourceLinks: 12`), respecting `:level`, `:only-contents`, `:lines`, `:exclude-elements`. |
| `C9` | `S2-4` | `PASS` | Nested `5` inner transclusions cleanly; flagged `3` cycle guards, `1` missing ID error, and `1` unsupported option warning; left directives inside `#+BEGIN_SRC` untouched (`hasCodeRaw: true`). |
| `C10` | `P0-6` | `PASS` | Real edit, save, close, and reopen preserved CRLF endings, `:ID:`, `:PROPERTIES:`, and unknown Org blocks byte-for-byte (`exactRoundTripCrlf: true`). |
| `C11` | `P0-6` | `PASS` | Clean buffer silently reloaded external disk edit (`reloaded: true`); dirty buffer raised `.org-conflict-banner` (`bannerVisible: true`), left disk untouched until choice, and saved unique `.conflict-*.org` copy cleanly (`hasEmacsV3: true`). |
| `C12` | `P0-7` | `PASS` | Multi-pane same-file split (`["reading", "live"]`) remained functional after closing one pane; disabling and re-enabling `org-native` restored `org-native-view` cleanly with `0` console/page errors. |

### Saved Visual Screenshots (Visually Inspected)

All screenshots reside locally under `tests/qa/screenshots/` (gitignored binaries):

- `s3-01-welcome-dark.png` & `s3-01-welcome-light.png` — Dark & Light Reading View + Core Outline on `01-welcome-and-reading.org`
- `s3-01-live-preview.png` & `s3-01-source-mode.png` — Cursor-aware Live Preview syntax hiding & raw Source mode
- `s3-01-narrow-split.png` — Light 390px narrow split pane verifying CJK wrapping & zero horizontal overflow
- `s3-02-math-code-table-img.png` & `s3-02-table-and-image.png` — MathJax, `$5`/`$12` price guard, Prism, `<l>/<c>/<r>` table alignment, & local SVG diagram
- `s3-04-backlinks-hover.png` — Backlinks sidebar + unclipped multi-line Hover Popover title
- `s3-06-transclusion-dark.png` & `s3-06-transclusion-light.png` — Dark & Light read-only `#+transclude:` cards, cycle/missing warnings, & source links
- `s3-conflict-banner.png` — Dirty local edit vs external Emacs conflict banner (`Reload`, `Keep local & save`, `Save local conflict copy`)

---

## 4. Reading & Editing UX Improvements (Grounded in Live GUI Inspection)

1. **Full-Width CJK Punctuation Around Inline Markup (`2ce8b76`)**:
   - *Before (observed in initial GUI run)*: Strings such as `（=Reading= / =Live Preview= / =Source=）` or `*强调*` adjacent to `（`, `）`, `《`, `》`, `「`, `」`, `『`, `』`, `【`, `】`, `‘`, `’`, `“`, `”`, `…` failed to parse as inline code/emphasis when inside full-width punctuation pairs.
   - *After*: Expanded allowed pre/post inline emphasis and code boundary regexes in `src/core/parser/inline.ts` (lines 43 and 183); added regression coverage in `tests/parser.test.ts` and converted stray Markdown backticks/`**bold**` in `test-vault/06-transclusion-demo.org` to pure Org syntax.
2. **Hover Preview Title Unclipping (`6b9a0d6`)**:
   - *Before (diagnosed directly from `s3-04-backlinks-hover.png`)*: Obsidian's default `<button>` Flexbox centering caused long node titles (`Embodied Memory for Vision-Language-Action Models`) inside `.org-node-hover-title-btn` to clip asymmetrically/on both edges.
   - *After*: Set `.org-node-hover-title-btn` to `display: block; height: auto; justify-content: flex-start; white-space: normal; overflow-wrap: anywhere;` and refined `.org-node-hover-popover` shadow and width across `src/views/nodes/nodes.css` and `styles.css`. Re-verified cleanly in re-captured `s3-04-backlinks-hover.png`.
3. **Transclusion Surface Blend & Backlink Snippets (`6b9a0d6`)**:
   - Softened `.org-transclusion` background & left accent border in `src/views/transclusion/transclusion.css` and `styles.css` so embedded content integrates smoothly with host prose in both Dark and Light themes (`s3-06-transclusion-dark.png`, `s3-06-transclusion-light.png`).
   - Added `.org-transclusion-readonly-badge` alongside `.org-transclusion-badge` in `src/views/transclusion/renderTransclusion.ts`.
   - Clamped `.org-backlinks-context` previews to 3 lines in `src/views/nodes/nodes.css`.

---

## 5. Bug Fix Ledger

| Bug | Symptom / Root Cause | Commit | Verification |
|---|---|---|---|
| **QA Asset & `.obsidian` Noise** | `02-math-code-and-tables.org` lacked an in-vault diagram asset; Electron runtime files inside `test-vault/.obsidian/` polluted git status. | `e40de79` | Added `test-vault/assets/org-native-architecture.svg`, updated `.gitignore`, verified via `C4` (`complete: true`). |
| **CJK Full-Width Punctuation Inline Parsing** | `（=Reading= / ...）` failed to tokenize inside `src/core/parser/inline.ts` boundary regexes; `06-transclusion-demo.org` contained minor Markdown syntax. | `2ce8b76` | `tests/parser.test.ts` regression case + visually verified in `s3-01-live-preview.png` and `s3-06-transclusion-dark.png`. |
| **Hover Popover Title Clipping & Readonly Class** | Obsidian native `<button>` styling clipped `.org-node-hover-title-btn`; `.org-transclusion-readonly-badge` omitted on transclusion badges. | `6b9a0d6` | Visually verified in `s3-04-backlinks-hover.png` and `C8`/`C9` (`readonlyBadges: 16`). |
| **Lifecycle Leaks, Stale Controller & Over-Refreshing** | `VaultIndexService` lacked `dispose()`; `OrgView` did not reset `TransclusionRefreshController`, detach `vault.offref` handles, or abort in-flight hydrations on view close/reopen/mode switch; unrelated `.org` edits triggered redundant Reading View re-renders. | `f791f64` | Added `VaultIndexService.dispose()`, `TransclusionRefreshController.reset()`, `cleanupRuntimeHandles()`, `shouldRefreshForIndexEvent()`; verified in `tests/qa/sprint02-regression.test.ts`, `tests/qa/sprint03-reliability.test.ts`, and `C12`. |
| **Stale Modal Across Live CDP Sessions** | `scripts/qa-cdp-sprint03.mjs` defined `closeAllModals()` only inside Check `C7`, allowing leftover modals from interrupted prior sessions to obscure `s3-01-live-preview.png` and `s3-01-narrow-split.png`. | Post-`d4eba3c` Sprint 03 commit | Hoisted multi-attempt `closeAllModals()` above `C1`, re-ran CDP (`12/12 PASS`), and visually confirmed clean re-captured PNGs. |

---

## 6. Data Integrity & Concurrency Verification (`14` New Stress Tests)

Implemented in `tests/qa/sprint03-reliability.test.ts` (`f458bf1`, merged in `ed34fb1`):

- **External Edit vs Dirty Buffer Storms**: Rapid consecutive external modifications while conflicted never clobber local memory or disk; resolving via `Reload`, `Keep local`, or `Save local conflict copy` clears state properly, generating unique `.conflict-*.org` filenames even within the same second.
- **Multi-Pane Same-File Editing**: Syncs clean edits between Leaf A and Leaf B, raises conflict protection when Leaf B is dirty, maintains independent fold snapshots per pane, and survives closing Leaf A cleanly.
- **Large File Incremental Indexing & Cross-File Node Moves**: Accurate add/move/modify/delete updates plus `contentHash`/stat skip across 1,200+ lines & 100 `:ID:` headings; `resolveId`, `getBacklinks`, and `navigateToId` survive multi-hop file renames and node migrations.
- **Transclusion Refresh, Depth Cap & Diamond DAG**: Re-hydrates only when dependent `id:`/`file:` targets change, ignores unrelated `vault.modify` events, supports `transclusionMaxDepth=8` while blocking depth `9`, expands diamond DAG reuse without false-positive cycles, and blocks 3-node cycles cleanly.
- **Mount/Dispose Churn & Abrupt Close Recovery**: Cleans up hover popovers, views, and listeners across repeated `registerNodeNavigation` / `OrgView` teardown cycles; abrupt close or failed save preserves exact disk bytes and clean `FileSyncGuard` state on reopen.

---

## 7. Synthetic Performance & Scalability Benchmarks

Measured on **Node `v26.4.0` (`darwin/arm64`, 10x Apple M5)** using synthetic in-memory corpora via `node scripts/bench-synthetic.mjs --json` (plus `7` regression gate tests in `tests/qa/sprint03-perf.test.ts` using `happy-dom` where DOM rendering applies). Zero personal notes were used.

| Benchmark Scenario | Workload Detail | Cold (ms) | Warm Avg (ms) | Warm P95 (ms) | Heap Delta | RSS Delta |
|---|---|---|---|---|---|---|
| `OrgIdIndex build` (100 nodes / 10 files) | 1,110 lines, 300 links, 0 errors | `5.722` | `1.122` | `2.684` | `+3.32 MB` | `+2.53 MB` |
| `OrgIdIndex build` (1,000 nodes / 50 files) | 10,950 lines, 3,000 links, 0 errors | `11.547` | `10.412` | `12.194` | `+1.68 MB` | `+2.56 MB` |
| `OrgIdIndex build` (5,000 nodes / 200 files) | 54,600 lines, 15,000 links, 0 errors | `53.327` | `46.627` | `50.003` | `+19.19 MB` | `+38.33 MB` |
| `upsertFile` (1 file on 5,000-node index) | 25 affected nodes, incremental | `0.307` | `0.190` | `0.930` | `+0.45 MB` | `+0.00 MB` |
| `searchNodes("alpha")` (5,000 nodes) | 400 matches | `6.103` | `0.869` | `0.948` | `+2.44 MB` | `+1.94 MB` |
| `getBacklinksForFile` (5,000 nodes) | `corpus-000.org` (25 nodes, 5,025 backlinks) | `0.372` | `0.127` | `0.139` | `+0.11 MB` | `+0.00 MB` |
| `parseOrgDoc + buildSectionTree` (Normal note) | 87 lines, 7 sections | `0.094` | `0.030` | `0.036` | `+0.08 MB` | `+0.00 MB` |
| `renderOrgPreview` (Normal note) | 87 lines, 7 `.org-section` | `10.116` | `3.143` | `5.358` | `+6.95 MB` | `+0.16 MB` |
| `parseOrgDoc + buildSectionTree` (Paper) | 3,000 lines, 211 sections | `4.824` | `1.114` | `2.615` | `-5.41 MB` | `+12.63 MB` |
| `renderOrgPreview` (Academic paper) | 3,000 lines, 211 `.org-section` | `77.065` | `75.246` | `88.167` | `+62.70 MB` | `+60.92 MB` |
| `parseOrgDoc + buildSectionTree` (Chinese doc) | 2,500 lines, 129 sections | `3.923` | `0.966` | `3.149` | `+2.63 MB` | `+0.28 MB` |
| `renderOrgPreview` (Chinese doc) | 2,500 lines, 129 `.org-section` | `51.450` | `62.547` | `83.641` | `+46.47 MB` | `+46.00 MB` |
| `hydrateTransclusionsInDom` (stress) | 20 top slots, 23 hydrated, 4-level chain | `31.470` | `9.583` | `11.418` | `+5.29 MB` | `+2.75 MB` |
| `renderOrgPreview + hydrate` (e2e stress) | 20 slots, 4-level chain (`depth 0..3`) | `9.908` | `10.838` | `14.888` | `+5.05 MB` | `+12.63 MB` |

**Takeaway:** Indexing `5,000` Org nodes finishes in ~`47–53 ms`, incremental single-file re-indexing runs sub-millisecond (`~0.19 ms` warm), backlink lookup runs in `~0.13 ms`, and `3,000`-line full preview renders in `~75 ms` without blocking normal desktop interactivity.

---

## 8. Build, Type-Check & Test Status

Executed against final Beta release (`v0.2.0-beta.1`) cleanly deployed to `test-vault/`:

- `npm run check` (`tsc --noEmit`): **PASS (0 errors)**
- `npm test` (`vitest run`): **11 test files, 90/90 tests PASS (0 skipped, 0 failed)**
- `npm run build`: **PASS (`main.js` production bundle generated cleanly)**
- `npm run deploy:test-vault`: **PASS (deployed `v0.2.0-beta.1` to `test-vault/.obsidian/plugins/org-native/`)**

---

## 9. Prioritized Sprint 04 Recommendations

1. **P0 — Built-in Org Node Graph View (`src/views/nodes/` + Canvas/SVG)**: Obsidian's built-in Graph View only indexes Markdown files unless emulated with virtual `.md` proxies (which conflicts with `Org as Source of Truth`). Adding a dedicated local & global Org Graph View driven by `OrgIdIndex` (`link` vs `transclude` edge styles, node tag colors, one-click jump) completes the visual knowledge-graph gap cleanly without writing duplicate Markdown files.
2. **P1 — Live Preview `#+transclude:` Inline Cards**: Show a compact read-only preview popover or widget below active `#+transclude:` lines in Live Preview while preserving exact raw source syntax.
3. **P1 — Progressive/Chunked Long-Document Reading Rendering**: Defer offscreen section hydration for extreme `5,000+`-line documents containing dozens of MathJax blocks or wide tables.
4. **P2 — Mobile / Touch Viewport QA & Visual Callout Presets**: Explicit mobile pane toolbar testing and CSS-only callout styling presets that keep `.org` files untouched.
