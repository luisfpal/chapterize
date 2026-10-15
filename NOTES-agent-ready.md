# Agent-ready codebase

## What landed

`npm run check` is the gate: Prettier, ESLint (`typescript-eslint` strict-type-checked), `tsc`, the unit tests, then `scripts/verify.mjs`.

The strict flags live in `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Every `packages/*/tsconfig.json` and `apps/*/tsconfig.json` extends it, and `verify` fails if one does not. ESLint globs are `packages/*/src`, `packages/*/test`, and `apps/*/src`, so a new package is covered without an edit to the config.

Lessons that used to live only in comments:

- `HeadingLevel` is `0 | 1 | 2 | 3 | 4 | 5 | 6`.
- A missing index is `must(value, what)`, and the message names it.
- `as unknown as T` is a lint error. `JSON.parse` stops at `unknown`; `parseBookIndex` and `parseAnnotations` narrow it and name the file they refused.
- `readingMinutes` treats a missing or non-finite word count as unknown, not as `NaN`.
- Annotation offsets walk UTF-16 code units, the same indexes a JS string uses.
- A line shared by both chapters of a two-chapter book is not boilerplate. The same line in three chapters is. `packages/core/test/titles.test.ts` locks that, and the synthetic book needs its third chapter to stay over 200 characters or `mergeStubs` eats it.

`scripts/verify.mjs` builds one EPUB in memory and runs `openEpub`, `detect`, `mergeStubs`, `toChapters`, `deriveTitles`, `renderChapter`, and `chapterFilename`. The skill is `.grok/skills/verify/SKILL.md`. It loads `packages/core` through `scripts/register-ts.mjs`, because Node does not rewrite the `.js` imports. That hook needs Node 22.15 (`module.registerHooks`).

`.githooks/pre-commit` runs `npm run check`. `npm install` points a normal clone at that directory. A linked worktree shares git config with the other checkouts, so the installer does nothing there. Confirmed here: `core.hooksPath` is still unset.

CI runs the four steps on `ubuntu-latest` and `macos-latest`. The existing Rust job on `ubuntu-22.04` is unchanged. `AGENTS.md` is the command map. `CLAUDE.md` still holds the domain lessons and points at it.

## Try it

```bash
npm run check
```

The book alone, without the shelf:

```bash
npm run verify
```

## Unfinished

- `CHAPTERIZE_FIXTURES` was unset. Vitest reported 12 passed and 27 skipped. The skipped tests are the real books. `verify` does not replace them.
- The workflow file was not executed. Nothing was pushed.
- The desktop window was not opened. The reader change is the offset walk in `Book.tsx`; pixels were not checked.
- In this linked worktree the pre-commit hook is not installed, on purpose. A normal clone installs it on `npm install`.
- A package added on another branch is linted and typechecked only after it lands under `packages/*` or `apps/*` and extends `tsconfig.base.json`. The first merge of one that does not will fail `npm run check`.
- Pre-existing `npm audit` findings were left as they were.
- GitHub's `node-version: 22` must resolve to 22.15 or newer. `scripts/register-ts.mjs` throws a named error if `registerHooks` is missing. That was not run on a 22.0–22.14 runtime.
