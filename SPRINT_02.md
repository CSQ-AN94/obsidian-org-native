# Sprint 02 — Multi-Agent Parallel Development (`Org Native for Obsidian`)

> **Org = Knowledge Source of Truth · Emacs = Knowledge Authoring & Composition · Obsidian = Native Reading & Interaction**

## 0. Sprint 01 Baseline Audit (Verified)
- Local development baseline on branch `main` (`bb16d6a`).
- Checks verified before Sprint 02 kickoff:
  - `npm run check` (`tsc --noEmit`): pass (0 errors).
  - `npm test` (`vitest run`): 4 test files, 22/22 assertions passing.
  - `npm run build` & `npm run deploy:test-vault`: clean bundle deployed to isolated `test-vault/`.
- Known gap carried into Sprint 02: Real Obsidian Electron GUI verification has NOT been run yet and is tracked as **P0** (marked explicitly `NOT_VERIFIED` whenever interactive Electron GUI access is unavailable).

---

## 1. Priorities & Workstreams

| Priority | Track / Branch | Owner | Scope |
|---|---|---|---|
| **P0** | `test/gui-regression` | QA Agent | Isolated `test-vault/` GUI smoke test checklist, vault-guarded CDP smoke script, and data-safety regression suite |
| **P1** | `feat/reading-ux` | Agent A | Typora/Obsidian-native Reading View typography, CJK mixed layout, folding UX, Live Preview cursor/hiding polish, dark/light CSS variables, responsive split panes |
| **P1** | `feat/node-navigation` | Agent B | Org ID Backlinks sidebar, Quick Open Org Node switcher, hover preview popover, heading-path breadcrumbs, duplicate-ID / broken-link diagnostics |
| **P2** | `feat/transclusion` | Agent C | Clean-room read-only `#+transclude:` engine & DOM renderer (`id:`, safe vault `file:`, `:level`, `:only-contents`, `:exclude-elements`, `:lines`, nested & cycle/depth guards) |
| **Lead** | `main` | Lead / Integration Agent | Shared interfaces, agent coordination, code review, sequential merges, `OrgView` / `main.ts` wiring, final verification |

---

## 2. Hard Engineering Rules
1. **Zero Data Loss (`Data Integrity > Reading Experience > Org Compatibility > Editing Convenience`)**: Opening, folding, switching modes, hovering, and transcluding MUST NEVER mutate `.org` source bytes on disk or overwrite external Emacs edits.
2. **Real GUI Honesty**: DOM tests do NOT substitute for Obsidian Electron GUI checks. Without live Obsidian Electron verification against `test-vault/`, the GUI checklist item remains `NOT_VERIFIED`.
3. **Clean-Room Transclusion**: Zero GPLv3 code copied from `nobiot/org-transclusion`. Implement independently from documented Org syntax behavior.
4. **Strict Environment Isolation**: Never access or launch against the user's formal Obsidian Vaults, `~/Library/Application Support/obsidian`, or Emacs configs.
5. **No Fake Tests**: Zero empty tests or skipped tests (`it.skip`, `test.todo`, trivial placeholder expects).
6. **Parallel Worktree Discipline**: Every Agent works in its own dedicated Git worktree and commits independently; no two agents edit the same directory or Lead-owned files concurrently.

---

## 3. Acceptance Criteria
- [ ] Shared interfaces, agent ownership rules, and docs committed on `main` before worker kickoff.
- [ ] All 4 Git worktrees created cleanly and compiling independently.
- [ ] Each Agent produces focused commits within its owned scope with passing `npm run check && npm test`.
- [ ] Lead reviews every branch diff, merges sequentially via `--no-ff`, and integrates all components cleanly into `src/main.ts`, `src/views/OrgView.ts`, and `styles.css`.
- [ ] `test-vault/` receives updated Sprint 02 build and Transclusion + Node Navigation sample notes (`06-transclusion-demo.org`).
- [ ] Full regression suite, TypeScript check, production build, and isolated `test-vault` deploy pass on `main`.
- [ ] `SPRINT_02_REPORT.md`, `README.md`, `ROADMAP.md`, and `tests/qa/GUI_SMOKE_TEST_CHECKLIST.md` accurately reflect all verified vs `NOT_VERIFIED` items.
