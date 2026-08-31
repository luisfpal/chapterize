import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openEpub, resolvePath } from '../src/epub.js';
import { detect, detectFromToc } from '../src/detect.js';
import { toChapters, limitCount, mergeSmall } from '../src/chapters.js';
import { deriveTitles } from '../src/titles.js';
import { allBooks, libraryAvailable, loadBook } from './fixtures.js';

describe('resolvePath', () => {
  it('resolves relative to the referring document, not the zip root', () => {
    expect(resolvePath('OEBPS/content.opf', 'text/ch1.xhtml')).toBe('OEBPS/text/ch1.xhtml');
    expect(resolvePath('content.opf', 'OEBPS/part1.xhtml')).toBe('OEBPS/part1.xhtml');
  });
  it('walks out of directories with ..', () => {
    expect(resolvePath('OEBPS/text/nav.xhtml', '../images/a.png')).toBe('OEBPS/images/a.png');
  });
});

describe.runIf(libraryAvailable())('real library', () => {
  it('opens every book without throwing', () => {
    for (const path of allBooks()) {
      const book = openEpub(new Uint8Array(readFileSync(path)));
      expect(book.spine.length, basename(path)).toBeGreaterThan(0);
      expect(book.blocks.length, basename(path)).toBeGreaterThan(0);
    }
  });

  it('produces more than one chapter for every book', () => {
    for (const path of allBooks()) {
      const book = openEpub(new Uint8Array(readFileSync(path)));
      const { cuts } = detect(book);
      expect(cuts.length, basename(path)).toBeGreaterThan(1);
    }
  });

  it('every chapter is non-empty and chapters tile the book exactly', () => {
    for (const path of allBooks()) {
      const book = openEpub(new Uint8Array(readFileSync(path)));
      const chapters = toChapters(detect(book).cuts, book.blocks);
      expect(chapters[0]!.start, basename(path)).toBe(0);
      expect(chapters[chapters.length - 1]!.end, basename(path)).toBe(book.blocks.length);
      for (let i = 1; i < chapters.length; i++) {
        expect(chapters[i]!.start, basename(path)).toBe(chapters[i - 1]!.end);
      }
    }
  });
});

describe.runIf(libraryAvailable())('The 48 Laws of Power — EPUB 2, NCX, one file per chapter', () => {
  const book = openEpub(loadBook('Laws of Power'));

  it('reads EPUB 2 metadata and the NCX table of contents', () => {
    expect(book.metadata.epubVersion).toBe('2.0');
    expect(book.tocSource).toBe('ncx');
    expect(book.metadata.title).toContain('48 Laws of Power');
    expect(book.spine.length).toBe(53);
  });

  it('detects roughly one chapter per law', () => {
    const { cuts, unresolved } = detectFromToc(book);
    expect(cuts.length).toBeGreaterThanOrEqual(50);
    expect(unresolved).toHaveLength(0);
  });

  it('recovers the real law titles that live in no heading', () => {
    const chapters = deriveTitles(toChapters(detect(book).cuts, book.blocks), book.blocks);
    const titles = chapters.map((c) => c.title).join('\n');
    expect(titles).toMatch(/Never Outshine the Master/i);
    expect(titles).toMatch(/Conceal Your Intentions/i);
  });

  it('does not name every chapter after the book, which the raw h1 would', () => {
    const chapters = deriveTitles(toChapters(detect(book).cuts, book.blocks), book.blocks);
    const repeats = chapters.filter((c) => /^48 Laws of Power$/i.test(c.title));
    expect(repeats).toHaveLength(0);
  });

  it('joins a display title split across several elements', () => {
    const chapters = deriveTitles(toChapters(detect(book).cuts, book.blocks), book.blocks);
    const law7 = chapters.find((c) => /LAW 7\b/i.test(c.title));
    expect(law7?.title).toMatch(/Get Others to Do the Work/i);
  });
});

describe.runIf(libraryAvailable())('structural edge cases across the library', () => {
  it('Word Power: 362 spine files collapse into ~29 chapters spanning many files each', () => {
    const book = openEpub(loadBook('Word Power'));
    expect(book.spine.length).toBeGreaterThan(300);
    const chapters = toChapters(detect(book).cuts, book.blocks);
    expect(chapters.length).toBeLessThan(60);
    const spread = chapters.map(
      (c) => new Set(book.blocks.slice(c.start, c.end).map((b) => b.path)).size,
    );
    expect(Math.max(...spread)).toBeGreaterThan(1);
  });

  it('Olly Richards: every TOC href carries a fragment and all of them resolve', () => {
    const book = openEpub(loadBook('Olly Richards - English Short Stories'));
    expect(book.toc.filter((t) => t.fragment !== undefined).length).toBeGreaterThan(0);
    expect(detectFromToc(book).unresolved).toHaveLength(0);
  });

  it('Practice Makes Perfect: EPUB 3 nav, ignoring the page-list nav', () => {
    const book = openEpub(loadBook('Practice makes perfect'));
    expect(book.metadata.epubVersion).toBe('3.0');
    expect(book.tocSource).toBe('nav');
    // The book also ships <nav epub:type="page-list"> with 174 print-page
    // anchors and a <nav epub:type="landmarks">. Only the toc nav is a table of
    // contents; counting the others would invent ~174 phantom chapters.
    expect(book.toc.length).toBeLessThan(30);
    expect(detect(book).cuts.length).toBeLessThan(30);
  });

  it('reports an image-only cover as empty rather than as a broken spine', () => {
    const book = openEpub(loadBook('Practice makes perfect'));
    const { unresolved } = detectFromToc(book);
    expect(unresolved.every((u) => u.reason === 'document-has-no-text')).toBe(true);
  });

  it('English for Everyone: 100+ chapters, including a genuine mid-file cut', () => {
    const book = openEpub(loadBook('English for Everyone'));
    const { cuts } = detect(book);
    expect(cuts.length).toBeGreaterThan(100);
    const perFile = new Map<string, number>();
    for (const cut of cuts) {
      const path = book.blocks[cut.at]!.path;
      perFile.set(path, (perFile.get(path) ?? 0) + 1);
    }
    expect(Math.max(...perFile.values())).toBeGreaterThan(1);
    const limited = limitCount(cuts, book.blocks, 50);
    expect(limited.length).toBeLessThanOrEqual(50);
    const chapters = toChapters(limited, book.blocks);
    expect(chapters[chapters.length - 1]!.end).toBe(book.blocks.length);
  });

  it('mergeSmall removes cover and copyright stubs without dropping content', () => {
    const book = openEpub(loadBook('Laws of Power'));
    const { cuts } = detect(book);
    const merged = mergeSmall(cuts, book.blocks, 500);
    expect(merged.length).toBeLessThanOrEqual(cuts.length);
    expect(toChapters(merged, book.blocks).at(-1)!.end).toBe(book.blocks.length);
  });
});
