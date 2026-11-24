# Sprint 04 — Org Knowledge Graph

## Goals & Priorities

- **P0**: Org Node Graph + Local Graph + bidirectional Reader synchronization (`OrgReaderFocusBus`, Follow vs Lock, double-click open preserving Graph leaf & viewport)
- **P1**: Global Graph (Node & File granularity via shared `OrgGraphAdapter`), search/filters (`tag:`, `file:`, `id:`), color groups, layout/display controls, Dark/Light theme adaptation, state persistence
- **P2**: Large-scale performance (Barnes-Hut quadtree ticks, incremental coordinate preservation, viewport culling, batched Canvas2D) verified at **100 / 1,000 / 5,000** synthetic Org nodes
- **Out of Scope**: Hybrid Markdown+Org graphs, Notion publisher, Org Babel execution, drag-and-drop node composer writing `.org` files

## Non-Negotiable Constraints

1. **Reuse `OrgIdIndex`**: No duplicate vault scanner or parallel JSON index.
2. **Official Obsidian APIs only**: `ItemView`, `Workspace`, `Plugin` commands/ribbon; never mutate Obsidian's internal Markdown `MetadataCache` or private Graph internals.
3. **Org as Source of Truth**: Zero writes to `.org` files on graph open, zoom, drag, hover, lock, or navigation.
4. **Real GUI Validation**: All 12 acceptance scenarios verified against isolated `test-vault/` in real Obsidian Electron (`scripts/qa-cdp-sprint04.mjs`) with inspected screenshots and `0` console/page errors.
