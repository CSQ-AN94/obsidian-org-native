# Org Transclusion — Lead Integration Guide

Clean-room, strictly read-only implementation of `#+transclude:` parsing, resolution, safety guards, and Reading View DOM hydration for **Org Native for Obsidian**.

- **Zero GPLv3 code**: Implemented independently from documented `org-transclusion` and Org-mode syntax semantics.
- **Zero shared contract changes**: Uses frozen `src/core/transclusion/types.ts`, `src/core/model/types.ts`, `src/settings.ts`, and `src/i18n.ts` without modification.
- **Reuses existing core**: Powered by `parseOrgDoc`, `buildSectionTree`, `OrgIdIndex`, `renderOrgPreview`, and `isUnsafeUriScheme`.

---

## 1. Module Map & Public API

### Core Engine (`src/core/transclusion/index.ts`)

| File | Key Exports | Responsibility |
|---|---|---|
| `types.ts` | `TransclusionDirective`, `TransclusionOptions`, `TransclusionResolution`, `TransclusionResolver`, `TransclusionContentProvider` | Frozen Sprint 02 contracts |
| `pathGuard.ts` | `resolveSafeVaultPath(rawPath, sourcePath)` | Normalizes relative vault paths; blocks `..` escapes, absolute OS paths, UNC shares, `~`, `file://`, unsafe URI schemes, percent-encoded escapes, `.obsidian`, and `.git` |
| `parser.ts` | `parseTransclusionDirective`, `findTransclusionDirectives`, `isTransclusionKeywordLine`, `extractRawSearchOption`, `computeLineParentLevels` | Parses `#+transclude:` targets & parameters; ignores directives inside `src`, `example`, `comment`, `export`, `drawer`, and `math` blocks |
| `transform.ts` | `extractAndTransformTransclusion`, `truncateOrgContentSafely`, `DEFAULT_EXCLUDE_ELEMENTS`, `SUPPORTED_EXCLUDE_ELEMENTS` | Pure read-only extraction (`id`, `::*Heading`, `::#custom-id`, `::name` / `<<target>>`), `:lines`, `:only-contents`, `:exclude-elements`, `:level`, and syntax-safe truncation |
| `engine.ts` | `OrgTransclusionEngine`, `buildLocationCanonicalKey`, `OrgTransclusionEngineOptions`, `OrgTransclusionResolveContext` | Enforces cycle detection, max depth (`1..8`), expansion count cap, character budgets, duplicate ID warnings, and unsupported parameter preservation |
| `provider.ts` | `createVaultTransclusionProvider(app, index)`, `createMemoryTransclusionProvider(files, index)` | Bridges `OrgIdIndex` + `app.vault.cachedRead` (read-only) without building a duplicate ID index |

### Reading View Renderer (`src/views/transclusion/index.ts`)

| File | Key Exports | Responsibility |
|---|---|---|
| `renderTransclusion.ts` | `hydrateTransclusionsInDom`, `renderOrgPreviewWithTransclusions`, `prepareTransclusionPlaceholders`, `replacePlaceholdersWithSlots`, `TransclusionDomRenderOptions` | Hydrates `.org-transclude-slot` elements into read-only `<aside class="org-transclusion">` with clickable source links, nested recursive expansion, warning banners, error callouts, and disabled task checkboxes |
| `refreshController.ts` | `TransclusionRefreshController`, `HydrationSession` | Tracks resolved source file dependencies + unresolved targets, cancels stale async hydrations via `AbortController`, and skips unrelated file change events |
| `transclusion.css` | Styles for `.org-transclusion*` | Theme-variable CSS for seamless embedded prose, attribution headers, warnings, and error callouts |

---

## 2. Supported Syntax & Guardrails

### Target Syntax
- `[[id:<node-id>]]` — resolved via existing `OrgIdIndex` (`resolveId`). Duplicates resolve to the first match with an explicit UI warning.
- `[[file:<path>.org]]` — whole file (validated in-vault by `resolveSafeVaultPath`).
- `[[file:<path>.org::*Heading]]` / `[[*Heading]]` — heading subtree extraction.
- `[[file:<path>.org::#custom-id]]` / `[[#custom-id]]` — `:CUSTOM_ID:` subtree extraction.
- `[[file:<path>.org::name]]` / `[[file:<path>.org::<<target>>]]` — named block/table/paragraph (`#+NAME:` or dedicated `<<target>>`).

### Verified Parameters
- `:level N` (`1..8`): promotes or demotes the top transcluded heading to level `N` and shifts descendant headings relatively (code blocks untouched).
- `:level` / `:level auto`: automatically shifts top transcluded heading to `parentLevel + 1`.
- `:only-contents` / `:only-contents t`: strips target heading title and its immediate `:PROPERTIES:` drawer (or leading file metadata on whole-file targets), preserving body and sub-headlines.
- `:exclude-elements "type1 type2 ..."`: strips listed Org element types in read-only output (`property-drawer` is excluded by default, matching `org-transclusion`).
- `:lines A-B` / `A-` / `-B` / `N`: 1-based inclusive line range slice applied prior to element filtering.
- Any unrecognized `:param` is preserved in `unsupportedParams` and displayed in `.org-transclusion-warnings`.

### Default Safety & Performance Limits
- `defaultMaxDepth`: `4` (configurable `1..8` via `settings.transclusionMaxDepth`).
- `maxExpansions`: `50` expanded transclusions per rendered document.
- `maxSingleExpansionChars`: `50_000` characters per transclusion (closed cleanly on block/drawer/math boundaries).
- `maxTotalChars`: `200_000` total expanded characters per rendered document.
- Security: path traversal, external/OS paths, unsafe URI schemes, and XSS payloads are blocked/sanitized per slot without crashing surrounding prose.

---

## 3. Lead Integration Snippets

### Step A: Merge CSS into `styles.css`
Append the contents of `src/views/transclusion/transclusion.css` to `styles.css`.

### Step B: Instantiate Engine & Wire Settings in `src/main.ts`
```ts
import {
  createVaultTransclusionProvider,
  OrgTransclusionEngine,
} from "./core/transclusion";

// On OrgNativePlugin:
transclusionEngine!: OrgTransclusionEngine;

// Inside onload(), after this.vaultIndex is created:
const transclusionProvider = createVaultTransclusionProvider(
  this.app,
  this.vaultIndex.index
);
this.transclusionEngine = new OrgTransclusionEngine(transclusionProvider, {
  defaultMaxDepth: this.settings.transclusionMaxDepth,
});
```
Also expose `settings.enableTransclusion` and `settings.transclusionMaxDepth` controls in `OrgNativeSettingTab.display()`.

### Step C: Wire Reading View Hydration & Live Refresh in `src/views/OrgView.ts`

1. Create a controller on `OrgView`:
```ts
import {
  hydrateTransclusionsInDom,
  TransclusionRefreshController,
} from "./transclusion";

private transclusionRefresh = new TransclusionRefreshController(() => {
  if (this.mode === "reading") this.renderPreview(true);
});
```

2. Inside `onOpen()`, subscribe to vault file changes and index changes:
```ts
this.registerEvent(
  this.app.vault.on("modify", (file) => {
    this.transclusionRefresh.notifyFileChanged(file.path);
  })
);
this.registerEvent(
  this.app.vault.on("rename", (file, oldPath) => {
    if (!this.transclusionRefresh.notifyFileChanged(oldPath)) {
      this.transclusionRefresh.notifyFileChanged(file.path);
    }
  })
);
this.registerEvent(
  this.app.vault.on("delete", (file) => {
    this.transclusionRefresh.notifyFileChanged(file.path);
  })
);
// Inside existing vaultIndex.onDidChange callback:
this.transclusionRefresh.notifyIndexChanged();
```

3. Inside `onClose()`, clean up:
```ts
this.transclusionRefresh.dispose();
```

4. Inside `renderPreview()`, pass `hydrateTransclusions` into `renderOrgPreview(...)` (requires Agent A's `.org-transclude-slot` emission + `hydrateTransclusions` hook; or call `renderOrgPreviewWithTransclusions` directly if slots are not emitted by `renderOrgPreview`):
```ts
const session = this.transclusionRefresh.beginHydration();
const preview = renderOrgPreview(source, this.app, this.sourcePath(), {
  settings: this.plugin.settings,
  fallbackTitle: this.displayTitle(),
  linkCallbacks: this.buildLinkCallbacks(),
  resolveIdStatus: this.resolveIdStatus,
  onToggleTask: (from, to, checked) => {
    this.editor?.dispatch({
      changes: { from, to, insert: checked ? "[X]" : "[ ]" },
      userEvent: "input",
    });
  },
  hydrateTransclusions: (root, currentSourcePath) =>
    hydrateTransclusionsInDom(root, {
      app: this.app,
      sourcePath: currentSourcePath,
      resolver: this.plugin.transclusionEngine,
      settings: this.plugin.settings,
      linkCallbacks: this.buildLinkCallbacks(),
      resolveIdStatus: this.resolveIdStatus,
      t: (key) => this.plugin.t(key),
      signal: session.signal,
      isStale: session.isStale,
      onDependency: session.onDependency,
      onOpenSource: (filePath, line) => {
        void this.plugin.vaultIndex?.openLocation(filePath, line, this.mode);
      },
    }),
});
```

---

## 4. Test Fixtures & Verification

- Fixtures live under `tests/fixtures/transclusion/`:
  - `01-knowledge-nodes.org`: atomic nodes, math, tables, code blocks, drawers, duplicates, XSS payload, cycles, depth-5 chain.
  - `sub/04-nested-leaf.org`: nested leaf node referencing `../01-knowledge-nodes.org::#kv-compression`.
  - `02-assembled-article.org`: multi-node composition exercising `:level`, `:only-contents`, `:exclude-elements`, `:lines`, named/dedicated targets, 4-level nested chains, diamond reuse, and code/comment immunity.
  - `03-edge-and-errors.org`: cycles, depth guard, missing/duplicate targets, vault-boundary & URI security blocks, unsupported parameters, XSS sanitization, and crash isolation.
- Automated suites: `tests/transclusion.test.ts` and `tests/transclusionRenderer.test.ts`.
- Verification commands:
  - `npm run check`
  - `npm test`
  - `npm run build`
