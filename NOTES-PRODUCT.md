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
cuts: the navigation document, then headings, then files, and a stub under
200 characters merges into the next chapter.

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
