# Org Native for Obsidian (Sprint 02 Alpha — v0.2.0-alpha.1)

**Core Philosophy: Org as Source of Truth · Emacs = Authoring & Composition · Obsidian = Native Reading & Interaction Layer.**

`Org Native for Obsidian` adds Reading View, Live Preview, source editing, Org-roam node navigation, and read-only `#+transclude:` support for `.org` notes. The plugin is in active alpha development.

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
3. Open `01-welcome-and-reading.org` through `06-transclusion-demo.org` to inspect Reading UX, cross-file navigation, backlinks, hover preview, diagnostics, and read-only transclusion.
4. Optional CDP smoke verification against an Electron Obsidian session **already opened on `test-vault`**:
   ```bash
   node scripts/qa-cdp-smoke.mjs --port 9222 --expect-vault test-vault --screenshots
   ```

> **P0 Real Obsidian Electron GUI Status: `NOT_VERIFIED`**  
> See [the manual GUI checklist](tests/qa/GUI_SMOKE_TEST_CHECKLIST.md) for real desktop Obsidian acceptance checks.

---

## Authors & Acknowledgments

**Author and maintainer** [Siqi Cai (@CSQ-AN94)](https://github.com/CSQ-AN94)

**AI development assistance** Gemini via [Google Antigravity](https://antigravity.google/).

Org Native adapts the MIT-licensed [obsidian-org-live](https://github.com/zzeitt/obsidian-org-live) by zzeitt. Thanks to ESeNonFossiIo for Reading View and folding design references, Benoit Bazard for Org ID navigation references, and nobiot for documenting Org Transclusion behavior. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the upstream revisions, attribution details, and license notices.

## License

Licensed under the [MIT License](LICENSE). Include [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when distributing the compiled plugin.

See the [Sprint 02 report](SPRINT_02_REPORT.md), [contributor guidelines](AGENTS.md), and [interface documentation](docs/INTERFACES.md) for development details.
