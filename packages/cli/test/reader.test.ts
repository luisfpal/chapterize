import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import {
  DONT_KNOW, openingUnlocked, parseHash, start, stepView, studied, withReveal,
  type ChapterProgress,
} from '../src/reader.js';

const blank = (): ChapterProgress => ({ whyBefore: '', whyAfter: '', steps: {} });

const steps = [
  { id: 's0', question: 'What is “The court” for?', passage: 'PASSAGE-ONE-HIDDEN' },
  { id: 's1', question: 'What is “The cost” for?', passage: 'PASSAGE-TWO-HIDDEN' },
];

describe('the study lock', () => {
  it('hides a passage until there is an answer, and hides the next question until then', () => {
    const progress = blank();
    expect(stepView(steps, progress, 0).locked).toBe(false);
    expect(stepView(steps, progress, 1).locked).toBe(true);
    expect(withReveal(steps, progress, 0, '   ').ok).toBe(false);
    expect(withReveal(steps, progress, 1, 'I tried to skip').ok).toBe(false);

    const first = withReveal(steps, progress, 0, '  the court punishes shine  ');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.chapter.steps['s0']).toEqual({ text: 'the court punishes shine', revealed: true });
    expect(stepView(steps, first.chapter, 1).locked).toBe(false);

    const skipped = withReveal(steps, progress, 1, 'still the old progress');
    expect(skipped.ok).toBe(false);

    const second = withReveal(steps, first.chapter, 1, DONT_KNOW);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.chapter.steps['s1']?.text).toBe(DONT_KNOW);
  });

  it('does not treat whitespace as a reason the chapter matters', () => {
    expect(openingUnlocked({ whyBefore: '   ' })).toBe(false);
    expect(openingUnlocked({ whyBefore: 'Because the court is watching.' })).toBe(true);
  });

  it('counts a chapter studied only after the opening and every question', () => {
    const chapter = { opening: 'The court watches.', steps };
    expect(studied(chapter, blank())).toBe(false);
    const answered = withReveal(steps, { ...blank(), whyBefore: 'Mine.' }, 0, 'one');
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(studied(chapter, answered.chapter)).toBe(false);
    const done = withReveal(steps, answered.chapter, 1, DONT_KNOW);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(studied(chapter, done.chapter)).toBe(true);
    expect(studied({ opening: '', steps: [] }, blank())).toBe(false);
  });

  it('reads a chapter address and rejects one that falls off the book', () => {
    expect(parseHash('#contents', 3)).toEqual({ screen: 'contents' });
    expect(parseHash('#c/1/paper', 3)).toEqual({ screen: 'chapter', index: 1, mode: 'paper' });
    expect(parseHash('#c/1/study', 3)).toEqual({ screen: 'study', index: 1, mode: 'read' });
    expect(parseHash('#c/9', 3)).toEqual({ screen: 'contents' });
  });
});

const book = {
  id: 'abc',
  title: 'Laws',
  author: 'Greene',
  language: 'en',
  startChapter: 1,
  chapters: [
    {
      index: 0,
      title: 'Copyright <script>',
      words: 2,
      minutes: 1,
      html: '<p>Short.</p>',
      opening: '',
      outline: [],
      steps: [],
      stepsSampled: false,
    },
    {
      index: 1,
      title: 'Never Outshine',
      words: 400,
      minutes: 2,
      html: '<p>FULL-CHAPTER-SENTENCE-UNIQUE</p>',
      opening: 'OPENING-SENTENCE-HIDDEN',
      outline: [
        { title: 'The court', level: 2, kind: 'heading' },
        { title: 'The cost', level: 2, kind: 'heading' },
      ],
      steps,
      stepsSampled: false,
    },
  ],
};

function buttons(window: Window) {
  return [...window.document.querySelectorAll('button')];
}

function labeled(window: Window, text: string) {
  const found = buttons(window).find((button) => button.textContent?.trim() === text);
  if (!found) throw new Error(`No button labelled "${text}". Have: ${buttons(window).map((b) => b.textContent?.trim()).join(' | ')}`);
  return found;
}

describe('the phone page', () => {
  it('keeps the chapter and the passages off the paper companion until each step is faced', async () => {
    const window = new Window({ url: 'http://127.0.0.1/token/' });
    window.document.body.innerHTML = '<div id="app"></div>';
    await start(book, window);

    const body = () => window.document.body.textContent ?? '';
    expect(body()).toContain('Laws');
    expect(body()).toContain('Never Outshine');
    expect(body()).not.toContain('FULL-CHAPTER-SENTENCE-UNIQUE');
    expect(body()).not.toContain('PASSAGE-ONE-HIDDEN');
    // The angle brackets are the chapter's title, rendered as text.
    expect(window.document.body.innerHTML).not.toContain('<script');
    expect(body()).toContain('Copyright <script>');

    window.document.querySelector('button.continue')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(window.location.hash).toBe('#c/1');
    expect(body()).toContain('FULL-CHAPTER-SENTENCE-UNIQUE');
    expect(body()).not.toContain('PASSAGE-ONE-HIDDEN');

    labeled(window, 'Paper').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(window.location.hash).toBe('#c/1/paper');
    expect(body()).not.toContain('FULL-CHAPTER-SENTENCE-UNIQUE');
    expect(body()).not.toContain('OPENING-SENTENCE-HIDDEN');
    expect(body()).not.toContain('PASSAGE-ONE-HIDDEN');
    expect(body()).not.toContain('What is “The cost” for?');
    expect(body()).toContain('What is “The court” for?');
    expect(body()).toContain('1 more question stays locked');

    labeled(window, 'Show how the chapter opens').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(body()).toContain('Write one sentence first');
    expect(body()).not.toContain('OPENING-SENTENCE-HIDDEN');

    const why = window.document.querySelector('textarea');
    if (!why) throw new Error('missing the reason field');
    why.value = 'The court punishes the obvious star.';
    why.dispatchEvent(new window.Event('input', { bubbles: true }));
    labeled(window, 'Show how the chapter opens').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(body()).toContain('OPENING-SENTENCE-HIDDEN');

    labeled(window, 'Show the passage').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(body()).toContain("Write an answer first");
    expect(body()).not.toContain('PASSAGE-ONE-HIDDEN');

    const answer = [...window.document.querySelectorAll('textarea')].at(-1);
    if (!answer) throw new Error('missing the answer field');
    answer.value = 'Do not outshine.';
    answer.dispatchEvent(new window.Event('input', { bubbles: true }));
    labeled(window, 'Show the passage').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(body()).toContain('PASSAGE-ONE-HIDDEN');
    expect(body()).toContain('Do not outshine.');
    expect(body()).toContain('What is “The cost” for?');
    expect(body()).not.toContain('PASSAGE-TWO-HIDDEN');

    labeled(window, "I don't know yet").dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(body()).toContain('PASSAGE-TWO-HIDDEN');
    expect(body()).toContain(DONT_KNOW);

    const saved = window.localStorage.getItem('chapterize:abc');
    expect(saved).toBeTruthy();

    const again = new Window({ url: 'http://127.0.0.1/token/#c/1/paper' });
    again.localStorage.setItem('chapterize:abc', saved ?? '');
    again.document.body.innerHTML = '<div id="app"></div>';
    await start(book, again);
    const againBody = again.document.body.textContent ?? '';
    expect(againBody).toContain('PASSAGE-ONE-HIDDEN');
    expect(againBody).toContain('PASSAGE-TWO-HIDDEN');
    expect(againBody).not.toContain('FULL-CHAPTER-SENTENCE-UNIQUE');

    labeled(window, 'Night').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(window.document.documentElement.dataset['theme']).toBe('dark');
  });
});
