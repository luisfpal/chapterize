import type { Block, BlockIndex, Book, CutPoint, Detection, SpineItem, TocEntry, UnresolvedEntry } from './types.js';

/**
 * Every strategy returns the same shape: a sorted, deduplicated CutPoint[] that
 * always starts at block 0. Downstream code never asks which strategy ran.
 */

/** First block belonging to each spine document, by path. */
function pathStarts(blocks: Block[]): Map<string, BlockIndex> {
  const starts = new Map<string, BlockIndex>();
  blocks.forEach((b, i) => {
    if (!starts.has(b.path)) starts.set(b.path, i);
  });
  return starts;
}

/**
 * Resolve a TOC href to a block.
 *
 * No fragment  -> first block of that document.
 * Fragment     -> the block carrying that id. Ids on wrappers and inline anchors
 *                 were pushed onto the next block when the blocks were built.
 *
 * A missing fragment still resolves to the start of its document, because a
 * chapter at the wrong offset beats a chapter that silently vanishes — but the
 * caller is told, so the UI can say so.
 */
function resolve(
  entry: TocEntry,
  blocks: Block[],
  starts: Map<string, BlockIndex>,
  spinePaths: Set<string>,
): { at: BlockIndex } | { reason: UnresolvedEntry['reason'] } {
  const start = starts.get(entry.path);
  if (start === undefined) {
    return {
      reason: spinePaths.has(entry.path) ? 'document-has-no-text' : 'path-not-in-spine',
    };
  }
  if (entry.fragment === undefined) return { at: start };

  for (let i = start; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.path !== entry.path) break;
    if (block.ids.includes(entry.fragment)) return { at: i };
  }
  return { reason: 'fragment-not-found' };
}

/** Sort, drop duplicate positions, and guarantee a cut at block 0. */
function normalise(cuts: CutPoint[], strategy: CutPoint['source']): CutPoint[] {
  const sorted = [...cuts].sort((a, b) => a.at - b.at || a.depth - b.depth);
  const unique: CutPoint[] = [];
  for (const cut of sorted) {
    if (unique.length && unique[unique.length - 1]!.at === cut.at) continue;
    unique.push(cut);
  }
  if (!unique.length || unique[0]!.at !== 0) {
    unique.unshift({ at: 0, title: 'Front matter', source: strategy, depth: 0 });
  }
  return unique;
}

export function detectFromToc(book: Book): Detection {
  const starts = pathStarts(book.blocks);
  const spinePaths = new Set(book.spine.map((s: SpineItem) => s.path));
  const cuts: CutPoint[] = [];
  const unresolved: UnresolvedEntry[] = [];

  for (const entry of book.toc) {
    const result = resolve(entry, book.blocks, starts, spinePaths);
    if ('at' in result) {
      cuts.push({ at: result.at, title: entry.label, source: 'toc', depth: entry.depth });
    } else {
      unresolved.push({ entry, reason: result.reason });
      // Degrade to the document start rather than losing the chapter entirely.
      const fallback = starts.get(entry.path);
      if (fallback !== undefined) {
        cuts.push({ at: fallback, title: entry.label, source: 'toc', depth: entry.depth });
      }
    }
  }
  return { cuts: normalise(cuts, 'toc'), strategy: 'toc', unresolved };
}

/**
 * Headings fallback, for books with no usable TOC.
 *
 * Picks the shallowest heading level that yields a sensible number of chapters.
 * h1 is tried first; if a book puts its title in an h1 on every page (common in
 * Calibre output) that yields one cut per file, so h2 is tried too and whichever
 * produces more distinct cuts without exploding wins.
 */
export function detectFromHeadings(book: Book, level?: number): Detection {
  const levels = level ? [level] : [1, 2, 3];
  let best: CutPoint[] = [];

  for (const lvl of levels) {
    const cuts = book.blocks
      .map((block, at) => ({ block, at }))
      .filter(({ block }) => block.heading === lvl && block.text.length > 0)
      .map(({ block, at }): CutPoint => ({ at, title: block.text, source: 'heading', depth: 0 }));
    if (cuts.length > best.length && cuts.length <= book.blocks.length / 3) best = cuts;
    if (level) best = cuts;
  }
  return { cuts: normalise(best, 'heading'), strategy: 'heading', unresolved: [] };
}

/** Last resort: one chapter per spine document. */
export function detectFromSpine(book: Book): Detection {
  const seen = new Set<string>();
  const cuts: CutPoint[] = [];
  book.blocks.forEach((block, at) => {
    if (seen.has(block.path)) return;
    seen.add(block.path);
    cuts.push({ at, title: block.path.split('/').pop() ?? block.path, source: 'spine', depth: 0 });
  });
  return { cuts: normalise(cuts, 'spine'), strategy: 'spine', unresolved: [] };
}

/**
 * Run the fallback chain. A TOC with a single entry is not a table of contents,
 * so it is rejected in favour of headings.
 */
export function detect(book: Book, strategy?: CutPoint['source']): Detection {
  if (strategy === 'heading') return detectFromHeadings(book);
  if (strategy === 'spine') return detectFromSpine(book);
  if (strategy === 'toc' || strategy === undefined) {
    if (book.toc.length > 1) {
      const fromToc = detectFromToc(book);
      if (fromToc.cuts.length > 1) return fromToc;
    }
    if (strategy === 'toc') return detectFromToc(book);
    const fromHeadings = detectFromHeadings(book);
    if (fromHeadings.cuts.length > 1) return fromHeadings;
    return detectFromSpine(book);
  }
  return detectFromSpine(book);
}
