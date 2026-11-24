# Multi-Agent Collaboration & Code Ownership Rules

This file governs parallel Sprint 02 development in the repository.

## 1. Git Worktree Topology

| Agent Role | Branch | Worktree Directory |
|---|---|---|
| Lead / Integration Agent | `main` | Repository root |
| Agent A — Reading UX | `feat/reading-ux` | `.worktrees/reading-ux` |
| Agent B — Node Navigation | `feat/node-navigation` | `.worktrees/node-navigation` |
| Agent C — Transclusion | `feat/transclusion` | `.worktrees/transclusion` |
| QA Agent — GUI & Data Safety | `test/gui-regression` | `.worktrees/gui-regression` |

---

## 2. Strict File & Directory Ownership

### Lead Agent (Exclusive Integration Ownership)
- `src/main.ts`
- `src/views/OrgView.ts`
- `src/core/model/types.ts`
- `src/core/parser/` public signatures
- `src/settings.ts`
- `src/i18n.ts`
- `src/constants.ts`
- `tests/mocks/obsidian.ts`
- `package.json`, `manifest.json`
- Shared docs (`SPRINT_02.md`, `AGENTS.md`, `docs/INTERFACES.md`, `SPRINT_02_REPORT.md`, `README.md`, `ROADMAP.md`)

### Agent A — Reading UX (`feat/reading-ux`)
- Owns:
  - `src/views/reading/*`
  - `src/views/editor/*`
  - `styles.css`
  - `tests/readingUx.test.ts`
- Must NOT edit `src/main.ts`, `src/views/OrgView.ts`, `src/core/*`, `src/views/nodes/*`, `src/views/transclusion/*`, `package.json`, `manifest.json`.

### Agent B — Node Navigation (`feat/node-navigation`)
- Owns:
  - `src/core/index/*`
  - `src/views/nodes/*`
  - `src/views/nodes/nodes.css` (merged into `styles.css` by Lead in Phase 3)
  - `tests/nodeNavigation.test.ts`
- Must NOT edit `src/main.ts`, `src/views/OrgView.ts`, root `styles.css`, `src/views/reading/*`, `src/views/editor/*`, `src/core/transclusion/*`, `package.json`, `manifest.json`.

### Agent C — Transclusion (`feat/transclusion`)
- Owns:
  - `src/core/transclusion/*`
  - `src/views/transclusion/*`
  - `src/views/transclusion/transclusion.css` (merged into `styles.css` by Lead in Phase 3)
  - `tests/transclusion.test.ts`
- Must NOT edit `src/main.ts`, `src/views/OrgView.ts`, root `styles.css`, `src/views/reading/*`, `src/core/index/*`, `package.json`, `manifest.json`.
- Zero GPLv3 source code copying from `nobiot/org-transclusion`.

### QA Agent (`test/gui-regression`)
- Owns:
  - `tests/qa/*`
  - `scripts/qa-cdp-smoke.mjs`
- Must NOT edit `src/*`, `styles.css`, `package.json`, `manifest.json`, or `test-vault/` sample `.org` files (Lead updates `test-vault/` during final integration so parallel `orgIdIndex.test.ts` corpus assertions remain green across all worktrees).

---

## 3. CSS Conflict-Prevention Convention
Obsidian bundles a single `styles.css` at plugin root. To guarantee **zero merge conflicts** during parallel execution:
- Agent A edits `styles.css` directly for Reading View and Live Preview UX.
- Agent B writes node-navigation styles in `src/views/nodes/nodes.css`.
- Agent C writes transclusion styles in `src/views/transclusion/transclusion.css`.
- During Phase 3 integration, the Lead Agent appends `nodes.css` and `transclusion.css` cleanly into root `styles.css`.

---

## 4. Interface Change & Merge Rules
1. Workers develop against frozen types defined on `main` (`docs/INTERFACES.md`, `src/core/model/types.ts`, `src/core/transclusion/types.ts`, `src/settings.ts`, `src/i18n.ts`).
2. If a Worker discovers a missing shared interface or mock, report it back to Lead instead of modifying Lead-owned files directly.
3. Every Worker MUST run `npm run check && npm test` inside its own worktree before committing.
4. Every Worker creates focused Git commit(s) on its assigned branch (`feat/...` or `test/...`). Never use `git reset --hard` or force-overwrite work.
5. Lead inspects every branch diff (`git diff main..<branch>`) before merging into `main` via `git merge --no-ff`.
