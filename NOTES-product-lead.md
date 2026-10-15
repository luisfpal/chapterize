# Notes — product lead

## What this is

Luis reads on his iPhone and in paper books. The desktop library is the wrong daily surface, so the computer is a dock: one command, a QR code, and the phone is the product.

`chapterize book.epub` writes an offline page and serves it on the LAN.

- Serif type the phone already has, warm paper, warm dark, type size, place saved in that phone's local storage.
- Per chapter: the author's outline, a sentence he writes before the opening is quoted, then at most five questions. A blank answer does not reveal the passage. The next question stays locked. "I don't know yet" counts as facing it.
- Paper mode shows the recap and the questions, and does not show the chapter text.
- The link for a given book stays the same across runs, so a Home Screen icon keeps opening. It changes if the computer's address changes, or if the port moves.

No model. No upload. Sentences are not copied back to the computer. The desktop app was not changed.

## Try it

From this worktree, with Node 22.18 or newer:

```bash
npm install
npx chapterize /path/to/book.epub
```

Scan the QR code. On iPhone: Share, then Add to Home Screen. `--host 127.0.0.1` stays off Wi-Fi. `--no-serve` only writes `./chapterize-reader/<title>/`.

## Unfinished, on purpose

- Progress does not sync back to the computer, and there is no multi-book shelf on the phone.
- No highlights, read-aloud, dictionary, or search on the phone. Those stay in the desktop app.
- No generated summaries. Questions are templates over the author's headings, or landmarks when a chapter has none.
- The server has to be running for the first load and for a rebuilt book. After that the phone uses its saved copy. iOS may evict that copy.
- The icon is a URL. A new LAN address, or a port other than the one that was saved, means scanning the code again.
- Study quality on a real shelf was not checked. The local EPUBs did not open from this machine (the files hung on read, consistent with evicted iCloud placeholders). The structural fixture test still skips unless `CHAPTERIZE_FIXTURES` points at books that are actually on disk. Do not point it at that shelf until the files are local.
- Typography, the QR scan, and Add to Home Screen were not exercised on a physical iPhone. The ritual, the lock, the token, and the server were tested here with vitest (happy-dom plus a live `node packages/cli/bin.js`).
