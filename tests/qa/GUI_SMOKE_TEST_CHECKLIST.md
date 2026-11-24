# Org Native for Obsidian — P0 & Sprint 02 Manual GUI Smoke Test Checklist

> **REAL OBSIDIAN ELECTRON GUI STATUS: `VERIFIED — 12/12 PASS (Sprint 03 CDP Suite against isolated test-vault, 2026-11-25)`**
>
> Automated Vitest + `happy-dom` tests (`11` suites, `90/90` tests) verify parser offsets, DOM rendering, CM6 folding, Org ID indexing, concurrency/reliability, and synthetic scale metrics. **Live Obsidian Electron GUI verification** was additionally executed against the isolated `test-vault` via Chrome DevTools Protocol (`scripts/qa-cdp-sprint03.mjs --port 9222 --expect-vault test-vault --screenshots --close-browser`), confirming `12/12 PASS` with `0` `pageErrors` and `0` `consoleErrors`.

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
     node scripts/qa-cdp-sprint03.mjs --port 9222 --expect-vault test-vault --screenshots --close-browser
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
| **P0-1** | `PASS` (`C1`) | **Open `.org` files (`01`–`06`)**: Open `01-welcome-and-reading.org`, `02-math-code-and-tables.org`, `03-vla-memory-notes.org`, `04-knowledge-nodes.org`, `05-diagnostics-demo.org`, and `06-transclusion-demo.org` *(added during Sprint 02 integration)*. | All 6 `.org` files appear in File Explorer and open inside `org-native-view`. Inline title renders, `:PROPERTIES:` drawers start collapsed and expand cleanly with raw source toggle, Chinese TODO keywords (`待办`/`进行中`/`完成`/`取消`) style properly, Core Outline shows headings, and SHA-256 hashes remain identical (`C1`). |
| **P0-2** | `PASS` (`C2`) | **Mode Switching (`Reading` / `Live Preview` / `Source`)**: Switch modes via header toolbar icons and command palette (`Toggle reading / editing view`, `Switch to Reading view`, `Switch to Live preview`, `Switch to Source mode`). | `.org-view` switches cleanly between Reading (`.is-preview-mode`), Live Preview (`.is-live-preview`), and Source Mode (`.is-source-mode`) with `dirty: false` and zero disk modifications (`C2`). |
| **P0-3** | `PASS` (`C3`) | **Folding, `#+STARTUP:`, & Fold Preservation**: Open `05-diagnostics-demo.org` (`#+STARTUP: content`) and `01-welcome-and-reading.org` (`#+STARTUP: showall`). Click Reading View fold chevrons; test `Tab` / `Shift-Tab` in editing modes and commands (`Fold all headings (Overview)`, `Show headings only (Contents)`, `Unfold all headings`). Fold a section in Reading View, switch `Reading -> Live -> Source -> Reading`. | `#+STARTUP:` directives apply on open (`bodyFoldedOnStartup: 3`). Reading View fold state is preserved across mode switches (`preservedFolded: true`). Folding never modifies `.org` bytes on disk (`dirty: false`, `C3`). |
| **P0-4** | `PASS` (`C4`) | **Math, Code Highlighting, Tables, & Images**: Open `02-math-code-and-tables.org` and verify `$E = mc^2$`, `\(\beta_t = ...\)`, `$5 and $12` price guard, `\begin{align}...\end{align}`, `\[...\]`, `$$...$$`, `#+BEGIN_SRC org/python/elisp`, `<l>/<c>/<r>` aligned tables, and local vault SVG `[[file:assets/org-native-architecture.svg]]`. | Inline & display math render cleanly via MathJax (`mjxCount: 4`); prices `$5`/`$12` are not treated as math (`priceEscapedCorrectly: true`); code blocks show Prism syntax colors (`prismTokens: 41`, `copyBtns: 3`); aligned tables align 20 cells and local SVG `720x220` loads (`complete: true`, `C4`). |
| **P0-5** | `PASS` (`C6`, `C7`) | **Cross-file `[[id:...]]` Jump, Diagnostics, & Node Move Survival**: Click `[[id:vla-memory-overview]]` in `01`, inspect `05-diagnostics-demo.org`, and run `Org Native: Show Org ID diagnostics`. | Clicking `[[id:vla-memory-overview]]` opens `03-vla-memory-notes.org` (`C6`); Diagnostics Modal lists `demo-duplicate-id`, `missing-demo-404`, and `missing-transclude-404` while excluding `fake-id-must-not-be-indexed` and `fake-transclude-target-id` (`C7`). |
| **P0-6** | `PASS` (`C10`, `C11`) | **Data Integrity on Edit & External Emacs Conflict Banner**: Real edit, save, close, and reopen preserves CRLF, `:ID:`, `:PROPERTIES:`, and unknown Org blocks (`C10`). External Emacs edits reload cleanly when clean; dirty buffer shows `.org-conflict-banner` and creates `.conflict-*.org` copy on resolution (`C11`). | Exact CRLF round-trip verified (`exactRoundTripCrlf: true`); dirty buffer raises `.org-conflict-banner`, leaves disk untouched until explicit user choice, and saves `.conflict-*.org` cleanly (`C11`). |
| **P0-7** | `PASS` (`C5`, `C12`) | **Dark/Light Themes, CJK Mixed Layout, & Split Panes**: Toggle Obsidian Appearance between Light and Dark themes; resize pane to 390px narrow width (`C5`) and test multi-pane same-file split + plugin disable/re-enable (`C12`). | Clean contrast in Light (`rgb(255, 255, 255)`) & Dark (`rgb(28, 28, 28)`); full-width CJK punctuation around inline code/emphasis renders cleanly (`2ce8b76`); 390px narrow pane has `scrollWidth == clientWidth` (`307px`, zero horizontal overflow); multi-pane split and plugin reload succeed with `0` console/page errors (`C5`, `C12`). |

---

## 3. Sprint 02 Feature Checks

| Check ID | Status | Scope & Test Steps | Pass Criteria |
|---|---|---|---|
| **S2-1** | `PASS` (`C7`) | **Org Backlinks Sidebar**: Run `Org Native: Open Org backlinks panel` on `04-knowledge-nodes.org`. | Sidebar (`org-native-backlinks`) renders 10 incoming items (`5 transclude`, `5 link`), distinguishes badges cleanly, and truncates context smoothly with 3-line clamp (`C7`). |
| **S2-2** | `PASS` (`C7`) | **Quick Open Org Node Modal**: Run `Org Native: Quick open Org node by ID or title`. | Fuzzy modal lists `11` indexed nodes including `vla-memory-overview`, never leaks `fake-id-must-not-be-indexed`, and closes cleanly via Escape/backdrop (`C7`). |
| **S2-3** | `PASS` (`C7`) | **Hover Preview Popover**: Hover `a.org-link-id[data-org-id='vla-memory-overview']` in Reading View (`04-knowledge-nodes.org`). | Read-only `.org-node-hover-popover` (`status: "found"`, `scriptCount: 0`) displays unclipped full multi-line title (`6b9a0d6`), breadcrumb path, planning timestamp, and body excerpt (`C7`). |
| **S2-4** | `PASS` (`C8`, `C9`) | **Read-Only Transclusion (`#+TRANSCLUDE:`)**: Inspect `06-transclusion-demo.org` in Reading View covering `:level`, `:only-contents`, `:lines`, `:exclude-elements`, 4-level nesting, cycles, missing ID, and unsupported params. | Expands all `16` top/nested slots (`remainingSlots: 0`, `nested: 5`), marks all `16` read-only with `12` source attribution links, flags `3` cycles / `1` missing / `1` unsupported option warning, and keeps code-block directives untouched (`hasCodeRaw: true`, `C8`, `C9`). |
| **S2-5** | `PASS` (`C5`) | **Reading UX Settings**: Verify Reading typography attributes (`readingWidth`, `readingLineHeight`, `cjkTypography`, `lineBreak`) in live DOM. | Active preview renders with `readingWidth: "normal"`, `readingLineHeight: "comfortable"`, `cjkTypography: "true"`, `lineBreak: "strict"` and zero `.org` source edits (`C5`). |

---

## 4. Screenshot & Execution Log

Verified via `node scripts/qa-cdp-sprint03.mjs --port 9222 --expect-vault test-vault --screenshots --close-browser` on `2026-11-25` against Obsidian Electron (`test-vault`, macOS `arm64`). Screenshots are stored locally under `tests/qa/screenshots/` (gitignored binaries, visually inspected).

| Check ID | Theme | Result | Screenshot File | Notes |
|---|---|---|---|---|
| `P0-1` / `P0-7-dark` | Dark | `PASS` | `tests/qa/screenshots/s3-01-welcome-dark.png` | `01-welcome-and-reading.org` in Dark Reading View + Core Outline |
| `P0-1` / `P0-7-light` | Light | `PASS` | `tests/qa/screenshots/s3-01-welcome-light.png` | `01-welcome-and-reading.org` in Light Reading View + Core Outline |
| `P0-2` | Dark | `PASS` | `tests/qa/screenshots/s3-01-live-preview.png` | Live Preview syntax hiding, inline `(=Reading= / =Live Preview= / =Source=)`, clean viewport |
| `P0-2` | Dark | `PASS` | `tests/qa/screenshots/s3-01-source-mode.png` | Raw `.org` Source mode fidelity |
| `P0-4` | Dark | `PASS` | `tests/qa/screenshots/s3-02-math-code-table-img.png` | MathJax inline/display formulas + `$5`/`$12` guard + Prism syntax highlighting |
| `P0-4` | Dark | `PASS` | `tests/qa/screenshots/s3-02-table-and-image.png` | `<l>/<c>/<r>` aligned table + local SVG diagram `org-native-architecture.svg` |
| `P0-7-split` | Light | `PASS` | `tests/qa/screenshots/s3-01-narrow-split.png` | Narrow 390px split pane with `scrollWidth == clientWidth` (`307px`, zero overflow) |
| `S2-1` / `S2-3` | Dark | `PASS` | `tests/qa/screenshots/s3-04-backlinks-hover.png` | Backlinks sidebar (`10` items) + unclipped Hover Preview title popover (`6b9a0d6`) |
| `S2-4` / `C8` / `C9` | Dark | `PASS` | `tests/qa/screenshots/s3-06-transclusion-dark.png` | `06-transclusion-demo.org` expanded transclusions, cycle/missing warnings, code immunity |
| `S2-4` / `C8` / `C9` | Light | `PASS` | `tests/qa/screenshots/s3-06-transclusion-light.png` | `06-transclusion-demo.org` in Light mode with softened `.org-transclusion` blend |
| `P0-6` / `C11` | Dark | `PASS` | `tests/qa/screenshots/s3-conflict-banner.png` | Dirty buffer + external Emacs edit `.org-conflict-banner` with 3 resolution actions |
