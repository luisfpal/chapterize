import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  countWords, deriveTitles, detect, findBoilerplate, mergeStubs, readingMinutes, slugify,
  toChapters,
} from '@chapterize/core';
import type { Book, Chapter } from '@chapterize/core';
import { CliError } from './errors.js';
import { renderBody, renderChapterPage, renderIndex, type IndexRow } from './html.js';
import { chapterEpub, imageFileNames } from './mini-epub.js';

/** Same threshold the desktop uses, so a book splits the same way in both places. */
const STUB_CHARS = 200;

export interface Prepared {
  book: Book;
  chapters: Chapter[];
  words: number[];
  minutes: number[];
  warnings: string[];
}

export interface BundleFile {
  /** Path inside the bundle, using `/`, never absolute and never `..`. */
  path: string;
  data: Uint8Array;
}

export function prepare(book: Book): Prepared {
  const detection = detect(book);
  const cuts = mergeStubs(detection.cuts, book.blocks, STUB_CHARS);
  const chapters = deriveTitles(toChapters(cuts, book.blocks), book.blocks);
  const words = chapters.map((chapter) => countWords(
    book.blocks.slice(chapter.start, chapter.end).map((block) => block.text).join(' '),
  ));
  const minutes = words.map((count) => readingMinutes(count));
  const warnings: string[] = [];
  const real = detection.unresolved.filter((entry) => entry.reason !== 'document-has-no-text');
  if (real.length) {
    warnings.push(
      `${real.length} table-of-contents ${real.length === 1 ? 'entry' : 'entries'} could not be located; ` +
      'those chapters start at the top of their file.',
    );
  }
  if (detection.strategy !== 'toc') {
    warnings.push(
      `This book has no usable table of contents, so chapters were found from ${
        detection.strategy === 'heading' ? 'headings' : 'file boundaries'
      }. Check the split before relying on it.`,
    );
  }
  return { book, chapters, words, minutes, warnings };
}

/** 1-based. The Files app shows this name, and the first chapter is not "000". */
export function chapterBase(chapter: Chapter): string {
  return `${String(chapter.index + 1).padStart(3, '0')}-${slugify(chapter.title)}`;
}

export function bookSlug(title: string, author?: string): string {
  return slugify(author ? `${title} ${author}` : title, 80);
}

function asset(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../assets/${name}`, import.meta.url))));
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function buildBundle(book: Book, opts: { epubs: boolean }): { files: BundleFile[]; prepared: Prepared } {
  if (book.blocks.length === 0) {
    throw new CliError(
      `"${book.metadata.title}" has no readable text. If it came from a store it may be DRM-protected, which has to be removed before it can be opened.`,
    );
  }
  const prepared = prepare(book);
  if (prepared.chapters.length === 0) {
    throw new CliError(`"${book.metadata.title}" produced no chapters.`);
  }

  const names = imageFileNames(book.images.keys());
  const boilerplate = findBoilerplate(prepared.chapters, book.blocks);
  const lang = book.metadata.language ?? 'en';
  const slug = bookSlug(book.metadata.title, book.metadata.author);
  const bases = prepared.chapters.map(chapterBase);
  const files: BundleFile[] = [];
  const rows: IndexRow[] = [];
  const manifestChapters: Record<string, string | number>[] = [];

  for (let i = 0; i < prepared.chapters.length; i++) {
    const chapter = prepared.chapters[i]!;
    const base = bases[i]!;
    const file = `chapters/${base}.html`;
    const epubPath = `epub/${base}.epub`;
    const prev = i > 0 ? `${bases[i - 1]}.html` : undefined;
    const next = i + 1 < bases.length ? `${bases[i + 1]}.html` : undefined;
    let left = 0;
    for (let j = i; j < prepared.minutes.length; j++) left += prepared.minutes[j]!;
    const rendered = renderBody({
      blocks: book.blocks.slice(chapter.start, chapter.end),
      notes: book.notes,
      imageSrc: (imagePath) => {
        const name = names.get(imagePath);
        return name && book.images.has(imagePath) ? `../images/${name}` : null;
      },
      chapterTitle: chapter.title,
      bookTitle: book.metadata.title,
      boilerplate,
    });
    const page = renderChapterPage({
      lang,
      bookTitle: book.metadata.title,
      bookSlug: slug,
      chapterTitle: chapter.title,
      index: chapter.index,
      total: prepared.chapters.length,
      minutes: prepared.minutes[i]!,
      leftMinutes: left,
      file,
      ...(prev !== undefined ? { prevHref: prev } : {}),
      ...(next !== undefined ? { nextHref: next, nextTitle: prepared.chapters[i + 1]!.title } : {}),
      ...(opts.epubs ? { epubHref: `../${epubPath}` } : {}),
      body: rendered.body,
      notesHtml: rendered.notesHtml,
    });
    files.push({ path: file, data: utf8(page) });
    if (opts.epubs) {
      files.push({
        path: epubPath,
        data: chapterEpub(book, chapter, names, boilerplate),
      });
    }
    rows.push({
      href: file,
      title: chapter.title,
      minutes: prepared.minutes[i]!,
      depth: chapter.depth,
      n: i + 1,
    });
    const row: Record<string, string | number> = {
      index: chapter.index,
      title: chapter.title,
      file,
      minutes: prepared.minutes[i]!,
      words: prepared.words[i]!,
      depth: chapter.depth,
    };
    if (opts.epubs) row.epub = epubPath;
    manifestChapters.push(row);
  }

  const total = prepared.minutes.reduce((sum, n) => sum + n, 0);
  const index = renderIndex({
    lang,
    bookTitle: book.metadata.title,
    ...(book.metadata.author !== undefined ? { author: book.metadata.author } : {}),
    bookSlug: slug,
    totalMinutes: total,
    rows,
  });
  const manifest: Record<string, unknown> = {
    title: book.metadata.title,
    ...(book.metadata.author !== undefined ? { author: book.metadata.author } : {}),
    ...(book.metadata.language !== undefined ? { language: book.metadata.language } : {}),
    chapters: manifestChapters,
  };

  files.push({ path: 'index.html', data: utf8(index) });
  files.push({ path: 'reader.css', data: asset('reader.css') });
  files.push({ path: 'reader.js', data: asset('reader.js') });
  files.push({ path: 'book.json', data: utf8(JSON.stringify(manifest, null, 2) + '\n') });
  for (const [imagePath, bytes] of book.images) {
    const name = names.get(imagePath);
    if (name) files.push({ path: `images/${name}`, data: bytes });
  }
  return { files, prepared };
}
