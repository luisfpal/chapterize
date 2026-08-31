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

## Verification

`npm test` runs against the user's **real library** under
`$CHAPTERIZE_FIXTURES` — not synthetic fixtures. Those books are not
committed. If they are absent the suite skips rather than fails.
