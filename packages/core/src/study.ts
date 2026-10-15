import type { Block, Chapter } from './types.js';

/**
 * A chapter's study plan.
 *
 * There is no model in this path. "Why it matters" is a sentence the reader
 * writes; the opening below is the chapter's own first paragraph, shown only
 * after that sentence exists. Each question is a template over one section,
 * and its passage is a verbatim prefix of one paragraph — a quotation, not a
 * paraphrase. The phone enforces the order. This function only chooses what
 * is worth asking, and it caps the list so a sitting stays a sitting.
 */

/** How many questions a chapter asks. More than this and the ritual gets skipped. */
export const MAX_STUDY_STEPS = 5;

/** Shorter than this is a caption, a label, or a running header — not a passage. */
const MIN_CHARS = 40;

/**
 * Past this length a passage is cut on a sentence boundary. It remains a
 * prefix of the paragraph, so a test can prove it was not rewritten.
 */
const MAX_PASSAGE = 700;

export interface OutlineItem {
  title: string;
  /** 1–6 for an author heading. 0 for a landmark we chose because there were none. */
  level: number;
  kind: 'heading' | 'landmark';
}

export interface StudyStep {
  id: string;
  question: string;
  /** Verbatim prefix of one paragraph from this chapter. */
  passage: string;
  source: 'heading' | 'landmark';
}

export interface ChapterStudy {
  outline: OutlineItem[];
  /** First substantive paragraph, verbatim. Empty when the chapter has no prose. */
  opening: string;
  steps: StudyStep[];
  /** Some sections have no question. The outline is still complete. */
  stepsSampled: boolean;
}

interface Candidate {
  title: string;
  level: number;
  kind: 'heading' | 'landmark';
  passage: string;
  role: 'section' | 'opening' | 'middle' | 'close';
}

export function buildStudy(
  chapter: Chapter,
  blocks: Block[],
  boilerplate: Set<string>,
): ChapterStudy {
  const opening = openingOf(chapter, blocks);
  const headed = headingStructure(chapter, blocks, boilerplate);

  let outline: OutlineItem[];
  let candidates: Candidate[];
  if (headed && headed.candidates.length > 0) {
    outline = headed.outline;
    candidates = headed.candidates;
  } else {
    const land = landmarkStructure(chapter, blocks);
    outline = headed && headed.outline.length > 0 ? headed.outline : land.outline;
    candidates = land.candidates;
  }

  // The opening is revealed by "why this matters". A question whose answer is
  // that same paragraph would lock the same words twice.
  const usable = candidates.filter((c) => c.passage.length > 0 && c.passage !== opening);
  const picked = sampleEvenly(usable, MAX_STUDY_STEPS);
  const steps = picked.map((c, i) => ({
    id: `s${i}`,
    question: questionFor(c),
    passage: c.passage,
    source: c.kind,
  }));

  return {
    outline,
    opening,
    steps,
    stepsSampled: usable.length > picked.length,
  };
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isProse(block: Block): boolean {
  return block.heading === 0 && block.image === undefined && block.text.trim().length >= MIN_CHARS;
}

/** A prefix of `text`. Sentence boundary when it has to be shortened. */
export function slicePassage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PASSAGE) return trimmed;
  const window = trimmed.slice(0, MAX_PASSAGE);
  let end = -1;
  for (const mark of ['. ', '? ', '! ', '.\n', '?\n', '!\n']) {
    end = Math.max(end, window.lastIndexOf(mark));
  }
  // A tiny leading sentence is a worse quotation than a clean cut.
  if (end >= 80) return trimmed.slice(0, end + 1);
  return window;
}

function openingOf(chapter: Chapter, blocks: Block[]): string {
  for (let i = chapter.start; i < chapter.end; i++) {
    const block = blocks[i];
    if (block && isProse(block)) return slicePassage(block.text);
  }
  return '';
}

interface Head {
  index: number;
  level: number;
  text: string;
}

function headingStructure(
  chapter: Chapter,
  blocks: Block[],
  boilerplate: Set<string>,
): { outline: OutlineItem[]; candidates: Candidate[] } | null {
  const heads: Head[] = [];
  for (let i = chapter.start; i < chapter.end; i++) {
    const block = blocks[i];
    if (!block || block.heading === 0 || !block.text.trim()) continue;
    // A line repeated across chapters is a running header, not a section.
    if (boilerplate.has(normalise(block.text))) continue;
    heads.push({ index: i, level: block.heading, text: block.text.trim() });
  }
  if (heads.length === 0) return null;

  const outline: OutlineItem[] = heads.map((h) => ({
    title: h.text,
    level: h.level,
    kind: 'heading',
  }));

  // The level with the most real sections wins. A single chapter-title h1
  // must not beat the h2s that actually divide the chapter. Ties go deeper.
  let best: Candidate[] = [];
  const levels = [...new Set(heads.map((h) => h.level))];
  for (const level of levels) {
    const candidates: Candidate[] = [];
    for (const head of heads) {
      if (head.level !== level) continue;
      const passage = passageAfter(head, heads, chapter, blocks);
      if (!passage) continue;
      candidates.push({
        title: head.text,
        level,
        kind: 'heading',
        passage,
        role: 'section',
      });
    }
    const deeperTie = candidates.length === best.length && candidates.length > 0 && level > (best[0]?.level ?? 0);
    if (candidates.length > best.length || deeperTie) best = candidates;
  }
  return { outline, candidates: best };
}

function passageAfter(head: Head, heads: Head[], chapter: Chapter, blocks: Block[]): string {
  const next = heads.find((h) => h.index > head.index && h.level <= head.level);
  const end = next ? next.index : chapter.end;
  for (let i = head.index + 1; i < end; i++) {
    const block = blocks[i];
    if (block && isProse(block)) return slicePassage(block.text);
  }
  return '';
}

function landmarkStructure(chapter: Chapter, blocks: Block[]): { outline: OutlineItem[]; candidates: Candidate[] } {
  const paras: string[] = [];
  for (let i = chapter.start; i < chapter.end; i++) {
    const block = blocks[i];
    if (block && isProse(block)) paras.push(slicePassage(block.text));
  }
  if (paras.length === 0) return { outline: [], candidates: [] };

  const picks: { role: 'opening' | 'middle' | 'close'; index: number }[] = [
    { role: 'opening', index: 0 },
  ];
  if (paras.length >= 3) picks.push({ role: 'middle', index: Math.floor((paras.length - 1) / 2) });
  if (paras.length >= 2) picks.push({ role: 'close', index: paras.length - 1 });

  const seen = new Set<number>();
  const unique = picks.filter((p) => {
    if (seen.has(p.index)) return false;
    seen.add(p.index);
    return true;
  });

  const items = unique.map((p) => {
    const passage = paras[p.index] ?? '';
    return {
      title: landmarkTitle(passage),
      passage,
      role: p.role,
    };
  });

  return {
    outline: items.map((item) => ({ title: item.title, level: 0, kind: 'landmark' as const })),
    candidates: items.map((item) => ({
      title: item.title,
      level: 0,
      kind: 'landmark' as const,
      passage: item.passage,
      role: item.role,
    })),
  };
}

function landmarkTitle(text: string): string {
  const words = text.split(/\s+/);
  const head = words.slice(0, 10).join(' ');
  return words.length > 10 ? `${head}\u2026` : head;
}

function questionFor(candidate: Candidate): string {
  let question: string;
  if (candidate.role === 'middle') question = 'What changes by the middle of this chapter?';
  else if (candidate.role === 'close') question = 'What does the ending leave you with?';
  else if (candidate.role === 'opening') question = 'What does the opening commit this chapter to?';
  else if (candidate.title.length > 80) question = 'What is this section for?';
  else question = `What is \u201c${candidate.title}\u201d for?`;

  // The question is allowed to name the section. It is not allowed to contain
  // the quotation that is supposed to stay hidden.
  if (candidate.passage && question.includes(candidate.passage)) return 'What is this section for?';
  return question;
}

function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const picked = new Set<number>();
  for (let i = 0; i < max; i++) {
    picked.add(Math.round((i * (items.length - 1)) / (max - 1)));
  }
  for (let i = 0; picked.size < max && i < items.length; i++) picked.add(i);
  return [...picked].sort((a, b) => a - b).slice(0, max).map((i) => items[i]!);
}
