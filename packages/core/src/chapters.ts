import type { Block, BlockIndex, Book, Chapter, CutPoint } from './types.js';
import { must } from './must.js';
import { deriveTitles } from './titles.js';

/** A contents label that names chapter, book, or law N. Part numbers are not chapters. */
export type ChapterScheme = 'chapter' | 'book' | 'law';

const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
] as const;

const ROMAN: readonly (readonly [string, number])[] = [
  ['m', 1000],
  ['cm', 900],
  ['d', 500],
  ['cd', 400],
  ['c', 100],
  ['xc', 90],
  ['l', 50],
  ['xl', 40],
  ['x', 10],
  ['ix', 9],
  ['v', 5],
  ['iv', 4],
  ['i', 1],
];

function toRoman(value: number): string {
  let rest = value;
  let out = '';
  for (const [symbol, amount] of ROMAN) {
    while (rest >= amount) {
      out += symbol;
      rest -= amount;
    }
  }
  return out;
}

/** Canonical roman only. "mix" and "iiii" are letters, not numbers. */
function romanValue(token: string): number | null {
  const text = token.toLowerCase();
  let at = 0;
  let value = 0;
  while (at < text.length) {
    const pair = ROMAN.find(([symbol]) => text.startsWith(symbol, at));
    if (pair === undefined) return null;
    value += pair[1];
    at += pair[0].length;
  }
  return toRoman(value) === text ? value : null;
}

function schemeOf(word: string): ChapterScheme | null {
  const lower = word.toLowerCase();
  if (lower === 'chapter' || lower === 'book' || lower === 'law') return lower;
  return null;
}

/**
 * The chapter, book, or law number written in a contents label.
 *
 * The word may sit anywhere: a caption often precedes it ("… CHAPTER II."),
 * and the number may be glued on ("CHAPTERXXVII"). "THE FIRST BOOK" is 1.
 * "Part One" and the heading "BOOKS" are not numbers.
 * When a label names two, the later one is the chapter. The caption comes first.
 */
export function chapterIndex(label: string): { scheme: ChapterScheme; n: number } | null {
  const text = label.normalize('NFKC');
  const numbered = /(?<![a-z0-9])(chapter|book|law)\s*(\d+|[ivxlcdm]+)(?![a-z0-9])/gi;
  let chosen: { scheme: ChapterScheme; n: number } | null = null;
  for (const match of text.matchAll(numbered)) {
    const word = match[1];
    const raw = match[2];
    if (word === undefined || raw === undefined) continue;
    const scheme = schemeOf(word);
    if (scheme === null) continue;
    const n = /^\d+$/.test(raw) ? Number(raw) : romanValue(raw);
    if (n === null || n < 1) continue;
    chosen = { scheme, n };
  }
  if (chosen !== null) return chosen;

  const schemeMatch = /(?<![a-z0-9])(chapter|book|law)(?![a-z0-9])/i.exec(text);
  const word = schemeMatch?.[1];
  if (word === undefined) return null;
  const scheme = schemeOf(word);
  if (scheme === null) return null;
  for (let i = 0; i < ORDINALS.length; i++) {
    const ordinal = ORDINALS[i];
    if (ordinal === undefined) continue;
    if (new RegExp(`(?<![a-z0-9])${ordinal}(?![a-z0-9])`, 'i').test(text)) {
      return { scheme, n: i + 1 };
    }
  }
  return null;
}

/**
 * Longest contents run whose numbers are 1, 2, 3, … in reading order.
 *
 * An unnumbered entry between them is not a break. A second "1" is: the run
 * starts again there, so a half-title "HIS FIRST BOOK" does not eat "THE FIRST BOOK".
 * One numbered entry is not a run. A book with no run keeps every cut.
 */
function bodyRun(cuts: CutPoint[]): CutPoint[] | null {
  let best: CutPoint[] | null = null;
  for (const scheme of ['chapter', 'book', 'law'] as const) {
    const numbered: { cut: CutPoint; n: number }[] = [];
    for (const cut of cuts) {
      const index = chapterIndex(cut.title);
      if (index !== null && index.scheme === scheme) numbered.push({ cut, n: index.n });
    }
    let i = 0;
    while (i < numbered.length) {
      const start = numbered[i];
      if (start === undefined || start.n !== 1) {
        i++;
        continue;
      }
      const run: CutPoint[] = [start.cut];
      let expect = 2;
      let j = i + 1;
      while (j < numbered.length) {
        const next = numbered[j];
        if (next === undefined || next.n !== expect) break;
        run.push(next.cut);
        expect++;
        j++;
      }
      if (run.length >= 2 && (best === null || run.length > best.length)) best = run;
      i = Math.max(j, i + 1);
    }
  }
  return best;
}

function endOfRun(cuts: CutPoint[], run: CutPoint[], blockCount: number): number {
  const last = run[run.length - 1];
  if (last === undefined) return blockCount;
  let tail = blockCount;
  for (const cut of cuts) {
    if (cut.at > last.at && cut.at < tail) tail = cut.at;
  }
  return tail;
}

/**
 * The chapters a reader opens.
 *
 * `detect` still tiles every block, so a preface and a license remain cuts.
 * A run of Chapter 1..N (or Book, or Law) is the book: the preface is not a
 * chapter, and the license does not extend the last one. Without such a run
 * the old split stands, including a part divider folded into what it introduces.
 */
export function readingChapters(book: Book, cuts: CutPoint[], minChars: number): Chapter[] {
  const ordered = [...cuts].sort((a, b) => a.at - b.at);
  const run = bodyRun(ordered);
  const selected = run ?? ordered;
  const limit = run === null ? book.blocks.length : endOfRun(ordered, run, book.blocks.length);
  const blocks = limit === book.blocks.length ? book.blocks : book.blocks.slice(0, limit);
  return deriveTitles(toChapters(mergeStubs(selected, blocks, minChars), blocks), blocks);
}

/** Cut points become chapters: chapter i spans [cuts[i].at, cuts[i+1].at). */
export function toChapters(cuts: CutPoint[], blocks: Block[]): Chapter[] {
  return cuts.map((cut, i) => {
    const next = cuts[i + 1];
    const end = next !== undefined ? next.at : blocks.length;
    let chars = 0;
    for (let b = cut.at; b < end; b++) chars += must(blocks[b], `block ${b}`).text.length;
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
 * Dissolve stub chapters — entries with almost no text of their own.
 *
 * Two kinds exist and they merge in opposite directions:
 *
 *   A part divider ("THE FUNDAMENTALS", 14 tokens) is a heading for what comes
 *   next, so it merges FORWARD and hands its slot to the chapter it introduces.
 *
 *   A trailing blank or colophon has nothing after it, so it merges BACKWARD.
 *
 * Getting the direction wrong is what produces a reader that opens on a page
 * containing nothing but a section title.
 */
export function mergeStubs(cuts: CutPoint[], blocks: Block[], minChars: number): CutPoint[] {
  let current = cuts;
  // Each pass removes at most one boundary, so the loop is bounded by the count.
  for (let guard = 0; guard < cuts.length; guard++) {
    const chapters = toChapters(current, blocks);
    // A numbered chapter is the book, however short. Folding it forward is
    // what dropped Chapter I and left the reader on the next chapter.
    const victim = chapters.findIndex(
      (chapter) => chapter.chars < minChars && chapterIndex(chapter.title) === null,
    );
    if (victim === -1 || chapters.length < 2) break;

    if (victim < current.length - 1) {
      // Forward: keep this start, adopt the following chapter's title.
      const next = must(current[victim + 1], `cut ${victim + 1}`);
      const here = must(current[victim], `cut ${victim}`);
      current = [
        ...current.slice(0, victim),
        { ...next, at: here.at },
        ...current.slice(victim + 2),
      ];
    } else {
      // Backward: the last chapter has nothing to merge into but its predecessor.
      current = current.slice(0, victim);
    }
  }
  return current;
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
      const chapter = must(chapters[i], `chapter ${i}`);
      const smallest = must(chapters[victim], `chapter ${victim}`);
      if (chapter.chars < smallest.chars) victim = i;
    }
    current = mergeUp(current, victim);
  }
  return current;
}
