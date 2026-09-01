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
Install the `.deb` from [Releases](../../releases):
```bash
sudo dpkg -i Chapterize_*.deb
```
Chapterize then behaves like any other installed application: it appears in your
app grid, you can search it by "epub" or "book", pin it to the dock, and
double-click an `.epub` in your file manager to open it. Opening a second book
while it is running sends the file to the existing window rather than starting a
second copy.

Prefer no install? The `.AppImage` runs standalone — `chmod +x` it and go — but it
will not register in your app menu or handle `.epub` files.

### macOS — required on first launch
The builds are unsigned, so Gatekeeper refuses them with *"Chapterize is damaged
and can't be opened"*. The app is fine; macOS simply will not run software from a
developer who has not paid Apple $99/yr. Clear the quarantine flag once:

```bash
xattr -cr /Applications/Chapterize.app
```

---

## Use

1. **Add books…**, or drop EPUB files onto the window. They can live anywhere —
   Downloads, an external drive, wherever you keep them.
2. Chapterize splits each one and **copies** it into your library. The file you
   picked is never moved or altered.
3. Open a book, read a chapter, select text to highlight it and attach a note.
4. **Export** writes the chapter Markdown — with your highlights appended — to any
   folder. Feed one file to a model, or drop the folder into Gemini Notebook so you
   can tick a single chapter and keep the others out of the answer.

Keys: `j`/`k` scroll · `n`/`p` chapter · `h` highlight · `m` mark read ·
`−`/`+` text size · `Esc` library.

### Where your library lives

Chapterize stores books in the location your operating system reserves for
application data, so it works the same on every platform and needs no setup:

| | |
|---|---|
| Linux | `~/.local/share/dev.l11.chapterize/library` |
| macOS | `~/Library/Application Support/dev.l11.chapterize/library` |
| Windows | `%LOCALAPPDATA%\dev.l11.chapterize\library` |

Local app data rather than roaming, so a library of EPUBs never follows a Windows
domain profile across the network. Each book is a plain folder you can open,
inspect, copy, or back up:

```
library/The 48 Laws of Power — Robert Greene/
    book.epub                                   a copy of the original
    chapters/003-law-1-never-outshine-the-master.md
    index.json                                  titles, sizes, reading progress
    annotations.json                            highlights and notes
```

Nothing is in a database, so your notes stay readable and greppable, and they
outlive the app. **Library folder** in the footer opens it in your file manager.

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

The parser suite runs against **real EPUBs**, not synthetic fixtures — every
parser bug found so far was invisible to fixtures written by hand, because a
fixture encodes the assumptions of whoever wrote it. Point it at a directory of
your own books:

```bash
CHAPTERIZE_FIXTURES=/path/to/epubs npm test
```

Without the variable the structural tests skip and the unit tests still run, so a
fresh clone is green.
