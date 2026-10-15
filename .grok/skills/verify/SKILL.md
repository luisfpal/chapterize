---
name: verify
description: Drive Chapterize's real splitter on a synthetic EPUB and assert the export. Use when changing packages/core parsing, chapter detection, titles, or Markdown export, and before claiming a parser change works.
---

# Verify the split

Run, from the repo root:

```bash
npm run verify
```

That is `node --import ./scripts/register-ts.mjs scripts/verify.mjs`. The hook exists so Node can load `packages/core`, which imports its own files as `.js`.

The script builds one EPUB in memory and runs `openEpub`, `detect`, `mergeStubs`, `toChapters`, `deriveTitles`, `renderChapter`, and `chapterFilename`. It does not mock them. A passing run means the reading order followed the spine, the page-list nav was ignored, the repeated h1 was not a title, a display line was not glued to the paragraph under it, a wrapped line was rejoined, emphasis survives as Markdown, and the footnote came from the non-linear document.

When it fails, the message names the assertion. Fix the parser or the book the script builds. Do not loosen the assertion to match new output: the assertion is the record of a bug that already shipped.

`npm test` runs this after the unit tests. `npm run check` runs format, lint, types, and tests. Real shelves are `CHAPTERIZE_FIXTURES`, documented in `AGENTS.md`. This script is the run that does not need one.
