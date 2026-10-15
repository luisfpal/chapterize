# QA + reviewer

## What changed

Parser version is 4. The next time a book is opened, chapters are rebuilt in the folder that is already open. The import date and the Kindle send are kept. Highlights are reattached by the quote, at the occurrence nearest the old offset. Progress is dropped because the chapter indexes moved.

The pipeline — split, then Markdown, then highlights appended on export — is tested with small original EPUBs. They are not a shelf. Each one pins a failure that was reproduced in the parser: a page-list taken as the contents, an id inside a heading, a line break that glued two words, a footnote that ate its number, two figures that became one file, a second chart in the same paragraph, and an EPUB 2 NCX.

A bad `index.json` no longer hides the rest of the library. The message names the file and says it was not modified.

The list of what was fixed, what was left alone, and what is still wrong is in `REVIEW.md`.

## Try it

```sh
npm test
```

That is the suite: 44 passing tests, and 27 real-shelf tests that skip until `CHAPTERIZE_FIXTURES` points at a directory of EPUBs.

To write the sample books (gitignored, safe to delete):

```sh
node packages/core/test/fixtures/build-epub.ts
```

They land in `packages/core/test/fixtures/out/`. `npx vite-node` on that file writes nothing: vite-node does not put the script on `argv`.

## Unfinished

- The nine-book shelf was not run. This pass did not look for it. `npm test` with `CHAPTERIZE_FIXTURES` set is the check that matters, and it was not run.
- The desktop window was not opened. Speech, the shelf banner, and the Escape key were checked as pure functions and by reading the effect. They were not clicked.
- Tables still export as one paragraph per cell. A chapter title with no ASCII letters is still named `untitled`. `istanbul` does not find `İstanbul`. Two image names that differ only by case still collide on the default macOS disk. Details and severities are in `REVIEW.md`.
