import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import type { Block, Chapter } from '../src/types.js';
import { buildStudy, MAX_STUDY_STEPS, slicePassage } from '../src/study.js';
import { openEpub } from '../src/epub.js';
import { detect } from '../src/detect.js';
import { toChapters } from '../src/chapters.js';
import { deriveTitles } from '../src/titles.js';
import { prepareReader } from '../src/reader.js';
import { allBooks, libraryAvailable } from './fixtures.js';
import { readFileSync } from 'node:fs';

function block(over: Partial<Block> & Pick<Block, 'text'>): Block {
  return {
    spineIndex: 0,
    path: 'ch.xhtml',
    ids: [],
    tag: 'p',
    heading: 0,
    html: over.html ?? over.text,
    ...over,
  };
}

function chapter(end: number, title = 'Chapter'): Chapter {
  return { index: 0, title, start: 0, end, source: 'toc', depth: 0, chars: 0 };
}

const PARA = (seed: string) =>
  `${seed} is long enough to be a real paragraph about what the section is doing in the argument.`;

describe('slicePassage', () => {
  it('keeps a short paragraph whole', () => {
    expect(slicePassage('  Hello there.  ')).toBe('Hello there.');
  });

  it('cuts a long paragraph on a sentence and stays a prefix', () => {
    const sentence = 'This sentence is forty characters long!! ';
    const text = sentence.repeat(40);
    const cut = slicePassage(text);
    expect(text.trim().startsWith(cut)).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(700);
    expect(cut.endsWith('!')).toBe(true);
  });
});

describe('buildStudy', () => {
  it('asks one question per section, quoting that section', () => {
    const blocks = [
      block({ text: 'The claim', tag: 'h1', heading: 1 }),
      block({ text: PARA('Alpha') }),
      block({ text: 'The method', tag: 'h2', heading: 2 }),
      block({ text: PARA('Beta'), html: `Say <em>this</em>. ${PARA('Beta')}` }),
      block({ text: 'The cost', tag: 'h2', heading: 2 }),
      block({ text: PARA('Gamma') }),
    ];
    const study = buildStudy(chapter(blocks.length), blocks, new Set());
    expect(study.outline.map((item) => item.title)).toEqual(['The claim', 'The method', 'The cost']);
    expect(study.opening.startsWith('Alpha')).toBe(true);
    // Two h2s beat the single h1. The h1's paragraph is the opening, so it is
    // not also a question.
    expect(study.steps.map((step) => step.question)).toEqual([
      'What is \u201cThe method\u201d for?',
      'What is \u201cThe cost\u201d for?',
    ]);
    expect(study.steps[0]?.passage.startsWith('Beta')).toBe(true);
    expect(study.steps[1]?.passage.startsWith('Gamma')).toBe(true);
    expect(study.stepsSampled).toBe(false);
    for (const step of study.steps) {
      expect(step.question.includes(step.passage)).toBe(false);
    }
  });

  it('caps a long chapter at five questions and still lists every section', () => {
    const blocks: Block[] = [];
    for (let n = 0; n < 8; n++) {
      blocks.push(block({ text: `Section ${n}`, tag: 'h2', heading: 2 }));
      blocks.push(block({ text: PARA(`Body ${n}`) }));
    }
    const study = buildStudy(chapter(blocks.length), blocks, new Set());
    expect(study.outline).toHaveLength(8);
    expect(study.steps).toHaveLength(MAX_STUDY_STEPS);
    expect(study.stepsSampled).toBe(true);
    // Section 0's paragraph is the opening, so it is not asked again.
    expect(study.steps[0]?.question).toContain('Section 1');
    expect(study.steps[MAX_STUDY_STEPS - 1]?.question).toContain('Section 7');
  });

  it('uses opening, middle, and end when the chapter has no headings', () => {
    const blocks = [
      block({ text: PARA('Opens') }),
      block({ text: PARA('Continues') }),
      block({ text: PARA('Turns') }),
      block({ text: PARA('Closes') }),
    ];
    const study = buildStudy(chapter(blocks.length), blocks, new Set());
    expect(study.outline.every((item) => item.kind === 'landmark')).toBe(true);
    expect(study.steps.map((step) => step.question)).toEqual([
      'What changes by the middle of this chapter?',
      'What does the ending leave you with?',
    ]);
    expect(study.steps[0]?.passage.startsWith('Turns') || study.steps[0]?.passage.startsWith('Continues')).toBe(true);
    expect(study.steps[1]?.passage.startsWith('Closes')).toBe(true);
    expect(study.opening.startsWith('Opens')).toBe(true);
  });

  it('asks nothing of a chapter that is only a title', () => {
    const blocks = [block({ text: 'Cover', tag: 'h1', heading: 1 })];
    const study = buildStudy(chapter(blocks.length), blocks, new Set());
    expect(study.opening).toBe('');
    expect(study.steps).toEqual([]);
    expect(study.outline.map((item) => item.title)).toEqual(['Cover']);
  });

  it('drops a running header that repeats across the book', () => {
    const blocks = [
      block({ text: 'The Book', tag: 'h1', heading: 1 }),
      block({ text: PARA('Only this') }),
      block({ text: 'A real section', tag: 'h2', heading: 2 }),
      block({ text: PARA('And then the consequence, which is the part worth asking about') }),
    ];
    const study = buildStudy(chapter(blocks.length), blocks, new Set(['the book']));
    expect(study.outline.map((item) => item.title)).toEqual(['A real section']);
    expect(study.opening.startsWith('Only this')).toBe(true);
    expect(study.steps).toHaveLength(1);
    expect(study.steps[0]?.passage.startsWith('And then')).toBe(true);
  });

  it('does not put the passage inside the question when the heading is the paragraph', () => {
    const quoted = 'This section repeats its heading as the whole body.';
    const blocks = [
      block({ text: PARA('Opening differs') }),
      block({ text: quoted, tag: 'h2', heading: 2 }),
      block({ text: quoted }),
    ];
    const study = buildStudy(chapter(blocks.length), blocks, new Set());
    expect(study.steps).toHaveLength(1);
    expect(study.steps[0]?.question).toBe('What is this section for?');
    expect(study.steps[0]?.passage).toBe(quoted);
  });
});

describe('prepareReader on a built EPUB', () => {
  it('splits chapters, escapes markup, and keeps the image', () => {
    const book = openEpub(sampleEpub());
    const model = prepareReader(book);
    expect(model.title).toBe('Sample & Test');
    expect(model.author).toBe('A. Reader');
    expect(model.language).toBe('en');
    expect(model.chapters.length).toBeGreaterThanOrEqual(2);
    expect(model.startChapter).toBe(1);
    expect(model.chapters[0]?.words).toBeLessThan(80);

    const body = model.chapters[1]!;
    expect(body.title).toBe('The Opening Claim');
    expect(body.html).toContain('<em>Let them</em>');
    expect(body.html).not.toContain('<script');
    expect(body.html).not.toContain('alert(1)');
    expect(body.html).toContain('src="images/dot.png"');
    expect(body.html).toContain('alt="A dot"');
    expect(model.images).toEqual([{ sourcePath: 'OEBPS/images/dot.png', fileName: 'dot.png' }]);
    expect(body.opening.length).toBeGreaterThan(40);
  });
});

describe.runIf(libraryAvailable())('study plan against the real shelf', () => {
  it('quotes the book and never asks more than five questions', () => {
    for (const path of allBooks()) {
      const book = openEpub(new Uint8Array(readFileSync(path)));
      const model = prepareReader(book);
      const chapters = deriveTitles(toChapters(detect(book).cuts, book.blocks), book.blocks);
      expect(model.chapters.length, path).toBe(chapters.length);
      for (let i = 0; i < chapters.length; i++) {
        const range = chapters[i]!;
        const rendered = model.chapters[i]!;
        const texts = book.blocks
          .slice(range.start, range.end)
          .map((b) => b.text.trim())
          .filter((t) => t.length > 0);
        expect(rendered.steps.length, `${path} #${i}`).toBeLessThanOrEqual(MAX_STUDY_STEPS);
        if (rendered.opening) {
          expect(texts.some((t) => t.startsWith(rendered.opening)), `${path} #${i} opening`).toBe(true);
        }
        for (const step of rendered.steps) {
          expect(step.question.length, `${path} #${i}`).toBeGreaterThan(0);
          expect(step.question.includes(step.passage), `${path} #${i} spoiler`).toBe(false);
          expect(texts.some((t) => t.startsWith(step.passage)), `${path} #${i} quote`).toBe(true);
        }
      }
    }
  });
});

function sampleEpub(): Uint8Array {
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Sample &amp; Test</dc:title>
    <dc:creator>A. Reader</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="uid">sample</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="img" href="images/dot.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;
  const ncx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
  <navPoint id="a"><navLabel><text>Copyright</text></navLabel><content src="copyright.xhtml"/></navPoint>
  <navPoint id="b"><navLabel><text>The Opening Claim</text></navLabel><content src="ch.xhtml"/></navPoint>
</navMap></ncx>`;
  const copyright = `<html><body><h1>Copyright</h1><p>Short.</p></body></html>`;
  const chapterHtml = `<html><body>
<h1>The Opening Claim</h1>
<p>The first paragraph says something substantive about power and attention in a court of people who notice everything.</p>
<h2>Never show the work</h2>
<p>Hide the method. <em>Let them</em> see the result and keep the machinery out of sight for as long as the room will allow. <script>alert(1)</script></p>
<img src="images/dot.png" alt="A dot"/>
<p onclick="alert(1)">A later paragraph continues the section with enough words to stand as its own thought about concealment and display.</p>
</body></html>`;
  const files: Record<string, Uint8Array> = {
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/toc.ncx': strToU8(ncx),
    'OEBPS/copyright.xhtml': strToU8(copyright),
    'OEBPS/ch.xhtml': strToU8(chapterHtml),
    'OEBPS/images/dot.png': new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]),
  };
  return zipSync(files);
}
