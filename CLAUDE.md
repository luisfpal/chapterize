# Chapterize — AI instructions

Split an EPUB into one file per chapter, read chapters in-app, annotate them,
and export them for a model. The invariant: **one chapter at a time**, because a
whole book does not fit in a useful context window (The 48 Laws of Power is
~320k tokens; one law is ~4–12k).

## Mandatory Instructions

1. **Git Workflow**
   - Branch per phase. Never work directly on `main`.
   - Commit often — every working state is a commit. Avoid large diffs.
   - Commit messages explain WHY, not what. No AI attribution, ever.

2. **File Structure**
   - Planning + work log → `internal_docs/development/PLAN.md` (update constantly)
   - Learning docs → `internal_docs/learning/`
   - Scratch / archive → `internal_docs/archive/`

3. **Sequencing**
   - Deploy before cleanup. Untested code is existential risk; cleanup is cosmetic.
   - Iterate end-to-end until the system demonstrably works before moving on.

## The one design idea

A book is a flat array of blocks; a chapter is the interval between two cut
points. Detection strategies and manual edits both emit `CutPoint[]`. There are
no per-layout branches, and there must never be any — if a new EPUB shape seems
to need one, the block model is wrong and that is the thing to fix.

## Parsing rules learned from broken books

- Converted scans emit **one `<p>` per printed line**. Faithful markup, unreadable
  prose. Rejoining needs positive evidence of continuation — next line starting
  lowercase, or this one ending on a comma or a function word — because "ends
  without a full stop" also describes every display title, and swallowing one
  destroys the chapter's name.
- Never join across a heading, a figure, a list item, a document boundary, or out
  of an all-caps line.
- `Block.html` holds whitelisted inline tags with **no attributes**. Its text
  nodes must concatenate to `Block.text` exactly, because annotation offsets index
  into that text. There is a test for it.
- Highlights are laid over markup by resolving every character to its tag stack
  and grouping equal neighbours. Injecting `<mark>` into the HTML directly
  produces crossed tags.
- Only append a derived name to a chapter title when the TOC label is a bare
  enumerator ("LAW 1", "IV"). Labels that already read as titles are left alone.
- Stub chapters merge **forward** when something follows (a part divider heads the
  chapter after it) and backward only at the end.
- Markdown emphasis must not sit against a space: `**bold. **` renders literally.

## Storage rules

- The library lives in the OS application-data directory, resolved by Tauri's path
  API — never a hardcoded path under the user's documents, and never a cache
  directory. It holds annotations; losing it loses the user's work.
- Local app data, not roaming: EPUB libraries must not traverse a Windows domain
  profile.
- Import **copies**. The source is a file the user chose from anywhere on their
  disk; moving it into an application-managed directory is how people lose files.
- Everything on disk is plain JSON and Markdown. No database, no migration story,
  and the user's notes survive the app being deleted.
- **Never copy a file onto itself.** `fs::copy` truncates the destination before
  reading the source, so same-path copy destroys the file. Re-splitting asks for
  exactly that; `copy_into` refuses it and a Rust test pins the behaviour.
- Re-splitting moves block indices, so annotations are re-anchored by searching
  for their stored quote rather than kept at stale offsets.

## Rules learned from real books — do not regress these

- `findAll` must return **document order**. The spine is read from `<itemref>`;
  a reversed result silently reverses the entire book.
- Ids that anchor chapters live on `<body>`, on inline `<a>`/`<span>`, and on
  wrappers — not only on block elements. Capture all of them.
- Only `<nav epub:type="toc">` is a table of contents. `page-list` carries print
  page anchors (174 of them in one of the fixtures) and would invent phantom chapters.
- Never title a chapter from its first `<h1>`. Every chapter of The 48 Laws of
  Power has the same one. Suppress text that repeats across chapters instead.
- Report why a TOC entry failed to resolve, precisely. An image-only cover with
  no text is normal; a TOC pointing outside the spine is a malformed book.

## Desktop integration rules

- `StartupWMClass` in the `.desktop` file must equal the window's WM_CLASS
  instance name (`chapterize`, from the binary name). Without the match, GNOME
  cannot bind the running window to the launcher and pinning to the dock produces
  a second, nameless icon. Verify with `xprop -id <win> WM_CLASS`.
- `Exec` needs `%U`, or the file manager cannot hand the app a book.
- The single-instance plugin must be registered **first** in the builder chain.
  Opening a book while the app runs has to reach the existing window; a second
  library process fighting over the same JSON files is a corruption bug waiting.
- Ship the full `hicolor` icon size range. GNOME picks different sizes for the
  dock, the grid, and the window list, and a missing size renders blurry.

## Verification

`npm test` runs against the user's **real library** under
`$CHAPTERIZE_FIXTURES` — not synthetic fixtures. Those books are not
committed. If they are absent the suite skips rather than fails.
