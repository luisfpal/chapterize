import {
  openEpub, detect, toChapters, deriveTitles, renderChapter, chapterFilename,
  mergeStubs, imageFilename, countWords, readingMinutes, estimateTokens, EpubError,
} from '@chapterize/core';
import type { CutPoint } from '@chapterize/core';
import {
  native, bookFolderName, bytesOf,
  type Annotation, type BookIndex, type LoadedBook, type OutputFile,
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
  options: { copySource?: boolean } = {},
): Promise<IngestResult> {
  const bytes = bytesOf(await native.readFile(epubPath));

  let book;
  try {
    book = openEpub(bytes);
  } catch (error) {
    throw error instanceof EpubError ? error : new Error(`Could not read the EPUB: ${String(error)}`);
  }

  const detection = detect(book);
  const cuts = mergeStubs(detection.cuts, book.blocks, STUB_CHARS);
  const chapters = deriveTitles(toChapters(cuts, book.blocks), book.blocks);

  const warnings: string[] = [];
  if (detection.unresolved.length) {
    const real = detection.unresolved.filter((u) => u.reason !== 'document-has-no-text');
    if (real.length) {
      warnings.push(
        `${real.length} table-of-contents ${real.length === 1 ? 'entry' : 'entries'} could not be located; ` +
        'those chapters start at the top of their file.',
      );
    }
  }
  if (detection.strategy !== 'toc') {
    warnings.push(
      `This book has no usable table of contents, so chapters were found from ${
        detection.strategy === 'heading' ? 'headings' : 'file boundaries'
      }. Check the split before relying on it.`,
    );
  }

  const dir = `${libraryDir}/${bookFolderName(book.metadata.title, book.metadata.author)}`;
  const files: OutputFile[] = [];
  const names: string[] = [];
  const wordCounts: number[] = [];
  for (const chapter of chapters) {
    const name = chapterFilename(chapter, chapter.title);
    names.push(name);
    const words = countWords(
      book.blocks.slice(chapter.start, chapter.end).map((b) => b.text).join(' '),
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
    title: book.metadata.title,
    ...(book.metadata.author !== undefined ? { author: book.metadata.author } : {}),
    epubFile: 'book.epub',
    createdAt: new Date().toISOString(),
    chapters: chapters.map((c, i) => ({
      index: c.index, title: c.title, start: c.start, end: c.end, chars: c.chars,
      file: names[i] ?? '',
      words: wordCounts[i] ?? 0,
      approxTokens: estimateTokens(c.chars),
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
  const index = JSON.parse(indexText) as BookIndex;

  const bytes = bytesOf(await native.readFile(`${dir}/${index.epubFile}`));
  const book = openEpub(bytes);

  const annText = await native.readText(`${dir}/annotations.json`);
  const annotations = annText ? JSON.parse(annText) : [];

  // Object URLs, so the reader shows figures without inlining megabytes of
  // base64 into the DOM. Revoked when the book is closed.
  const imageUrls = new Map<string, string>();
  for (const [path, data] of book.images) {
    const copy = new Uint8Array(data);
    imageUrls.set(path, URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer])));
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
export async function resplit(dir: string, libraryDir: string): Promise<IngestResult & { orphaned: number }> {
  const existingText = await native.readText(`${dir}/annotations.json`);
  const existing: Annotation[] = existingText ? JSON.parse(existingText) : [];

  const result = await ingest(`${dir}/book.epub`, libraryDir, { copySource: false });

  if (!existing.length) return { ...result, orphaned: 0 };

  const bytes = bytesOf(await native.readFile(`${result.dir}/book.epub`));
  const { blocks } = openEpub(bytes);

  const reanchored: Annotation[] = [];
  let orphaned = 0;
  for (const note of existing) {
    // Search near the old position first: a book rarely repeats a sentence, but
    // when it does, the nearest match is the intended one.
    const order = blocks
      .map((block, at) => ({ block, at }))
      .sort((a, b) => Math.abs(a.at - note.block) - Math.abs(b.at - note.block));
    const hit = order.find(({ block }) => block.text.includes(note.quote));
    if (!hit) { orphaned++; continue; }
    const start = hit.block.text.indexOf(note.quote);
    reanchored.push({ ...note, block: hit.at, start, end: start + note.quote.length });
  }
  await native.writeText(`${result.dir}/annotations.json`, JSON.stringify(reanchored, null, 2));
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
): Promise<BookIndex> {
  const chapters = toChapters(cuts, book.blocks);
  const files: OutputFile[] = [];
  const stored: BookIndex['chapters'] = [];

  for (const [i, chapter] of chapters.entries()) {
    const words = countWords(
      book.blocks.slice(chapter.start, chapter.end).map((b) => b.text).join(' '),
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
      index: i, title: chapter.title, start: chapter.start, end: chapter.end,
      chars: chapter.chars, file: name, words, approxTokens: estimateTokens(chapter.chars),
    });
  }

  await native.writeChapters(book.dir, files);

  // Progress and finished flags are chapter-indexed, and the indices just moved.
  // Keeping them would mark the wrong chapters read, so they are dropped rather
  // than silently misapplied.
  const next: BookIndex = { ...book.index, version: 2, chapters: stored, progress: {}, finished: [] };
  delete next.lastChapter;
  await native.writeText(`${book.dir}/index.json`, JSON.stringify(next, null, 2));
  return next;
}
