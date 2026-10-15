# Review

Reviewed the pipeline from EPUB bytes to chapter Markdown, and the desktop code that opens a library, rebuilds a book when the parser version changes, and appends highlights on export.

Evidence: `npm test` — 44 passed, 27 skipped. `npm run typecheck` — core and desktop, both clean. The 27 skips are the real-shelf tests. `CHAPTERIZE_FIXTURES` is unset, so those books were not opened. The synthetic EPUBs are original text written to hit failures that were reproduced in the parser, not a substitute for that shelf.

Severity: **high** means lost text, wrong chapters, or a library that will not open. **Medium** means a wrong highlight, figure, or message, and the book still opens. **Low** means an uncommon input or a limit that is already the design.

## Fixed

| Issue | Severity | What happened |
|---|---|---|
| A `page-list` nav was read as the table of contents | high | The page-list is often the first `<nav>`. Every printed page became a chapter. Only `epub:type="toc"`, `role="doc-toc"`, or a nav that is not a page-list, landmarks, or list-of-figures is the contents. |
| An id inside a heading was invisible | high | `<h1><a id="salt">` never resolved. Every mid-file chapter collapsed onto one block and dedupe deleted the rest. Descendant ids are kept. |
| A line break glued two words | high | `<br>` was dropped, so `Hello<br>harbor` exported as `Helloharbor`. It is a space, in both the text and the markup. |
| A footnote ate its own number | high | The marker regex stripped `12 ` from `12 men remained`. A bare number stays. `1.` and `*` still come off. |
| An image replaced the sentence it sat in | high | The block rendered as the figure only. The sentence is written, then the figure. |
| Two figures became one file | high | The same basename in two folders, `a/b.png` and `a..b.png`, and two names that differ only by a non-ASCII letter, all collapsed to one filename. The second write replaced the first. The directory stays in the name; dots and other characters are hex, so the paths no longer meet. |
| A second image in one paragraph was dropped | high | A block held one image. Further figures in that paragraph are emitted after it, and their bytes are exported. |
| Re-split wrote a second copy, and the wrong folder on Windows | high | The library was `dir.slice(0, lastIndexOf('/'))`. A renamed folder was not the name the title would produce, so the book was copied beside itself. Re-split now writes back into the folder that is open. |
| Re-split forgot the Kindle send and the import date | high | `index.json` was replaced from the EPUB. `createdAt` and `sentToKindle` are carried. Reading progress is not, because chapter indexes moved. |
| The second "cat" jumped onto the first | high | Re-anchor used the first `indexOf`. It now prefers the occurrence nearest the old offset. |
| An empty quote was pinned to block 0 | high | `includes('')` is true for every block, at offset 0. An empty or whitespace quote is counted as orphaned and left out. |
| The stored quote did not match the offsets | high | The quote was `selection.toString().trim()`, which drops spaces the offsets still included. The quote is now the block's own slice, with the same trim applied to the offsets. |
| One bad `index.json` hid the whole shelf | high | `JSON.parse` threw "Unexpected token" with no path, and the shelf load aborted. That file is named, not rewritten, and skipped. The other books still open. |
| `annotations.json` of `{}` crashed the reader | medium | Valid JSON, not a list. The failure was `.filter is not a function`. It now says the file is not a list of highlights and was not modified. That book still will not open until the file is repaired. |
| A pamphlet became one chapter | medium | Headings were kept only when there were at most `blocks / 3` of them. A heading plus one paragraph never qualifies. A short book may keep up to 12 headings; a long book still rejects a heading on every block. |
| A contents list wrapped in a `<div>` was ignored | medium | The nav had no direct `<ol>`, so the book had no chapters from the TOC. The first descendant list is used. |
| An unlabeled contents list after a page-list was ignored | medium | Falling back to "the first nav" selected the page-list and stopped. A nav that is not a page-list is the contents. |
| A rejected TOC explained nothing | medium | Several entries that collapsed to one cut were discarded, and the UI said only "found from headings". The unresolved entries are attached to the fallback. |
| A list item or quotation exported as a plain paragraph | medium | `<li><p>` and `<blockquote><p>` emitted the inner `<p>` and lost the list and the quote. The inner paragraph inherits the wrapper. |
| A sentence beside a child block was dropped | medium | Direct text in a container was ignored. It is its own block. |
| Joining wrapped lines dropped the footnote | medium | The continuation carried the noteref. The joined block now keeps it, and the marker still becomes `[^1]`. |
| Search highlighted the wrong letters of `İstanbul` | medium | `İ` lowercases to `i` plus a combining dot, so an index into the lowercased string landed on the wrong characters. The folded index maps back. The mark is `İstan`. |
| A negative highlight offset was stored | medium | `String.slice` treats a negative start as an offset from the end, so a corrupt start of `-3` could match and be written back. Offsets are clamped into the block. |
| A highlight whose quote was not text aborted the rewrite | medium | Resplit threw on `.trim` of a number after the chapters had already been rewritten. The record is kept unchanged, not deleted. |
| Escape left the book while the dictionary was open | medium | The key handler closed over `lookup` and `speaking` but did not list them as dependencies, so the closure was stale. Both are dependencies now. The order (dictionary, speech, footnote, pending highlight, split edit, library) is a pure function and is tested. The React effect itself was not run in a browser. |
| Command-N turned the page | low | A key with Command, Control, or Alt is ignored, except Escape, which still dismisses whatever is open. |

## Left alone on purpose

- **Progress, finished chapters, and the last chapter are dropped on re-split.** They are indexes into the old chapter list. Keeping them would reopen the book at the wrong place. The import date and the Kindle send are properties of the library copy, so those stay.
- **A single TOC entry is not a table of contents.** One link is a title page, not a structure. Headings or the spine are used instead.
- **When h2 headings outnumber h1 headings, h2 wins.** That is the case the heuristic exists for: a book whose h1 is a running header. Not changed.
- **Nested emphasis such as `*a *b* c*` is not rewritten.** Identical markers nest ambiguously. The existing whitespace tests cover the case that actually breaks Markdown.
- **A highlight is a substring, not a word.** After a re-split, `cat` can land inside `category` if that is the nearest match. A word boundary would move a highlight that was made in the middle of a word. Not changed.
- **A line ending in `Dr.` does not join with the next line.** The period is the signal that the line is the end of a sentence. Treating abbreviations as mid-sentence would also join real sentence ends.

## Unfixed

| Issue | Severity | What happens |
|---|---|---|
| The real shelf was not run | high | Every bug this parser has had showed up in a real book and not in an invented fixture. The new tests pin failures that were reproduced from the code. They do not prove the next book. Set `CHAPTERIZE_FIXTURES` to the shelf and run `npm test`. |
| Tables are flattened | medium | Each cell becomes its own block, in document order. There is no row. A table exports as a sequence of paragraphs. |
| `write_bytes` does not refuse `..` | low | Chapter writes refuse a name containing `/` or `..`. Image writes do not. `imageFilename` no longer emits either, so the current caller cannot escape the folder. A later caller could. |
| Image names that differ only by case still collide on macOS | low | `A.png` and `a.png` stay different strings and are one file on the default APFS volume. Encoding case into every `OEBPS` path would rename every ordinary figure. |
| A non-Latin chapter title becomes `untitled` | low | The slug keeps ASCII letters only. The chapter index in `000-untitled.md` keeps two such files from overwriting each other. The name is useless on the phone. |
| The query `istanbul` does not find `İstanbul` | low | The wrong-span bug is fixed. `İ` still lowercases to `i` plus a combining dot, so a plain `i` does not match. Searching for `İstan` highlights `İstan`. |
| A library whose only index is corrupt also shows "Your library is empty" | low | The error banner names the file. The empty-library welcome is still underneath it, because hiding that welcome would also hide it when a drop fails on a shelf that really is empty. |
| A highlight with no id is not shown | low | The notes list deletes by id. An entry with no id stays in the file and is omitted from the reader so a broken row cannot be stranded on screen. Highlights the app writes have ids. |

## Removed

- The second copy of search in the desktop tools. Search lives in core, which is where it can be tested.
- The re-anchor loop inside re-split. It is `reanchorAnnotations`.
- Finding the library by cutting the path at `/`.
- Using whichever `<nav>` came first, including a page-list, as the table of contents.
- Storing `selection.toString().trim()` as the quote.
