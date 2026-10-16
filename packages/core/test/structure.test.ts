import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { EpubError, openEpub } from '../src/epub.js';
import { must } from '../src/must.js';
import { detect, detectFromHeadings, detectFromToc, explainUnresolved } from '../src/detect.js';
import {
  limitCount,
  mergeSmall,
  mergeStubs,
  mergeUp,
  retitle,
  splitAt,
  toChapters,
} from '../src/chapters.js';
import { deriveTitles } from '../src/titles.js';
import { renderChapter } from '../src/markdown.js';
import type { Block, Book, CutPoint } from '../src/types.js';
import { buildEpub, type ChapterFile, type TocItem } from './build-epub.js';

/**
 * The behaviours below used to run only when CHAPTERIZE_FIXTURES pointed at a
 * private shelf, so a fresh clone reported them as skipped. The books here are
 * original. They reproduce the structures those shelf tests were pinning:
 * EPUB 2 NCX, EPUB 3 nav, page-list, fragments, one chapter across many files,
 * a chapter that starts mid-file, wrapped lines, footnotes, images.
 */

function prose(seed: string): string {
  return [
    `<p>${seed} The river kept its own hours, and the keeper wrote them down so the next watch would know where the sand had shifted overnight.</p>`,
    '<p>A second paragraph already ends, so it must not be glued to the next one.</p>',
    '<p>A third paragraph keeps a heading from being the whole file.</p>',
  ].join('\n');
}

function chapter(href: string, body: string, extra: Partial<ChapterFile> = {}): ChapterFile {
  return { href, body, ...extra };
}

function open(bytes: Uint8Array): Book {
  return openEpub(bytes);
}

function titlesOf(book: Book, cuts = detect(book).cuts): string[] {
  return deriveTitles(toChapters(cuts, book.blocks), book.blocks).map((c) => c.title);
}

function expectTiling(book: Book, cuts: CutPoint[] = detect(book).cuts): void {
  const chapters = toChapters(cuts, book.blocks);
  expect(chapters.length).toBeGreaterThan(0);
  expect(must(chapters[0], 'chapters[0]').start).toBe(0);
  expect(must(chapters.at(-1), 'chapters.at(-1)').end).toBe(book.blocks.length);
  for (let i = 1; i < chapters.length; i++) {
    expect(must(chapters[i], 'chapters[i]').start).toBe(
      must(chapters[i - 1], 'chapters[i - 1]').end,
    );
  }
  for (const chapter of chapters) expect(chapter.end).toBeGreaterThan(chapter.start);
}

function htmlText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

describe('EPUB 2 NCX', () => {
  const bytes = buildEpub({
    title: 'Field Notes on Rivers',
    author: 'A. Keeper',
    language: 'en',
    version: '2.0',
    tocKind: 'ncx',
    ncxPageTargets: 40,
    prefixed: true,
    chapters: [
      chapter('OEBPS/cover.xhtml', '<p>Cover</p>'),
      ...[1, 2, 3, 4].map((n) => {
        // A converted display title arrives as one element per printed line.
        const titles = [
          ['NEVER', 'DIM THE', 'LANTERN'],
          ['KEEP', 'THE MATCH', 'DRY'],
          ['COUNT', 'THE', 'BOATS'],
          ['LEAVE', 'THE', 'GATE'],
        ];
        const lines = must(titles[n - 1], `display lines for law ${n}`);
        return chapter(
          `OEBPS/law${n}.xhtml`,
          `<h1>Field Notes on Rivers</h1><h2>LAW ${n}</h2>${lines.map((line) => `<p>${line}</p>`).join('')}${prose(`Law ${n}.`)}`,
        );
      }),
    ],
    toc: [
      { label: 'Cover', href: 'cover.xhtml' },
      { label: 'LAW 1', href: 'law1.xhtml' },
      { label: 'LAW 2', href: 'law2.xhtml' },
      { label: 'LAW 3', href: 'law3.xhtml' },
      { label: 'LAW 4', href: 'law4.xhtml' },
    ],
  });

  it('reads EPUB 2 metadata and the NCX, including a prefixed package document', () => {
    const book = open(bytes);
    expect(book.metadata.epubVersion).toBe('2.0');
    expect(book.metadata.title).toBe('Field Notes on Rivers');
    expect(book.metadata.author).toBe('A. Keeper');
    expect(book.metadata.language).toBe('en');
    expect(book.tocSource).toBe('ncx');
    expect(book.spine.length).toBe(5);
    // Forty page targets live in the NCX pageList and are not chapters.
    expect(book.toc).toHaveLength(5);
  });

  it('resolves one cut per contents entry', () => {
    const book = open(bytes);
    const { cuts, unresolved } = detectFromToc(book);
    expect(unresolved).toHaveLength(0);
    expect(cuts.length).toBeGreaterThanOrEqual(5);
    expectTiling(book, cuts);
  });

  it('recovers a display title that lives in no heading when the label is only an enumerator', () => {
    const book = open(bytes);
    const titles = titlesOf(book);
    expect(titles).toContain('LAW 1 — Never Dim the Lantern');
    expect(titles.join('\n')).toMatch(/Keep the Match Dry/i);
  });

  it('does not name every chapter after the running header', () => {
    const book = open(bytes);
    const titles = titlesOf(book);
    const named = titles.filter((t) => t === 'Field Notes on Rivers');
    expect(named).toHaveLength(0);
    expect(new Set(titles.map((t) => t.toLowerCase())).size).toBe(titles.length);
  });

  it('finds the NCX by its media type when the spine forgets toc=""', () => {
    const book = open(
      buildEpub({
        version: '2.0',
        tocKind: 'ncx',
        ncxOnSpine: false,
        chapters: [chapter('OEBPS/a.xhtml', prose('A')), chapter('OEBPS/b.xhtml', prose('B'))],
        toc: [
          { label: 'A', href: 'a.xhtml' },
          { label: 'B', href: 'b.xhtml' },
        ],
      }),
    );
    expect(book.tocSource).toBe('ncx');
    expect(book.toc.map((t) => t.label)).toEqual(['A', 'B']);
  });
});

describe('EPUB 3 nav', () => {
  const pageList = Array.from({ length: 30 }, (_, i) => ({
    label: String(i + 1),
    href: `ch1.xhtml#p${i}`,
  }));

  it('prefers the nav over the NCX, and ignores page-list and landmarks', () => {
    const book = open(
      buildEpub({
        version: '3.0',
        tocKind: 'both',
        pageList,
        chapters: [
          chapter('OEBPS/ch1.xhtml', prose('One')),
          chapter('OEBPS/ch2.xhtml', prose('Two')),
        ],
        toc: [
          { label: 'From the nav', href: 'ch1.xhtml' },
          { label: 'Also the nav', href: 'ch2.xhtml' },
        ],
        ncxToc: [
          { label: 'From the ncx', href: 'ch1.xhtml' },
          { label: 'Also the ncx', href: 'ch2.xhtml' },
        ],
      }),
    );
    expect(book.metadata.epubVersion).toBe('3.0');
    expect(book.tocSource).toBe('nav');
    expect(book.toc.map((t) => t.label)).toEqual(['From the nav', 'Also the nav']);
    expect(detect(book).cuts.length).toBeLessThan(10);
  });

  it('reads a nav whose list is wrapped, and whose properties="nav" was left off', () => {
    const book = open(
      buildEpub({
        version: '3.0',
        tocKind: 'nav',
        navProperties: false,
        navBody: `<nav epub:type="toc"><div><ol>
        <li><a href="ch1.xhtml">Wrapped</a></li>
        <li><a href="ch2.xhtml">Too</a></li>
      </ol></div></nav>`,
        chapters: [
          chapter('OEBPS/ch1.xhtml', prose('One')),
          chapter('OEBPS/ch2.xhtml', prose('Two')),
        ],
      }),
    );
    expect(book.tocSource).toBe('nav');
    expect(book.toc.map((t) => t.label)).toEqual(['Wrapped', 'Too']);
  });

  it('reads a contents list that is only anchors, with no ol', () => {
    const book = open(
      buildEpub({
        version: '3.0',
        tocKind: 'nav',
        navBody: `<nav epub:type="toc">
        <p><a href="ch1.xhtml">Plain</a></p>
        <p><a href="ch2.xhtml">Links</a></p>
      </nav>`,
        chapters: [
          chapter('OEBPS/ch1.xhtml', prose('One')),
          chapter('OEBPS/ch2.xhtml', prose('Two')),
        ],
      }),
    );
    expect(book.toc.map((t) => t.label)).toEqual(['Plain', 'Links']);
  });

  it('does not treat a page-list as the table of contents', () => {
    const book = open(
      buildEpub({
        version: '3.0',
        tocKind: 'nav',
        navBody: `<nav epub:type="page-list"><ol>${pageList.map((p) => `<li><a href="${p.href}">${p.label}</a></li>`).join('')}</ol></nav>`,
        chapters: [
          chapter('OEBPS/ch1.xhtml', `<h2>One</h2>${prose('One')}`),
          chapter('OEBPS/ch2.xhtml', `<h2>Two</h2>${prose('Two')}`),
        ],
      }),
    );
    expect(book.tocSource).toBe('none');
    expect(book.toc).toHaveLength(0);
    expect(detect(book).strategy).toBe('heading');
  });

  it('keeps nested contents depth', () => {
    const toc: TocItem[] = [
      {
        label: 'Part',
        href: 'part.xhtml',
        children: [
          {
            label: 'Chapter',
            href: 'part.xhtml#ch',
            children: [{ label: 'Scene', href: 'part.xhtml#sc' }],
          },
        ],
      },
      { label: 'After', href: 'after.xhtml' },
    ];
    const book = open(
      buildEpub({
        version: '3.0',
        chapters: [
          chapter(
            'OEBPS/part.xhtml',
            `<h1 id="part">Part</h1>${prose('Part')}<h2 id="ch">Chapter</h2>${prose('Chapter')}<h3 id="sc">Scene</h3>${prose('Scene')}`,
          ),
          chapter('OEBPS/after.xhtml', prose('After')),
        ],
        toc,
      }),
    );
    expect(book.toc.map((t) => [t.label, t.depth])).toEqual([
      ['Part', 0],
      ['Chapter', 1],
      ['Scene', 2],
      ['After', 0],
    ]);
    const chapters = toChapters(detectFromToc(book).cuts, book.blocks);
    expect(chapters.map((c) => c.depth)).toContain(2);
    expectTiling(book);
  });

  it('uses a nav that is only in the spine when the manifest forgot it', () => {
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [
          chapter(
            'OEBPS/ch1.xhtml',
            `<nav epub:type="toc"><ol><li><a href="ch1.xhtml#one">One</a></li><li><a href="ch2.xhtml">Two</a></li></ol></nav><h1 id="one">One</h1>${prose('One')}`,
          ),
          chapter('OEBPS/ch2.xhtml', prose('Two')),
        ],
      }),
    );
    expect(book.tocSource).toBe('nav');
    expect(book.toc.map((t) => t.label)).toEqual(['One', 'Two']);
    expect(detectFromToc(book).unresolved).toHaveLength(0);
  });
});

describe('fragments, anchors, and paths', () => {
  it('resolves ids on the body, on a wrapper, and on an inline span', () => {
    const book = open(
      buildEpub({
        chapters: [
          chapter(
            'OEBPS/ch.xhtml',
            `<div id="wrap"><p>Inside the wrapper, which is where this chapter actually starts.</p></div><p><span id="mid">The middle starts at the span.</span> More of the same sentence.</p><p>After the middle.</p>`,
            { bodyId: 'top' },
          ),
          chapter('OEBPS/other.xhtml', prose('Other')),
        ],
        toc: [
          { label: 'Top', href: 'ch.xhtml#top' },
          { label: 'Wrap', href: 'ch.xhtml#wrap' },
          { label: 'Mid', href: 'ch.xhtml#mid' },
          { label: 'Other', href: 'other.xhtml' },
        ],
      }),
    );
    const { cuts, unresolved } = detectFromToc(book);
    expect(unresolved).toHaveLength(0);
    const indexes = cuts.map((c) => c.at);
    expect(new Set(indexes).size).toBe(indexes.length);
    // `#top` is on <body> and `#wrap` is on the div around the first paragraph.
    // Both land on that paragraph, so they are one chapter. The earlier label wins.
    expect(indexes).toHaveLength(3);
    const opening = must(book.blocks[must(cuts[0], 'cuts[0]').at], 'opening block');
    expect(opening.text).toMatch(/Inside the wrapper/);
    expect(opening.ids).toEqual(expect.arrayContaining(['top', 'wrap']));
    expect(must(cuts[0], 'cuts[0]').title).toBe('Top');
    const mid = must(
      cuts.find((c) => c.title === 'Mid'),
      "cuts.find((c) => c.title === 'Mid')",
    );
    expect(must(book.blocks[mid.at], 'book.blocks[mid.at]').text).toMatch(
      /middle starts at the span/,
    );
    expect(must(book.blocks[mid.at], 'book.blocks[mid.at]').ids).toContain('mid');
    expect(cuts.some((c) => c.title === 'Other')).toBe(true);
  });

  it('resolves a fragment-only href against the nav document itself', () => {
    const book = open(
      buildEpub({
        tocKind: 'nav',
        navInSpine: true,
        navBody: `<nav epub:type="toc"><ol>
        <li><a href="#second">Second</a></li>
        <li><a href="ch1.xhtml">File</a></li>
      </ol></nav><h1 id="second">Second lives here</h1><p>Text after the heading in the nav document, long enough to be kept.</p>`,
        chapters: [chapter('OEBPS/ch1.xhtml', prose('File'))],
      }),
    );
    const { unresolved, cuts } = detectFromToc(book);
    expect(unresolved).toHaveLength(0);
    const second = must(
      cuts.find((c) => c.title === 'Second'),
      "cuts.find((c) => c.title === 'Second')",
    );
    expect(must(book.blocks[second.at], 'book.blocks[second.at]').text).toMatch(
      /Second lives here/,
    );
  });

  it('lands an empty anchor and a percent-encoded id on the paragraph they name', () => {
    const book = open(
      buildEpub({
        version: '2.0',
        tocKind: 'ncx',
        chapters: [
          chapter(
            'OEBPS/ch.xhtml',
            [
              '<a id="start"></a>',
              '<p>The chapter starts at the anchor, not on a blank line.</p>',
              '<p xml:id="mid-point">The middle of the file has its own name.</p>',
              prose('After'),
            ].join(''),
          ),
        ],
        toc: [
          { label: 'Start', href: 'ch.xhtml#start' },
          { label: 'Middle', href: 'ch.xhtml#mid%2Dpoint' },
        ],
      }),
    );
    const { cuts, unresolved } = detectFromToc(book);
    expect(unresolved).toHaveLength(0);
    const start = must(
      cuts.find((c) => c.title === 'Start'),
      "cuts.find((c) => c.title === 'Start')",
    );
    expect(must(book.blocks[start.at], 'book.blocks[start.at]').text).toMatch(
      /starts at the anchor/,
    );
    expect(must(book.blocks[start.at], 'book.blocks[start.at]').ids).toContain('start');
    const middle = must(
      cuts.find((c) => c.title === 'Middle'),
      "cuts.find((c) => c.title === 'Middle')",
    );
    expect(must(book.blocks[middle.at], 'book.blocks[middle.at]').text).toMatch(
      /middle of the file/,
    );
    expect(must(book.blocks[middle.at], 'book.blocks[middle.at]').ids).toContain('mid-point');
  });

  it('accepts absolute paths, backslashes, and a query string', () => {
    const book = open(
      buildEpub({
        chapters: [
          chapter('OEBPS/text/ch1.xhtml', prose('One')),
          chapter('OEBPS/text/ch2.xhtml', prose('Two')),
        ],
        toc: [
          { label: 'Absolute', href: '/OEBPS/text/ch1.xhtml' },
          { label: 'Slashes', href: 'text\\ch2.xhtml?rev=2' },
        ],
      }),
    );
    expect(detectFromToc(book).unresolved).toHaveLength(0);
    expect(detect(book).cuts).toHaveLength(2);
  });

  it('resolves a contents entry whose zip entry differs only by case', () => {
    const built = buildEpub({
      chapters: [
        chapter('OEBPS/ch1.xhtml', prose('One')),
        chapter('OEBPS/ch2.xhtml', prose('Two')),
      ],
      toc: [
        { label: 'One', href: 'ch1.xhtml' },
        { label: 'Two', href: 'ch2.xhtml' },
      ],
    });
    const entries = unzipSync(built);
    const moved: Record<string, Uint8Array> = {};
    for (const [key, value] of Object.entries(entries)) {
      moved[key === 'OEBPS/ch1.xhtml' ? 'OEBPS/CH1.XHTML' : key] = value;
    }
    const book = open(zipSync(moved));
    expect(detectFromToc(book).unresolved).toHaveLength(0);
    expect(book.blocks.some((b) => b.text.includes('river kept its own hours'))).toBe(true);
  });

  it('follows itemref order when the manifest lists files the other way', () => {
    const book = open(
      buildEpub({
        chapters: [
          chapter('OEBPS/a.xhtml', '<p>Alpha file.</p>'),
          chapter('OEBPS/b.xhtml', '<p>Beta file.</p>'),
          chapter('OEBPS/c.xhtml', '<p>Gamma file.</p>'),
        ],
        spineOrder: ['OEBPS/c.xhtml', 'OEBPS/a.xhtml', 'OEBPS/b.xhtml'],
        tocKind: 'none',
      }),
    );
    const paths = book.blocks.map((b) => b.path);
    expect(paths).toEqual(['OEBPS/c.xhtml', 'OEBPS/a.xhtml', 'OEBPS/b.xhtml']);
  });

  it('reports each kind of contents failure differently', () => {
    const book = open(
      buildEpub({
        chapters: [
          chapter('OEBPS/cover.xhtml', '<div class="cover"></div>'),
          chapter('OEBPS/ch.xhtml', `<p id="real">Present.</p>${prose('Present')}`),
        ],
        toc: [
          { label: 'Cover', href: 'cover.xhtml' },
          { label: 'Missing file', href: 'no-such.xhtml' },
          { label: 'Missing id', href: 'ch.xhtml#no-such' },
          { label: 'Real', href: 'ch.xhtml#real' },
        ],
      }),
    );
    const { unresolved, cuts } = detectFromToc(book);
    const byLabel = Object.fromEntries(unresolved.map((u) => [u.entry.label, u.reason]));
    expect(byLabel['Cover']).toBe('document-has-no-text');
    expect(byLabel['Missing file']).toBe('path-not-in-spine');
    expect(byLabel['Missing id']).toBe('fragment-not-found');
    expect(unresolved.some((u) => u.entry.label === 'Real')).toBe(false);
    // A missing id still starts a chapter, at the top of the file it did find.
    expect(cuts.some((c) => c.title === 'Missing id')).toBe(true);
    expect(
      explainUnresolved(
        must(
          unresolved.find((u) => u.reason === 'path-not-in-spine'),
          "unresolved.find((u) => u.reason === 'path-not-in-spine')",
        ),
      ),
    ).toMatch(/not in this book's spine/);
    expect(
      explainUnresolved(
        must(
          unresolved.find((u) => u.reason === 'fragment-not-found'),
          "unresolved.find((u) => u.reason === 'fragment-not-found')",
        ),
      ),
    ).toMatch(/top of the file/);
    expect(
      explainUnresolved(
        must(
          unresolved.find((u) => u.reason === 'document-has-no-text'),
          "unresolved.find((u) => u.reason === 'document-has-no-text')",
        ),
      ),
    ).toMatch(/no extractable text/);
  });
});

describe('chapters across files and inside one file', () => {
  it('lets one chapter span the files that have no cut of their own', () => {
    const chapters = Array.from({ length: 12 }, (_, i) =>
      chapter(
        `OEBPS/p${i}.xhtml`,
        `<p>Page ${i} stands alone in its file and belongs to a larger chapter.</p>`,
      ),
    );
    const book = open(
      buildEpub({
        chapters,
        toc: [0, 4, 8].map((i) => ({ label: `Part ${i}`, href: `p${i}.xhtml` })),
      }),
    );
    const found = toChapters(detect(book).cuts, book.blocks);
    expect(found.length).toBe(3);
    const spread = found.map(
      (c) => new Set(book.blocks.slice(c.start, c.end).map((b) => b.path)).size,
    );
    expect(spread).toEqual([4, 4, 4]);
    expectTiling(book);
  });

  it('cuts in the middle of a file when several fragments point into it', () => {
    const book = open(
      buildEpub({
        chapters: [
          chapter(
            'OEBPS/all.xhtml',
            [
              '<p id="a">Alpha starts the file and keeps going so this section has weight.</p>',
              prose('Alpha'),
              '<p><span id="b">Beta starts at an inline anchor.</span></p>',
              prose('Beta'),
              '<p id="c">Gamma is the third chapter in the same file.</p>',
              prose('Gamma'),
            ].join('\n'),
          ),
        ],
        toc: [
          { label: 'Alpha', href: 'all.xhtml#a' },
          { label: 'Beta', href: 'all.xhtml#b' },
          { label: 'Gamma', href: 'all.xhtml#c' },
        ],
      }),
    );
    const { cuts, unresolved } = detect(book);
    expect(unresolved).toHaveLength(0);
    expect(cuts.length).toBe(3);
    const perFile = new Map<string, number>();
    for (const cut of cuts) {
      const path = must(book.blocks[cut.at], 'book.blocks[cut.at]').path;
      perFile.set(path, (perFile.get(path) ?? 0) + 1);
    }
    expect(Math.max(...perFile.values())).toBe(3);
    const limited = limitCount(cuts, book.blocks, 2);
    expect(limited.length).toBeLessThanOrEqual(2);
    expectTiling(book, limited);
  });

  it('opens a few hundred documents and still tiles the book', () => {
    const n = 240;
    const chapters = Array.from({ length: n }, (_, i) =>
      chapter(`OEBPS/f${i}.xhtml`, `<p>File ${i} is one short page of the log.</p>`),
    );
    const toc = Array.from({ length: n / 10 }, (_, i) => ({
      label: `Group ${i}`,
      href: `f${i * 10}.xhtml`,
    }));
    const started = Date.now();
    const book = open(buildEpub({ chapters, toc }));
    const elapsed = Date.now() - started;
    expect(book.spine.length).toBe(n);
    expect(detect(book).cuts.length).toBe(n / 10);
    expectTiling(book);
    expect(elapsed).toBeLessThan(8000);
  });
});

describe('missing table of contents', () => {
  it('cuts at the first heading level whose titles actually differ', () => {
    const chapters = ['Lantern', 'Harbour', 'Gate'].map((name) =>
      chapter(
        `OEBPS/${name.toLowerCase()}.xhtml`,
        `<h1>Field Notes on Rivers</h1><h2>${name}</h2>${prose(name)}<h3>Supplies</h3><p>Nails, oil, and glass.</p>`,
      ),
    );
    const book = open(buildEpub({ tocKind: 'none', chapters }));
    expect(book.tocSource).toBe('none');
    const detected = detect(book);
    expect(detected.strategy).toBe('heading');
    const titles = detected.cuts.map((c) => c.title);
    // The repeated h1 sits before the first real chapter, and the book still
    // has to tile from block 0. That opening interval is front matter.
    expect(titles).toEqual(['Front matter', 'Lantern', 'Harbour', 'Gate']);
    expect(titles).not.toContain('Supplies');
    expect(titles).not.toContain('Field Notes on Rivers');
    expect(detected.cuts).toHaveLength(4);
  });

  it('falls back to one chapter per file when nothing is marked', () => {
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [chapter('OEBPS/a.xhtml', prose('A')), chapter('OEBPS/b.xhtml', prose('B'))],
      }),
    );
    expect(detect(book).strategy).toBe('spine');
    expect(detect(book).cuts).toHaveLength(2);
    expectTiling(book);
  });

  it('honours an explicit heading level', () => {
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [chapter('OEBPS/a.xhtml', `<h1>Same</h1><h2>Real</h2>${prose('Real')}`)],
      }),
    );
    const forced = detectFromHeadings(book, 1);
    expect(forced.cuts.some((c) => c.title === 'Same')).toBe(true);
  });
});

describe('wrapped lines', () => {
  const book = open(
    buildEpub({
      tocKind: 'none',
      chapters: [
        chapter(
          'OEBPS/ch.xhtml',
          [
            '<p>The lanterns in the</p>',
            '<p>harbour. There can be only</p>',
            '<p>one light at a time, and</p>',
            '<p>the keeper tends the</p>',
            '<p>flame.</p>',
            '<p>NEVER SWALLOW THE TITLE</p>',
            '<p>The body starts here with a real sentence.</p>',
            '<p>The gate closed at dusk.</p>',
            '<p>Morning brought rain and a new log.</p>',
            '<p>He walked to the</p>',
            '<p>Market before dawn.</p>',
            '<p>He waited,</p>',
            '<p>Then went in.</p>',
          ].join(''),
        ),
      ],
    }),
  );

  it('rejoins a paragraph the converter broke into one element per line', () => {
    const joined = book.blocks.find((b) => b.text.startsWith('The lanterns in the'));
    expect(joined).toBeDefined();
    expect(must(joined, 'joined').text).toContain('one light at a time');
    expect(must(joined, 'joined').text).toContain('keeper tends the flame.');
    expect(must(joined, 'joined').text.endsWith('flame.')).toBe(true);
  });

  it('does not swallow a display title or a paragraph that already ended', () => {
    expect(book.blocks.some((b) => b.text === 'NEVER SWALLOW THE TITLE')).toBe(true);
    const ended = book.blocks.find((b) => b.text.startsWith('The gate closed at dusk.'));
    expect(must(ended, 'ended').text).toBe('The gate closed at dusk.');
    expect(book.blocks.some((b) => b.text === 'Morning brought rain and a new log.')).toBe(true);
  });

  it('joins on a function word or a dangling comma even when the next line is capitalised', () => {
    expect(book.blocks.some((b) => b.text === 'He walked to the Market before dawn.')).toBe(true);
    expect(book.blocks.some((b) => b.text === 'He waited, Then went in.')).toBe(true);
  });
});

describe('footnotes', () => {
  it('keeps an EPUB 3 footnote out of the chapter and renders it as Markdown', () => {
    const book = open(
      buildEpub({
        chapters: [
          chapter(
            'OEBPS/ch.xhtml',
            [
              '<p>The river rose <a epub:type="noteref" href="#n1">1</a> overnight.</p>',
              prose('The rise'),
              '<aside epub:type="footnote" id="n1"><p>1 Measured at the old bridge.</p></aside>',
            ].join(''),
          ),
        ],
        toc: [
          { label: 'Chapter', href: 'ch.xhtml' },
          { label: 'Next', href: 'ch.xhtml' },
        ],
      }),
    );
    // The aside's text is not a paragraph of the chapter.
    expect(book.blocks.some((b) => b.text.includes('old bridge'))).toBe(false);
    expect(book.notes.get('OEBPS/ch.xhtml#n1')).toBe('Measured at the old bridge.');
    const ref = book.blocks.find((b) => b.noterefs?.length);
    expect(ref?.noterefs?.[0]?.key).toBe('OEBPS/ch.xhtml#n1');
  });

  it('resolves a note that lives in a later linear="no" file', () => {
    const book = open(
      buildEpub({
        chapters: [
          chapter(
            'OEBPS/ch.xhtml',
            `<p>History <a epub:type="noteref" role="doc-noteref" href="notes.xhtml#fn1">*</a> records the flood.</p>${prose('History')}`,
          ),
          chapter('OEBPS/notes.xhtml', '<p id="fn1">* The flood of the third year.</p>', {
            linear: false,
          }),
        ],
        tocKind: 'none',
      }),
    );
    expect(book.spine.filter((s) => !s.linear)).toHaveLength(1);
    expect(book.blocks.some((b) => b.path.endsWith('notes.xhtml'))).toBe(false);
    expect(book.notes.get('OEBPS/notes.xhtml#fn1')).toBe('The flood of the third year.');
    const refs = book.blocks.flatMap((b) => b.noterefs ?? []);
    expect(refs.every((r) => book.notes.has(r.key))).toBe(true);

    const chapters = toChapters(detect(book).cuts, book.blocks);
    const md = renderChapter(
      must(chapters[0], 'chapters[0]'),
      book.blocks,
      must(chapters[0], 'chapters[0]').title,
      {
        bookTitle: book.metadata.title,
        totalChapters: chapters.length,
        notes: book.notes,
        frontMatter: false,
      },
    );
    expect(md).toMatch(/\[\^1\]/);
    expect(md).toMatch(/^\[\^1\]: The flood of the third year\./m);
    expect(md).not.toMatch(/\[\^0\]/);
  });

  it('keeps a noteref that the converter pushed onto the next printed line', () => {
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [
          chapter(
            'OEBPS/ch.xhtml',
            [
              '<p>The lanterns in the</p>',
              '<p>harbour <a epub:type="noteref" href="#n1">1</a> were lit.</p>',
              '<aside epub:type="footnote" id="n1"><p>1 Counted at dusk.</p></aside>',
            ].join(''),
          ),
        ],
      }),
    );
    const joined = book.blocks.find((b) => b.text.startsWith('The lanterns in the'));
    expect(joined?.noterefs).toHaveLength(1);
    expect(joined?.text).toContain('harbour');
    expect(book.notes.has('OEBPS/ch.xhtml#n1')).toBe(true);
  });

  it('reads a group of endnotes without leaving them in the chapter', () => {
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [
          chapter(
            'OEBPS/ch.xhtml',
            [
              '<p>See the mark <a epub:type="noteref" href="#en1">1</a> and the other <a epub:type="noteref" href="#en2">2</a>.</p>',
              prose('Body'),
              '<section epub:type="endnotes"><ol>',
              '<li id="en1"><p>1 First aside.</p></li>',
              '<li id="en2"><p>2 Second aside.</p></li>',
              '</ol></section>',
            ].join(''),
          ),
        ],
      }),
    );
    expect(book.blocks.some((b) => /First aside|Second aside/.test(b.text))).toBe(false);
    expect(book.notes.get('OEBPS/ch.xhtml#en1')).toBe('First aside.');
    expect(book.notes.get('OEBPS/ch.xhtml#en2')).toBe('Second aside.');
  });

  it('treats linear="NO" as outside the reading flow', () => {
    const built = buildEpub({
      tocKind: 'none',
      chapters: [
        chapter('OEBPS/ch.xhtml', prose('Main')),
        chapter('OEBPS/notes.xhtml', '<p id="n">A side note.</p>', { linear: false }),
      ],
    });
    const entries = unzipSync(built);
    const opf = new TextDecoder()
      .decode(must(entries['OEBPS/content.opf'], "entries['OEBPS/content.opf']"))
      .replace('linear="no"', 'linear="NO"');
    entries['OEBPS/content.opf'] = new TextEncoder().encode(opf);
    const book = open(zipSync(entries));
    expect(must(book.spine[1], 'book.spine[1]').linear).toBe(false);
    expect(book.blocks.some((b) => b.path.endsWith('notes.xhtml'))).toBe(false);
  });
});

describe('images and broken markup', () => {
  it('keeps a figure, its alt text, and the sentence beside it', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const book = open(
      buildEpub({
        tocKind: 'none',
        files: { 'OEBPS/images/map.png': png },
        chapters: [
          chapter(
            'OEBPS/text/ch.xhtml',
            [
              '<p>See the <img src="../images/map.png" alt="River [map]" class="full"> before you row.</p>',
              '<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="../images/map.png"/></svg>',
            ].join(''),
          ),
        ],
      }),
    );
    const pictured = book.blocks.find((b) => b.text.startsWith('See the'));
    expect(pictured?.image).toBe('OEBPS/images/map.png');
    expect(pictured?.alt).toBe('River [map]');
    // SVG <image xlink:href> is a figure too. Dropping it lost the map in books
    // that draw it as a vector instead of an <img>.
    const figures = book.blocks.filter((b) => b.image === 'OEBPS/images/map.png');
    expect(figures.length).toBeGreaterThanOrEqual(2);
    expect(book.images.get('OEBPS/images/map.png')).toEqual(png);
    const md = renderChapter(
      {
        index: 0,
        title: 'Map',
        start: 0,
        end: book.blocks.length,
        source: 'spine',
        depth: 0,
        chars: 10,
      },
      book.blocks,
      'Map',
      { bookTitle: 'Notes', totalChapters: 1, frontMatter: false },
    );
    expect(md).toContain('![River map](images/OEBPS_images_map.png)');
    expect(md).toContain('before you row');
    expect(must(pictured, 'pictured').html).not.toMatch(/<[a-z0-9]+\s+[^>]*class=/i);
    expect(must(pictured, 'pictured').html).not.toMatch(/<(script|iframe|img|a)\b/i);
  });

  it('puts a spine image in the book instead of parsing the bytes as HTML', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 9, 9]);
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [
          chapter('OEBPS/cover.jpg', '', { rawBytes: jpeg, mediaType: 'image/jpeg' }),
          chapter('OEBPS/ch.xhtml', prose('After the cover')),
        ],
      }),
    );
    expect(must(book.blocks[0], 'book.blocks[0]').image).toBe('OEBPS/cover.jpg');
    expect(must(book.blocks[0], 'book.blocks[0]').text).toBe('');
    expect(book.blocks.some((b) => b.text.includes('After the cover'))).toBe(true);
    expect(book.images.get('OEBPS/cover.jpg')).toEqual(jpeg);
  });

  it('reads broken XHTML without dropping the sentences around the break', () => {
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [
          chapter(
            'OEBPS/ch.xhtml',
            [
              '<p>Unclosed paragraph',
              '<p>Second &amp; third</p>',
              '<div><span>Wrapped <b class="x" onclick="alert(1)">bold</b>',
              '<p>Tom &amp; Jerry <em class="it">stressed</em> it.</p>',
              '<p>Line<br>break</p>',
              '<script>alert(1)</script>',
              '<p>After the script.</p>',
            ].join(''),
          ),
        ],
      }),
    );
    const text = book.blocks.map((b) => b.text).join('\n');
    expect(text).toContain('Unclosed paragraph');
    expect(text).toContain('Second & third');
    expect(text).toContain('Wrapped bold');
    expect(text).toContain('Tom & Jerry stressed it.');
    expect(text).toContain('Line break');
    expect(text).not.toContain('alert');
    for (const block of book.blocks) {
      expect(htmlText(block.html)).toBe(block.text);
      expect(block.html).not.toMatch(/\s(?:class|onclick|href)=/);
    }
  });

  it('keeps a loose span that never got a paragraph', () => {
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [
          chapter('OEBPS/ch.xhtml', '<span id="only">Only a span holds this sentence.</span>'),
        ],
      }),
    );
    expect(book.blocks.map((b) => b.text)).toEqual(['Only a span holds this sentence.']);
    expect(must(book.blocks[0], 'book.blocks[0]').ids).toContain('only');
  });
});

describe('encodings', () => {
  it('honours a windows-1252 declaration', () => {
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [
          chapter('OEBPS/ch.xhtml', '<p>The café — naïve, and still open.</p>', {
            encoding: 'windows-1252',
          }),
        ],
      }),
    );
    expect(book.blocks.map((b) => b.text).join(' ')).toContain('café — naïve');
  });

  it('falls back to windows-1252 when the file never says what it is', () => {
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [
          chapter('OEBPS/ch.xhtml', '<p>The café — naïve, and still open.</p>', {
            encoding: 'windows-1252',
            declare: '',
          }),
        ],
      }),
    );
    expect(book.blocks.map((b) => b.text).join(' ')).toContain('café — naïve');
  });

  it('reads a UTF-16 document from its BOM', () => {
    const xml =
      '<?xml version="1.0" encoding="utf-16"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Lantern encoded wide.</p></body></html>';
    const bytes = new Uint8Array(xml.length * 2 + 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < xml.length; i++) {
      bytes[2 + i * 2] = xml.charCodeAt(i) & 0xff;
      bytes[3 + i * 2] = xml.charCodeAt(i) >> 8;
    }
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [chapter('OEBPS/ch.xhtml', '', { rawBytes: bytes })],
      }),
    );
    expect(book.blocks.map((b) => b.text)).toEqual(['Lantern encoded wide.']);
  });
});

describe('failures name the file and the next step', () => {
  function message(bytes: Uint8Array): string {
    try {
      openEpub(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(EpubError);
      expect((error as Error).name).toBe('EpubError');
      return (error as Error).message;
    }
    throw new Error('openEpub should have failed');
  }

  it('rejects a file that is not a zip', () => {
    expect(message(Uint8Array.from([1, 2, 3, 4]))).toMatch(/ZIP archive/);
    expect(message(Uint8Array.from([1, 2, 3, 4]))).toMatch(/DRM/);
  });

  it('names a missing container, a missing rootfile, and an empty spine', () => {
    expect(
      message(
        buildEpub({ container: 'missing', chapters: [chapter('OEBPS/a.xhtml', prose('A'))] }),
      ),
    ).toMatch(/container\.xml/);
    expect(
      message(
        buildEpub({ container: 'no-rootfile', chapters: [chapter('OEBPS/a.xhtml', prose('A'))] }),
      ),
    ).toMatch(/rootfile/);
    expect(message(buildEpub({ chapters: [] }))).toMatch(/spine lists no documents/);
    expect(message(buildEpub({ chapters: [], brokenSpineId: 'ghost' }))).toMatch(/ghost/);
  });

  it('names the spine item whose file was left out of the archive', () => {
    expect(
      message(
        buildEpub({
          chapters: [chapter('OEBPS/gone.xhtml', prose('Gone'), { omit: true })],
        }),
      ),
    ).toMatch(/OEBPS\/gone\.xhtml/);
  });

  it('names an unsupported encoding', () => {
    expect(
      message(
        buildEpub({
          tocKind: 'none',
          chapters: [chapter('OEBPS/ch.xhtml', '<p>Hello.</p>', { declare: 'ebcdic' })],
        }),
      ),
    ).toMatch(/ebcdic/);
    expect(
      message(
        buildEpub({
          tocKind: 'none',
          chapters: [chapter('OEBPS/ch.xhtml', '<p>Hello.</p>', { declare: 'ebcdic' })],
        }),
      ),
    ).toMatch(/UTF-8/);
  });

  it('rejects DRM and still opens a book whose encryption.xml only covers fonts', () => {
    expect(
      message(
        buildEpub({
          encryption: 'content',
          chapters: [chapter('OEBPS/ch.xhtml', prose('Secret'))],
        }),
      ),
    ).toMatch(/OEBPS\/ch\.xhtml/);
    expect(
      message(
        buildEpub({
          encryption: 'adobe',
          chapters: [chapter('OEBPS/ch.xhtml', prose('Secret'))],
        }),
      ),
    ).toMatch(/Adept/);
    const book = open(
      buildEpub({
        encryption: 'font',
        tocKind: 'none',
        chapters: [chapter('OEBPS/ch.xhtml', prose('Readable'))],
      }),
    );
    expect(book.blocks.length).toBeGreaterThan(0);
  });

  it('still opens when a non-linear file is missing', () => {
    const book = open(
      buildEpub({
        tocKind: 'none',
        chapters: [
          chapter('OEBPS/ch.xhtml', prose('Main')),
          chapter('OEBPS/notes.xhtml', '<p>Gone.</p>', { linear: false, omit: true }),
        ],
      }),
    );
    expect(book.blocks.some((b) => b.text.includes('Main'))).toBe(true);
  });
});

describe('chapter boundaries', () => {
  function blocksOf(texts: string[]): Block[] {
    return texts.map((text) => ({
      spineIndex: 0,
      path: 'a.xhtml',
      ids: [],
      tag: 'p',
      heading: 0,
      text,
      html: text,
    }));
  }

  it('merges a short chapter forward when it introduces the next one, and backward at the end', () => {
    const blocks = blocksOf([
      'Part',
      ...Array.from({ length: 8 }, () => 'word '.repeat(40)),
      'Colophon',
    ]);
    // Cuts: part divider at 0 (tiny), real chapter at 1 (long), colophon at the last block.
    const cuts: CutPoint[] = [
      { at: 0, title: 'Part One', source: 'toc', depth: 0 },
      { at: 1, title: 'The Lantern', source: 'toc', depth: 0 },
      { at: blocks.length - 1, title: 'Colophon', source: 'toc', depth: 0 },
    ];
    const merged = mergeStubs(cuts, blocks, 200);
    const chapters = toChapters(merged, blocks);
    expect(chapters).toHaveLength(1);
    expect(must(chapters[0], 'chapters[0]').title).toBe('The Lantern');
    expect(must(chapters[0], 'chapters[0]').start).toBe(0);
    expect(must(chapters[0], 'chapters[0]').end).toBe(blocks.length);
  });

  it('mergeSmall drops later stubs and keeps the opening cut', () => {
    const blocks = blocksOf([
      'Cover',
      'Rights',
      ...Array.from({ length: 6 }, () => 'word '.repeat(40)),
    ]);
    const cuts: CutPoint[] = [
      { at: 0, title: 'Cover', source: 'toc', depth: 0 },
      { at: 1, title: 'Rights', source: 'toc', depth: 0 },
      { at: 2, title: 'Body', source: 'toc', depth: 0 },
    ];
    const merged = mergeSmall(cuts, blocks, 500);
    expect(merged.map((c) => c.title)).toEqual(['Cover', 'Body']);
    expect(must(toChapters(merged, blocks).at(-1), 'toChapters(merged, blocks).at(-1)').end).toBe(
      blocks.length,
    );
  });

  it('edits cuts without disturbing the blocks outside the edit', () => {
    const blocks = blocksOf(['a', 'b', 'c', 'd']);
    const cuts: CutPoint[] = [{ at: 0, title: 'A', source: 'toc', depth: 0 }];
    const split = splitAt(cuts, 2, 'C');
    expect(split.map((c) => c.at)).toEqual([0, 2]);
    expect(splitAt(split, 2, 'Again')).toBe(split);
    expect(
      must(
        retitle(split, 1, 'Sea').find((c) => c.at === 2),
        "retitle(split, 1, 'Sea').find((c) => c.at === 2)",
      ).title,
    ).toBe('Sea');
    expect(retitle(split, 5, 'No').map((c) => c.title)).toEqual(['A', 'C']);
    expect(mergeUp(split, 1).map((c) => c.at)).toEqual([0]);
    expect(mergeUp(split, 0)).toBe(split);
    expectTiling({ blocks } as Book, split);
  });
});

describe('every generated book stays consistent', () => {
  const books = [
    buildEpub({
      chapters: [
        chapter(
          'OEBPS/a.xhtml',
          `<p><em class="x">stress</em> and <b>bold </b> stay.</p><p>Keep <b>the <i> inner </i> word</b> whole.</p>${prose('A')}`,
        ),
        chapter('OEBPS/b.xhtml', prose('B')),
      ],
      toc: [
        { label: 'A', href: 'a.xhtml' },
        { label: 'B', href: 'b.xhtml' },
      ],
    }),
    buildEpub({
      version: '2.0',
      tocKind: 'ncx',
      chapters: [chapter('OEBPS/a.xhtml', prose('A')), chapter('OEBPS/b.xhtml', prose('B'))],
      toc: [
        { label: 'A', href: 'a.xhtml' },
        { label: 'B', href: 'b.xhtml' },
      ],
    }),
  ];

  it('tiles, and the markup text matches the plain text', () => {
    for (const bytes of books) {
      const book = open(bytes);
      expect(book.spine.length).toBeGreaterThan(0);
      expect(book.blocks.length).toBeGreaterThan(0);
      expect(detect(book).cuts.length).toBeGreaterThan(1);
      expectTiling(book);
      for (const block of book.blocks) {
        expect(htmlText(block.html)).toBe(block.text);
        expect(block.html).not.toMatch(/<[a-z0-9]+\s+[^>]*\s*=/i);
      }
    }
  });

  it('does not append a bare numeral or a phrase the label already contains', () => {
    const bytes = buildEpub({
      chapters: [
        chapter(
          'OEBPS/a.xhtml',
          `<h1>1</h1><p>1</p>${prose('Already titled properly in the contents, so nothing is appended.')}`,
        ),
        chapter('OEBPS/b.xhtml', `<p>IV</p>${prose('Four')}`),
      ],
      toc: [
        { label: '1: The Quiet Work of Small Repairs', href: 'a.xhtml' },
        { label: 'IV', href: 'b.xhtml' },
      ],
    });
    const book = open(bytes);
    const derived = deriveTitles(
      toChapters(mergeStubs(detect(book).cuts, book.blocks, 50), book.blocks),
      book.blocks,
    );
    expect(derived.some((c) => c.title === '1: The Quiet Work of Small Repairs')).toBe(true);
    expect(derived.some((c) => /— The Fundamentals$/.test(c.title))).toBe(false);
    for (const c of derived) {
      const parts = c.title.split(' — ');
      if (parts.length < 2) continue;
      const tail = parts.slice(1).join(' — ').toLowerCase().trim();
      expect(/^[\d.,ivxlcm\s:-]+$/i.test(tail)).toBe(false);
      expect(must(parts[0], 'parts[0]').toLowerCase().includes(tail)).toBe(false);
    }
  });
});
