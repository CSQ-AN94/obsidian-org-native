# Org Native for Obsidian (Beta — v0.3.0-beta.1)

**Core Philosophy: Org as Source of Truth · Emacs = Authoring & Composition · Obsidian = Native Reading & Interaction Layer.**

`Org Native for Obsidian` adds Reading View, Live Preview, source editing, Org-roam node navigation, read-only `#+transclude:` support, and built-in **Org Knowledge Graph (Global + Local Graph)** for `.org` notes. Verified in live Obsidian Electron GUI (`12/12` Sprint 03 + `12/12` Sprint 04 checks passed on isolated `test-vault`) and benchmarked up to `5,000` synthetic Org nodes.

---

## Key Features

### Reading View, Live Preview & Editing UX (Sprint 01 + Sprint 02)
- **Native `.org` File Ownership**: Opens `.org` files natively via `OrgView` across **Reading**, **Live Preview**, and **Source** modes without maintaining parallel Markdown copies.
- **Refined Reading Typography**: Configurable column width (`narrow` / `normal` / `wide`), line-height rhythm (`compact` / `comfortable` / `relaxed`), font scale (`0.85`–`1.25`), and **CJK + Latin mixed typography** optimization.
- **Modern Visual Hierarchy & Media**: H1–H6 scale, aligned fold gutters + collapsed indicators, code blocks with copy button & Prism highlighting, MathJax display/inline formulas, aligned tables with horizontal scroll on narrow splits, blockquotes, footnotes, and collapsed-by-default Property Drawers (expandable raw `:PROPERTIES:` view).
- **Cursor-Aware Live Preview**: Smooth CM6 syntax hiding/reveal with reduced cursor-line layout jitter; full dark/light Obsidian CSS theme compatibility and mobile/split-pane responsiveness.
- **Org Heading & Block Folding**: Per-heading chevrons, `Overview` / `Contents` / `Show all` commands, `#+STARTUP:` directives, keyboard navigation, and snapshot preservation across mode switches—never mutating file bytes.

### Org-roam Node Compatibility & Navigation (Sprint 02)
- **Incremental `OrgIdIndex` (`src/core/index/`)**: Indexes `:ID:` and `:CUSTOM_ID:` drawers with hierarchical `headingPath` breadcrumbs, subtree `endLine` bounds, and `link` vs `transclude` backlink classification while ignoring fake directives inside code/example/comment/math/verbatim blocks.
- **Org Backlinks Sidebar (`Org Native: Open Org backlinks panel`)**: Live panel grouped by target node in the active `.org` file, distinguishing regular `[[id:...]]` links from `#+transclude:` references with one-click source jump.
- **Quick Open Org Node (`Org Native: Quick open Org node by ID or title`)**: Fuzzy node switcher searching across title, heading path breadcrumb, file path, `:ID:`, and `:CUSTOM_ID:`—tracking moved nodes seamlessly across files.
- **Node Hover Preview**: Strictly read-only, HTML-escaped floating popover on `[[id:...]]` links showing target title, breadcrumb path, duplicate warnings, and property-free excerpts.
- **Diagnostics Modal (`Org Native: Show Org ID diagnostics`)**: Reports duplicate `:ID:` definitions with heading paths and broken `[[id:...]]` links/transclusions with source line context.

### Clean-Room Read-Only Transclusion (Sprint 02)
- **Zero-GPLv3 Clean-Room Implementation (`src/core/transclusion/`, `src/views/transclusion/`)**: Expands `#+transclude:` directives purely read-only in Reading View without modifying or duplicating source files.
- **Supported Targets & Options**:
  - `[[id:...]]`, in-vault `[[file:...]]`, `::*Heading`, `::#custom-id`, and named blocks/targets (`::name`, `::<<target>>`).
  - `:level N` / bare `:level` (auto depth relative to enclosing section), `:only-contents`, `:exclude-elements "..."`, and 1-based `:lines A-B` / `A-` / `-B`.
- **Safety & Guardrails**:
  - Cycle detection (`status: "cycle"`), configurable nesting cap (`transclusionMaxDepth`, `1..8`), expansion & character budgets, vault-boundary path traversal & unsafe URI blocking, XSS sanitization, disabled task checkboxes inside transcluded fragments, clickable source attribution links, explicit warnings for unsupported `:params`, and automatic Reading View refresh when referenced source `.org` files change on disk.

### Org Knowledge Graph — Global & Local Views (Sprint 04)
- **Single-Index Force-Directed Canvas Engine (`src/core/graph/`, `src/views/graph/`)**: Powered by `d3-force` + `d3-quadtree` (ISC) and batched HiDPI Canvas2D, built exclusively on official Obsidian `ItemView` / `Workspace` APIs and reusing `OrgIdIndex` as the single source of truth without mutating `.org` files.
- **Node & File Granularities + 3 Semantic Edge Types**: Toggle seamlessly between `id:<orgId>` heading-level nodes and `.org` file-level nodes; distinguishes **reference** (`[[id:...]]`, solid arrow), **transclusion** (`#+TRANSCLUDE:`, dashed curved line), and **structural** (dotted hierarchy/ownership edges, hidden by default), with automatic parallel-edge separation plus orphan, unresolved target, and duplicate `:ID:` indicators.
- **Global Graph Controls**: Query search (`tag:...`, `file:...`, `path:...`, `todo:...`, `id:...`, text), tag/folder/property filters, color groups, collapsible sections, full-width precision physics/display sliders (double-click to reset + Restore Defaults), Dark & Light Obsidian theme synchronization, and persisted view state.
- **Local Graph, Custom Icons & Bidirectional Reader Sync**: Distinct Lucide-weight custom SVG icons (`src/views/icons.ts`), 4-slot collision-free CJK/Latin label placement, `forceCollide` + 60fps hover easing, and a dedicated neighborhood pane (`1` / `2` / `3` depth hops, incoming/outgoing toggles) synchronized through `OrgReaderFocusBus` and `LocalGraphController`—heading clicks, cursor moves, and file switches auto-focus smoothly with scroll-jitter suppression and a **Lock** toggle; hovering opens an HTML-escaped preview popover + inspector card, and double-clicking jumps back to the target `.org` heading with `.org-heading-jump-highlight` while preserving Graph panes.

### Emacs Co-Editing & Data-Safety Guard
- Read-only opening, folding, switching modes, hovering, and closing **never** write to disk and preserve LF and CRLF line endings byte-for-byte.
- External Emacs edits reload cleanly when the buffer is clean; when unsaved local edits exist, auto-save pauses and offers **Reload from disk**, **Keep local & save**, or **Save local conflict copy**.
- Bilingual UI (**English / 中文**).

---

## Commands & Keyboard Shortcuts

- `Org Native: Toggle reading / editing view`
- `Org Native: Switch to Reading view` / `Switch to Live preview` / `Switch to Source mode`
- `Org Native: Fold all headings (Overview)` / `Show headings only (Contents)` / `Unfold all headings`
- `Org Native: Toggle fold at cursor` / `Cycle document folding (all / overview / content)`
- `Org Native: Cycle TODO state`
- `Org Native: Open Org backlinks panel`
- `Org Native: Quick open Org node by ID or title`
- `Org Native: Show Org ID diagnostics` / `Rebuild Org ID index`
- `Org Native: Open Org Knowledge Graph`
- `Org Native: Open Local Org Graph`
- `Org Native: Focus active node in Local Org Graph`
- **Editor Keys**: `Tab` folds/unfolds heading or indents list item; `Shift-Tab` cycles document folding or outdents list item; `Enter` continues lists/checkboxes.

---

## Development, Testing & Isolated Test Vault

```bash
npm install
npm run check               # TypeScript strict type-check (tsc --noEmit)
npm test                    # Run Vitest unit, DOM, CM6 folding, integration & QA suites
npm run build               # Typecheck + production bundle -> main.js
npm run deploy:test-vault   # Build and install into ./test-vault/.obsidian/plugins/org-native/
```

### Opening the Isolated Test Vault in Obsidian

1. Run `npm run deploy:test-vault`.
2. Open Obsidian → **Open another vault** → **Open folder as vault** → select the `test-vault` folder in your checkout.
3. Open `01-welcome-and-reading.org` through `07-graph-showcase.org` to inspect Reading UX, cross-file navigation, backlinks, hover preview, diagnostics, read-only transclusion, and the Org Knowledge Graph.
4. Automated live Obsidian Electron GUI verification against **isolated `test-vault`** (aborts with exit code `2` if `app.vault.getName()` is not `test-vault`):
   ```bash
   node scripts/qa-cdp-sprint03.mjs --port 9222 --expect-vault test-vault --screenshots --close-browser
   node scripts/qa-cdp-sprint04.mjs --port 9222 --expect-vault test-vault --screenshots --close-browser
   ```
5. Optional synthetic performance benchmarks (`100` / `1,000` / `5,000` nodes, reading/transclusion workloads, and Global/Local graph + `d3-force` + `d3-quadtree` workloads):
   ```bash
   node scripts/bench-synthetic.mjs
   node scripts/bench-graph.mjs
   ```

> **P0 Real Obsidian Electron GUI Status: `PASS (12/12)` (Sprint 03) & `PASS (12/12)` (Sprint 04)**  
> Verified against isolated `test-vault` via live Obsidian Electron CDP (`scripts/qa-cdp-sprint04.mjs`, `0` page/console errors) alongside `134/134` Vitest tests across `15` suites. See [the GUI verification checklist](tests/qa/GUI_SMOKE_TEST_CHECKLIST.md), [Sprint 03 report](SPRINT_03_REPORT.md), and [Sprint 04 report](SPRINT_04_REPORT.md).

---

## Authors & Acknowledgments

**Author and maintainer** [Siqi Cai (@CSQ-AN94)](https://github.com/CSQ-AN94)

**AI development assistance** Gemini via [Google Antigravity](https://antigravity.google/).

Org Native adapts the MIT-licensed [obsidian-org-live](https://github.com/zzeitt/obsidian-org-live) by zzeitt and uses `d3-force` / `d3-quadtree` (ISC license, Mike Bostock) for its built-in Knowledge Graph engine. Thanks to ESeNonFossiIo for Reading View and folding design references, Benoit Bazard for Org ID navigation references, and nobiot for documenting Org Transclusion behavior. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the upstream revisions, attribution details, and license notices.

## License

Licensed under the [MIT License](LICENSE). Include [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when distributing the compiled plugin.

See the [Sprint 04 report](SPRINT_04_REPORT.md), [Sprint 03 report](SPRINT_03_REPORT.md), [Sprint 02 report](SPRINT_02_REPORT.md), [contributor guidelines](AGENTS.md), and [interface documentation](docs/INTERFACES.md) for development details.
