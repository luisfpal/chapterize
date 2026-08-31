import type { Block, Chapter } from './types.js';

/** Rough token estimate. Labelled as approximate everywhere it surfaces. */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
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

function renderBlock(block: Block): string {
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
  return block.html ? inlineMarkdown(block.html) : block.text;
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
  for (let i = chapter.start; i < chapter.end; i++) {
    const line = renderBlock(blocks[i]!);
    if (line) body.push(line);
  }

  if (options.frontMatter === false) return body.join('\n\n') + '\n';

  const attribution = options.author
    ? `${options.bookTitle} — ${options.author}`
    : options.bookTitle;
  return [
    `# ${title}`,
    `_${attribution} · chapter ${chapter.index} of ${options.totalChapters - 1} · ~${estimateTokens(chapter.chars).toLocaleString()} tokens (estimated)_`,
    body.join('\n\n'),
  ].join('\n\n') + '\n';
}
