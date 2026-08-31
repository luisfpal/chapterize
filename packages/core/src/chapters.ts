import type { Block, BlockIndex, Chapter, CutPoint } from './types.js';

/** Cut points become chapters: chapter i spans [cuts[i].at, cuts[i+1].at). */
export function toChapters(cuts: CutPoint[], blocks: Block[]): Chapter[] {
  return cuts.map((cut, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1]!.at : blocks.length;
    let chars = 0;
    for (let b = cut.at; b < end; b++) chars += blocks[b]!.text.length;
    return {
      index: i,
      title: cut.title,
      start: cut.at,
      end,
      source: cut.source,
      depth: cut.depth,
      chars,
    };
  });
}

/**
 * Editing operations. Each returns a new CutPoint[], so undo is just keeping the
 * previous array — no separate undo machinery is needed anywhere else.
 */

export function splitAt(cuts: CutPoint[], at: BlockIndex, title = 'Untitled'): CutPoint[] {
  if (cuts.some((c) => c.at === at)) return cuts;
  return [...cuts, { at, title, source: 'manual' as const, depth: 0 }].sort((a, b) => a.at - b.at);
}

/** Remove the boundary at `index`, merging that chapter into the previous one. */
export function mergeUp(cuts: CutPoint[], index: number): CutPoint[] {
  if (index <= 0 || index >= cuts.length) return cuts;
  return cuts.filter((_, i) => i !== index);
}

export function retitle(cuts: CutPoint[], index: number, title: string): CutPoint[] {
  if (index < 0 || index >= cuts.length) return cuts;
  return cuts.map((c, i) => (i === index ? { ...c, title } : c));
}

/**
 * Merge chapters below `minChars` into their predecessor.
 *
 * This is what removes the Cover / Title Page / Copyright noise that otherwise
 * occupies the first several slots of every book.
 */
export function mergeSmall(cuts: CutPoint[], blocks: Block[], minChars: number): CutPoint[] {
  const chapters = toChapters(cuts, blocks);
  const keep = new Set<number>([0]);
  chapters.forEach((ch, i) => {
    if (i > 0 && ch.chars >= minChars) keep.add(i);
  });
  return cuts.filter((_, i) => keep.has(i));
}

/**
 * Reduce to at most `max` chapters by repeatedly dissolving the boundary in
 * front of the smallest chapter. Used to fit a destination's source limit.
 */
export function limitCount(cuts: CutPoint[], blocks: Block[], max: number): CutPoint[] {
  let current = cuts;
  while (current.length > max && current.length > 1) {
    const chapters = toChapters(current, blocks);
    let victim = 1;
    for (let i = 1; i < chapters.length; i++) {
      if (chapters[i]!.chars < chapters[victim]!.chars) victim = i;
    }
    current = mergeUp(current, victim);
  }
  return current;
}
