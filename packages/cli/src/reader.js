/**
 * The phone app. This file is copied into the site unchanged, and the tests
 * import it, so the rules below are the rules the phone actually runs.
 *
 * A question's passage stays off the page until the reader has written
 * something — an answer, or the exact words "I don't know yet". The next
 * question stays locked until that happens. Order is the whole feature.
 * There is nothing on the network to ask.
 */

export const DONT_KNOW = "I don't know yet";
const SCALES = ['0.94', '1', '1.12', '1.28'];

export function openingUnlocked(chapterProgress) {
  return (chapterProgress.whyBefore ?? '').trim().length > 0;
}

export function stepView(steps, chapterProgress, index) {
  const step = steps[index];
  const previous = index > 0 ? steps[index - 1] : null;
  const locked = previous ? chapterProgress.steps[previous.id]?.revealed !== true : false;
  const saved = chapterProgress.steps[step.id] ?? { text: '', revealed: false };
  return { locked, revealed: saved.revealed === true, text: saved.text ?? '' };
}

/**
 * Record an attempt and reveal the passage. Blank does not count: that is
 * how "skip" would have been implemented, and it is the thing this refuses.
 */
export function withReveal(steps, chapterProgress, index, text) {
  const view = stepView(steps, chapterProgress, index);
  if (view.locked) {
    return {
      ok: false,
      reason: 'This question is locked. Finish the one above it first.',
    };
  }
  if (text.trim().length === 0) {
    return {
      ok: false,
      reason: "Write an answer first, or say you don't know. The passage stays hidden until you do.",
    };
  }
  const step = steps[index];
  return {
    ok: true,
    chapter: {
      ...chapterProgress,
      steps: {
        ...chapterProgress.steps,
        [step.id]: { text: text.trim(), revealed: true },
      },
    },
  };
}

/** Studied means the ritual was faced, not that the chapter was scrolled. */
export function studied(chapter, chapterProgress) {
  if (!chapter.opening && chapter.steps.length === 0) return false;
  if (chapter.opening && !openingUnlocked(chapterProgress)) return false;
  return chapter.steps.every((step) => chapterProgress.steps[step.id]?.revealed === true);
}

export function parseHash(hash, count) {
  if (hash === '#contents' || hash === '' || hash === '#') return { screen: 'contents' };
  const match = /^#c\/(\d+)(?:\/(paper|study))?$/.exec(hash);
  if (!match) return { screen: 'contents' };
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 0 || index >= count) return { screen: 'contents' };
  if (match[2] === 'paper') return { screen: 'chapter', index, mode: 'paper' };
  if (match[2] === 'study') return { screen: 'study', index, mode: 'read' };
  return { screen: 'chapter', index, mode: 'read' };
}

function hashFor(route) {
  if (route.screen === 'contents') return '#contents';
  if (route.mode === 'paper') return `#c/${route.index}/paper`;
  if (route.screen === 'study') return `#c/${route.index}/study`;
  return `#c/${route.index}`;
}

function emptyProgress(book) {
  return { version: 1, chapter: book.startChapter, mode: 'read', chapters: {} };
}

function chapterProgress(progress, index) {
  return progress.chapters[String(index)] ?? { whyBefore: '', whyAfter: '', steps: {}, scroll: 0 };
}

function loadProgress(storage, book) {
  try {
    const raw = storage.getItem(`chapterize:${book.id}`);
    if (!raw) return emptyProgress(book);
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || typeof parsed.chapters !== 'object' || parsed.chapters === null) {
      return emptyProgress(book);
    }
    if (typeof parsed.chapter !== 'number' || parsed.chapter < 0 || parsed.chapter >= book.chapters.length) {
      parsed.chapter = book.startChapter;
    }
    if (parsed.mode !== 'paper' && parsed.mode !== 'read') parsed.mode = 'read';
    return parsed;
  } catch {
    return emptyProgress(book);
  }
}

export async function start(book, win = globalThis) {
  const env = win;
  const loaded = book ?? await fetchBook(env);
  mount(loaded, env);
}

async function fetchBook(env) {
  const response = await env.fetch('./book.json');
  if (!response.ok) throw new Error('The saved copy is missing and the computer is not serving.');
  return response.json();
}

function mount(book, env) {
  const doc = env.document;
  const storage = env.localStorage;
  const app = doc.getElementById('app');
  if (!app) return;

  doc.documentElement.lang = book.language || 'en';
  doc.title = book.title;

  let progress = loadProgress(storage, book);
  let saveError = '';
  let notice = '';
  let lastKey = '';

  const persist = () => {
    try {
      storage.setItem(`chapterize:${book.id}`, JSON.stringify(progress));
      saveError = '';
    } catch {
      // The place and the sentences live only here. Say so when they cannot.
      saveError = 'This browser is not saving your place. Leaving the page will lose it.';
    }
  };

  const putChapter = (index, next) => {
    progress = {
      ...progress,
      chapters: { ...progress.chapters, [String(index)]: next },
    };
    persist();
  };

  const routeNow = () => parseHash(env.location.hash, book.chapters.length);

  const saveScroll = (index) => {
    const max = doc.documentElement.scrollHeight - env.innerHeight;
    const ratio = max > 0 ? env.scrollY / max : 0;
    const current = chapterProgress(progress, index);
    if (current.scroll === ratio) return;
    putChapter(index, { ...current, scroll: ratio });
  };

  const raf = env.requestAnimationFrame
    ? env.requestAnimationFrame.bind(env)
    : (fn) => env.setTimeout(fn, 16);

  let scrollQueued = false;
  env.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    raf(() => {
      scrollQueued = false;
      const route = routeNow();
      if (route.screen === 'chapter' && route.mode !== 'paper') saveScroll(route.index);
    });
  }, { passive: true });

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'hidden') return;
    const route = routeNow();
    if (route.screen === 'chapter' && route.mode !== 'paper') saveScroll(route.index);
  });

  const go = (route) => {
    const leaving = routeNow();
    if (leaving.screen === 'chapter' && leaving.mode !== 'paper') saveScroll(leaving.index);
    const hash = hashFor(route);
    if (route.screen !== 'contents') {
      progress = { ...progress, chapter: route.index, mode: route.mode ?? progress.mode };
      persist();
    }
    if (env.location.hash !== hash) env.location.hash = hash;
    render();
  };

  env.addEventListener('hashchange', () => render());

  if (!env.location.hash || env.location.hash === '#') env.location.hash = '#contents';

  try {
    // Offline is a copy taken on the first good load. A failed registration
    // still leaves the book readable while the computer is serving it.
    env.navigator?.serviceWorker?.register('./sw.js')?.catch(() => {});
  } catch {
    // Some browsers throw instead of rejecting. Same outcome.
  }

  function render() {
    const route = routeNow();
    const key = route.screen === 'contents' ? 'contents' : `${route.screen}:${route.index}:${route.mode ?? ''}`;
    app.replaceChildren();
    app.append(header(route));
    const page = el('main', { class: 'page' });
    if (route.screen === 'contents') page.append(contentsView());
    else if (route.screen === 'study') page.append(studyView(book.chapters[route.index], route.index));
    else page.append(chapterView(book.chapters[route.index], route.index, route.mode));
    if (saveError) page.append(el('p', { class: 'notice', text: saveError }));
    app.append(page);

    if (key !== lastKey) {
      if (route.screen === 'chapter' && route.mode !== 'paper') {
        const ratio = chapterProgress(progress, route.index).scroll ?? 0;
        raf(() => {
          const max = doc.documentElement.scrollHeight - env.innerHeight;
          env.scrollTo(0, max > 0 ? ratio * max : 0);
        });
      } else {
        env.scrollTo(0, 0);
      }
    }
    lastKey = key;
    paintChrome();
  }

  function paintChrome() {
    const theme = doc.documentElement.dataset.theme
      || (env.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light');
    let meta = doc.querySelector('meta[name="theme-color"][data-live]');
    if (!meta) {
      meta = el('meta', { name: 'theme-color' });
      meta.setAttribute('data-live', '');
      doc.head?.append(meta);
    }
    meta.setAttribute('content', theme === 'dark' ? '#141311' : '#fbf8f3');
  }

  function header(route) {
    const bar = el('header');
    if (route.screen === 'contents') {
      bar.append(el('span', { class: 'running', text: 'Chapterize' }));
    } else if (route.screen === 'study') {
      bar.append(el('button', { type: 'button', text: 'Back', onclick: () => go({ screen: 'chapter', index: route.index, mode: 'read' }) }));
      bar.append(el('span', { class: 'running', text: book.chapters[route.index].title }));
    } else {
      bar.append(el('button', { type: 'button', text: 'Contents', onclick: () => go({ screen: 'contents' }) }));
      bar.append(el('span', { class: 'running', text: book.chapters[route.index].title }));
    }
    bar.append(el('button', {
      type: 'button',
      text: explicitTheme() === 'dark' ? 'Day' : 'Night',
      'aria-label': explicitTheme() === 'dark' ? 'Switch to day' : 'Switch to night',
      onclick: toggleTheme,
    }));
    bar.append(el('button', {
      type: 'button',
      text: 'Aa',
      'aria-label': 'Larger text',
      onclick: cycleScale,
    }));
    return bar;
  }

  function explicitTheme() {
    const set = doc.documentElement.dataset.theme;
    if (set === 'light' || set === 'dark') return set;
    return env.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
  }

  function toggleTheme() {
    const next = explicitTheme() === 'dark' ? 'light' : 'dark';
    doc.documentElement.dataset.theme = next;
    try { storage.setItem('chapterize-theme', next); } catch { /* shown via saveError on the book key */ }
    render();
  }

  function cycleScale() {
    const current = doc.documentElement.style.getPropertyValue('--scale') || '1';
    const index = Math.max(0, SCALES.indexOf(current));
    const next = SCALES[(index + 1) % SCALES.length];
    doc.documentElement.style.setProperty('--scale', next);
    try { storage.setItem('chapterize-scale', next); } catch { /* same as theme */ }
  }

  function contentsView() {
    const wrap = el('div');
    const title = el('h1', { class: 'book-title', text: book.title });
    wrap.append(title);
    if (book.author) wrap.append(el('p', { class: 'byline', text: book.author }));
    else wrap.append(el('p', { class: 'byline', text: `${book.chapters.length} chapters` }));

    const index = progress.chapter;
    const chapter = book.chapters[index];
    const mode = progress.mode === 'paper' ? 'paper' : 'read';
    const cont = el('button', {
      type: 'button',
      class: 'continue',
      onclick: () => go({ screen: 'chapter', index, mode }),
    });
    cont.append(el('span', { class: 'eyebrow', text: 'Continue' }));
    cont.append(el('span', { class: 'name', text: chapter.title }));
    cont.append(el('span', { class: 'meta', text: chapterMeta(chapter, index) }));
    wrap.append(cont);

    wrap.append(el('p', { class: 'section-label', text: 'Chapters' }));
    const list = el('ol', { class: 'contents' });
    book.chapters.forEach((item, i) => {
      const li = el('li');
      const button = el('button', {
        type: 'button',
        onclick: () => go({ screen: 'chapter', index: i, mode }),
      });
      button.append(el('span', { class: 'num', text: String(i + 1) }));
      button.append(el('span', { class: 'ctitle', text: item.title }));
      const done = studied(item, chapterProgress(progress, i));
      // Keep the length visible after the ritual. "Studied" alone hides how
      // long the chapter is the next time he is choosing one.
      button.append(el('span', { class: 'cmeta', text: done ? `Studied · ${item.minutes} min` : `${item.minutes} min` }));
      li.append(button);
      list.append(li);
    });
    wrap.append(list);

    const standalone = env.navigator?.standalone === true
      || env.matchMedia?.('(display-mode: standalone)')?.matches === true;
    let dismissed = false;
    try { dismissed = storage.getItem('chapterize-install-dismissed') === '1'; } catch { dismissed = true; }
    if (!standalone && !dismissed) {
      const note = el('div', { class: 'install' });
      note.append(el('p', {
        text: 'On iPhone: Share, then Add to Home Screen. The book stays on this phone. Your sentences stay on this phone too — they are not copied back to the computer.',
      }));
      note.append(el('button', {
        type: 'button',
        text: 'Hide this',
        onclick: () => {
          try { storage.setItem('chapterize-install-dismissed', '1'); } catch { /* still hiding for this render */ }
          render();
        },
      }));
      wrap.append(note);
    }
    return wrap;
  }

  function chapterView(chapter, index, mode) {
    const wrap = el('div');
    wrap.append(el('p', { class: 'kicker', text: kicker(chapter, index) }));
    wrap.append(el('h1', { class: 'chapter-title', text: chapter.title }));
    wrap.append(segment(index, mode));
    if (mode === 'paper') {
      wrap.append(el('p', { class: 'lede', text: 'The pages stay in the book. This is the companion.' }));
      wrap.append(studyBody(chapter, index));
    } else {
      const article = el('article');
      // Chapter HTML was sanitized when the site was built. It is the book's
      // words, not a string the reader typed.
      article.innerHTML = chapter.html;
      wrap.append(article);
      wrap.append(el('button', {
        type: 'button',
        class: 'study-link',
        text: 'Study this chapter',
        onclick: () => go({ screen: 'study', index, mode: 'read' }),
      }));
    }
    wrap.append(pager(index, mode));
    return wrap;
  }

  function studyView(chapter, index) {
    const wrap = el('div');
    wrap.append(el('p', { class: 'kicker', text: kicker(chapter, index) }));
    wrap.append(el('h1', { class: 'chapter-title', text: chapter.title }));
    wrap.append(studyBody(chapter, index));
    return wrap;
  }

  function studyBody(chapter, index) {
    const cp = chapterProgress(progress, index);
    const wrap = el('div', { class: 'study' });

    wrap.append(el('h2', { text: 'Recap' }));
    if (chapter.outline.length === 0) {
      wrap.append(el('p', { class: 'hint', text: 'This chapter has no sections to list.' }));
    } else if (chapter.outline[0].kind === 'landmark') {
      wrap.append(el('p', { class: 'hint', text: 'This chapter has no headings. These lines are the first words of passages spaced through it — landmarks, not the author\u2019s outline.' }));
    } else {
      wrap.append(el('p', { class: 'hint', text: 'The author\u2019s sections, in order. Not a summary.' }));
    }
    if (chapter.outline.length) {
      const list = el('ol', { class: 'outline' });
      for (const item of chapter.outline) {
        const li = el('li', { class: item.level >= 3 ? `lv${Math.min(item.level, 6)}` : '', text: item.title });
        list.append(li);
      }
      wrap.append(list);
    }

    wrap.append(el('h2', { text: 'Why this chapter matters' }));
    wrap.append(el('p', { class: 'hint', text: 'One sentence before you go on. Yours, not the book\u2019s.' }));
    const why = el('textarea', { 'aria-label': 'Why this chapter matters' });
    why.value = cp.whyBefore;
    why.addEventListener('input', () => {
      notice = '';
      putChapter(index, { ...chapterProgress(progress, index), whyBefore: why.value });
    });
    wrap.append(why);

    if (!chapter.opening) {
      wrap.append(el('p', { class: 'hint', text: 'This chapter does not open in prose.' }));
    } else if (!openingUnlocked(cp)) {
      wrap.append(el('button', {
        type: 'button',
        class: 'primary',
        text: 'Show how the chapter opens',
        onclick: () => {
          if (!why.value.trim()) {
            notice = 'Write one sentence first. The opening stays hidden until you do.';
            render();
            return;
          }
          putChapter(index, { ...chapterProgress(progress, index), whyBefore: why.value });
          notice = '';
          render();
        },
      }));
    } else {
      wrap.append(passageBlock('How the chapter opens', 'The book\u2019s words, not a summary.', chapter.opening));
      wrap.append(el('p', { class: 'hint', text: 'Revise your sentence now that you have seen it.' }));
      const after = el('textarea', { 'aria-label': 'Revised reason' });
      after.value = cp.whyAfter;
      after.addEventListener('input', () => {
        putChapter(index, { ...chapterProgress(progress, index), whyAfter: after.value });
      });
      wrap.append(after);
    }
    if (notice) wrap.append(el('p', { class: 'notice', text: notice }));

    wrap.append(el('h2', { text: 'Questions' }));
    if (chapter.steps.length === 0) {
      wrap.append(el('p', { class: 'hint', text: 'No questions. There was no further paragraph to ask about.' }));
    } else {
      const lead = chapter.stepsSampled
        ? `Five questions, spaced through the sections. They open in order. The book\u2019s words stay hidden until you answer, or until you say you don\u2019t know. The recap above still lists every section.`
        : 'They open in order. The book\u2019s words stay hidden until you answer, or until you say you don\u2019t know.';
      wrap.append(el('p', { class: 'hint', text: lead }));
    }

    const openAt = chapter.steps.findIndex((_step, i) => !stepView(chapter.steps, cp, i).revealed);
    chapter.steps.forEach((step, i) => {
      const view = stepView(chapter.steps, cp, i);
      if (view.revealed) {
        const block = el('div');
        block.append(el('p', { text: `${i + 1}. ${step.question}` }));
        block.append(el('p', { class: 'yours', text: `You wrote: ${view.text}` }));
        block.append(passageBlock('From the book', '', step.passage));
        wrap.append(block);
        return;
      }
      if (view.locked || (openAt !== -1 && i > openAt)) return;
      const block = el('div');
      block.append(el('p', { text: `${i + 1}. ${step.question}` }));
      const area = el('textarea', { 'aria-label': `Answer to question ${i + 1}` });
      area.value = view.text;
      area.addEventListener('input', () => {
        notice = '';
        const current = chapterProgress(progress, index);
        putChapter(index, {
          ...current,
          steps: { ...current.steps, [step.id]: { text: area.value, revealed: false } },
        });
      });
      block.append(area);
      const row = el('div', { class: 'row' });
      row.append(el('button', {
        type: 'button',
        class: 'primary',
        text: 'Show the passage',
        onclick: () => reveal(index, i, area.value),
      }));
      row.append(el('button', {
        type: 'button',
        class: 'quiet',
        text: "I don't know yet",
        onclick: () => reveal(index, i, DONT_KNOW),
      }));
      block.append(row);
      wrap.append(block);
    });

    if (openAt !== -1) {
      const lockedCount = chapter.steps.filter((_step, i) => stepView(chapter.steps, cp, i).locked).length;
      if (lockedCount > 0) {
        const noun = lockedCount === 1 ? 'question stays' : 'questions stay';
        wrap.append(el('p', { class: 'locked', text: `${lockedCount} more ${noun} locked until you finish the one in front of you.` }));
      }
    }
    return wrap;
  }

  function reveal(index, stepIndex, text) {
    const chapter = book.chapters[index];
    const result = withReveal(chapter.steps, chapterProgress(progress, index), stepIndex, text);
    if (!result.ok) {
      notice = result.reason;
      render();
      return;
    }
    notice = '';
    putChapter(index, result.chapter);
    render();
  }

  function passageBlock(label, hint, text) {
    const block = el('div', { class: 'passage' });
    block.append(el('div', { class: 'label', text: label }));
    if (hint) block.append(el('p', { class: 'hint', text: hint }));
    block.append(el('p', { text }));
    return block;
  }

  function segment(index, mode) {
    const bar = el('div', { class: 'segment', role: 'tablist' });
    bar.append(tab('Read', mode !== 'paper', () => go({ screen: 'chapter', index, mode: 'read' })));
    bar.append(tab('Paper', mode === 'paper', () => go({ screen: 'chapter', index, mode: 'paper' })));
    return bar;
  }

  function tab(text, selected, onclick) {
    return el('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': selected ? 'true' : 'false',
      text,
      onclick,
    });
  }

  function pager(index, mode) {
    const bar = el('div', { class: 'pager' });
    const prev = el('button', {
      type: 'button',
      text: 'Previous',
      disabled: index === 0 ? 'disabled' : null,
      onclick: () => { if (index > 0) go({ screen: 'chapter', index: index - 1, mode }); },
    });
    if (index === 0) prev.disabled = true;
    const next = el('button', {
      type: 'button',
      text: 'Next',
      onclick: () => { if (index + 1 < book.chapters.length) go({ screen: 'chapter', index: index + 1, mode }); },
    });
    if (index + 1 >= book.chapters.length) next.disabled = true;
    bar.append(prev, next);
    return bar;
  }

  function kicker(chapter, index) {
    return `Chapter ${index + 1} of ${book.chapters.length} · about ${chapter.minutes} min`;
  }

  function chapterMeta(chapter, index) {
    const where = progress.mode === 'paper' ? 'Paper' : 'Reading';
    return `${where} · chapter ${index + 1} of ${book.chapters.length} · about ${chapter.minutes} min`;
  }

  function el(tag, props, kids) {
    const node = doc.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'onclick') node.addEventListener('click', value);
        else node.setAttribute(key, String(value));
      }
    }
    for (const kid of kids ?? []) if (kid) node.append(kid);
    return node;
  }

  render();
}

const appNode = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (appNode) {
  start().catch((err) => {
    const detail = err instanceof Error ? err.message : '';
    appNode.textContent = detail
      ? `This book did not load. ${detail}`
      : 'This book did not load. On the computer, run chapterize again, then reload.';
  });
}
