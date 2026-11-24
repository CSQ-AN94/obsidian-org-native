# Upstream Baseline Report (`BASELINE.md`)

**Primary Upstream**: `https://github.com/zzeitt/obsidian-org-live`  
**Version**: `0.2.4`  
**Commit SHA**: `770fb9add4089a9724b0c750ff14ccbd56262c06` (2026-10-30)  
**Environment Audited**: macOS, Node `v26.4.0`, npm `11.17.0`

## 1. Commands Run & Observed Results

| Command | Exit Code | Output / Artifacts |
| --- | --- | --- |
| `npm ci` (inside `.references/obsidian-org-live`, outside network sandbox) | `0` | `added 22 packages, audited 23 packages in 57s` |
| `npm run check` (`tsc --noEmit --skipLibCheck`) | `0` | 0 TypeScript errors |
| `npm run build` (`npm run check && node esbuild.config.mjs production`) | `0` | `main.js` (`62 KB`), `styles.css` (`13 KB`), `manifest.json` (`273 B`) |
| `npm test` | N/A | Script does not exist in upstream `package.json` |

Secondary reference checks:
- `obsidian-org-reader` (`42c596af08085e110d1f398b5d83f9dda9c36856`): `npm test` passed `41/41` (`node --test`), `npm run build` exited `0` (`main.js` `63 KB`).
- `obsidian-orgmode-cm6` (`82c0475a26f9ddf7bfaba0c0d14931658fcb76d7`): `npm test` passed `51/51` across 4 files (`vitest run`), `npm run build` exited `0` (`main.js` `1.1 MB`).

## 2. What Works Out of the Box in Upstream `obsidian-org-live`

- Native `.org` extension registration via `Plugin.registerView` + `Plugin.registerExtensions(["org"], ...)`.
- Dual view toggle (`Live Preview` vs `Reading View`) with scroll ratio transfer.
- Structural & inline parsing: headings (levels 1–8), custom TODO keywords (`#+TODO:`, settings, CJK), priorities, Unicode tags, planning lines, drawers, tables with `<l>/<c>/<r>` column alignment, `#+BEGIN_SRC` / `QUOTE` / `EXAMPLE` / `CENTER` / `VERSE` / `COMMENT` / `EXPORT`, math (`$`/`$$`/`\(`/ `\[`/bare environments), footnotes, timestamps, cookies, CJK emphasis boundaries.
- Prism syntax highlighting in both Live Preview and Reading View.
- Interactive checkboxes (`[ ]` / `[X]`) and `Cycle TODO state` command.
- Code/quote/special block folding via CM6 `foldService` and inline chevrons.
- Core Outline pane bridge (`src/integration/outline.ts`).
- EN/ZH bilingual settings and command names.

## 3. What Does Not Work or Is Missing for `Org Native`

1. **Heading / Subtree Folding**: Neither Reading View nor CM6 editor folds Org headings or nested subtrees.
2. **Distinct Source Mode**: Only `Live Preview` and `Reading View` exist as view modes; `Source` editing requires toggling global `livePreview` settings rather than per-view mode switching.
3. **Org `:ID:` / `:CUSTOM_ID:` Index & `[[id:...]]` Navigation**: Cross-file `[[id:...]]` links fail because Obsidian's `openLinkText` does not understand Org property drawer IDs. No duplicate-ID or broken-link diagnostics exist.
4. **Property Drawer Collapsing by Default**: Property drawers render as always-open cards in Reading View rather than collapsed-by-default disclosures with inspectable raw text.
5. **External Modification Conflict Safety (Emacs <-> Obsidian)**:
   - `OrgView.onClose()` calls `await this.save()` even when untouched.
   - `OrgView.setViewData()` silently overwrites editor contents on disk changes even if the editor has unsaved edits.
6. **CRLF Offset Bug**: `parseOrgDoc` advances character offsets by `to + 1`, drifting on `\r\n` files.
7. **Automated Tests**: No unit, DOM, folding, ID-index, or data-safety test suite.
8. **Obsidian Version Compatibility**: Upstream requires `1.13.0+` because it uses `getSettingDefinitions()`.
9. **Security & Link Hygiene**: No explicit block against `javascript:` / `vbscript:` / `data:` link targets in rendered HTML.

## 4. Private Obsidian API Risk Audit

| Usage in Upstream | File | Risk Level | Mitigation for Org Native |
| --- | --- | --- | --- |
| Wrapping `getHeadings`, `update`, and reading `cachedHeadingDom` on core `outline` view | `src/integration/outline.ts` | Medium (internal methods may change across Obsidian updates) | Guard every property check, fail silently to no-op, restore originals in `onunload()`, expose toggle in settings |
| Mutating `app.commands.commands[id].name` | `src/main.ts` | Low (cosmetic only) | Keep optional try/catch guard; never depend on it for functionality |
| Accessing `app.internalPlugins.getPluginById("global-search").instance.openGlobalSearch` | `src/util/links.ts` | Low (graceful no-op if unavailable) | Guarded with `try/catch`; falls back cleanly |
