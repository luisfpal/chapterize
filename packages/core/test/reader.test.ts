import { describe, expect, it } from 'vitest';
import type { Block, Chapter } from '../src/types.js';
import { assignImageNames, escapeHtml, renderChapterHtml, safeInline } from '../src/reader.js';

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

const chapter: Chapter = {
  index: 0, title: 'Ch', start: 0, end: 0, source: 'toc', depth: 0, chars: 0,
};

describe('safeInline', () => {
  it('keeps emphasis and drops attributes, scripts, and foreign tags', () => {
    const html = 'Hello <em onclick="alert(1)">you</em> <script>alert(1)</script><img src=x onerror=alert(1)> <strong>go</strong>';
    expect(safeInline(html)).toBe('Hello you  <strong>go</strong>');
    expect(safeInline(html)).not.toContain('alert');
    expect(safeInline(html)).not.toContain('onerror');
  });

  it('does not double-escape entities the parser already escaped', () => {
    expect(safeInline('A &amp; B &lt; C')).toBe('A &amp; B &lt; C');
  });

  it('escapes raw text', () => {
    expect(safeInline('a < b & c')).toBe('a &lt; b &amp; c');
  });
});

describe('renderChapterHtml', () => {
  it('escapes titles, numbers footnotes, and refuses a path in an image name', () => {
    const blocks: Block[] = [
      block({ text: 'A <title>', tag: 'h1', heading: 1, html: 'A &lt;title&gt;' }),
      block({
        text: 'See the star.',
        html: 'See the star<noteref>*</noteref>.',
        noterefs: [{ label: '*', key: 'notes.xhtml#n1' }],
      }),
      block({ text: 'One', tag: 'li' }),
      block({ text: 'Two', tag: 'li' }),
      block({ text: '', tag: 'figure', image: 'OEBPS/images/a b.png', alt: 'A "dot"' }),
    ];
    const names = assignImageNames(blocks.flatMap((b) => (b.image ? [b.image] : [])));
    const html = renderChapterHtml({ ...chapter, end: blocks.length }, blocks, new Map([
      ['notes.xhtml#n1', 'The cited remark.'],
    ]), names);
    expect(html).toContain('<h1>A &lt;title&gt;</h1>');
    expect(html).toContain('<sup><a href="#fn-1" id="ref-1">1</a></sup>');
    expect(html).toContain('<li id="fn-1">The cited remark.');
    expect(html).toContain('<ul><li>One</li><li>Two</li></ul>');
    expect(html).toContain('src="images/ab.png"');
    expect(html).toContain('alt="A &quot;dot&quot;"');
    expect(html).not.toContain('..');
    expect(escapeHtml(`"<>&`)).toBe('&quot;&lt;&gt;&amp;');
  });

  it('gives two images with the same basename different files', () => {
    const names = assignImageNames(['a/cover.jpg', 'b/cover.jpg']);
    expect([...names.values()]).toEqual(['cover.jpg', 'cover-2.jpg']);
  });
});
