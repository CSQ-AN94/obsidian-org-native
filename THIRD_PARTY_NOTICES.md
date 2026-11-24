# Third-Party Notices & Attributions

`Org Native for Obsidian` adapts MIT-licensed code from `obsidian-org-live` and draws on the design references documented below.

## 1. zzeitt/obsidian-org-live (Primary Base)

- [Upstream repository](https://github.com/zzeitt/obsidian-org-live)
- **Upstream Version**: `0.2.4`
- **Pinned Commit SHA**: `770fb9add4089a9724b0c750ff14ccbd56262c06` (2026-10-30)
- **License**: MIT License
- **Use**: Adapted source code, including Org parsing, Reading View, CodeMirror editing and live preview, Obsidian integration, and styles. The upstream copyright and permission notice is also included in the root [LICENSE](LICENSE).

```text
MIT License

Copyright (c) 2026 zzeitt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. ESeNonFossiIo/obsidian-org-reader (Design & UX Reference)

- [Upstream repository](https://github.com/ESeNonFossiIo/obsidian-org-reader)
- **Upstream Version**: `0.1.3`
- **Pinned Commit SHA**: `42c596af08085e110d1f398b5d83f9dda9c36856` (2026-10-20)
- **License**: MIT License
- **Referenced Concepts**: Reading View collapsible `<section>` hierarchy, `overview`/`content`/`all` fold levels, `#+STARTUP:` handling, `Tab`/`Shift-Tab` folding behavior, and save-echo suppression guard pattern.

```text
MIT License

Copyright (c) 2026 ESeNonFossiIo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. BBazard/obsidian-orgmode-cm6 (Org ID Navigation Reference)

- [Upstream repository](https://github.com/BBazard/obsidian-orgmode-cm6)
- **Upstream Version**: `3.0.1`
- **Pinned Commit SHA**: `82c0475a26f9ddf7bfaba0c0d14931658fcb76d7` (2026-06-19)
- **License**: MIT License
- **Referenced Concepts**: File-level and heading-level `:PROPERTIES:`/`:ID:` semantics and `[[id:...]]` cross-file navigation behavior. (Replaced linear full-vault re-parse per click with an incremental vault index.)

```text
MIT License

Copyright (c) 2023 Benoit BAZARD

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 4. Org Format and Transclusion References

- [Org Transclusion by nobiot](https://github.com/nobiot/org-transclusion) documents the syntax and expected behavior in its [user manual](https://nobiot.github.io/org-transclusion/). Org Native implements a subset of that behavior in TypeScript. The upstream Emacs package is licensed under GPL-3.0-or-later. The build has no dependency on that package.
- The [GNU Org Manual](https://orgmode.org/manual/) is a reference for Org syntax. The manual is published under the GNU Free Documentation License and is not redistributed here.

## 5. Obsidian APIs and CodeMirror

The production build resolves [Obsidian](https://github.com/obsidianmd/obsidian-api) and [CodeMirror 6](https://codemirror.net/) from the Obsidian host. Their packages are external to the plugin bundle. The [npm lockfile](package-lock.json) records the development and test dependencies.
