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

function titleKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Headings fallback, for books with no usable TOC.
 *
 * The shallowest level whose titles actually differ wins. A running header
 * (`<h1>` of the book title on every file) has one distinct title, so it is
 * not a table of contents — the next level down is the chapter. Subsections
 * are not consulted once a diverse level has been found, or a book of ten
 * chapters and forty h2s would split into forty chapters.
 */
export function detectFromHeadings(book: Book, level?: number): Detection {
  const levels = level ? [level] : [1, 2, 3];
  let best: CutPoint[] = [];
  // A heading on every block is a running header, not a chapter, so a long
  // book may only keep a level with at least about three blocks behind each
  // cut. A pamphlet whose chapter is a heading plus one paragraph never
  // reaches that ratio, and the test used to throw those headings away —
  // the whole file became one chapter. The floor admits a handful of real
  // headings; on a long book the one-third cap still rejects the running header.
  const cap = Math.max(
    Math.floor(book.blocks.length / 3),
    Math.min(book.blocks.length, 12),
  );

  for (const lvl of levels) {
    const cuts = book.blocks
      .map((block, at) => ({ block, at }))
      .filter(({ block }) => block.heading === lvl && block.text.length > 0)
      .map(({ block, at }): CutPoint => ({ at, title: block.text, source: 'heading', depth: 0 }));
    if (level) {
      best = cuts;
      break;
    }
    // Shallowest diverse level wins, so a repeated running header is skipped
    // and a book of ten chapters is not split on its forty subsections. The
    // cap above is what lets a pamphlet keep a heading plus one paragraph.
    const distinct = new Set(cuts.map((c) => titleKey(c.title))).size;
    if (cuts.length >= 2 && cuts.length <= cap && distinct > 1) {
      best = cuts;
      break;
    }
  }
  return { cuts: normalise(best, 'heading'), strategy: 'heading', unresolved: [] };
}

/**
 * One sentence a person can act on. The three reasons are different failures:
 * a cover that is only a picture is normal, a missing id starts the chapter at
 * the top of its file, and a path outside the spine means the entry was dropped.
 */
export function explainUnresolved(item: UnresolvedEntry): string {
  const label = item.entry.label.trim() || 'A contents entry';
  const file = item.entry.path || '(no path)';
  switch (item.reason) {
    case 'path-not-in-spine':
      return `"${label}" points at "${file}", which is not in this book's spine, so that contents entry was dropped.`;
    case 'fragment-not-found':
      return `"${label}" points at "#${item.entry.fragment ?? ''}" in "${file}", but nothing in that file has that id. The chapter starts at the top of the file instead.`;
    case 'document-has-no-text':
      return `"${label}" points at "${file}", which has no extractable text. An image-only cover does this and can be ignored.`;
  }
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
    // A single TOC entry is not a table of contents. Several entries that all
    // collapse onto one block aren't either — but the reasons they failed are
    // still why the fallback ran, and dropping them leaves the UI saying only
    // "found from headings" with no account of the broken links.
    const fromToc = book.toc.length > 1 ? detectFromToc(book) : undefined;
    if (fromToc && fromToc.cuts.length > 1) return fromToc;
    if (strategy === 'toc') return detectFromToc(book);
    const unresolved = fromToc?.unresolved ?? [];
    const fromHeadings = detectFromHeadings(book);
    if (fromHeadings.cuts.length > 1) return { ...fromHeadings, unresolved };
    return { ...detectFromSpine(book), unresolved };
  }
  return detectFromSpine(book);
}
