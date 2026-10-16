import { must } from '@chapterize/core';
import type { Block, NoteRef } from '@chapterize/core';

/**
 * Sizes the Aa buttons cycle through, in px. The inline script in each page
 * whitelists these same numbers: a stored value is written into a style, so
 * anything else is ignored. Keep reader.js in step with this list.
 */
export const SIZES = [17, 19, 21, 24, 28] as const;

/** How far into a chapter a repeated running head is allowed to hide. Matches titles.ts. */
const TITLE_WINDOW = 12;

const ALLOWED = new Set([
  'em',
  'i',
  'strong',
  'b',
  'sup',
  'sub',
  'code',
  'cite',
  'q',
  'small',
  'u',
  'noteref',
]);

export function escapeHtml(s: string): string {
  return clean(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** XML rejects these controls, and they never mean anything in prose. */
function clean(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x08 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f)) continue;
    out += ch;
  }
  return out;
}

/** Same folding as the boilerplate finder, which does not export its normaliser. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function formatLength(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/**
 * Book HTML is a whitelist with no attributes. This page is also served on the
 * LAN, so a tag outside that set is dropped rather than rendered.
 */
function unsafeInline(html: string): boolean {
  const re = /<\/?([a-z0-9]+)(\s[^>]*)?>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const name = must(match[1], 'match[1]').toLowerCase();
    if (!ALLOWED.has(name)) return true;
    if (match[2]?.trim()) return true;
  }
  return false;
}

interface NoteItem {
  n: number;
  text: string;
}

export interface BodyInput {
  blocks: Block[];
  notes: Map<string, string>;
  /** URL for an image inside the book, or null when its bytes were not kept. */
  imageSrc: (path: string) => string | null;
  chapterTitle: string;
  bookTitle: string;
  boilerplate: Set<string>;
}

function marker(
  block: Block,
  index: number,
  bookNotes: Map<string, string>,
  items: NoteItem[],
  next: () => number,
): string {
  const ref: NoteRef | undefined = block.noterefs?.[index];
  const n = next();
  const text = ref
    ? (bookNotes.get(ref.key) ?? `Note "${ref.label}" is not in this book.`)
    : 'Note is not in this book.';
  items.push({ n, text });
  return `<sup class="fn" id="fnref-${n}"><a href="#fn-${n}">${n}</a></sup>`;
}

function inline(
  block: Block,
  bookNotes: Map<string, string>,
  items: NoteItem[],
  next: () => number,
): string {
  const raw = block.html;
  const trusted = raw.length > 0 && !unsafeInline(raw);
  let html = trusted ? clean(raw) : escapeHtml(block.text);
  let seen = 0;
  html = html.replace(/<noteref>[\s\S]*?<\/noteref>/g, () =>
    marker(block, seen++, bookNotes, items, next),
  );
  if (seen === 0 && block.noterefs?.length) {
    for (let i = 0; i < block.noterefs.length; i++)
      html += marker(block, i, bookNotes, items, next);
  }
  return html;
}

function isRunningHead(
  block: Block,
  offset: number,
  chapterTitle: string,
  bookTitle: string,
  boilerplate: Set<string>,
): boolean {
  if (block.heading === 0 || offset > TITLE_WINDOW) return false;
  const key = normalise(block.text);
  if (!key) return false;
  return key === normalise(chapterTitle) || key === normalise(bookTitle) || boilerplate.has(key);
}

function notesSection(items: NoteItem[]): string {
  if (!items.length) return '';
  const lis = items.map(
    (item) =>
      `<li id="fn-${item.n}">${escapeHtml(item.text)} <a href="#fnref-${item.n}" aria-label="Back to the reference">↩</a></li>`,
  );
  return `<section class="notes">\n<h2>Notes</h2>\n<ol>\n${lis.join('\n')}\n</ol>\n</section>`;
}

/** Inner HTML of one chapter: prose, then notes. The page title is added by the shell. */
export function renderBody(input: BodyInput): { body: string; notesHtml: string } {
  const items: NoteItem[] = [];
  let n = 0;
  const next = (): number => ++n;
  const parts: string[] = [];
  let i = 0;
  const blocks = input.blocks;
  while (i < blocks.length) {
    const block = must(blocks[i], 'blocks[i]');
    if (isRunningHead(block, i, input.chapterTitle, input.bookTitle, input.boilerplate)) {
      i++;
      continue;
    }
    if (block.tag === 'li') {
      const lis: string[] = [];
      while (i < blocks.length && must(blocks[i], 'blocks[i]').tag === 'li') {
        const item = must(blocks[i], 'blocks[i]');
        lis.push(`<li>${inline(item, input.notes, items, next)}</li>`);
        i++;
      }
      parts.push(`<ul>\n${lis.join('\n')}\n</ul>`);
      continue;
    }
    parts.push(oneBlock(block, input, items, next));
    i++;
  }
  return { body: parts.filter(Boolean).join('\n'), notesHtml: notesSection(items) };
}

function oneBlock(block: Block, input: BodyInput, items: NoteItem[], next: () => number): string {
  if (block.image) {
    const src = input.imageSrc(block.image);
    if (src) {
      const alt = escapeHtml(block.alt ?? '');
      const showCaption =
        block.text.trim() !== '' && block.text.trim() !== (block.alt ?? '').trim();
      const caption = showCaption
        ? `<figcaption>${inline(block, input.notes, items, next)}</figcaption>`
        : '';
      return `<figure><img src="${escapeHtml(src)}" alt="${alt}"/>${caption}</figure>`;
    }
  }
  const inner = inline(block, input.notes, items, next);
  if (!inner) return '';
  if (block.heading > 0) {
    // The page already has an h1 — the chapter title — so a book h1 becomes h2.
    const level = Math.min(block.heading + 1, 6);
    return `<h${level}>${inner}</h${level}>`;
  }
  if (block.tag === 'blockquote') return `<blockquote><p>${inner}</p></blockquote>`;
  if (block.tag === 'pre') return `<pre>${inner}</pre>`;
  return `<p>${inner}</p>`;
}

const TOOLS = `<div class="tools">
<button type="button" data-action="smaller" aria-label="Smaller text">A−</button>
<button type="button" data-action="larger" aria-label="Larger text">A+</button>
<button type="button" data-action="theme" aria-label="Appearance"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/></svg></button>
</div>`;

function appearanceScript(): string {
  const list = SIZES.map((size) => `'${size}'`).join(',');
  // Runs before paint. A throw here (locked-down storage, no matchMedia) must
  // not blank the page; the default appearance is already readable.
  //
  // The query string is read first on purpose. A page opened from the Files
  // app does not share localStorage with the next chapter — each file is its
  // own origin — so the link carries theme and size. Keep the whitelist equal
  // to prefsFromSearch in assets/reader.js.
  return `<script>
try {
  var allowed = [${list}];
  var q = new URLSearchParams(location.search);
  var qt = q.get('theme');
  var t = (qt === 'light' || qt === 'dark' || qt === 'system') ? qt : localStorage.getItem('chapterize-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  var qs = q.get('size');
  var s = allowed.indexOf(qs) >= 0 ? qs : localStorage.getItem('chapterize-size');
  if (allowed.indexOf(s) >= 0) document.documentElement.style.fontSize = s + 'px';
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
    m.setAttribute('content', dark ? '#16151a' : '#faf9f7');
  });
} catch (e) {}
</script>`;
}

function shell(opts: {
  title: string;
  lang: string;
  bookTitle: string;
  bookSlug: string;
  prefix: string;
  page: 'index' | 'chapter';
  file?: string;
  prev?: string;
  next?: string;
  body: string;
}): string {
  const prev = opts.prev ? `<link rel="prev" href="${escapeHtml(opts.prev)}">` : '';
  const next = opts.next ? `<link rel="next" href="${escapeHtml(opts.next)}">` : '';
  const attrs = [
    `data-page="${opts.page}"`,
    `data-book="${escapeHtml(opts.bookSlug)}"`,
    opts.file ? `data-file="${escapeHtml(opts.file)}"` : '',
    opts.prev ? `data-prev="${escapeHtml(opts.prev)}"` : 'data-prev=""',
    opts.next ? `data-next="${escapeHtml(opts.next)}"` : 'data-next=""',
  ]
    .filter(Boolean)
    .join(' ');
  return `<!DOCTYPE html>
<html lang="${escapeHtml(opts.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#faf9f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16151a" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${escapeHtml(opts.bookTitle)}">
<title>${escapeHtml(opts.title)}</title>
${prev}
${next}
<link rel="stylesheet" href="${opts.prefix}reader.css">
${appearanceScript()}
</head>
<body ${attrs}>
<a class="skip" href="#text">Skip to text</a>
<div id="progress"></div>
${opts.body}
<script src="${opts.prefix}reader.js"></script>
</body>
</html>
`;
}

export interface IndexRow {
  href: string;
  title: string;
  minutes: number;
  depth: number;
  n: number;
}

export function renderIndex(opts: {
  lang: string;
  bookTitle: string;
  author?: string;
  bookSlug: string;
  totalMinutes: number;
  rows: IndexRow[];
}): string {
  const count = opts.rows.length === 1 ? '1 chapter' : `${opts.rows.length} chapters`;
  const byline = opts.author ? `<p class="byline">${escapeHtml(opts.author)}</p>` : '';
  const rows = opts.rows
    .map(
      (row) =>
        `<a class="row" href="${escapeHtml(row.href)}" style="--depth: ${Math.max(0, Math.min(12, row.depth | 0))}"><span class="num">${row.n}</span><span class="name">${escapeHtml(row.title)}</span><span class="time">${formatLength(row.minutes)}</span></a>`,
    )
    .join('\n');
  const body = `<header class="top"><span class="booklink">Contents</span>${TOOLS}</header>
<main class="column" id="text">
<h1>${escapeHtml(opts.bookTitle)}</h1>
${byline}
<p class="stats">${count} · ~${formatLength(opts.totalMinutes)}</p>
<div id="continue"></div>
<nav class="rows">
${rows}
</nav>
</main>`;
  return shell({
    title: opts.bookTitle,
    lang: opts.lang,
    bookTitle: opts.bookTitle,
    bookSlug: opts.bookSlug,
    prefix: '',
    page: 'index',
    body,
  });
}

export function renderChapterPage(opts: {
  lang: string;
  bookTitle: string;
  bookSlug: string;
  chapterTitle: string;
  index: number;
  total: number;
  minutes: number;
  leftMinutes: number;
  file: string;
  prevHref?: string;
  nextHref?: string;
  nextTitle?: string;
  epubHref?: string;
  body: string;
  notesHtml: string;
}): string {
  const place = `Chapter ${opts.index + 1} of ${opts.total}`;
  const length =
    opts.index + 1 < opts.total
      ? `${place} · ${formatLength(opts.leftMinutes)} left in the book`
      : `${place} · ${formatLength(opts.minutes)}`;
  const prev = opts.prevHref
    ? `<a href="${escapeHtml(opts.prevHref)}">Prev</a>`
    : `<span class="off">Prev</span>`;
  const next = opts.nextHref
    ? `<a href="${escapeHtml(opts.nextHref)}">Next</a>`
    : `<span class="off">Next</span>`;
  const turn =
    opts.nextHref && opts.nextTitle
      ? `<a class="next-chapter" href="${escapeHtml(opts.nextHref)}"><span class="turn-kicker">Next</span><span class="turn-title">${escapeHtml(opts.nextTitle)}</span></a>`
      : `<p class="end-mark">End of the book</p>`;
  const books = opts.epubHref
    ? `<p class="books"><a href="${escapeHtml(opts.epubHref)}">Open this chapter in Books</a></p>`
    : '';
  const body = `<header class="top"><a class="booklink" href="../index.html">${escapeHtml(opts.bookTitle)}</a>${TOOLS}</header>
<main class="column" id="text">
<p class="kicker">${length}</p>
<h1>${escapeHtml(opts.chapterTitle)}</h1>
${opts.body}
${opts.notesHtml}
<nav class="turn">${turn}</nav>
${books}
</main>
<nav class="bar">${prev}<a class="pos" href="../index.html" aria-label="Contents">${opts.index + 1} / ${opts.total}</a>${next}</nav>`;
  return shell({
    title: `${opts.chapterTitle} — ${opts.bookTitle}`,
    lang: opts.lang,
    bookTitle: opts.bookTitle,
    bookSlug: opts.bookSlug,
    prefix: '../',
    page: 'chapter',
    file: opts.file,
    ...(opts.prevHref !== undefined ? { prev: opts.prevHref } : {}),
    ...(opts.nextHref !== undefined ? { next: opts.nextHref } : {}),
    body,
  });
}
