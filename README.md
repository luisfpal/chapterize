# Chapterize

Split an EPUB into one file per chapter, read the chapters, annotate them, and
export them for an AI model.

**Why one chapter at a time.** *The 48 Laws of Power* is ~319,000 tokens. It does
not fit in a useful context window, and feeding a model the whole book to ask
about one chapter gets you an answer contaminated by the other fifty. One law is
~4,000–11,000 tokens: the right size to be understood properly.

Everything runs locally. Books never leave the machine.

## On your phone

The computer is the dock. Reading happens on the phone.

```bash
npx chapterize book.epub
```

Needs Node 22.18 or newer. The terminal prints a QR code. Scan it, then on iPhone choose **Share → Add to Home Screen**. The type is a serif the phone already has (nothing is downloaded), daylight is warm paper, and night is warm dark. The chapter and the scroll position are still there the next time that phone opens the book.

Each chapter has a study panel. The outline is the author's own sections. "Why this matters" is a sentence you write; the chapter's opening is then quoted, not summarised. Questions open in order. A blank answer does not reveal the passage, and the next question stays locked until this one is answered or marked "I don't know yet". The passage is the author's paragraph. There is no model in this path, and nothing is sent anywhere.

**Paper** hides the chapter text. The section list and the same locked questions stay, for use beside a physical book.

The files land in `./chapterize-reader/<title>/` (gitignored). `--no-serve` writes them and exits. `--host 127.0.0.1` stays off Wi-Fi. The default port is 4737.

Limits, on purpose:

- The link is a long random token, not a login. Anyone on the same Wi-Fi who has it can read the book while the command is running. The terminal says so.
- The same book keeps the same link, so the Home Screen icon still opens the next time you run the command. It stops working if the computer's address changes, or if port 4737 is taken and the command moves.
- After the first load the phone can open the saved copy with the computer asleep. iOS may delete a site that has not been opened. The first load, and any new copy of the book, need the computer serving and the phone on that Wi-Fi.
- Sentences you write stay in that phone's local storage. They are not copied back. Clearing the site data loses them. Rebuilding the same chapter list keeps the place; a changed chapter list is a different book and starts over.
- A chapter asks at most five questions. A chapter with no headings gets landmarks (opening, middle, end), labelled as such. Questions are templates. The program does not understand the book.
- DRM is unchanged. An encrypted store file still will not open.
- A directory that is not empty, and not one this command created, is refused. Nothing of yours is deleted to make room.

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
`e` edit split · `/` find · `−`/`+` text size · `Esc` back.

**Find** searches the whole book and shows each hit with its chapter and
surrounding sentence. **Listen** reads the chapter aloud through the operating
system's speech service — speech-dispatcher on Linux (`sudo apt install
speech-dispatcher espeak-ng`), `say` on macOS. **Double-click any word** for its
definition; that lookup is the only network request this application makes, and
it sends one word, never a passage.

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

### Kindle

Press **Connect Kindle** once. Amazon's own sign-in opens in a window belonging to
Chapterize, and the session persists there exactly as it does in the Kindle app.
After that, every book has one **Send to Kindle** button.

No SMTP host, no port, no app password, no dialog, no dragging a file. Amazon
publishes no API for this, so the app drives its own signed-in window — which
means an Amazon redesign can break it. It fails with a message saying so rather
than failing quietly.

Whole books only, never chapters: Amazon turns one uploaded file into one library
entry, so a split book would arrive as dozens of unrelated "books".

### What cannot work, and why

**Books do not come back from Kindle.** Four supported routes were checked and all
are closed: *Manage Your Content* offers no download for purchases or for personal
documents, Kindle Cloud Reader excludes personal documents by Amazon's own design,
and Kindle for PC was retired in June 2026. Anything further would mean breaking
DRM.

So Chapterize is the library and Kindle is a display. Books flow one way, and the
app records which ones it has sent.

DRM-protected books (Kindle, Kobo, Google Play) likewise cannot be opened here —
the file is encrypted before it reaches us.

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
