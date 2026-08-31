import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openEpub, resolvePath } from '../src/epub.js';
import { detect, detectFromToc } from '../src/detect.js';
import { toChapters, limitCount, mergeSmall, mergeStubs } from '../src/chapters.js';
import { deriveTitles } from '../src/titles.js';
import { inlineMarkdown, renderChapter } from '../src/markdown.js';
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
    const named = chapters.filter((c) => /^48 Laws of Power$/i.test(c.title));
    // The h1 "48 Laws of Power" repeats in all 51 chapters, so boilerplate
    // suppression must stop it becoming their titles. The book's own table of
    // contents does label its title page that way, and echoing the source there
    // is correct — so one is expected, and more than one is the bug.
    expect(named.length).toBeLessThanOrEqual(1);
    const unique = new Set(chapters.map((c) => c.title.toLowerCase()));
    expect(unique.size).toBeGreaterThan(chapters.length - 3);
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

describe.runIf(libraryAvailable())('stub chapters', () => {
  it('dissolves a near-empty opening chapter into the first real one', () => {
    const book = openEpub(loadBook('Laws of Power'));
    const { cuts } = detect(book);
    const merged = mergeStubs(cuts, book.blocks, 200);
    const after = toChapters(merged, book.blocks);
    expect(after[0]!.start).toBe(0);
    expect(after[0]!.chars).toBeGreaterThanOrEqual(200);
    expect(after.at(-1)!.end).toBe(book.blocks.length);
  });

  it('leaves no chapter below the stub threshold', () => {
    for (const path of allBooks()) {
      const book = openEpub(new Uint8Array(readFileSync(path)));
      const merged = mergeStubs(detect(book).cuts, book.blocks, 200);
      const chapters = toChapters(merged, book.blocks);
      if (chapters.length < 2) continue;
      expect(Math.min(...chapters.map((c) => c.chars)), basename(path)).toBeGreaterThanOrEqual(200);
    }
  });
});

describe.runIf(libraryAvailable())('paragraphs split across printed lines', () => {
  it('rejoins a sidebar that the converter broke into one <p> per line', () => {
    const book = openEpub(loadBook('Laws of Power'));
    const joined = book.blocks.find((b) => b.text.startsWith('The Stars in the'));
    expect(joined, 'the sidebar block').toBeDefined();
    // Source is <p>The Stars in the</p><p>Sky. There can be only</p>… — nine
    // fragments that are one sentence.
    expect(joined!.text).toContain('one sun at a time');
    expect(joined!.text).toContain("master star's");
    expect(joined!.text.trimEnd().endsWith('intensity.')).toBe(true);
  });

  it('does not glue together paragraphs that already ended properly', () => {
    const book = openEpub(loadBook('Laws of Power'));
    const ended = book.blocks.filter((b) => b.heading === 0 && /\.$/.test(b.text));
    expect(ended.length).toBeGreaterThan(50);
    // A joined block would contain the next paragraph's opening; spot-check that
    // sentences ending in a full stop stay separate from what follows.
    const authority = book.blocks.find((b) => b.text.startsWith('Authority: Avoid outshining'));
    expect(authority?.text).not.toContain('REVERSAL');
  });
});

describe.runIf(libraryAvailable())('inline markup and figures', () => {
  it('keeps inline emphasis but strips every attribute', () => {
    for (const path of allBooks()) {
      const book = openEpub(new Uint8Array(readFileSync(path)));
      for (const block of book.blocks) {
        expect(block.html, basename(path)).not.toMatch(/<[a-z]+\s+[^>]*=/i);
        expect(block.html, basename(path)).not.toMatch(/<(script|iframe|img|a)\b/i);
      }
    }
  });

  it('html text content matches the plain text annotations index into', () => {
    const book = openEpub(loadBook('Laws of Power'));
    const strip = (h: string) => h.replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    for (const block of book.blocks.slice(0, 400)) {
      if (block.image) continue;
      expect(strip(block.html)).toBe(block.text);
    }
  });
});

describe.runIf(libraryAvailable())('derived titles say something new', () => {
  it('never appends a bare numeral or a phrase the label already contains', () => {
    for (const path of allBooks()) {
      const book = openEpub(new Uint8Array(readFileSync(path)));
      const chapters = deriveTitles(
        toChapters(mergeStubs(detect(book).cuts, book.blocks, 200), book.blocks),
        book.blocks,
      );
      for (const c of chapters) {
        const parts = c.title.split(' — ');
        if (parts.length < 2) continue;
        const [head, tail] = [parts[0]!.toLowerCase().trim(), parts.slice(1).join(' — ').toLowerCase().trim()];
        expect(/^[\d.,ivxlcm\s:-]+$/i.test(tail), `${basename(path)}: "${c.title}"`).toBe(false);
        expect(head.includes(tail), `${basename(path)}: "${c.title}"`).toBe(false);
      }
    }
  });
});

describe.runIf(libraryAvailable())('titles keep the book\'s own wording', () => {
  it('recovers a name only when the label is a bare enumerator', () => {
    const laws = openEpub(loadBook('Laws of Power'));
    const lawTitles = deriveTitles(
      toChapters(mergeStubs(detect(laws).cuts, laws.blocks, 200), laws.blocks), laws.blocks,
    ).map((c) => c.title);
    // "LAW 1" is an enumerator, so the real name must be recovered.
    expect(lawTitles.join('\n')).toMatch(/LAW 1 — Never Outshine the Master/i);

    const atomic = openEpub(loadBook('Atomic Habits'));
    const atomicTitles = deriveTitles(
      toChapters(mergeStubs(detect(atomic).cuts, atomic.blocks, 200), atomic.blocks), atomic.blocks,
    ).map((c) => c.title);
    // These labels are already titles and must survive untouched.
    expect(atomicTitles).toContain('1: The Surprising Power of Atomic Habits');
    expect(atomicTitles.some((t) => /— The Fundamentals$/.test(t))).toBe(false);
  });
});

describe('inline emphasis converts to valid Markdown', () => {
  it('moves whitespace outside the markers so the emphasis actually renders', () => {
    // Real markup from Atomic Habits; the trailing space inside <b> would
    // otherwise produce "**Productivity compounds. **", which is not bold.
    expect(inlineMarkdown('<b>Productivity compounds. </b>rest'))
      .toBe('**Productivity compounds.** rest');
    expect(inlineMarkdown('a <i> word </i>b')).toBe('a *word* b');
  });

  it('drops emphasis that wraps nothing but whitespace', () => {
    // The empty <b> disappears and the surrounding spaces collapse to one,
    // matching the whitespace handling applied to block text everywhere else.
    expect(inlineMarkdown('before<b>  </b>after')).toBe('before after');
  });

  it('decodes entities and strips tags outside the whitelist', () => {
    expect(inlineMarkdown('Tom &amp; Jerry <span>plain</span>')).toBe('Tom & Jerry plain');
  });
});

/**
 * Walk the text toggling in and out of emphasis, which is the only way to tell
 * an opening marker from a closing one. `**bold** text` is correct; `**bold **`
 * and `** bold**` are not.
 */
function danglingMarkers(text: string): number {
  let bad = 0;
  for (const line of text.split('\n')) {
    let open = false;
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i] !== '*' || line[i + 1] !== '*') continue;
      const before = line[i - 1] ?? '';
      const after = line[i + 2] ?? '';
      if (!open && /\s/.test(after)) bad++;
      if (open && /\s/.test(before)) bad++;
      open = !open;
      i++;
    }
  }
  return bad;
}

describe.runIf(libraryAvailable())('exported chapters are valid Markdown', () => {
  it('never leaves a space against an emphasis marker', () => {
    const book = openEpub(loadBook('Atomic Habits'));
    const chapters = deriveTitles(
      toChapters(mergeStubs(detect(book).cuts, book.blocks, 200), book.blocks), book.blocks,
    );
    let bad = 0;
    for (const chapter of chapters) {
      bad += danglingMarkers(renderChapter(chapter, book.blocks, chapter.title, {
        bookTitle: book.metadata.title, totalChapters: chapters.length,
      }));
    }
    expect(bad).toBe(0);
  });
});
