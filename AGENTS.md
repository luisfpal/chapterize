# Agents

Chapterize splits an EPUB into one file per chapter. `packages/core` decides what a chapter is. `apps/*` are shells. A book is a flat array of blocks; a chapter is the interval between two cut points. Do not add a per-layout branch.

Domain lessons (why a line was rejoined, why a TOC entry failed) live in `CLAUDE.md`. This file is the map and the commands. If a command disagrees, this file wins.

## Commands

```bash
npm install
npm test            # unit tests, then scripts/verify.mjs
npm run typecheck
npm run lint
npm run format
npm run verify      # one synthetic EPUB through the real split and export
npm run check       # format, lint, types, tests — the pre-commit gate and CI
```

Node 22.15 or newer (`module.registerHooks`). Rust is only needed to build `apps/desktop`.

`npm install` points a normal clone at `.githooks`, which runs `npm run check` before each commit. A linked worktree shares git config with every other checkout, so the installer does nothing there.

## Rules the toolchain enforces

- Every `packages/*/tsconfig.json` and `apps/*/tsconfig.json` extends `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). `npm run verify` checks this.
- ESLint is `typescript-eslint` strict-type-checked, over `packages/*/src`, `packages/*/test`, and `apps/*/src`. A new package is covered without editing the config.
- No `any`. No `as unknown as`. `JSON.parse` returns `unknown`; narrow it.
- A missing index is `must(value, what)`, not `!`. The message names the index.
- Annotation offsets are UTF-16 code units, the same indexes a JS string uses.
- Parser changes that alter blocks or chapters bump `PARSER_VERSION`.
- Import copies. Never copy a path onto itself. Do not delete a reader's files.

## Map

| Path | Role |
|---|---|
| `packages/core/src/epub.ts` | ZIP to `Book` |
| `packages/core/src/detect.ts` | `Book` to `CutPoint[]` |
| `packages/core/src/chapters.ts` | cuts to chapters, the numbered run, and the edits |
| `packages/core/src/titles.ts` | titles that are not the repeated h1 |
| `packages/core/src/markdown.ts` | one chapter to Markdown |
| `apps/desktop/src/ingest.ts` | the library folder on disk |
| `apps/desktop/src-tauri` | filesystem, Kindle window, speech |

`detect` tiles every block, so a preface and a license remain cuts. `readingChapters` is the split the CLI and the desktop import. A contents run numbered 1, 2, 3 in order (the word is chapter, book, or law; roman numerals and ordinals count) is the book. The preface is not a chapter. The last chapter stops at the next contents entry, so the license is not one either. A numbered chapter under 200 characters stays. Without that run, an unnumbered stub still folds forward: a part divider joins the chapter it introduces, and the harbor notes stay two chapters.

`packages/core/test/fixtures/pg132.epub` is The Art of War (13 chapters) and `pg2680.epub` is the Meditations (12 books). Pride and Prejudice is `~/chz-books/pg1342.epub` (61 chapters). That test skips when the file is absent. `CHAPTERIZE_FIXTURES` still points the older shelf oracles at a private directory. Without it those oracles are not registered, and `npm run verify` still runs.
