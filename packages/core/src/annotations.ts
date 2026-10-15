/**
 * Highlights, as the core pipeline sees them.
 *
 * A highlight is a quote plus the offsets of that quote inside one block.
 * The quote is what survives a re-split; the offsets are what the reader
 * paints. They have to name the same characters, or a later re-split moves
 * the mark onto a different occurrence of the same words.
 */

export interface HighlightNote {
  quote: string;
  note?: string;
}

export interface AnnotationRange {
  start: number;
  end: number;
  quote: string;
}

/**
 * The span a highlight actually covers.
 *
 * Offsets come from the rendered block; the stored quote used to be
 * `selection.toString().trim()`, which drops the surrounding spaces but
 * leaves the offsets where they were. The quote then no longer matches
 * `text.slice(start, end)`, and re-anchoring searches for a string the
 * offsets don't point at.
 */
export function annotationRange(text: string, start: number, end: number): AnnotationRange | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  let a = Math.trunc(start);
  let b = Math.trunc(end);
  if (a > b) [a, b] = [b, a];
  a = Math.max(0, Math.min(a, text.length));
  b = Math.max(a, Math.min(b, text.length));
  while (a < b && /\s/.test(text[a] ?? '')) a++;
  while (b > a && /\s/.test(text[b - 1] ?? '')) b--;
  if (a === b) return null;
  return { start: a, end: b, quote: text.slice(a, b) };
}

interface Anchored {
  block: number;
  quote: string;
  start: number;
  end: number;
}

/** Index of `quote` in `text` closest to `prefer`, or -1 when it is absent. */
function nearestOccurrence(text: string, quote: string, prefer: number): number {
  // `String.slice` treats a negative start as an offset from the end, so a
  // corrupt highlight at -3 can "match" and be stored there. Offsets are
  // indexes into the block, and a negative one paints the wrong words.
  const origin = Number.isFinite(prefer) ? Math.trunc(prefer) : 0;
  const clamped = Math.min(text.length, Math.max(0, origin));
  if (text.slice(clamped, clamped + quote.length) === quote) return clamped;
  let best = -1;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(quote, from);
    if (at < 0) break;
    if (best < 0 || Math.abs(at - prefer) < Math.abs(best - prefer)) best = at;
    from = at + Math.max(quote.length, 1);
  }
  return best;
}

/**
 * Place existing highlights onto a newly parsed block array.
 *
 * Block indices move when the parser changes. The quote is searched for,
 * preferring the block nearest the old index and, inside that block, the
 * occurrence nearest the old offset. The first `indexOf` hit used to win,
 * so the second "cat" in a paragraph jumped onto the first. A quote that
 * no longer occurs anywhere is counted and left out, rather than pinned
 * to block 0 — an empty quote matches every block at offset 0.
 */
export function reanchorAnnotations<T extends Anchored>(
  blocks: readonly { text: string }[],
  notes: readonly T[],
): { kept: T[]; orphaned: number } {
  const kept: T[] = [];
  let orphaned = 0;
  for (const note of notes) {
    const quote = note.quote;
    // A highlight whose quote is not text cannot be placed, and it must not
    // be deleted either: resplit rewrites the file from what this returns.
    if (typeof quote !== 'string') {
      kept.push(note);
      continue;
    }
    if (!quote.trim()) {
      orphaned++;
      continue;
    }
    const origin = Number.isFinite(note.block) ? note.block : 0;
    const order = blocks
      .map((block, at) => ({ block, at }))
      .filter(({ block }) => block.text.includes(quote))
      .sort((a, b) => Math.abs(a.at - origin) - Math.abs(b.at - origin)
        || a.at - b.at);
    const hit = order[0];
    if (!hit) {
      orphaned++;
      continue;
    }
    const prefer = hit.at === note.block ? note.start : 0;
    const start = nearestOccurrence(hit.block.text, quote, prefer);
    if (start < 0) {
      orphaned++;
      continue;
    }
    kept.push({ ...note, block: hit.at, start, end: start + quote.length });
  }
  return { kept, orphaned };
}

/**
 * Append the reader's highlights to a chapter that was exported on its own.
 *
 * The chapter file is the book's text. The highlights are the reader's, and
 * they go at the end so the prose the author wrote stays uninterrupted.
 * A quote that spans lines is quoted on every line; prefixing only the first
 * leaves the rest as ordinary paragraphs.
 */
export function withHighlights(markdown: string, notes: readonly HighlightNote[]): string {
  const blocks: string[] = [];
  for (const note of notes) {
    const quote = note.quote.trim();
    if (!quote) continue;
    const quoted = quote.split('\n').map((line) => `> ${line}`).join('\n');
    const extra = note.note?.trim();
    blocks.push(extra ? `${quoted}\n\n${extra}` : quoted);
  }
  if (!blocks.length) return markdown;
  return `${markdown.replace(/\n+$/, '')}\n\n---\n\n## My highlights\n\n${blocks.join('\n\n')}\n`;
}
