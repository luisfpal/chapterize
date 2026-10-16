import { describe, expect, it } from 'vitest';
import { must, openEpub } from '@chapterize/core';
import type { Block, Book } from '@chapterize/core';
import { buildBundle, chapterBase, prepare } from '../src/bundle.js';
import { formatLength, renderBody, SIZES } from '../src/html.js';
import { imageFileNames } from '../src/mini-epub.js';
import { fixtureEpub } from './fixture.js';

function text(files: { path: string; data: Uint8Array }[], filePath: string): string {
  const file = files.find((item) => item.path === filePath);
  if (!file) throw new Error(`missing ${filePath}`);
  return new TextDecoder().decode(file.data);
}

function block(partial: Partial<Block> & Pick<Block, 'text' | 'html' | 'tag'>): Block {
  return {
    spineIndex: 0,
    path: 'OEBPS/c.xhtml',
    ids: [],
    heading: 0,
    ...partial,
  };
}

describe('formatLength', () => {
  it('stays compact on a phone row', () => {
    expect(formatLength(1)).toBe('1 min');
    expect(formatLength(59)).toBe('59 min');
    expect(formatLength(60)).toBe('1 hr');
    expect(formatLength(90)).toBe('1 hr 30 min');
  });
});

describe('a generated book becomes a phone bundle', () => {
  const book = openEpub(fixtureEpub());

  it('keeps three chapters and drops the repeated running head', () => {
    const { files, prepared } = buildBundle(book, { epubs: false });
    expect(prepared.chapters.map((chapter) => chapter.title)).toEqual([
      'The Quiet Start',
      'Lists and Lines',
      'Marks & <Angles>',
    ]);
    expect(prepared.warnings).toEqual([]);

    const first = text(
      files,
      `chapters/${chapterBase(must(prepared.chapters[0], 'prepared.chapters[0]'))}.html`,
    );
    const second = text(
      files,
      `chapters/${chapterBase(must(prepared.chapters[1], 'prepared.chapters[1]'))}.html`,
    );
    const third = text(
      files,
      `chapters/${chapterBase(must(prepared.chapters[2], 'prepared.chapters[2]'))}.html`,
    );
    const index = text(files, 'index.html');
    const css = text(files, 'reader.css');

    expect(first).toContain('<h1>The Quiet Start</h1>');
    expect(first).not.toContain('<h1>Phone Fixture</h1>');
    expect(first).not.toContain('<h2>Phone Fixture</h2>');
    expect(first).toContain('<em>inside</em>');
    expect(first).toContain('The note body says ORIGIN.');
    expect(first).toContain('../images/dot.png');
    expect(first).toContain('UNIQUE_ALPHA');
    expect(first).not.toContain('UNIQUE_BETA');
    expect(first).not.toContain('UNIQUE_GAMMA_SENTENCE');
    expect(first).toContain('href="002-lists-and-lines.html"');
    expect(first).toContain('<span class="off">Prev</span>');
    expect(first).toContain('Chapter 1 of 3');
    expect(first).toContain('left in the book');
    expect(first).not.toContain('maximum-scale');
    expect(first).toContain('viewport-fit=cover');
    expect(first).toContain('URLSearchParams');
    expect(first).toContain("q.get('theme')");
    expect(first).not.toContain('Open this chapter in Books');

    expect(second).toContain('<h3>A real heading</h3>');
    expect(second).toContain('<ul>');
    expect(second).toContain('<li>First item of the list</li>');
    expect(second).toContain(
      '<blockquote><p>A quoted line that should stay a quote.</p></blockquote>',
    );
    expect(second).toContain('UNIQUE_BETA');
    expect(second).not.toContain('UNIQUE_GAMMA_SENTENCE');
    expect(second).toContain('&lt;Angles&gt;');
    expect(second).not.toContain('<Angles>');

    expect(third).toContain('<h1>Marks &amp; &lt;Angles&gt;</h1>');
    expect(third).not.toContain('<Angles>');
    expect(third).toContain('UNIQUE_GAMMA_SENTENCE');
    expect(third).not.toContain('UNIQUE_ALPHA');
    expect(third).toContain('<span class="off">Next</span>');
    expect(third).toContain('End of the book');
    expect(third).toContain(
      `Chapter 3 of 3 · ${formatLength(must(prepared.minutes[2], 'prepared.minutes[2]'))}`,
    );

    expect(index).toContain('Ada Test');
    expect(index).toContain('3 chapters');
    expect(index).toContain('href="chapters/001-the-quiet-start.html"');
    expect(index).toContain('style="--depth: 1"');
    expect(index).toContain('Marks &amp; &lt;Angles&gt;');
    expect(index).not.toContain('<Angles>');

    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('safe-area-inset');
    expect(css).toContain('Iowan Old Style');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('#16151a');
    // The comment may name the unit. A declaration would be the bug.
    expect(css).not.toMatch(/(?:height|min-height|max-height)\s*:\s*100vh/);
    for (const size of SIZES) expect(text(files, 'reader.js')).toContain(String(size));

    const manifest = JSON.parse(text(files, 'book.json')) as {
      title: string;
      author: string;
      chapters: { title: string; file: string }[];
    };
    expect(manifest.title).toBe('Phone Fixture');
    expect(manifest.author).toBe('Ada Test');
    expect(manifest.chapters).toHaveLength(3);
    expect(must(manifest.chapters[2], 'manifest.chapters[2]').title).toBe('Marks & <Angles>');
    expect(files.some((file) => file.path === 'images/dot.png')).toBe(true);
  });

  it('adds a Books file only when asked, and that file does not carry the other chapter', () => {
    const { files } = buildBundle(book, { epubs: true });
    const third = text(files, 'chapters/003-marks-angles.html');
    expect(third).toContain('href="../epub/003-marks-angles.epub"');
    expect(third).toContain('Open this chapter in Books');

    const epub = must(
      files.find((file) => file.path === 'epub/003-marks-angles.epub'),
      "files.find((file) => file.path === 'epub/003-marks-angles.epub')",
    ).data;
    expect(epub[0]).toBe(0x50);
    expect(epub[1]).toBe(0x4b);
    const method = must(epub[8], 'epub[8]') | (must(epub[9], 'epub[9]') << 8);
    const flags = must(epub[6], 'epub[6]') | (must(epub[7], 'epub[7]') << 8);
    const nameLen = must(epub[26], 'epub[26]') | (must(epub[27], 'epub[27]') << 8);
    const extra = must(epub[28], 'epub[28]') | (must(epub[29], 'epub[29]') << 8);
    const name = new TextDecoder().decode(epub.slice(30, 30 + nameLen));
    const stored = new TextDecoder().decode(
      epub.slice(30 + nameLen + extra, 30 + nameLen + extra + 20),
    );
    expect({ name, method, flags, extra, stored }).toEqual({
      name: 'mimetype',
      method: 0,
      flags: 0,
      extra: 0,
      stored: 'application/epub+zip',
    });

    const again = openEpub(epub);
    const prose = again.blocks.map((item) => item.text).join('\n');
    expect(prose).toContain('UNIQUE_GAMMA_SENTENCE');
    expect(prose).not.toContain('UNIQUE_ALPHA');
    expect(prose).not.toContain('UNIQUE_BETA');
    expect(again.metadata.title).toContain('Marks & <Angles>');
  });

  it('prepare agrees with the bundle on chapter count', () => {
    expect(prepare(book).chapters).toHaveLength(3);
  });
});

describe('book HTML is data', () => {
  it('drops a tag that is not on the whitelist', () => {
    const rendered = renderBody({
      blocks: [
        block({
          tag: 'p',
          text: 'click',
          html: '<a href="https://evil.example">click</a>',
        }),
      ],
      notes: new Map(),
      imageSrc: () => null,
      chapterTitle: 'One',
      bookTitle: 'Book',
      boilerplate: new Set(),
    });
    expect(rendered.body).toContain('click');
    expect(rendered.body).not.toContain('evil.example');
    expect(rendered.body).not.toContain('<a');
  });

  it('drops an attribute on an otherwise allowed tag', () => {
    const rendered = renderBody({
      blocks: [
        block({
          tag: 'p',
          text: 'hello',
          html: '<em onclick="alert(1)">hello</em>',
        }),
      ],
      notes: new Map(),
      imageSrc: () => null,
      chapterTitle: 'One',
      bookTitle: 'Book',
      boilerplate: new Set(),
    });
    expect(rendered.body).toContain('hello');
    expect(rendered.body).not.toContain('onclick');
  });

  it('keeps two lists apart when a paragraph sits between them', () => {
    const rendered = renderBody({
      blocks: [
        block({ tag: 'li', text: 'one', html: 'one' }),
        block({ tag: 'li', text: 'two', html: 'two' }),
        block({ tag: 'p', text: 'between', html: 'between' }),
        block({ tag: 'li', text: 'three', html: 'three' }),
      ],
      notes: new Map(),
      imageSrc: () => null,
      chapterTitle: 'One',
      bookTitle: 'Book',
      boilerplate: new Set(),
    });
    expect(rendered.body.match(/<ul>/g)).toHaveLength(2);
  });
});

describe('image names', () => {
  it('does not let two cover.png files overwrite each other', () => {
    const names = imageFileNames(['OEBPS/a/cover.png', 'OEBPS/b/cover.png']);
    expect(names.get('OEBPS/a/cover.png')).toBe('cover.png');
    expect(names.get('OEBPS/b/cover.png')).not.toBe('cover.png');
    expect(new Set(names.values()).size).toBe(2);
  });

  it('turns a basename that would break a URL into a plain filename', () => {
    const names = imageFileNames(['OEBPS/My Photo.png', 'OEBPS/a/"onclick".png', 'OEBPS/..']);
    expect(names.get('OEBPS/My Photo.png')).toBe('my-photo.png');
    expect(names.get('OEBPS/a/"onclick".png')).toBe('onclick.png');
    expect(names.get('OEBPS/..')).toBe('image');
    for (const name of names.values()) expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });
});

describe('an empty book', () => {
  it('says the file has no readable text', () => {
    const empty: Book = {
      metadata: { title: 'Blank', epubVersion: '3.0' },
      spine: [],
      blocks: [],
      toc: [],
      images: new Map(),
      notes: new Map(),
      tocSource: 'none',
    };
    expect(() => buildBundle(empty, { epubs: false })).toThrow(/no readable text/);
  });
});
