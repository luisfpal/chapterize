import { describe, expect, it } from 'vitest';
import {
  annotationRange, carryBookState, imageFilename, parseAnnotationList, parseStoredJson,
  readerCommand, reanchorAnnotations, search, tryParseBookIndex, type Block,
} from '../src/index.js';

function block(text: string): Block {
  return {
    spineIndex: 0, path: 'c.xhtml', ids: [], tag: 'p', heading: 0, text, html: text,
  };
}

describe('a highlight stays on the words it was made on', () => {
  it('trims the span so the quote is exactly the sliced text', () => {
    const text = '  rope held  ';
    expect(annotationRange(text, 0, text.length)).toEqual({
      start: 2, end: 11, quote: 'rope held',
    });
    expect(annotationRange(text, 0, text.length)!.quote)
      .toBe(text.slice(2, 11));
  });

  it('rejects a selection that is only space, and ignores offsets past the end', () => {
    expect(annotationRange('rope', 0, 0)).toBeNull();
    expect(annotationRange('rope', 2, 1)).toEqual({ start: 1, end: 2, quote: 'o' });
    expect(annotationRange('rope', -4, 80)).toEqual({ start: 0, end: 4, quote: 'rope' });
  });

  it('keeps the second occurrence of a repeated word', () => {
    const blocks = [{ text: 'cat and cat' }];
    const { kept, orphaned } = reanchorAnnotations(blocks, [{
      block: 0, quote: 'cat', start: 8, end: 11,
    }]);
    expect(orphaned).toBe(0);
    expect(kept[0]).toMatchObject({ block: 0, start: 8, end: 11 });
  });

  it('follows the quote to the nearest block when the old one lost it', () => {
    const blocks = [
      { text: 'cat in the rigging' },
      { text: 'no animals here' },
      { text: 'the dog slept' },
    ];
    const { kept, orphaned } = reanchorAnnotations(blocks, [{
      block: 2, quote: 'cat', start: 4, end: 7,
    }]);
    expect(orphaned).toBe(0);
    expect(kept[0]!.block).toBe(0);
    expect(blocks[0]!.text.slice(kept[0]!.start, kept[0]!.end)).toBe('cat');
  });

  it('does not pin an empty quote to the first block', () => {
    const { kept, orphaned } = reanchorAnnotations(
      [{ text: 'anything' }],
      [{ block: 4, quote: '', start: 0, end: 0 }],
    );
    expect(kept).toEqual([]);
    expect(orphaned).toBe(1);
  });

  it('does not store a negative offset from a corrupt start', () => {
    const text = 'cat and cat';
    const { kept, orphaned } = reanchorAnnotations([{ text }], [{
      block: 0, quote: 'cat', start: -3, end: 0,
    }]);
    expect(orphaned).toBe(0);
    expect(kept[0]!.start).toBeGreaterThanOrEqual(0);
    expect(text.slice(kept[0]!.start, kept[0]!.end)).toBe('cat');
  });

  it('keeps a highlight whose quote is not text, instead of deleting it', () => {
    const note = { block: 0, quote: 12, start: 0, end: 2 };
    const { kept, orphaned } = reanchorAnnotations(
      [{ text: '12 men remained' }],
      [note as unknown as { block: number; quote: string; start: number; end: number }],
    );
    expect(orphaned).toBe(0);
    expect(kept).toEqual([note]);
  });

  it('counts a quote the new text no longer contains', () => {
    const { kept, orphaned } = reanchorAnnotations(
      [{ text: 'the harbor' }],
      [{ block: 0, quote: 'lighthouse', start: 0, end: 10 }],
    );
    expect(kept).toEqual([]);
    expect(orphaned).toBe(1);
  });
});

describe('find', () => {
  const blocks = [
    block('The harbor kept its clock.'),
    block('İstanbul is a city on the water.'),
  ];
  const chapters = [{ start: 0, end: 1 }, { start: 1, end: 2 }];

  it('marks the matched word, including when the context starts with an ellipsis', () => {
    const padding = 'word '.repeat(20);
    const text = `${padding}harbor ${padding}`;
    const [hit] = search([block(text)], [{ start: 0, end: 1 }], 'Harbor');
    expect(hit).toBeDefined();
    expect(hit!.context.slice(hit!.at, hit!.at + hit!.length)).toBe('harbor');
    expect(hit!.context.startsWith('…')).toBe(true);
  });

  it('does not shift the mark when a letter grows under case folding', () => {
    const [hit] = search(blocks, chapters, 'İstan');
    expect(hit).toBeDefined();
    expect(hit!.block).toBe(1);
    expect(hit!.context.slice(hit!.at, hit!.at + hit!.length)).toBe('İstan');
  });

  it('ignores a query of a single letter', () => {
    expect(search(blocks, chapters, 'a')).toEqual([]);
  });
});

describe('reader keys', () => {
  const idle = {
    editing: false, lookup: false, speaking: false, note: false, pending: false,
  };

  it('closes the dictionary instead of leaving the book', () => {
    expect(readerCommand('Escape', { ...idle, lookup: true }).kind).toBe('close-lookup');
  });

  it('stops speech instead of leaving the book', () => {
    expect(readerCommand('Escape', { ...idle, speaking: true }).kind).toBe('stop-speech');
  });

  it('leaves the book only when nothing else is open', () => {
    expect(readerCommand('Escape', idle).kind).toBe('back');
  });

  it('does not highlight or mark read while the split is being edited', () => {
    expect(readerCommand('h', { ...idle, editing: true }).kind).toBe('ignore');
    expect(readerCommand('m', { ...idle, editing: true }).kind).toBe('ignore');
    expect(readerCommand('u', { ...idle, editing: true }).kind).toBe('undo-edit');
  });

  it('does not turn the page when Command, Control, or Alt is held', () => {
    expect(readerCommand('n', idle, true).kind).toBe('ignore');
    expect(readerCommand('Escape', { ...idle, lookup: true }, true).kind).toBe('close-lookup');
  });
});

describe('exported figure names', () => {
  it('keeps a readable name and does not let two different paths share it', () => {
    expect(imageFilename('OEBPS/img/chart.png')).toBe('OEBPS_img_chart.png');
    expect(imageFilename('a/b.png')).not.toBe(imageFilename('a..b.png'));
    expect(imageFilename('OEBPS/img/şəkil.png')).not.toBe(imageFilename('OEBPS/img/çəkil.png'));
    for (const path of ['a/b.png', 'a..b.png', '../secret.png', 'OEBPS/img/şəkil.png']) {
      const name = imageFilename(path);
      expect(name).not.toMatch(/[\\/]/);
      expect(name).not.toContain('..');
    }
  });
});

describe('a book folder across a re-split', () => {
  it('keeps when the book was sent, and when it was imported', () => {
    const next = carryBookState(
      { createdAt: '2020-01-01T00:00:00.000Z', sentToKindle: '2024-05-01T00:00:00.000Z' },
      { createdAt: '2026-10-15T00:00:00.000Z', title: 'Harbor Notes', progress: {} },
    );
    expect(next.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(next.sentToKindle).toBe('2024-05-01T00:00:00.000Z');
    expect(next.title).toBe('Harbor Notes');
    expect(next.progress).toEqual({});
  });

  it('does not invent a Kindle send the book never had', () => {
    const next = carryBookState(
      { createdAt: '2020-01-01T00:00:00.000Z' },
      { createdAt: '2026-10-15T00:00:00.000Z' },
    );
    expect(next.sentToKindle).toBeUndefined();
    expect(next.createdAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('names the file when stored JSON cannot be read', () => {
    expect(parseStoredJson('{"ok":true}', 'index.json')).toEqual({ ok: true });
    expect(() => parseStoredJson('{', '/library/Harbor/annotations.json'))
      .toThrow(/annotations\.json is not valid JSON/);
    expect(() => parseStoredJson('{', '/library/Harbor/annotations.json'))
      .toThrow(/not modified/);
  });

  it('reports one bad index without throwing, and refuses a file that is not a list of highlights', () => {
    const bad = tryParseBookIndex('{', '/library/Harbor/index.json');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/Harbor\/index\.json/);

    const list = tryParseBookIndex('[]', '/library/Harbor/index.json');
    expect(list.ok).toBe(false);

    const empty = tryParseBookIndex('{"title":"Harbor"}', '/library/Harbor/index.json');
    expect(empty.ok).toBe(false);

    const ok = tryParseBookIndex(
      '{"title":"Harbor","chapters":[{"title":"Salt"}]}',
      '/library/Harbor/index.json',
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.index.title).toBe('Harbor');
      expect(ok.index.finished).toEqual([]);
    }

    expect(parseAnnotationList('[]', 'annotations.json')).toEqual([]);
    expect(() => parseAnnotationList('{}', '/library/Harbor/annotations.json'))
      .toThrow(/not a list of highlights/);
    expect(() => parseAnnotationList('{}', '/library/Harbor/annotations.json'))
      .toThrow(/not modified/);
  });
});
