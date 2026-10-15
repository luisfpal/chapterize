import { describe, expect, it } from 'vitest';
import {
  annotationRange, chapterFilename, countWords, deriveTitles, detect,
  imageFilename, mergeStubs, openEpub, readingMinutes, renderChapter,
  toChapters, withHighlights, type Book,
} from '../src/index.js';
import {
  duplicateImageBook, enumeratorBook, epubZip, harborBook,
  missingFragmentBook, ncxBook, numberedNoteBook, pageListOnlyBook,
  partDividerBook, shortHeadingBook, tocAfterPageList, wrappedNavBook,
} from './fixtures/build-epub.js';

/**
 * The same steps the importer runs, without the disk.
 * Split, then markdown. Highlights are applied by the exporter on top.
 */
function pipeline(bytes: Uint8Array) {
  const book = openEpub(bytes);
  const detection = detect(book);
  const cuts = mergeStubs(detection.cuts, book.blocks, 200);
  const chapters = deriveTitles(toChapters(cuts, book.blocks), book.blocks);
  const files = chapters.map((chapter) => {
    const words = countWords(
      book.blocks.slice(chapter.start, chapter.end).map((b) => b.text).join(' '),
    );
    return {
      file: chapterFilename(chapter, chapter.title),
      markdown: renderChapter(chapter, book.blocks, chapter.title, {
        bookTitle: book.metadata.title,
        ...(book.metadata.author !== undefined ? { author: book.metadata.author } : {}),
        totalChapters: chapters.length,
        notes: book.notes,
        minutes: readingMinutes(words),
      }),
    };
  });
  return { book, detection, chapters, files };
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Annotation offsets are only meaningful when the markup's text is the block's text. */
function expectTextMatchesMarkup(book: Book): void {
  for (const block of book.blocks) {
    expect(visibleText(block.html)).toBe(block.text);
  }
}

function expectTiles(book: Book): void {
  const chapters = toChapters(detect(book).cuts, book.blocks);
  expect(chapters[0]?.start).toBe(0);
  expect(chapters.at(-1)?.end).toBe(book.blocks.length);
  for (let i = 1; i < chapters.length; i++) {
    expect(chapters[i]!.start).toBe(chapters[i - 1]!.end);
  }
}

describe('synthetic books through split, markdown, and highlights', () => {
  it('exports two chapters, the footnote, the quote, the list, and the sentence around the figure', () => {
    const { book, detection, chapters, files } = pipeline(harborBook());

    expect(book.metadata.title).toBe('Harbor Notes');
    expect(book.metadata.author).toBe('N. Harbor');
    expect(book.metadata.epubVersion).toBe('3.0');
    expect(book.tocSource).toBe('nav');
    expect(book.toc.map((entry) => entry.label)).toEqual(['Salt', 'Iron']);
    expect(detection.unresolved).toEqual([]);
    expect(detection.strategy).toBe('toc');

    expect(chapters.map((c) => c.title)).toEqual(['Salt', 'Iron']);
    expect(chapters[0]!.start).toBe(0);
    expect(chapters[1]!.start).toBeGreaterThan(0);
    expect(chapters[1]!.end).toBe(book.blocks.length);
    expect(files.map((f) => f.file)).toEqual(['000-salt.md', '001-iron.md']);

    const salt = book.blocks.find((b) => b.text.includes('rope held'));
    expect(salt?.text).toBe('The rope held fast* against the wind, and the crew slept.');
    expect(salt?.noterefs).toHaveLength(1);
    expect(salt?.noterefs?.[0]?.key).toBe('OEBPS/notes.xhtml#n1');
    expect(salt?.ids).toEqual([]);

    const saltMd = files[0]!.markdown;
    expect(saltMd).toContain('fast[^1] against');
    expect(saltMd).toContain('[^1]: Measured at dawn.');
    expect(saltMd).toContain('Tom & Jerry sailed at dusk.');
    expect(saltMd).not.toContain('<noteref>');
    // The display title was not swallowed into the paragraph under it.
    expect(saltMd).toContain('NEVER TRUST A');
    expect(saltMd).toContain('QUIET HARBOR');

    const ironMd = files[1]!.markdown;
    expect(ironMd).toContain('> A harbor is a *promise* the sea keeps breaking.');
    expect(ironMd).toContain('- Coil the rope.');
    expect(ironMd).toContain('- Count the **oars**.');
    expect(ironMd).toContain('Hello harbor and see the chart before sailing.');
    expect(ironMd).not.toContain('Helloharbor');
    expect(ironMd).toContain('![Depth chart](images/OEBPS_img_chart.png)');
    expect(ironMd).toContain('The loose sentence belongs in the chapter.');
    expect(book.images.get('OEBPS/img/chart.png')).toEqual(new Uint8Array([137, 80, 78, 71, 1]));

    const at = salt!.text.indexOf('rope held');
    const span = annotationRange(salt!.text, at - 1, at + 'rope held'.length + 1);
    expect(span).toEqual({ start: at, end: at + 'rope held'.length, quote: 'rope held' });
    const exported = withHighlights(saltMd, [{ quote: span!.quote, note: 'Check the knot.' }]);
    expect(exported).toContain('## My highlights');
    expect(exported).toContain('> rope held');
    expect(exported).toContain('Check the knot.');
    expect(exported.match(/## My highlights/g)).toHaveLength(1);
    // The chapter prose is still there, ahead of the reader's notes.
    expect(exported.indexOf('fast[^1]')).toBeLessThan(exported.indexOf('## My highlights'));

    expectTextMatchesMarkup(book);
    expectTiles(book);
  });

  it('does not turn a page-list into chapters when it is the only nav', () => {
    const book = openEpub(pageListOnlyBook());
    expect(book.toc).toEqual([]);
    expect(book.tocSource).toBe('none');
    const detection = detect(book);
    expect(detection.strategy).toBe('heading');
    expect(detection.cuts.map((c) => c.title)).toEqual(['Salt', 'Iron']);
  });

  it('reads the contents nav that follows a page-list, labeled or not', () => {
    for (const kind of ['unlabeled', 'role'] as const) {
      const book = openEpub(tocAfterPageList(kind));
      expect(book.toc.map((e) => e.label), kind).toEqual(['Salt', 'Iron']);
      const titles = detect(book).cuts.map((c) => c.title);
      expect(titles, kind).toEqual(['Salt', 'Iron']);
      expect(titles, kind).not.toContain('1');
    }
  });

  it('reads a table of contents whose list is wrapped in another element', () => {
    const book = openEpub(wrappedNavBook());
    expect(book.toc.map((e) => e.label)).toEqual(['Salt', 'Iron']);
    expect(detect(book).cuts.map((c) => c.title)).toEqual(['Salt', 'Iron']);
  });

  it('reports a fragment the book does not contain, and still places the one it does', () => {
    const book = openEpub(missingFragmentBook());
    const detection = detect(book);
    expect(detection.unresolved.map((u) => u.reason)).toEqual(['fragment-not-found']);
    const salt = book.blocks.findIndex((b) => b.ids.includes('salt'));
    expect(salt).toBeGreaterThan(0);
    expect(detection.cuts.map((c) => c.at)).toContain(salt);
    expectTiles(book);
  });

  it('keeps headings in a pamphlet a one-third rule would have discarded', () => {
    const book = openEpub(shortHeadingBook());
    expect(book.blocks).toHaveLength(4);
    const detection = detect(book);
    expect(detection.strategy).toBe('heading');
    expect(detection.cuts.map((c) => c.title)).toEqual(['Salt', 'Iron']);
  });

  it('keeps a number that begins a footnote, and still strips a real marker', () => {
    const book = openEpub(numberedNoteBook());
    expect(book.notes.get('OEBPS/notes.xhtml#n1')).toBe('Measured at dawn.');
    expect(book.notes.get('OEBPS/notes.xhtml#n2')).toBe('12 men remained on the wall.');
    expect(book.notes.get('OEBPS/notes.xhtml#n3')).toBe('The tide turned after all.');
  });

  it('gives two figures that share a basename different files', () => {
    const { book, files } = pipeline(duplicateImageBook());
    const paths = [...book.images.keys()];
    expect(paths).toHaveLength(2);
    const names = paths.map((p) => imageFilename(p));
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).not.toMatch(/[\\/]/);
    const md = files.map((f) => f.markdown).join('\n');
    expect(md).toContain(`images/${names[0]}`);
    expect(md).toContain(`images/${names[1]}`);
    expect(md).toContain('First mark');
    expect(md).toContain('Second mark');
    expect(book.images.get('OEBPS/a/mark.png')).toEqual(new Uint8Array([1, 2, 3]));
    expect(book.images.get('OEBPS/b/mark.png')).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('appends a recovered name only when the label is a bare enumerator', () => {
    const { chapters } = pipeline(enumeratorBook());
    expect(chapters.map((c) => c.title)).toEqual([
      'Chapter 1 — Never Trust a Quiet Harbor',
      'Iron',
    ]);
  });

  it('folds a part divider into the chapter it introduces', () => {
    const { chapters, files } = pipeline(partDividerBook());
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBe('Salt');
    expect(chapters[0]!.start).toBe(0);
    expect(files[0]!.markdown).toContain('Part One');
    expect(files[0]!.markdown).toContain('The part heading belongs to this chapter');
  });

  it('reads an EPUB 2 NCX as one chapter per file', () => {
    const { book, detection, chapters } = pipeline(ncxBook());
    expect(book.metadata.epubVersion).toBe('2.0');
    expect(book.tocSource).toBe('ncx');
    expect(detection.strategy).toBe('toc');
    expect(chapters.map((c) => c.title)).toEqual(['Salt', 'Iron']);
    expect(new Set(book.blocks.map((b) => b.path)).size).toBe(2);
  });

  it('says what is wrong with a file that is not an EPUB', () => {
    expect(() => openEpub(new Uint8Array([1, 2, 3]))).toThrow(/Not a readable EPUB/);
    expect(() => openEpub(epubZip({ 'readme.txt': 'not a book' }))).toThrow(/container\.xml/);
  });

  it('keeps markup text equal to block text in every synthetic book', () => {
    for (const bytes of [
      harborBook(), pageListOnlyBook(), tocAfterPageList('unlabeled'),
      wrappedNavBook(), missingFragmentBook(), shortHeadingBook(),
      numberedNoteBook(), duplicateImageBook(), enumeratorBook(),
      partDividerBook(), ncxBook(),
    ]) {
      const book = openEpub(bytes);
      expectTextMatchesMarkup(book);
      expectTiles(book);
      expect(book.blocks.length).toBeGreaterThan(0);
    }
  });
});

describe('highlights appended to an exported chapter', () => {
  it('leaves the chapter alone when there is nothing to append', () => {
    const md = '# Salt\n\nThe rope held.\n';
    expect(withHighlights(md, [])).toBe(md);
    expect(withHighlights(md, [{ quote: '   ', note: 'nope' }])).toBe(md);
  });

  it('quotes every line of a highlight that contains a line break', () => {
    const md = withHighlights('# Salt\n\nProse.\n', [{
      quote: 'first line\nsecond line',
      note: 'Kept.',
    }]);
    expect(md).toContain('> first line\n> second line');
    expect(md).toContain('Kept.');
    expect(md.startsWith('# Salt')).toBe(true);
  });
});
