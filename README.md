# Chapterize

Split an EPUB into one file per chapter, read the chapters, annotate them, and
export them for an AI model.

**Why one chapter at a time.** *The 48 Laws of Power* is ~319,000 tokens. It does
not fit in a useful context window, and feeding a model the whole book to ask
about one chapter gets you an answer contaminated by the other fifty. One law is
~4,000–11,000 tokens: the right size to be understood properly.

Everything runs locally. Books never leave the machine.

---

## Install

### Linux
Download the `.AppImage` from [Releases](../../releases), then:
```bash
chmod +x Chapterize_*.AppImage
./Chapterize_*.AppImage
```
Or install the `.deb`: `sudo dpkg -i Chapterize_*.deb`

### macOS — required on first launch
The builds are unsigned, so Gatekeeper refuses them with *"Chapterize is damaged
and can't be opened"*. The app is fine; macOS simply will not run software from a
developer who has not paid Apple $99/yr. Clear the quarantine flag once:

```bash
xattr -cr /Applications/Chapterize.app
```

---

## Use

1. Put `.epub` files in your **inbox** folder (set it under *Folders*).
2. Press **Rescan**, then click a book to split it.
3. The book becomes a library folder, and the original moves out of the inbox:

```
library/The 48 Laws of Power — Robert Greene/
    book.epub                                   the original, moved here
    chapters/003-law-1-never-outshine-the-master.md
    index.json                                  titles, sizes, reading progress
    annotations.json                            highlights and notes
```

4. Open the book, read a chapter, select text to highlight it and attach a note.
5. **Export** writes the chapter Markdown — with your highlights appended — to any
   folder. Feed one file to a model, or drop the folder into Gemini Notebook so
   you can tick a single chapter and keep the others out of the answer.

Keys: `j`/`k` scroll · `n`/`p` chapter · `h` highlight · `m` mark read ·
`−`/`+` text size · `Esc` library.

DRM-protected books (Kindle, Kobo, Google Play) cannot be opened by this or any
other tool — the file is encrypted before it reaches us.

---

## How chapters are found

A book is flattened into one array of blocks, and **a chapter is the interval
between two cut points**. That one idea removes every per-layout special case:

| Layout | Handled because |
|---|---|
| One file per chapter | cut points land on file boundaries |
| Whole book in one file | several cut points inside one file |
| One chapter across 12 files | files with no cut point merge into the chapter |

Cut points come from, in order: the EPUB 3 navigation document → the EPUB 2 NCX →
headings → file boundaries. Manual edits produce the same structure, so
auto-detection and hand-editing are the same operation.

Measured against a nine-book library, "one file = one chapter" is wrong on four of
them — *Word Power Made Easy* collapses **362 files into 29 chapters**.

**Titles are not taken from the first heading.** Every chapter of *The 48 Laws of
Power* carries the same `<h1>48 Laws of Power</h1>`, and the real title sits in
unmarked paragraphs split across three elements. Text that repeats across chapters
is suppressed as boilerplate, and the display title is reassembled from what
remains.

Token counts are estimates, shown as `≈4,000`. No open-source Claude tokenizer
exists; the estimate is close enough to choose a chapter and never presented as
exact.

---

## Development

```bash
npm install
npm test                      # parser suite, run against real books
npm run typecheck
cd apps/desktop && npm run tauri dev
```

Requires Node 22+ and Rust. On Ubuntu:
```bash
sudo apt install libwebkit2gtk-4.1-dev libxdo-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf
```

`packages/core` is pure TypeScript with no DOM or platform dependencies — it runs
in Node, in the webview, and would run in a CLI unchanged. The Rust side does only
what a webview cannot: read arbitrary files, write the library, move the original.

The test suite reads real EPUBs from `$CHAPTERIZE_FIXTURES` rather than
synthetic fixtures, and skips itself when they are absent. Every parser bug found
so far was invisible to hand-written fixtures.
