# Phone bundle

A command that turns one EPUB into a folder a phone can open. The desktop
app is where the book is split. These pages are for reading away from it.

## Try it

```bash
npm run cli -- book.epub --serve --epub
```

`npx chapterize book.epub --serve --epub` is the same command from this
repository. The phone has to be on the same Wi-Fi. The terminal prints the
address and a QR code. Ctrl-C stops it.

`--icloud` writes `iCloud Drive/Chapterize/<book>/` instead of serving.
`--out <dir>` writes a folder and exits. Drop `--epub` to skip the
per-chapter EPUBs.

## What it does

One `index.html`, then `chapters/001-title.html` and the rest. Shared
`reader.css` and `reader.js`. Light and dark follow the phone, with a
button that overrides them. Type size is 17, 19, 21, 24, or 28. Previous,
next, and a sideways swipe. A swipe that starts at the left edge is ignored,
because that is Safari's back gesture.

Footnotes, figures, lists, and quotes come through. A running head that
repeats the book title is left off. The chapter cuts are the desktop app's
cuts: the navigation document, then headings, then files. A numbered run
(chapter, book, or law, 1 then 2 then 3) is the book. An unnumbered stub
under 200 characters still merges into the next chapter.

`--epub` adds `epub/001-title.epub`, an EPUB 3 file whose mimetype is stored
and first, so Books will open it. The identifier is stable, so importing the
same chapter again is the same book.

`--serve` listens on every interface, not only localhost, and says that
anyone on the network can read the book until the process stops. A missing
file, a path that walks out of the folder, and a symlink that points out of
it are all 404s. An SVG is served with `script-src 'none'`, because the
picture is allowed and a script in it is not.

A page opened from the Files app does not share storage with the next file.
The link carries appearance, type size, and — from Contents — the scroll
position. Continue shows when you come back from a chapter, and whenever
the pages are served.

Re-running replaces `chapters/`, `images/`, and `epub/` only. Another file
in the folder is left alone. A symlink in one of those three directories is
refused rather than followed. A title of `.` or `..` is written as
`Untitled`, because otherwise `path.join` would leave `Chapterize/`.

## Unfinished

Not opened in mobile Safari. Nothing here could drive a phone or a browser.
Checked with `npm test` (CLI 29 passed; core 7 passed, 27 skipped because
`CHAPTERIZE_FIXTURES` is unset), `npm run typecheck` (cli, core, and desktop),
and one `npm run cli` run on a generated EPUB, which wrote three chapters,
the index, the figure, and three mini-EPUBs.

The QR code is drawn and the test checks that a frame came back. It was not
scanned.

`--icloud` was tested against a stand-in home directory. This Mac's iCloud
Drive was not written to.

Serve-only files live in a temporary directory and are removed when the
server stops, including when the port is already taken. `kill -9` skips
that cleanup.

An IPv6-only network gets no phone address. The loopback URL is still printed.

Opening `index.html` later, cold, from Files, does not show Continue. The
place survives the Contents link, and it survives on the served site. It
does not survive a fresh open of that one file.

The test book is built in memory. The core suite's real-book tests did not
run. There is no sepia; the phone cycles system, light, and dark. The
mini-EPUB still contains an SVG's original bytes for Books. Our server
blocks scripts in that SVG. Books' own handling of them was not checked.

## Study packs

A chapter export is the text. A study pack is that chapter turned into something you can revise on a phone: the whole argument in order, the few sentences worth keeping, why each one is there, and questions you answer with the book closed.

## Try it

```bash
npx chapterize study book.epub --out ~/Desktop/study
```

`npm run cli -- study book.epub --out ~/Desktop/study` is the same command from this repository. There is no build step. Open any `*-study.html` on the phone. Paste any `*-prompt.md` into Grok. The command does not call a model.

`--mode offline` skips the prompt. `--mode prompt` writes only the prompt. `--chapter 4` writes one chapter. Chapters under 15 words are skipped; `--all` keeps them.

## What it does

Offline mode quotes the book. Every heading is a step, nested headings stay nested, and the numbers run 1, 2, 3 without restarting. A chapter with no headings becomes one step per paragraph. List items stay in order under their step. A running header that repeats across chapters is left out; a sentence that merely mentions the title is kept.

“Why it matters” is its own section, one line per step. It is the author’s own sentence when the chapter says *because*, *therefore*, or *so that*. When the chapter never says why, the note names the neighboring step that would be left with nothing in front of this one, and it is marked as coming from the order, not from the author. That is a fact about the outline. It is not a guess about the author’s motive.

Key ideas are at most five sentences: a definition, a line the author emphasised, a reason, or the sentence a step opens with. The outline is the complete walk. The ideas are the short list.

Questions are recall, then deeper. Recall asks the reader to finish a sentence. Deeper asks why a step matters, what the next step claims, what a later step loses if this one is skipped, and what a step establishes in the reader’s own words. The check is a sentence the outline already showed, or the order note. In the HTML it sits inside a disclosure, so opening the file does not show the answer.

The prompt file is optional. It fences the chapter between `CHAPTER-START` and `CHAPTER-END` and tells the model to treat that text as the book, not as instructions. It asks for the same four parts, with nothing skipped and nothing brought in from outside the chapter. The command does not call a model.

## Tests

`npm test` and `npm run typecheck` pass. The study-pack tests build an EPUB (a nested chapter, a headingless chapter, a cover, a repeated header, a list, an emphasised sentence, and a paragraph that contains the characters `<script>`) and run it through the same parser the app uses. The `chapterize` bin (`packages/cli/bin/chapterize.js`) is executed on that file and the HTML and the prompt are read back. A real book is also checked when `CHAPTERIZE_FIXTURES` is set. It was not set here, so that test skipped.

## Unfinished

The desktop window has no Study button. The command is the way to get the files. A button would write the same three files beside the chapter export. It was not added.

The offline “why” can name a neighbor that is a tangent rather than a consequence. The prompt file is there for that case. Making the offline note smarter would mean paraphrasing, which this mode refuses to do.

A chapter whose only heading is its title is one step. Every sentence is still in the outline. There is no next step, so the deeper question about what the next step claims does not appear.

A chapter under 15 words is skipped unless you pass `--all` or `--chapter`. A real one-sentence chapter needs one of those.

The HTML was not opened on a phone. Tests check that it is a document, that book text cannot become a tag, and that each question’s answer is inside `<details>`.

Nothing copies the folder to the phone. You move `~/Desktop/study` the way you already move files.

After the merge into main, `chapterize study` was run on `packages/core/test/fixtures/pg132.epub` (Project Gutenberg, The Art of War) with `--chapter 2`. It wrote one study HTML, one study Markdown, and one prompt file.
