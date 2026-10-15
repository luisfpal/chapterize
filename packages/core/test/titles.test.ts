import { describe, expect, it } from 'vitest';
import { mergeStubs, toChapters } from '../src/chapters.js';
import { deriveTitles, findBoilerplate } from '../src/titles.js';
import type { Block, CutPoint, HeadingLevel } from '../src/types.js';

function para(text: string, heading: HeadingLevel = 0): Block {
  return {
    spineIndex: 0,
    path: 'OEBPS/text/laws.xhtml',
    ids: [],
    tag: heading === 0 ? 'p' : `h${heading}`,
    heading,
    text,
    html: text,
  };
}

function cut(at: number, title: string): CutPoint {
  return { at, title, source: 'toc', depth: 0 };
}

describe('repeated headings', () => {
  it('keeps a line that both chapters of a two-chapter book share', () => {
    // The count must exceed max(2, 20% of the chapters). Two occurrences do
    // not, so deriveTitle stops on the repeated h1 and never reaches the
    // shouty lines under it.
    const blocks = [
      para('Synthetic Laws', 1),
      para('NEVER'),
      para('Synthetic Laws', 1),
      para('CONCEAL'),
    ];
    const chapters = toChapters([cut(0, 'LAW 1'), cut(2, 'LAW 2')], blocks);
    expect(findBoilerplate(chapters, blocks).has('synthetic laws')).toBe(false);
    expect(deriveTitles(chapters, blocks).map((chapter) => chapter.title)).toEqual([
      'LAW 1 — Synthetic Laws',
      'LAW 2 — Synthetic Laws',
    ]);
  });

  it('drops a heading that opens three chapters and joins the shouty lines', () => {
    const blocks = [
      para('Synthetic Laws', 1),
      para('LAW 1'),
      para('NEVER'),
      para('OUTSHINE'),
      para('THE MASTER'),
      para('Synthetic Laws', 1),
      para('CONCEAL'),
      para('YOUR INTENTIONS'),
      para('Synthetic Laws', 1),
      para('KEEP'),
      para('YOUR MOUTH SHUT'),
    ];
    const chapters = toChapters([cut(0, 'LAW 1'), cut(5, 'LAW 2'), cut(8, 'LAW 3')], blocks);
    expect(findBoilerplate(chapters, blocks).has('synthetic laws')).toBe(true);
    expect(deriveTitles(chapters, blocks).map((chapter) => chapter.title)).toEqual([
      'LAW 1 — Never Outshine the Master',
      'LAW 2 — Conceal Your Intentions',
      'LAW 3 — Keep Your Mouth Shut',
    ]);
  });
});

describe('mergeStubs', () => {
  it('sends a part divider forward and a trailing stub backward', () => {
    // A divider is the heading of what follows. A trailing blank has nowhere
    // to go but into the chapter before it. The other direction opens the
    // reader on a section title.
    const blocks = [
      para('x'.repeat(250)),
      para('PART'),
      para('y'.repeat(250)),
      para('z'.repeat(40)),
    ];
    const merged = mergeStubs(
      [cut(0, 'One'), cut(1, 'Part'), cut(2, 'Two'), cut(3, 'End')],
      blocks,
      200,
    );
    expect(merged.map((point) => point.title)).toEqual(['One', 'Two']);
    expect(merged.map((point) => point.at)).toEqual([0, 1]);
  });

  it('keeps a chapter that meets the character floor', () => {
    const blocks = [para('x'.repeat(200)), para('y'.repeat(200))];
    const merged = mergeStubs([cut(0, 'One'), cut(1, 'Two')], blocks, 200);
    expect(merged.map((point) => point.at)).toEqual([0, 1]);
  });
});
