export const DONT_KNOW: string;

export interface ChapterProgress {
  whyBefore: string;
  whyAfter: string;
  steps: Record<string, { text: string; revealed: boolean }>;
  scroll?: number;
}

export interface Step {
  id: string;
  question: string;
  passage: string;
}

export function openingUnlocked(chapterProgress: { whyBefore?: string }): boolean;

export function stepView(
  steps: Step[],
  chapterProgress: ChapterProgress,
  index: number,
): { locked: boolean; revealed: boolean; text: string };

export function withReveal(
  steps: Step[],
  chapterProgress: ChapterProgress,
  index: number,
  text: string,
):
  | { ok: true; chapter: ChapterProgress }
  | { ok: false; reason: string };

export function studied(
  chapter: { opening: string; steps: { id: string }[] },
  chapterProgress: ChapterProgress,
): boolean;

export function parseHash(
  hash: string,
  count: number,
):
  | { screen: 'contents' }
  | { screen: 'chapter' | 'study'; index: number; mode: 'read' | 'paper' };

export function start(book?: object, win?: unknown): Promise<void>;
