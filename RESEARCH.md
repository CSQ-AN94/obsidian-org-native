# Upstream Reference Evaluation (`RESEARCH.md`)

This document summarizes the source, license, dependency, build, and test audit of the three candidate Obsidian Org-mode plugins prior to Sprint 01 development.

## 1. Repository Comparison

| Metric | `zzeitt/obsidian-org-live` | `ESeNonFossiIo/obsidian-org-reader` | `BBazard/obsidian-orgmode-cm6` |
| --- | --- | --- | --- |
| **Pinned Commit** | `770fb9add4089a9724b0c750ff14ccbd56262c06` | `42c596af08085e110d1f398b5d83f9dda9c36856` | `82c0475a26f9ddf7bfaba0c0d14931658fcb76d7` |
| **Version** | `0.2.4` | `0.1.3` | `3.0.1` |
| **minAppVersion** | `1.13.0` | `1.4.0` | `1.4.0` |
| **License** | MIT (`Copyright (c) 2026 zzeitt`) | MIT (`Copyright (c) 2026 ESeNonFossiIo`) | MIT (`Copyright (c) 2023 Benoit BAZARD`) |
| **Language** | TypeScript (`5.8.3`) | ESM JavaScript (`src/*.js` + JSDoc) | TypeScript (`4.7.4`) + Lezer grammar |
| **Parser Approach** | Line-oriented structural parser (`src/org/parse.ts`) + inline scanner (`src/org/inline.ts`) with absolute offsets | Pure recursive-descent section/block parser (`src/parser.js`) + inline AST | Lezer LR grammar (`codemirror-lang-orgmode`) + custom external tokenizers |
| **Reading View** | Yes — HTML renderer reusing `.markdown-preview-view.markdown-rendered` + MathJax + Prism | Yes — pure DOM API renderer (`src/render.js`, zero `innerHTML`) + MathJax + Footnotes section | No dedicated Reading View (Live Preview editor only) |
| **Live Preview / Source** | Live Preview (CM6 `StateField` using Obsidian `HyperMD-*` / `cm-*` classes) + toggleable via setting, no dedicated 3-mode switch | Clean Source CM6 editor with syntax highlighting & Org keybindings (no Live Preview) | Live Preview CM6 with Lezer syntax tree & Vim support |
| **Heading Folding** | Code/quote/special blocks only (headlines not implemented) | Yes — both Reading View section fold & CM6 `foldService` (`Tab` / `Shift-Tab`) | CM6 `foldService` gutter for headings, blocks, property drawers |
| **Org `:ID:` Navigation** | Not implemented (`openLinkText` only) | Partial (`file:`, `*heading`, `#slug`; no `id:` index) | Yes — `[[id:...]]` jumps across vault via `iterateOrgIds()` linear scan |
| **Math / Tables / CJK** | Rich: `$`/`$$`/`\(`/ `\[`/bare `\begin{align|equation|gather|...}`, `<l>/<c>/<r>` aligned tables, Unicode tags, CJK emphasis boundaries | MathJax inline/display + tables + footnotes; simpler CJK emphasis boundaries | No MathJax or table rendering (`README` marks both `[ ]`) |
| **Automated Tests** | None in `package.json` (manual CDP screenshot scripts + `.org` corpora) | `41/41` passing (`node --test test/*.test.js`) | `51/51` passing across 4 suites (`vitest run`) |
| **Build Output** | `npm run check` (exit 0), `npm run build` (exit 0, `main.js` 62K) | `npm run build` (exit 0, `main.js` 63K) | `npm run build` (exit 0, `main.js` 1.1M) |

## 2. Selection Decision

**Primary Base: `zzeitt/obsidian-org-live`**

Reasons:
1. **Visual Parity & Theme Compatibility**: Reuses Obsidian's native Markdown/CM6 classes (`HyperMD-header-*`, `cm-strong`, `cm-embed-block`, `.markdown-preview-view.markdown-rendered`) so light/dark themes work automatically.
2. **Richest Rendering Coverage**: Already solves CJK mixed-text emphasis boundaries, Unicode tags, `<l>/<c>/<r>` table alignment, Prism source highlighting, MathJax inline/display + bare LaTeX environments, and mobile responsiveness.
3. **Clean Codebase Size & TypeScript Hygiene**: ~3,300 lines of modular TypeScript with zero heavy Lezer runtime overhead (`62 KB` bundle vs `1.1 MB` in `obsidian-orgmode-cm6`).

**Adopted Design Patterns (Clean Re-implementation under MIT):**
- From **`obsidian-org-reader`**: Hierarchical Reading View `<section>` folding, `overview`/`content`/`all` fold cycles, `#+STARTUP:` handling, `Tab`/`Shift-Tab` editor folding UX, and safe save-echo checking (`lastSaved`).
- From **`obsidian-orgmode-cm6`**: File-level + heading-level `:PROPERTIES:`/`:ID:` semantics and `[[id:...]]` cross-file jump semantics — upgraded to an **incremental Vault index** with duplicate ID and broken link diagnostics instead of O(Vault) parsing on every link click.

## 3. Risks & Gaps Identified in `obsidian-org-live`

1. **Data-Safety Defect (`onClose` unconditional save)**: `OrgView.onClose()` calls `await this.save()`, risking writes on read-only closes.
2. **External-Edit Conflict Defect (`setViewData`)**: Disk updates overwrite `this.editor` unconditionally even when the user has unsaved local edits in Obsidian.
3. **CRLF Offset Drift (`parseOrgDoc`)**: `offset = to + 1` miscalculates absolute offsets when lines end with `\r\n` (`raw` strips `\r`, making `to` 1 shorter than `rawWithCr`).
4. **Eager DOM Side Effect (`util/dom.ts`)**: Top-level `document.body.createDiv(...)` breaks headless/Node test imports and couples DOM helpers to Obsidian's prototype extensions.
5. **Compatibility Constraint**: `manifest.json` pinned `minAppVersion: 1.13.0` solely for declarative `getSettingDefinitions()`. Switching to standard `PluginSettingTab.display()` restores compatibility back to Obsidian `1.5.0+`.
6. **Private API Usage**: `src/integration/outline.ts`, `app.commands.commands`, and `internalPlugins.getPluginById("global-search")` touch undocumented Obsidian internals. Must be strictly guarded and toggleable.
7. **Zero Automated Tests**: Upstream has no unit/regression test suite.
