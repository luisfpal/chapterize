import type { Block, Chapter } from './types.js';

/**
 * Deriving a usable chapter title is harder than reading the first heading, and
 * The 48 Laws of Power shows why. Every one of its 51 chapters opens with the
 * same `<h1>48 Laws of Power</h1>` (the book title, repeated), then `<h2>LAW 1</h2>`,
 * and the actual title — NEVER OUTSHINE THE MASTER — sits in plain paragraphs
 * with no heading markup at all, split across three separate elements.
 *
 * So: suppress text that repeats across chapters (that is boilerplate by
 * definition, whatever it is), then join the run of short shouty lines that
 * follows, which is how print titles survive conversion to XHTML.
 */

/** How far into a chapter a title may plausibly appear. */
const LOOKAHEAD = 12;
const MAX_TITLE_CHARS = 90;

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Mostly-uppercase and short: the signature of a display title in converted print. */
function isShouty(text: string): boolean {
  if (text.length > 60) return false;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length > 0.8;
}

/**
 * Text appearing at the head of many chapters carries no chapter identity.
 * Frequency, not a hardcoded string, so this generalises to any book.
 */
export function findBoilerplate(chapters: Chapter[], blocks: Block[]): Set<string> {
  const counts = new Map<string, number>();
  for (const ch of chapters) {
    const seen = new Set<string>();
    for (let i = ch.start; i < Math.min(ch.end, ch.start + LOOKAHEAD); i++) {
      const key = normalise(blocks[i]!.text);
      if (key) seen.add(key);
    }
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(2, chapters.length * 0.2);
  return new Set([...counts].filter(([, n]) => n > threshold).map(([k]) => k));
}

/**
 * Improve a chapter's title using its own content.
 *
 * The TOC label is kept as a prefix when it is a bare enumerator ("LAW 7",
 * "Chapter 3"), because "Law 7 — Get Others to Do the Work for You" is more
 * useful in a file list than either half alone.
 */
export function deriveTitle(
  chapter: Chapter,
  blocks: Block[],
  boilerplate: Set<string>,
): string {
  const label = chapter.title.trim();
  const parts: string[] = [];

  for (let i = chapter.start; i < Math.min(chapter.end, chapter.start + LOOKAHEAD); i++) {
    const text = blocks[i]!.text.trim();
    const key = normalise(text);
    if (!text || boilerplate.has(key) || key === normalise(label)) {
      if (parts.length) break;
      continue;
    }
    if (text.length > MAX_TITLE_CHARS) break;

    if (!parts.length) {
      parts.push(text);
      if (!isShouty(text)) break;
    } else if (isShouty(text)) {
      // Continuation of a display title broken across elements.
      parts.push(text);
    } else break;
  }

  const derived = titleCase(parts.join(' ').replace(/\s+/g, ' ').trim());
  if (!derived) return label || 'Untitled';
  if (!label) return derived;
  if (normalise(derived).includes(normalise(label))) return derived;
  return `${label} — ${derived}`;
}

/** Title-case a shouty line, leaving mixed-case text alone. */
function titleCase(s: string): string {
  const letters = s.replace(/[^A-Za-z]/g, '');
  const upper = letters.replace(/[^A-Z]/g, '').length;
  if (!letters.length || upper / letters.length < 0.8) return s;

  const minor = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in',
    'nor', 'of', 'on', 'or', 'the', 'to', 'up', 'with', 'is', 'it']);
  return s.toLowerCase().split(' ').map((word, i, all) => {
    if (i > 0 && i < all.length - 1 && minor.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

/** Apply title derivation across a whole book in one pass. */
export function deriveTitles(chapters: Chapter[], blocks: Block[]): Chapter[] {
  const boilerplate = findBoilerplate(chapters, blocks);
  return chapters.map((ch) => ({ ...ch, title: deriveTitle(ch, blocks, boilerplate) }));
}
