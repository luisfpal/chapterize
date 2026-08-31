import type { Block, Chapter } from './types.js';

/**
 * Rough token estimate. Kept for `index.json`, where an agent may want it, and
 * deliberately absent from the interface: no reading decision depends on it, and
 * no open-source tokenizer matches Claude anyway.
 */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** Words, counted the way a reader would. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Minutes to read, at `wpm`. This is what the interface shows.
 *
 * 238 wpm is the mean for adult silent reading of non-fiction prose (Brysbaert
 * 2019). Every serious reader — Kindle, Kobo, Apple Books, Foliate — surfaces
 * time rather than length, because time is the thing a reader actually budgets.
 */
export function readingMinutes(words: number, wpm = 238): number {
  return Math.max(1, Math.round(words / wpm));
}

export function slugify(s: string, max = 60): string {
  const base = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, max)
    .replace(/^-|-$/g, '');
  return base || 'untitled';
}

export function chapterFilename(chapter: Chapter, title: string): string {
  return `${String(chapter.index).padStart(3, '0')}-${slugify(title)}.md`;
}

/** Basename of a path inside the EPUB, used as the exported image filename. */
export function imageFilename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** `<noteref>*</noteref>` -> `[^3]`, numbered per chapter. */
function replaceNoterefs(html: string, numbers: number[]): string {
  let i = 0;
  return html.replace(/<noteref>[\s\S]*?<\/noteref>/g, () => {
    const n = numbers[i++];
    return n === undefined ? '' : `[^${n}]`;
  });
}

function renderBlock(block: Block, noteNumbers?: number[]): string {
  if (block.image) {
    return `![${(block.alt ?? '').replace(/[[\]]/g, '')}](images/${imageFilename(block.image)})`;
  }
  if (!block.text) return '';
  if (block.heading > 0) return `${'#'.repeat(Math.min(block.heading, 6))} ${block.text}`;
  if (block.tag === 'li') return `- ${block.text}`;
  if (block.tag === 'blockquote') return `> ${block.text}`;
  if (block.tag === 'pre') return '```\n' + block.text + '\n```';
  // Inline emphasis is carried through so exported prose keeps the author's
  // stress; the tag set is a fixed whitelist, so this cannot emit anything else.
  const html = noteNumbers ? replaceNoterefs(block.html, noteNumbers) : block.html;
  return html ? inlineMarkdown(html) : block.text;
}

/**
 * Convert whitelisted inline HTML to Markdown emphasis.
 *
 * Whitespace is moved outside the markers first. Books commonly write
 * `<b>Productivity compounds. </b>`, and `**Productivity compounds. **` is not
 * bold in any Markdown parser — the closing marker must sit against a
 * non-space character.
 */
export function inlineMarkdown(html: string): string {
  const shifted = html.replace(
    /<(b|strong|i|em)>(\s*)([\s\S]*?)(\s*)<\/\1>/g,
    (_all, tag: string, lead: string, inner: string, trail: string) =>
      inner ? `${lead}<${tag}>${inner}</${tag}>${trail}` : `${lead}${trail}`,
  );
  return shifted
    .replace(/<\/?(em|i)>/g, '*')
    .replace(/<\/?(strong|b)>/g, '**')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    // Shifting whitespace out of a marker can leave it beside a space that was
    // already there; block text is whitespace-collapsed, so collapse again.
    .replace(/ {2,}/g, ' ')
    .trim();
}

export interface RenderOptions {
  bookTitle: string;
  author?: string;
  totalChapters: number;
  /** Prepend a heading and provenance line, so a chapter read alone has context. */
  frontMatter?: boolean;
  /** Footnote bodies by `path#id`, from `Book.notes`. */
  notes?: Map<string, string>;
  /** Minutes to read, shown in the provenance line. */
  minutes?: number;
}

/**
 * Render one chapter as Markdown.
 *
 * The provenance line is not decoration: a chapter handed to a model with no
 * framing invites it to invent the framing.
 */
export function renderChapter(
  chapter: Chapter,
  blocks: Block[],
  title: string,
  options: RenderOptions,
): string {
  const body: string[] = [];
  // Footnotes are numbered per chapter, so a chapter read on its own has
  // markers starting at 1 rather than wherever it happened to fall in the book.
  const definitions: string[] = [];
  let counter = 0;

  for (let i = chapter.start; i < chapter.end; i++) {
    const block = blocks[i]!;
    let numbers: number[] | undefined;
    if (block.noterefs?.length) {
      numbers = block.noterefs.map((ref) => {
        const n = ++counter;
        const text = options.notes?.get(ref.key);
        definitions.push(`[^${n}]: ${text ?? `(note "${ref.label}" not found in this book)`}`);
        return n;
      });
    }
    const line = renderBlock(block, numbers);
    if (line) body.push(line);
  }

  const prose = definitions.length
    ? `${body.join('\n\n')}\n\n${definitions.join('\n\n')}`
    : body.join('\n\n');

  if (options.frontMatter === false) return prose + '\n';

  const attribution = options.author
    ? `${options.bookTitle} — ${options.author}`
    : options.bookTitle;
  const length = options.minutes !== undefined
    ? `~${options.minutes} min read`
    : `${chapter.chars.toLocaleString()} characters`;
  return [
    `# ${title}`,
    `_${attribution} · ${chapter.index + 1} of ${options.totalChapters} · ${length}_`,
    prose,
  ].join('\n\n') + '\n';
}
