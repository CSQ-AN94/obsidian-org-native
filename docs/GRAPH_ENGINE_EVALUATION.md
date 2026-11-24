# Graph Rendering Engine Evaluation (`Sprint 04`)

## Requirements

1. Treat every Org heading with `:ID:` (as well as `.org` files in File mode) as first-class graph nodes — even dozens of nodes inside one `.org` file.
2. Distinguish **3 relation types** visually and interactively:
   - Normal `[[id:...]]` links (`reference`: solid edges)
   - `#+TRANSCLUDE:` embeds (`transclusion`: dashed accent edges)
   - File ownership & heading hierarchy (`structural`: subtle dotted edges, hidden by default)
3. Match Obsidian native Graph View feel: elastic force-directed layout, dragging nodes with spring feedback, smooth cursor-centered zoom, pan, hover dimming, click select, double-click open.
4. Support simultaneous **Global Graph + Local Graph + multiple OrgView panes** without WebGL context exhaustion.
5. Scale cleanly to **5,000 Org nodes / 15,000+ edges** without blocking Electron or mutating `.org` files.
6. Permissive license compatible with MIT plugin distribution.

---

## Candidate Comparison

| Option | License | Bundle Impact | Physics & Interactive Dragging | 5,000-Node Perf | Edge Differentiation | Verdict |
|---|---|---|---|---|---|---|
| **Obsidian Juggl (`obsidian-juggl`)** | **GPL-3.0** | Heavy | Cytoscape-backed | Fair | Rich | **Rejected** — GPL-3.0 copyleft incompatible with MIT plugin bundle. |
| **Cytoscape.js** | MIT | ~180–350 KB gzipped | Static batch layouts (`cose` / `fcose`); lacks elastic continuous drag physics by default | Moderate; complex styling & bezier edges drop FPS near 5k nodes | Good (CSS-like selectors) | **Rejected** — heavier bundle, less native elastic feel, harder incremental node locking. |
| **Sigma.js v3 + Graphology** | MIT | ~45 KB gzipped | ForceAtlas2 / static layouts; continuous elastic drag requires custom physics loop | Excellent WebGL pan/zoom, but requires Web Worker layout | Dashed/dotted edges require custom GLSL edge shaders; multi-pane WebGL contexts limited in Chromium (~8–16) | **Rejected** — multi-pane Global + Local Graph WebGL context limits & custom shader overhead for dashed/structural edges + poor `happy-dom` coverage. |
| **Graphs Plus (`obsidian-graphs-plus`)** | MIT | — | Multi-pane Obsidian graph UX reference | Uses Obsidian internal PixiJS / WebGL structures or `.graph` schema | Markdown metadata dependent | **Reference Only** — cannot alter native Markdown MetadataCache for `.org` IDs without private API hacks. |
| **`d3-force` + Batched HiDPI Canvas2D** | **ISC** (`d3-force`, `d3-quadtree`) | **~15 KB** gzipped | Native continuous elastic simulation (`forceLink`, Barnes-Hut `forceManyBody`, `fx`/`fy` spring dragging) — matches native Obsidian Graph View | Fast: Barnes-Hut `theta=0.9` ticks + time-budgeted RAF + viewport-culled style-batched Canvas2D + quadtree `O(log N)` hit test | Trivial crisp Canvas2D solid / dashed (`[6, 4]`) / dotted (`[2, 3]`) / curved parallel edges + arrows | **Selected** |

---

## Architecture Choice Summary

- **Layout Engine**: `d3-force` + `d3-quadtree` (`ISC` license, zero GPL contamination).
- **Rendering Engine**: Custom HiDPI HTML5 `<canvas>` 2D renderer (`OrgGraphCanvasRenderer`) with:
  - Style-grouped `beginPath()` / `stroke()` batching + viewport bounding-box culling
  - Quadratic curved offsets for parallel `reference` + `transclusion` edges between the same pair
  - Zoom-adaptive CJK + Latin label LOD (always showing hovered/selected/center labels)
  - `d3-quadtree` spatial indexing for `O(log N)` hit-testing at 5,000+ nodes
  - Incremental coordinate retention & neighbor-centroid seeding on `OrgIdIndex` updates (zero sudden screen jumps when Emacs edits/moves a node).
