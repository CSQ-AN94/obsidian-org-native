# Roadmap

## Sprint 01 Alpha (Delivered — `v0.1.0-alpha.1`)

- [x] Upstream audit & baseline verification (`RESEARCH.md`, `BASELINE.md`, `THIRD_PARTY_NOTICES.md`)
- [x] Modular architecture (`core/model`, `core/parser`, `core/index`, `core/safety`, `core/transclusion`, `views/reading`, `views/editor`)
- [x] Native `.org` registration with **Reading / Live Preview / Source** modes
- [x] Nested Reading View `<section>` folding & CM6 subtree/block/drawer folding (`overview` / `content` / `all`, `#+STARTUP:`)
- [x] Property Drawer collapsed by default with expandable raw `:PROPERTIES:` view
- [x] Incremental Vault `OrgIdIndex`, cross-file `[[id:...]]` jump, duplicate-ID & broken-link diagnostics
- [x] `FileSyncGuard` external-edit conflict protection & CRLF line-ending preservation
- [x] Automated unit, DOM, CM6 folding, and data-safety regression test suite + isolated `test-vault/`

---

## Sprint 02 Alpha (Delivered — `v0.2.0-alpha.1`)

- [x] **Reading & Editing UX (`feat/reading-ux`)**: Refined H1–H6 typography hierarchy, configurable reading column width / line height / font scale / CJK+Latin layout, copy-code controls, enhanced fold indicators, responsive split panes, and Live Preview cursor/syntax polish.
- [x] **Backlinks & Node Navigation (`feat/node-navigation`)**: Dedicated Org Backlinks sidebar panel (`OrgBacklinksView`), Quick Open Org Node fuzzy switcher (`OrgNodeSwitcherModal`), HTML-escaped Hover Preview popover (`attachNodeHoverPreview`), heading breadcrumbs, node-move stability, and enriched diagnostics.
- [x] **Clean-Room Read-Only `#+transclude:` Expansion (`feat/transclusion`)**: `OrgTransclusionEngine` + Reading View DOM hydration supporting `[[id:...]]`, in-vault `[[file:...]]`, `::*Heading`, `::#custom-id`, `::name` / `<<target>>`, `:level`, bare `:level`, `:only-contents`, `:exclude-elements`, `:lines`, cycle/depth/budget/security guards, explicit warnings on unsupported options, and live refresh on referenced source file edits.
- [x] **QA Harness & Data-Safety Regression Suite (`test/gui-regression`)**: Isolated `test-vault/` manual GUI smoke checklist (`NOT_VERIFIED`), vault-guarded CDP smoke script (`scripts/qa-cdp-smoke.mjs`), `06-transclusion-demo.org` showcase note, and Sprint 02 data-safety + integrated E2E tests.

---

## Phase 3: Real GUI Sign-Off & Advanced Ecosystem Extensions (Future)

- [ ] **Real Obsidian Electron GUI Sign-Off**: Execute [tests/qa/GUI_SMOKE_TEST_CHECKLIST.md](tests/qa/GUI_SMOKE_TEST_CHECKLIST.md) against isolated `test-vault/` in desktop Obsidian (Light & Dark themes, CJK layout, screenshots).
- [ ] **Live Preview Transclusion Previews**: Optional inline widget or hover card preview for `#+transclude:` lines while editing in Live Preview.
- [ ] **Configurable Visual Themes / Callout Cards**: Custom reading styles (Notion-like colored callouts, multi-column cards) purely in `views/reading` and CSS without altering `.org` source syntax.
- [ ] **Node Composer / Exporter Extensions**: Clean plugin extension seams built on top of `OrgSectionTree` and `OrgIdIndex`.
