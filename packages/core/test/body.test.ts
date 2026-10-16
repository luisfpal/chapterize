import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chapterIndex, detect, openEpub, readingChapters } from '../src/index.js';
import type { Book, Chapter } from '../src/index.js';
import { shortFirstChapterBook } from './fixtures/build-epub.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function textOf(book: Book, chapter: Chapter): string {
  return book.blocks
    .slice(chapter.start, chapter.end)
    .map((block) => block.text)
    .join('\n');
}

function readBook(path: string): { book: Book; chapters: Chapter[] } {
  const book = openEpub(readFileSync(path));
  return { book, chapters: readingChapters(book, detect(book).cuts, 200) };
}

describe('a contents label names a chapter only when it numbers one', () => {
  it('reads arabic, roman, a glued numeral, and an ordinal', () => {
    expect(chapterIndex('Chapter 1')).toEqual({ scheme: 'chapter', n: 1 });
    expect(chapterIndex('LAW 3')).toEqual({ scheme: 'law', n: 3 });
    expect(chapterIndex('Chapter I. LAYING PLANS')).toEqual({ scheme: 'chapter', n: 1 });
    expect(chapterIndex('CHAPTERXXVII.')).toEqual({ scheme: 'chapter', n: 27 });
    expect(chapterIndex('CHAPTER LXI.')).toEqual({ scheme: 'chapter', n: 61 });
    expect(chapterIndex('I hope Mr. Bingley will like it. CHAPTER II.')).toEqual({
      scheme: 'chapter',
      n: 2,
    });
    expect(chapterIndex('THE FIRST BOOK')).toEqual({ scheme: 'book', n: 1 });
    expect(chapterIndex('HIS FIRST BOOK')).toEqual({ scheme: 'book', n: 1 });
    expect(chapterIndex('THE TWELFTH BOOK')).toEqual({ scheme: 'book', n: 12 });
  });

  it('does not treat a part, a bare heading, or a caption without a number as a chapter', () => {
    expect(chapterIndex('Part One')).toBeNull();
    expect(chapterIndex('BOOKS')).toBeNull();
    expect(chapterIndex('Front matter')).toBeNull();
    expect(chapterIndex('INTRODUCTION Sun Wu and his Book')).toBeNull();
    expect(chapterIndex('Paragraphs with First Lines')).toBeNull();
    expect(chapterIndex('Salt')).toBeNull();
  });
});

describe('the chapters a reader opens', () => {
  it('keeps a short first chapter and leaves the preface and the license out', () => {
    const book = openEpub(shortFirstChapterBook());
    const chapters = readingChapters(book, detect(book).cuts, 200);
    expect(chapters).toHaveLength(2);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      'Chapter I — A short opening.',
      'Chapter II',
    ]);
    const first = chapters[0];
    const second = chapters[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(first.start).toBeGreaterThan(0);
    expect(textOf(book, first)).toContain('A short opening.');
    expect(textOf(book, first)).not.toContain('preface is not a numbered chapter');
    expect(textOf(book, second)).not.toContain('license is back matter');
    expect(chapters.some((chapter) => chapter.title === 'Front matter')).toBe(false);
  });

  it('reads the thirteen chapters of The Art of War', () => {
    const book = openEpub(readFileSync(join(fixtures, 'pg132.epub')));
    const detection = detect(book);
    const chapters = readingChapters(book, detection.cuts, 200);
    expect(chapters).toHaveLength(13);
    expect(chapters[0]?.title).toContain('LAYING PLANS');
    expect(chapters[12]?.title).toContain('THE USE OF SPIES');
    const first = chapters[0];
    const last = chapters[12];
    const license = detection.cuts.find((cut) => /LICENSE/.test(cut.title));
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(license).toBeDefined();
    if (first === undefined || last === undefined || license === undefined) return;
    expect(textOf(book, first)).toContain('The art of war is of vital importance to the State.');
    expect(textOf(book, first)).not.toContain('Preface by Lionel Giles');
    expect(last.end).toBe(license.at);
    expect(chapters.some((chapter) => /LICENSE|Front matter/.test(chapter.title))).toBe(false);
  });

  it('reads the twelve books of the Meditations', () => {
    const { book, chapters } = readBook(join(fixtures, 'pg2680.epub'));
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      'THE FIRST BOOK',
      'THE SECOND BOOK',
      'THE THIRD BOOK',
      'THE FOURTH BOOK',
      'THE FIFTH BOOK',
      'THE SIXTH BOOK',
      'THE SEVENTH BOOK',
      'THE EIGHTH BOOK',
      'THE NINTH BOOK',
      'THE TENTH BOOK',
      'THE ELEVENTH BOOK',
      'THE TWELFTH BOOK',
    ]);
    const first = chapters[0];
    const last = chapters[11];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;
    expect(textOf(book, first)).toContain('Of my grandfather Verus');
    expect(textOf(book, first)).not.toContain('HIS FIRST BOOK');
    expect(textOf(book, last)).not.toContain('APPENDIX');
  });

  it.skipIf(!existsSync(join(homedir(), 'chz-books', 'pg1342.epub')))(
    'reads the sixty-one chapters of Pride and Prejudice',
    () => {
      const path = join(homedir(), 'chz-books', 'pg1342.epub');
      const book = openEpub(readFileSync(path));
      const detection = detect(book);
      const chapters = readingChapters(book, detection.cuts, 200);
      expect(chapters).toHaveLength(61);
      expect(chapters[0]?.title).not.toMatch(/Gutenberg/);
      expect(chapters[60]?.title).toMatch(/LXI/);
      const first = chapters[0];
      const last = chapters[60];
      const license = detection.cuts.find((cut) => /LICENSE/.test(cut.title));
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      expect(license).toBeDefined();
      if (first === undefined || last === undefined || license === undefined) return;
      expect(textOf(book, first)).toContain('truth universally acknowledged');
      expect(textOf(book, first)).not.toContain('Project Gutenberg');
      expect(last.end).toBe(license.at);
      expect(chapters.some((chapter) => /LICENSE|Front matter/.test(chapter.title))).toBe(false);
    },
  );
});
