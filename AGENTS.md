# Multi-Agent Collaboration & Code Ownership Rules

This file governs parallel development across Sprint 02–04 worktrees in the repository.

## 1. Sprint 04 Git Worktree Topology

| Agent Role | Branch | Worktree Directory |
|---|---|---|
| Lead / Integration Agent | `main` | Repository root |
| Agent A — Graph Data & Adapter | `feat/graph-data` | `.worktrees/sprint04-graph-data` |
| Agent B — Graph UI & Canvas Renderer | `feat/graph-ui` | `.worktrees/sprint04-graph-ui` |
| Agent C — Local Graph & Reader Sync | `feat/graph-local-sync` | `.worktrees/sprint04-graph-local` |
| QA Agent — Graph QA, Perf & GUI | `test/graph-qa` | `.worktrees/sprint04-graph-qa` |

---

## 2. Strict File & Directory Ownership (Sprint 04)

### Lead Agent (Exclusive Integration Ownership)
- `src/main.ts`
- `src/views/OrgView.ts`
- `src/core/model/types.ts`
- `src/core/index/orgIdIndex.ts`
- `src/core/index/vaultIndexService.ts`
- `src/core/graph/types.ts`
- `src/views/graph/readerFocusBus.ts`
- `src/views/graph/index.ts`
- `src/views/graph/OrgLocalGraphView.ts` (final Lead assembly wiring B + C + A)
- `src/settings.ts`, `src/i18n.ts`, `src/constants.ts`, root `styles.css`
- `tests/mocks/obsidian.ts`, `package.json`, `manifest.json`
- Shared docs (`SPRINT_04.md`, `AGENTS.md`, `docs/INTERFACES.md`, `docs/GRAPH_ENGINE_EVALUATION.md`, `THIRD_PARTY_NOTICES.md`, `SPRINT_04_REPORT.md`, `README.md`, `ROADMAP.md`)

### Agent A — Graph Data & Adapter (`feat/graph-data`)
- Owns:
  - `src/core/graph/graphFilter.ts`
  - `src/core/graph/graphAdapter.ts`
  - `src/core/graph/localGraph.ts`
  - `src/core/graph/index.ts`
  - `tests/graphAdapter.test.ts`
- Must NOT edit `src/core/graph/types.ts`, `src/core/index/*`, `src/views/*`, `src/main.ts`, `package.json`.

### Agent B — Graph UI, Simulation & Canvas (`feat/graph-ui`)
- Owns:
  - `src/views/graph/simulation.ts`
  - `src/views/graph/canvasRenderer.ts`
  - `src/views/graph/graphControls.ts`
  - `src/views/graph/OrgGraphBaseView.ts`
  - `src/views/graph/OrgGlobalGraphView.ts`
  - `src/views/graph/graph.css` (merged into `styles.css` by Lead in Phase 2)
  - `tests/graphRenderer.test.ts`
- Must NOT edit `src/views/graph/readerFocusBus.ts`, `src/views/graph/localGraphController.ts`, `src/views/OrgView.ts`, `src/main.ts`, root `styles.css`, `src/core/*`.

### Agent C — Local Graph & Reader Sync (`feat/graph-local-sync`)
- Owns:
  - `src/views/graph/localGraphController.ts`
  - `tests/graphLocalSync.test.ts`
- Must NOT edit `src/views/graph/readerFocusBus.ts`, `src/views/graph/OrgGraphBaseView.ts`, `src/views/OrgView.ts`, `src/main.ts`, `src/core/*`.

### QA Agent (`test/graph-qa`)
- Owns (branched AFTER Phase 2 integration on `main`):
  - `test-vault/07-graph-showcase.org` (plus updating `tests/orgIdIndex.test.ts` expected file count only when adding `07`)
  - `scripts/bench-graph.mjs`
  - `scripts/qa-cdp-sprint04.mjs`
  - `tests/qa/sprint04-graph-qa.test.ts`

---

## 3. Rules
1. Workers develop against frozen contracts in `src/core/graph/types.ts`, `src/views/graph/readerFocusBus.ts`, and `docs/INTERFACES.md`.
2. Zero cross-worktree edits. Each subagent operates strictly in its own worktree directory.
3. Every Worker MUST verify `npm run check && npx vitest run <its test>` before committing on its feature branch.
4. Lead inspects branch diffs (`git diff main..<branch>`) and merges cleanly via `git merge --no-ff`.
