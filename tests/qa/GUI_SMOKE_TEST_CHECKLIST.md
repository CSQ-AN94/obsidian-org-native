# Org Native for Obsidian — P0 & Sprint 02 Manual GUI Smoke Test Checklist

> **REAL OBSIDIAN ELECTRON GUI STATUS: `NOT_VERIFIED`**
>
> Automated Vitest + `happy-dom` tests verify parser offsets, DOM rendering, CodeMirror 6 folding, Org ID indexing, and `FileSyncGuard` conflict logic, **not** live Obsidian Electron window lifecycle, MathJax/Prism runtime loading, theme contrast, pane layout, or IPC behavior.
> Per Sprint 02 Engineering Rules, every live GUI check below MUST remain **`NOT_VERIFIED`** until executed interactively against the isolated `test-vault` in real desktop Obsidian.

---

## 1. Strict Environment Isolation & Safe Launch Procedure

**MANDATORY SAFETY RULES (READ BEFORE LAUNCHING OBSIDIAN):**
1. **NEVER** open, attach to, or run CDP scripts against your personal Obsidian vaults.
2. **NEVER** inspect or modify `~/Library/Application Support/obsidian` user vault configs or Emacs configs (`~/.emacs.d`, `~/.doom.d`, `~/.config/emacs`).
3. **ONLY** launch and test against the isolated `test-vault` folder in your checkout.

### Step A — Build & Deploy Plugin to Isolated `test-vault`
Run this command from the repository root.

```bash
npm run deploy:test-vault
```

This copies `main.js`, `manifest.json`, and `styles.css` strictly into `test-vault/.obsidian/plugins/org-native/` and enables `"org-native"` + `"showUnsupportedFiles": true` inside `test-vault/.obsidian/`.

### Step B — Snapshot Baseline Hashes Before Manual Edits
Record SHA-256 hashes of all sample `.org` files before running any edit or conflict test:

```bash
shasum -a 256 test-vault/*.org
```

### Step C — Launch Obsidian Pointing ONLY to `test-vault`
Choose one of the two safe launch workflows below:

- **Option 1 — Manual GUI Launch (No CDP):**
  1. Close any personal Obsidian vault windows first.
  2. In Obsidian, choose **Open folder as vault** and select the `test-vault` folder in your checkout.
  3. Confirm the Obsidian window title / Vault Switcher shows **`test-vault`** and Community Plugins -> **Org Native** is enabled.

- **Option 2 — Isolated CDP Launch for `scripts/qa-cdp-smoke.mjs` (macOS):**
  1. Close any personal Obsidian windows, and launch Obsidian with a dedicated temporary user-data-dir and remote debugging port `9222`:
     ```bash
     open -na "Obsidian" --args --remote-debugging-port=9222 --user-data-dir=/tmp/org-native-obsidian-qa
     ```
  2. In that Obsidian window, click **Open folder as vault**, select the `test-vault` folder in your checkout, trust the folder, and verify **Org Native** is enabled.
  3. Run the vault-guarded CDP smoke script (aborts with exit code `2` if `app.vault.getName()` is not `test-vault`):
     ```bash
     node scripts/qa-cdp-smoke.mjs --port 9222 --expect-vault test-vault --screenshots
     ```

### Step D — Restore `test-vault` Cleanly After Destructive/Conflict Tests
After finishing P0-5 / P0-6 manual edit and conflict tests, restore any modified sample files and clean up scratch test files inside `test-vault/`:

```bash
git status test-vault/
git checkout -- test-vault/
```

---

## 2. P0 Core GUI Smoke Checks (7 Checks)

| Check ID | Status | Scope & Test Steps | Pass Criteria |
|---|---|---|---|
| **P0-1** | `NOT_VERIFIED` | **Open `.org` files (`01`–`06`)**: Open `01-welcome-and-reading.org`, `02-math-code-and-tables.org`, `03-vla-memory-notes.org`, `04-knowledge-nodes.org`, `05-diagnostics-demo.org`, and `06-transclusion-demo.org` *(added during Sprint 02 integration)*. | All `.org` files appear in File Explorer and open inside `org-native-view`. Inline title renders, `:PROPERTIES:` drawers start collapsed and expand cleanly with raw source toggle, Chinese TODO keywords (`待办`/`进行中`/`完成`/`取消`) style properly, and Core Outline shows headings. |
| **P0-2** | `NOT_VERIFIED` | **Mode Switching (`Reading` / `Live Preview` / `Source`)**: Switch modes via header toolbar icons and command palette (`Toggle reading / editing view`, `Switch to Reading view`, `Switch to Live preview`, `Switch to Source mode`). | `.org-view` switches cleanly between Reading (`.is-preview-mode`), Live Preview (`.is-live-preview`), and Source Mode (`.is-source-mode`). Relative scroll position stays aligned; zero disk modifications occur. |
| **P0-3** | `NOT_VERIFIED` | **Folding, `#+STARTUP:`, & Fold Preservation**: Open `05-diagnostics-demo.org` (`#+STARTUP: content`) and `01-welcome-and-reading.org` (`#+STARTUP: showall`). Click Reading View fold chevrons; test `Tab` / `Shift-Tab` in editing modes and commands (`Fold all headings (Overview)`, `Show headings only (Contents)`, `Unfold all headings`). Fold a section in Reading View, switch `Reading -> Live -> Source -> Reading`. | `#+STARTUP:` directives apply on open (`honorStartup: true`). Reading View fold state is preserved across mode switches. Folding never modifies `.org` bytes on disk. |
| **P0-4** | `NOT_VERIFIED` | **Math, Code Highlighting, Tables, & Images**: Open `02-math-code-and-tables.org` and verify `$E = mc^2$`, `\(\beta_t = ...\)`, `$5 and $12` price guard, `\begin{align}...\end{align}`, `\[...\]`, `$$...$$`, `#+BEGIN_SRC org/python/elisp`, and `<l>/<c>/<r>` aligned tables. Test a local vault PNG `[[file:sample.png]]` in a temporary note inside `test-vault` (remove afterward). | Inline & display math render cleanly via MathJax; prices `$5`/`$12` are not treated as math; code blocks show Prism syntax colors; aligned tables align columns properly and resolve `[[id:node-semantic-graph]]`; vault images render `img.org-inline-image` while `javascript:`/`data:text/html` links stay blocked. |
| **P0-5** | `NOT_VERIFIED` | **Cross-file `[[id:...]]` Jump, Diagnostics, & Node Move Survival**: Click `[[id:vla-memory-overview]]` in `01`, `[[#core-idea]]`, `[[*未知 Org 语法安全保留]]`. Open `05-diagnostics-demo.org`, click `demo-duplicate-id` and `missing-demo-404`, and run `Org Native: Show Org ID diagnostics`. Temporarily move a test `:ID:` heading between two notes in `test-vault`. | Cross-file jumps open target `.org` file and scroll/unfold to exact target line. Duplicate IDs warn and jump to first match; broken ID shows `.org-link-broken` + Notice; diagnostics modal lists `demo-duplicate-id` & `missing-demo-404` (and NEVER `fake-id-must-not-be-indexed`). Moving a node between files preserves `[[id:...]]` resolution automatically. |
| **P0-6** | `NOT_VERIFIED` | **Data Integrity on Edit & External Emacs Conflict Banner**: Toggle a checkbox in Reading View or edit a single line in Live Preview/Source, close & reopen, and verify `:ID:`, `:CUSTOM_ID:`, `:PROPERTIES:`, planning timestamps, `#+ATTR_HTML:`, `#+CALL:`, `#+BEGIN_CUSTOM_CALLOUT`, `[fn:1]`, comments, and CRLF line endings (on a CRLF scratch note). Then test external disk changes: (a) clean buffer reloads silently; (b) dirty buffer displays `.org-conflict-banner`, refuses overwrite on close, and executes all 3 buttons (`Reload from disk`, `Keep local & save`, `Save local conflict copy`). | Zero loss of IDs, drawers, unknown keywords/blocks, or CRLF endings. External edit never silently overwrites unsaved work or gets overwritten on close; `.conflict-*.org` copy contains exact local edits. |
| **P0-7** | `NOT_VERIFIED` | **Dark/Light Themes, CJK Mixed Layout, & Split Panes**: Toggle Obsidian Appearance between Light and Dark themes on `01`, `02`, and `03`. Resize workspace into a narrow split pane (~380px width). | Headings, TODO badges, tags, property drawers, math, code blocks, tables, conflict banner, and transclusions remain legible in both Light & Dark themes; Chinese/English inline spans wrap naturally; narrow split panes keep toolbar accessible and scroll wide tables horizontally without layout breakage. |

---

## 3. Sprint 02 Feature Checks

| Check ID | Status | Scope & Test Steps | Pass Criteria |
|---|---|---|---|
| **S2-1** | `NOT_VERIFIED` | **Org Backlinks Sidebar**: Run `Org Native: Open Org backlinks panel`. Navigate across `04-knowledge-nodes.org`, `03-vla-memory-notes.org`, and `01-welcome-and-reading.org`. | Sidebar (`org-native-backlinks`) updates dynamically on file switch, distinguishes regular `link` vs `transclude` incoming references, displays surrounding context, and jumps to exact source line on click. |
| **S2-2** | `NOT_VERIFIED` | **Quick Open Org Node Modal**: Run `Org Native: Quick open Org node by ID or title`. Search by title, `headingPath`, filename, `:ID:`, and `:CUSTOM_ID:`. | Fuzzy modal lists real indexed nodes (never fake IDs from code/example/comment/math blocks) and opens/unfolds the chosen node. |
| **S2-3** | `NOT_VERIFIED` | **Hover Preview Popover**: Hover or keyboard-focus `a.org-link-id` links in Reading View (`01`, `03`, `05`). | Read-only preview popover displays target node title, heading path, and excerpt (or duplicate/missing diagnostic state), dismisses cleanly on mouseout/Escape, and writes nothing to disk. |
| **S2-4** | `NOT_VERIFIED` | **Read-Only Transclusion (`#+TRANSCLUDE:`)**: Inspect `01`, `03`, and `06-transclusion-demo.org` in Reading View; toggle `Render #+transclude directives` and adjust `Max transclusion nesting depth` in Settings. | Expands `<aside class="org-transclusion">` with read-only badge & clickable source link; respects `:level`, `:only-contents`, `:exclude-elements`, `:lines`; blocks cycles, depth excess, and `../` path traversal; surfaces `unsupportedParams` warnings cleanly; falls back to `.org-keyword-line` when disabled. |
| **S2-5** | `NOT_VERIFIED` | **Reading UX Settings**: In Settings -> Org Native, adjust Reading column width (`narrow`/`normal`/`wide`), line height (`compact`/`comfortable`/`relaxed`), font scale (`0.85`–`1.25`), and `Optimize CJK + Latin typography`. | Reading View typography updates live (`data-reading-width`, `data-reading-line-height`, `data-cjk-typography`, `--org-reading-font-scale`) with zero `.org` source edits. |

---

## 4. Screenshot & Execution Log

Store any manual or CDP-captured PNG screenshots under `tests/qa/screenshots/` (only when running verification explicitly; do not commit temporary binaries unless requested).

| Check ID | Theme | Result | Screenshot File | Notes |
|---|---|---|---|---|
| `P0-1` | Light | `NOT_VERIFIED` | `tests/qa/screenshots/p0-1-open-org-light.png` | Pending live Electron run against `test-vault` |
| `P0-2` | Light | `NOT_VERIFIED` | `tests/qa/screenshots/p0-2-modes.png` | Reading -> Live -> Source -> Reading |
| `P0-3` | Light | `NOT_VERIFIED` | `tests/qa/screenshots/p0-3-folding.png` | `#+STARTUP:` + fold preservation |
| `P0-4` | Light | `NOT_VERIFIED` | `tests/qa/screenshots/p0-4-math-code-table.png` | MathJax, Prism, aligned tables, images |
| `P0-5` | Light | `NOT_VERIFIED` | `tests/qa/screenshots/p0-5-id-diagnostics.png` | Cross-file jump + `OrgDiagnosticsModal` |
| `P0-6` | Light | `NOT_VERIFIED` | `tests/qa/screenshots/p0-6-conflict-banner.png` | Dirty buffer + external edit conflict banner |
| `P0-7-light` | Light | `NOT_VERIFIED` | `tests/qa/screenshots/p0-7-cjk-light.png` | CJK + English mixed prose in Light mode |
| `P0-7-dark` | Dark | `NOT_VERIFIED` | `tests/qa/screenshots/p0-7-cjk-dark.png` | CJK + English mixed prose in Dark mode |
| `P0-7-split` | Dark | `NOT_VERIFIED` | `tests/qa/screenshots/p0-7-split-pane.png` | Narrow split-pane layout responsiveness |
| `S2-1` | Light/Dark | `NOT_VERIFIED` | `tests/qa/screenshots/s2-1-backlinks.png` | `OrgBacklinksView` incoming `link` vs `transclude` |
| `S2-2` | Light/Dark | `NOT_VERIFIED` | `tests/qa/screenshots/s2-2-quick-open.png` | `OrgNodeSwitcherModal` fuzzy search |
| `S2-3` | Light/Dark | `NOT_VERIFIED` | `tests/qa/screenshots/s2-3-hover-popover.png` | Hover preview popover on `a.org-link-id` |
| `S2-4` | Light/Dark | `NOT_VERIFIED` | `tests/qa/screenshots/s2-4-transclusion.png` | Read-only `<aside class="org-transclusion">` + warnings |
| `S2-5` | Light/Dark | `NOT_VERIFIED` | `tests/qa/screenshots/s2-5-reading-ux.png` | Width, line-height, font scale, CJK typography |
