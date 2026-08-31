import {
  openEpub, detect, toChapters, deriveTitles, renderChapter, chapterFilename, EpubError,
} from '@chapterize/core';
import { native, bookFolderName, bytesOf, type BookIndex, type OutputFile } from './native';

export interface IngestResult {
  dir: string;
  index: BookIndex;
  warnings: string[];
}

/**
 * Turn one EPUB into a library folder.
 *
 *   <library>/<Title — Author>/
 *       book.epub          the original, moved out of the inbox
 *       chapters/NNN-*.md  one file per chapter
 *       index.json         titles, ranges, progress
 *
 * The original is moved last. If anything above fails the book stays in the
 * inbox, so a half-written library folder can always be retried by re-importing
 * rather than by hunting for where the file went.
 */
export async function ingest(epubPath: string, libraryDir: string): Promise<IngestResult> {
  const bytes = bytesOf(await native.readFile(epubPath));

  let book;
  try {
    book = openEpub(bytes);
  } catch (error) {
    throw error instanceof EpubError ? error : new Error(`Could not read the EPUB: ${String(error)}`);
  }

  const detection = detect(book);
  const chapters = deriveTitles(toChapters(detection.cuts, book.blocks), book.blocks);

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
  for (const chapter of chapters) {
    const name = chapterFilename(chapter, chapter.title);
    names.push(name);
    files.push({
      name,
      contents: renderChapter(chapter, book.blocks, chapter.title, {
        bookTitle: book.metadata.title,
        ...(book.metadata.author !== undefined ? { author: book.metadata.author } : {}),
        totalChapters: chapters.length,
      }),
    });
  }
  await native.writeChapters(dir, files);

  const index: BookIndex = {
    version: 1,
    title: book.metadata.title,
    ...(book.metadata.author !== undefined ? { author: book.metadata.author } : {}),
    epubFile: 'book.epub',
    createdAt: new Date().toISOString(),
    chapters: chapters.map((c, i) => ({
      index: c.index, title: c.title, start: c.start, end: c.end, chars: c.chars,
      file: names[i] ?? '',
    })),
    progress: {},
    finished: [],
  };
  await native.writeText(`${dir}/index.json`, JSON.stringify(index, null, 2));
  await native.writeText(`${dir}/annotations.json`, '[]');
  await native.moveInto(epubPath, dir, 'book.epub');

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

  return { dir, index, blocks: book.blocks, annotations };
}
