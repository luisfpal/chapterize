# Engineering notes

The 27 skipped tests were the shelf oracles in `packages/core/test/epub.test.ts`. They sit behind `CHAPTERIZE_FIXTURES`, and that path was removed from the repo, so a fresh clone never registered them. Vitest was counting the `it()` calls inside `describe.runIf(false)` as skipped. They are not registered now, so `npm test` reports 0 skipped. The structures they pinned run on original EPUBs built in memory by `packages/core/test/build-epub.ts`.

`npm test` — 58 passed, 0 skipped. `npm run typecheck` is clean, including the desktop ingest path.

## What changed

`PARSER_VERSION` is 4. A library split with the old parser rebuilds on open, because block boundaries moved.

- EPUB 2 NCX and EPUB 3 nav. `page-list`, landmarks, and the NCX `pageList` are not chapters. A nav wins when both exist. A nav that forgot `properties="nav"` is still found. A page-list with no toc nav falls through to headings.
- No table of contents. The shallowest heading level whose titles actually differ becomes the chapters. A repeated running header does not. The opening before the first real heading stays front matter, so the book still tiles from block 0. No headings at all means one chapter per spine file.
- Fragments. Ids on `<body>`, on a wrapper, on an empty `<a id>`, and on a `<span>` inside a paragraph all resolve. `#id` with no path is the nav document itself. A leading slash is the zip root. Backslashes, query strings, percent-encoding, and a zip entry that differs only by case all resolve. Two contents entries that land on the same paragraph are one chapter.
- A chapter may span many files. A missing id starts that chapter at the top of its file and says so. A path outside the spine is dropped and says so. An image-only cover is not warned about.
- Same-file footnotes and endnote groups leave the reading flow and come back as Markdown `[^n]`. `linear="no"` is case-insensitive. A note file that is missing does not fail the book. A chapter file that is missing does, and the message names the spine id and the path.
- Broken markup still yields the sentences around the break. A `<br>` is a space. `<script>` and `<style>` are dropped when the parser keeps the element. A space inside an inline tag and a space after it collapse to one, so the markup's text nodes equal `Block.text`.
- Images stay with the sentence beside them, including an SVG `<image xlink:href>`. A spine item that is a JPEG becomes a figure instead of being parsed as HTML.
- Declared encodings are honoured (`windows-1252`, `cp1252`, `utf8`). An undeclared file that is not valid UTF-8 is read as windows-1252. UTF-16 with a BOM is read as UTF-16. An encoding the runtime does not know names the file and tells you to re-save as UTF-8.
- Adobe Adept and an encrypted chapter are refused by name. An `encryption.xml` that only covers a font still opens. A file that is not a zip says so, and mentions DRM only as a possibility.
- Wrapped print lines rejoin when the next line continues the sentence. An all-caps display title is left alone, which is what keeps "NEVER / DIM THE / LANTERN" as the chapter name.

The public signatures are unchanged. `explainUnresolved` is a new export. The desktop warning uses it for the first three real failures and then a count.

## Try it

```
npm test
```

Shelf oracles, when you have the books:

```
CHAPTERIZE_FIXTURES=/path/to/epubs npm test
```

## Unfinished

The shelf oracles were not executed. There are no EPUBs on this machine, and those tests name the owner's books. If one of them encoded a wrong belief about the old parser, it will fail on the next run against the shelf and should be changed only then.

The desktop warning text typechecks and is not exercised in the window. This pass did not open the app.

Two images with the same filename in different folders still export as one file. `imageFilename` uses the basename, and the chapter links then point at whichever write landed last.

Markup so broken that the HTML parser discards the `<script>` element can still leak that text into a paragraph. A well-formed script does not.

`<pre>` whitespace is collapsed, like every other block. A code listing loses its spacing. `Block.text` is the string annotation offsets index into, and that string has always been collapsed.
