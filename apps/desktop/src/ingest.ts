import {
  openEpub,
  detect,
  renderChapter,
  chapterFilename,
  readingChapters,
  toChapters,
  imageFilename,
  countWords,
  readingMinutes,
  PARSER_VERSION,
  EpubError,
  explainUnresolved,
  reanchorAnnotations,
  carryBookState,
} from '@chapterize/core';
import type { CutPoint } from '@chapterize/core';
import {
  native,
  bookFolderName,
  bytesOf,
  parseAnnotations,
  parseBookIndex,
  type BookIndex,
  type LoadedBook,
  type OutputFile,
} from './native';

/** A cover or half-title below this many characters is not a chapter. */
const STUB_CHARS = 200;

export interface IngestResult {
  dir: string;
  index: BookIndex;
  warnings: string[];
}

/**
 * Turn one EPUB, from anywhere on disk, into a library folder.
 *
 *   <library>/<Title — Author>/
 *       book.epub          a copy of the original
 *       chapters/NNN-*.md  one file per chapter
 *       index.json         titles, ranges, progress
 *
 * The source file is never moved or altered: it is the user's, and it may live
 * anywhere they chose to keep it.
 */
export async function ingest(
  epubPath: string,
  libraryDir: string,
  options: { copySource?: boolean; into?: string } = {},
): Promise<IngestResult> {
  const bytes = bytesOf(await native.readFile(epubPath));

  let book;
  try {
    book = openEpub(bytes);
  } catch (error) {
    throw error instanceof EpubError
      ? error
      : new Error(`Could not read the EPUB: ${String(error)}`);
  }

  const detection = detect(book);
  const chapters = readingChapters(book, detection.cuts, STUB_CHARS);

  const warnings: string[] = [];
  if (detection.unresolved.length) {
    // An image-only cover is in the spine and has no text. That is normal, and
    // warning about it taught people to distrust a message that sometimes meant
    // "this contents entry points outside the book".
    const real = detection.unresolved.filter((u) => u.reason !== 'document-has-no-text');
    if (real.length) {
      const shown = real.slice(0, 3).map((item) => explainUnresolved(item));
      const extra = real.length > 3 ? ` ${real.length - 3} more contents entries also failed.` : '';
      warnings.push(`${shown.join(' ')}${extra}`);
    }
  }
  if (detection.strategy !== 'toc') {
    warnings.push(
      `This book has no usable table of contents, so chapters were found from ${
        detection.strategy === 'heading' ? 'headings' : 'file boundaries'
      }. Check the split before relying on it.`,
    );
  }

  // Re-splitting passes `into`: the folder already open. Recomputing the name
  // from the title would write a second copy when the folder had been renamed,
  // and slicing the path at '/' to find the library gets the parent wrong on
  // Windows, where the separator is a backslash.
  const dir =
    options.into ?? `${libraryDir}/${bookFolderName(book.metadata.title, book.metadata.author)}`;
  const files: OutputFile[] = [];
  const names: string[] = [];
  const wordCounts: number[] = [];
  for (const chapter of chapters) {
    const name = chapterFilename(chapter, chapter.title);
    names.push(name);
    const words = countWords(
      book.blocks
        .slice(chapter.start, chapter.end)
        .map((b) => b.text)
        .join(' '),
    );
    wordCounts.push(words);
    files.push({
      name,
      contents: renderChapter(chapter, book.blocks, chapter.title, {
        bookTitle: book.metadata.title,
        ...(book.metadata.author !== undefined ? { author: book.metadata.author } : {}),
        totalChapters: chapters.length,
        notes: book.notes,
        minutes: readingMinutes(words),
      }),
    });
  }
  await native.writeChapters(dir, files);

  // Figures live beside the chapters so an exported folder is self-contained and
  // the Markdown's relative image links resolve wherever it is opened.
  for (const [path, bytes] of book.images) {
    await native.writeBytes(`${dir}/chapters/images/${imageFilename(path)}`, Array.from(bytes));
  }

  const index: BookIndex = {
    version: 2,
    parserVersion: PARSER_VERSION,
    title: book.metadata.title,
    ...(book.metadata.author !== undefined ? { author: book.metadata.author } : {}),
    epubFile: 'book.epub',
    createdAt: new Date().toISOString(),
    chapters: chapters.map((c, i) => ({
      index: c.index,
      title: c.title,
      start: c.start,
      end: c.end,
      chars: c.chars,
      file: names[i] ?? '',
      words: wordCounts[i] ?? 0,
    })),
    progress: {},
    finished: [],
  };
  await native.writeText(`${dir}/index.json`, JSON.stringify(index, null, 2));
  const hasAnnotations = await native.readText(`${dir}/annotations.json`);
  if (hasAnnotations === null) await native.writeText(`${dir}/annotations.json`, '[]');
  // Created, never overwritten: this folder is the user's.
  await native.ensureAnalysis(dir);
  // Skipped when re-splitting, where the source already is the library's copy.
  if (options.copySource !== false) await native.copyInto(epubPath, dir, 'book.epub');

  return { dir, index, warnings };
}

/** Re-open a book from disk: its index, its annotations, and its parsed blocks. */
export async function load(dir: string) {
  const indexText = await native.readText(`${dir}/index.json`);
  if (!indexText) throw new Error(`No index.json in ${dir}`);
  // Same check as the shelf. An index with no chapter list must fail here,
  // before the reader assumes `finished` and `chapters` are arrays.
  let index = parseBookIndex(indexText, dir);

  const bytes = bytesOf(await native.readFile(`${dir}/${index.epubFile}`));
  const book = openEpub(bytes);

  // The parser has changed since this book was split, so its chapters are stale.
  // Rebuild them now rather than putting a "Re-split" button in front of someone
  // who only wants to read.
  if (index.parserVersion !== PARSER_VERSION) {
    await resplit(dir);
    const refreshed = await native.readText(`${dir}/index.json`);
    if (!refreshed) throw new Error(`Re-split of ${dir} did not write index.json.`);
    index = parseBookIndex(refreshed, dir);
  }

  // Libraries split before word counts existed carry no `words`, which the
  // reader would render as "~NaN min". Fill them in once, from the blocks we
  // just parsed, and persist so the repair happens only on first open.
  const missingWords = index.chapters.some(
    (c) => c.words === undefined || !Number.isFinite(c.words),
  );
  if (missingWords) {
    index.chapters = index.chapters.map((c) => ({
      ...c,
      words: countWords(
        book.blocks
          .slice(c.start, c.end)
          .map((b) => b.text)
          .join(' '),
      ),
    }));
    index.version = 2;
    await native.writeText(`${dir}/index.json`, JSON.stringify(index, null, 2));
  }

  const annText = await native.readText(`${dir}/annotations.json`);
  const annotations = annText ? parseAnnotations(annText, dir) : [];

  // Object URLs, so the reader shows figures without inlining megabytes of
  // base64 into the DOM. Revoked when the book is closed.
  const imageUrls = new Map<string, string>();
  for (const [path, data] of book.images) {
    const copy = new Uint8Array(data);
    imageUrls.set(path, URL.createObjectURL(new Blob([copy.buffer])));
  }

  return { dir, index, blocks: book.blocks, annotations, imageUrls, notes: book.notes };
}

/**
 * Re-split a book already in the library, after a parser improvement.
 *
 * Block indices move when parsing changes, so annotations cannot simply be kept:
 * their offsets would land on unrelated words. Each highlight is re-anchored by
 * searching the new blocks for the text it recorded, which is why the quote is
 * stored alongside the offsets in the first place. Anything whose text no longer
 * appears is reported rather than silently relocated.
 */
export async function resplit(dir: string): Promise<IngestResult & { orphaned: number }> {
  const indexText = await native.readText(`${dir}/index.json`);
  let previous: BookIndex | undefined;
  if (indexText) previous = parseBookIndex(indexText, dir);
  const existingText = await native.readText(`${dir}/annotations.json`);
  const existing = existingText ? parseAnnotations(existingText, dir) : [];

  const result = await ingest(`${dir}/book.epub`, dir, { copySource: false, into: dir });

  if (previous) {
    const carried = carryBookState(previous, result.index);
    await native.writeText(`${result.dir}/index.json`, JSON.stringify(carried, null, 2));
    result.index = carried;
  }

  if (!existing.length) return { ...result, orphaned: 0 };

  const bytes = bytesOf(await native.readFile(`${result.dir}/book.epub`));
  const { blocks } = openEpub(bytes);
  const { kept, orphaned } = reanchorAnnotations(blocks, existing);
  await native.writeText(`${result.dir}/annotations.json`, JSON.stringify(kept, null, 2));
  return { ...result, orphaned };
}

/**
 * Rewrite a book's chapters from cut points the user edited by hand.
 *
 * The same renderer the importer uses, so a hand-made boundary produces exactly
 * the file an automatic one would. `analysis/` is untouched — the Rust side
 * refuses to delete anything but `chapters/`.
 */
export async function saveSplit(
  book: LoadedBook,
  cuts: CutPoint[],
  endAt: number | null = null,
): Promise<BookIndex> {
  // A contents run stops before the license. The editor's cuts do not repeat
  // that boundary, so a save would otherwise extend the last chapter to the end.
  const limit =
    endAt !== null && endAt > 0 && endAt < book.blocks.length ? endAt : book.blocks.length;
  const blocks = book.blocks.slice(0, limit);
  const chapters = toChapters(cuts, blocks);
  const files: OutputFile[] = [];
  const stored: BookIndex['chapters'] = [];

  for (const [i, chapter] of chapters.entries()) {
    const words = countWords(
      book.blocks
        .slice(chapter.start, chapter.end)
        .map((b) => b.text)
        .join(' '),
    );
    const name = chapterFilename(chapter, chapter.title);
    files.push({
      name,
      contents: renderChapter(chapter, book.blocks, chapter.title, {
        bookTitle: book.index.title,
        ...(book.index.author !== undefined ? { author: book.index.author } : {}),
        totalChapters: chapters.length,
        notes: book.notes,
        minutes: readingMinutes(words),
      }),
    });
    stored.push({
      index: i,
      title: chapter.title,
      start: chapter.start,
      end: chapter.end,
      chars: chapter.chars,
      file: name,
      words,
    });
  }

  await native.writeChapters(book.dir, files);

  // Progress and finished flags are chapter-indexed, and the indices just moved.
  // Keeping them would mark the wrong chapters read, so they are dropped rather
  // than silently misapplied.
  const next: BookIndex = {
    ...book.index,
    version: 2,
    parserVersion: PARSER_VERSION,
    chapters: stored,
    progress: {},
    finished: [],
  };
  delete next.lastChapter;
  await native.writeText(`${book.dir}/index.json`, JSON.stringify(next, null, 2));
  return next;
}
