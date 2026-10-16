import { must } from './must.js';
import type { Block } from './types.js';

export interface Hit {
  block: number;
  chapter: number;
  /** Text around the match, with the match itself marked by offsets. */
  context: string;
  at: number;
  length: number;
}

/**
 * Lowercase `text` and remember where each folded unit came from.
 *
 * `toLowerCase` is not length-preserving: Turkish `İ` becomes `i` plus a
 * combining dot. An index into the lowercased string then highlights the
 * wrong letters of the original. The map sends a folded index back. When
 * nothing expanded, the map is omitted and the indexes already agree.
 */
function foldWithMap(text: string): { folded: string; map: number[] | null } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const ch = cp === undefined ? must(text[i], 'text[i]') : String.fromCodePoint(cp);
    const low = ch.toLowerCase();
    for (let k = 0; k < low.length; k++) map.push(i);
    folded += low;
    i += ch.length;
  }
  return folded.length === text.length ? { folded, map: null } : { folded, map };
}

/** Original span of a match found in the folded string. */
function originalSpan(
  map: number[] | null,
  at: number,
  needleLen: number,
  textLen: number,
): { at: number; length: number } {
  if (!map) return { at, length: needleLen };
  const start = map[at] ?? 0;
  const end = map[at + needleLen] ?? textLen;
  return { at: start, length: Math.max(0, end - start) };
}

/**
 * Find a phrase across the whole book.
 *
 * Searches `Block.text`, which is the same string annotation offsets index
 * into, so a hit's position is directly usable for scrolling and highlighting.
 */
export function search(
  blocks: readonly Block[],
  chapters: readonly { start: number; end: number }[],
  query: string,
  limit = 200,
): Hit[] {
  const raw = query.trim();
  if (raw.length < 2) return [];
  // Fold the query the same way as the block. Whole-string toLowerCase and a
  // per-character fold disagree on a few letters, and the match would then
  // highlight a span the query never named.
  const needle = foldWithMap(raw).folded;
  if (!needle) return [];

  const hits: Hit[] = [];
  for (let b = 0; b < blocks.length && hits.length < limit; b++) {
    const text = must(blocks[b], 'blocks[b]').text;
    const { folded, map } = foldWithMap(text);
    let from = 0;
    while (hits.length < limit) {
      const foldedAt = folded.indexOf(needle, from);
      if (foldedAt < 0) break;
      const found = originalSpan(map, foldedAt, needle.length, text.length);
      const windowStart = Math.max(0, found.at - 45);
      const prefix = windowStart > 0 ? '…' : '';
      hits.push({
        block: b,
        chapter: chapters.findIndex((c) => b >= c.start && b < c.end),
        context: prefix + text.slice(windowStart, found.at + found.length + 55),
        at: found.at - windowStart + prefix.length,
        length: found.length,
      });
      // Advance in the folded string. A match that grew is more than one unit.
      from = foldedAt + needle.length;
    }
  }
  return hits;
}
