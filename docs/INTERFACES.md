# Sprint 02 Module Interfaces & Contracts (`Org Native for Obsidian`)

This document freezes all cross-module interfaces between Lead (`src/main.ts`, `src/views/OrgView.ts`, `src/core/model/types.ts`), Agent A (`views/reading/`, `views/editor/`), Agent B (`core/index/`, `views/nodes/`), Agent C (`core/transclusion/`, `views/transclusion/`), and QA (`tests/qa/`).

---

## 1. Constants, Settings, and View IDs

- `src/constants.ts`:
  - `VIEW_TYPE_ORG = "org-native-view"`
  - `VIEW_TYPE_ORG_BACKLINKS = "org-native-backlinks"`
- `src/settings.ts` (`OrgNativeSettings`):
  - `readingWidth: "narrow" | "normal" | "wide"` (default `"normal"`)
  - `readingLineHeight: "compact" | "comfortable" | "relaxed"` (default `"comfortable"`)
  - `readingFontScale: number` (default `1.0`, clamped `0.85..1.25`)
  - `cjkTypography: boolean` (default `true`)
  - `enableTransclusion: boolean` (default `true`)
  - `transclusionMaxDepth: number` (default `4`, clamped `1..8`)

---

## 2. Reading View Contract (Agent A <-> Lead & Agent C)

### 2.1 Typography Attributes on `.org-preview`
`renderOrgPreview(...)` applies settings onto the `.org-preview` root element without mutating `.org` text:
- `dataset.readingWidth` -> `"narrow" | "normal" | "wide"`
- `dataset.readingLineHeight` -> `"compact" | "comfortable" | "relaxed"`
- `dataset.cjkTypography` -> `"true" | "false"`
- `--org-reading-font-scale` inline CSS variable -> numeric string (e.g. `"1.05"`)

### 2.2 Transclusion Slot Emission & Hydration Hook
In `src/views/reading/render.ts`:
```ts
export interface PreviewRenderOptions {
  settings: OrgNativeSettings;
  fallbackTitle?: string;
  linkCallbacks?: LinkCallbacks;
  resolveIdStatus?: (id: string) => OrgIdStatus;
  onToggleTask?: (from: number, to: number, checked: boolean) => void;
  /** Optional hook called after DOM tree creation to expand read-only #+transclude slots. */
  hydrateTransclusions?: (root: HTMLElement, sourcePath: string) => Promise<void> | void;
}
```
When `settings.enableTransclusion` is `true` and a `keyword` line begins with `#+TRANSCLUDE:` (case-insensitive) outside verbatim/code/example/comment/math blocks:
- `skipInitialKeywords` stops BEFORE any `#+TRANSCLUDE:` line so top-of-file transclusions render in document order rather than inside the metadata card.
- Reading View emits:
  ```html
  <div class="org-transclude-slot"
       data-transclude-raw="..."
       data-line="<0-based-line>"
       data-parent-level="<enclosing-heading-level-or-0>"></div>
  ```
- When `settings.enableTransclusion` is `false`, Reading View falls back to an inert `.org-keyword-line`.

---

## 3. Node Navigation Contract (Agent B <-> Lead)

### 3.1 `OrgNodeEntry` & `OrgIdLink` (`src/core/model/types.ts`)
```ts
export interface OrgNodeEntry {
  id?: string;
  customId?: string;
  filePath: string;
  line: number;
  endLine: number;
  level: number;
  title: string;
  headingPath: string[];
  drawerStartLine: number;
  drawerEndLine: number;
}

export interface OrgIdLink {
  sourcePath: string;
  line: number;
  from: number;
  to: number;
  targetId: string;
  desc?: string;
  relation?: "link" | "transclude";
  context?: string;
}
```

### 3.2 Agent B Public Exports (`src/views/nodes/`)
- `OrgBacklinksView extends ItemView`:
  - `getViewType() === VIEW_TYPE_ORG_BACKLINKS`
  - Tracks active `.org` file and `VaultIndexService`, renders indexed nodes & incoming backlinks (distinguishing `link` vs `transclude`), opens target source line on click.
- `OrgNodeSwitcherModal extends FuzzySuggestModal<OrgNodeEntry>`:
  - Searches `OrgIdIndex` nodes by title, `headingPath`, `filePath`, `:ID:`, and `:CUSTOM_ID:`.
  - Calls `VaultIndexService.openNode(item)` on selection.
- `attachNodeHoverPreview(root: HTMLElement, options: NodeHoverPreviewOptions): () => void`:
  - Attaches hover/focus preview popover on `a.org-link-id[data-org-id]`, resolving live `OrgIdIndex` state + read-only target excerpt via `readFile(filePath)`, and cleans up cleanly via returned disposer.

---

## 4. Transclusion Contract (Agent C <-> Lead & Reading View)

Defined cleanly in `src/core/transclusion/types.ts` (zero GPLv3 code):
- `parseTransclusionDirective(rawLine, sourcePath, line, parentLevel)` -> `TransclusionDirective | null`
- `resolveSafeVaultPath(rawPath, sourcePath)` -> `{ ok: true; vaultPath } | { ok: false; reason }`
- `OrgTransclusionEngine implements TransclusionResolver`:
  - Resolves `[[id:...]]` via `TransclusionContentProvider.resolveId` and safe in-vault `[[file:...]]` (with optional `::*Heading` or `::#custom-id`) via `resolveSafeVaultPath` + `readFile`.
  - Supported parameters: `:level N`, bare `:level`, `:only-contents`, `:exclude-elements "..."`, `:lines A-B` / `A-` / `-B`.
  - Any unrecognized parameter MUST be preserved in `options.unsupportedParams` and surfaced explicitly in UI warnings.
  - Guards: cycle detection via `canonicalKey`, max nesting depth (`depth >= maxDepth`), expansion budget cap, path traversal & unsafe URI blocking, zero mutation of source files.
- `hydrateTransclusionsInDom(root: HTMLElement, options: TransclusionDomRenderOptions): Promise<void>`:
  - Replaces `.org-transclude-slot` elements with read-only `<aside class="org-transclusion">`, clickable source link, unsupported parameter warnings, error callouts, and recursive nested hydration.


---

## 5. Sprint 04 Knowledge Graph Contracts (Frozen by Lead)

### 5.1 View IDs & Settings
- `VIEW_TYPE_ORG_GRAPH = "org-native-graph"`
- `VIEW_TYPE_ORG_LOCAL_GRAPH = "org-native-local-graph"`
- `OrgNativeSettings.graphGlobalState?: Partial<OrgGraphViewState>`
- `OrgNativeSettings.graphLocalState?: Partial<OrgGraphViewState>`

### 5.2 Extended `OrgNodeEntry` & `OrgIdIndex` Accessors
- `OrgNodeEntry` carries optional `tags?: string[]`, `todo?: string`, `parentNodeId?: string`.
- `OrgFileIndexData` carries `fileTitle?: string`.
- `OrgIdIndex` exposes `getFileIndexData(filePath)`, `getAllFileIndexData()`, and `findEnclosingNodeAtLine(filePath, line)`.
- `VaultIndexService.openNode(node, preferredMode, { preserveLeaf, highlight })` never replaces Graph or Backlinks leaves when jumping from Graph to Reader.

### 5.3 Canonical Graph Keys & Relations (`src/core/graph/types.ts`)
- Node IDs:
  - `id:<orgId>` (`canonicalOrgNodeKey`) for primary Org `:ID:` headings/files
  - `dup:<orgId>@<filePath>:<line>` (`canonicalDuplicateNodeKey`) for duplicate definitions
  - `file:<filePath>` (`canonicalFileNodeKey`) for File Graph nodes & fallback anchors
  - `missing:<targetId>` (`canonicalUnresolvedNodeKey`) for unresolved target ghosts
- Three non-confused edge kinds (`OrgGraphEdgeKind`):
  - `"reference"`: `[[id:...]]` citations
  - `"transclusion"`: `#+TRANSCLUDE: [[id:...]]` content embeds
  - `"structural"`: file -> heading and parent `:ID:` -> child `:ID:` containment edges (hidden by default)

### 5.4 Reader <-> Local Graph Focus Bus (`src/views/graph/readerFocusBus.ts`)
- `OrgReaderFocusBus` emits `OrgReaderFocusEvent` (`file-open` | `click` | `cursor` | `jump` | `manual`) whenever resolved `(filePath, nodeKey, orgId)` changes (skipping redundant `cursor` / `file-open` events on scroll).
