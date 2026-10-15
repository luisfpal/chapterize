import type { Block, Book, Chapter, NoteRef } from './types.js';
import { detect } from './detect.js';
import { toChapters } from './chapters.js';
import { deriveTitles, findBoilerplate } from './titles.js';
import { countWords, readingMinutes } from './markdown.js';
import { buildStudy, type ChapterStudy, type OutlineItem, type StudyStep } from './study.js';

/**
 * The phone reader is a static site: one JSON document and the images the
 * chapters actually use. Everything in it is a pure function of a parsed book.
 *
 * Chapter HTML is assembled here, not taken raw from the EPUB. Block.html is
 * already a whitelist with no attributes; we check it again because this HTML
 * is what a phone will parse.
 */

/**
 * A fresh phone opens on the first chapter that is actually prose.
 * Covers and copyright pages are shorter than this; a chapter that is only
 * a title would otherwise be the thing he sees every time he starts a book.
 */
const START_WORDS = 40;

const INLINE = new Set(['em', 'i', 'strong', 'b', 'sup', 'sub', 'code', 'cite', 'q', 'small', 'u']);

export interface ReaderChapter {
  index: number;
  title: string;
  words: number;
  minutes: number;
  html: string;
  opening: string;
  outline: OutlineItem[];
  steps: StudyStep[];
  stepsSampled: boolean;
}

export interface ReaderImage {
  sourcePath: string;
  fileName: string;
}

export interface ReaderModel {
  id: string;
  title: string;
  /** Null when the EPUB names no author. JSON keeps the key either way. */
  author: string | null;
  language: string;
  /** Used when the phone has no saved place. */
  startChapter: number;
  chapters: ReaderChapter[];
  images: ReaderImage[];
}

export function prepareReader(book: Book): ReaderModel {
  if (book.blocks.length === 0) {
    throw new Error(
      'This EPUB has no readable text. If it came from a store it may be DRM-protected, which Chapterize does not remove.',
    );
  }

  const chapters = deriveTitles(toChapters(detect(book).cuts, book.blocks), book.blocks);
  const boilerplate = findBoilerplate(chapters, book.blocks);

  const imagePaths: string[] = [];
  for (const block of book.blocks) {
    if (block.image && book.images.has(block.image) && !imagePaths.includes(block.image)) {
      imagePaths.push(block.image);
    }
  }
  const names = assignImageNames(imagePaths);

  const rendered: ReaderChapter[] = chapters.map((chapter) => {
    const study: ChapterStudy = buildStudy(chapter, book.blocks, boilerplate);
    let text = '';
    for (let i = chapter.start; i < chapter.end; i++) text += ` ${book.blocks[i]?.text ?? ''}`;
    const words = countWords(text);
    return {
      index: chapter.index,
      title: chapter.title,
      words,
      minutes: readingMinutes(words),
      html: renderChapterHtml(chapter, book.blocks, book.notes, names),
      opening: study.opening,
      outline: study.outline,
      steps: study.steps,
      stepsSampled: study.stepsSampled,
    };
  });

  const start = rendered.findIndex((chapter) => chapter.words >= START_WORDS);
  return {
    id: readerId(book.metadata.title, book.metadata.author, rendered.map((chapter) => chapter.title)),
    title: book.metadata.title,
    author: book.metadata.author ?? null,
    language: book.metadata.language ?? 'en',
    startChapter: start === -1 ? 0 : start,
    chapters: rendered,
    images: imagePaths.map((sourcePath) => ({
      sourcePath,
      fileName: names.get(sourcePath) ?? 'image',
    })),
  };
}

/**
 * Stable across regenerating the same book, so the phone keeps its place.
 * A changed chapter list is a different book and starts over — the old
 * sentences were about chapters that no longer line up.
 */
export function readerId(title: string, author: string | undefined, titles: string[]): string {
  const material = `${title}\n${author ?? ''}\n${titles.join('\n')}`;
  return `${fnv(material)}-${fnv([...material].reverse().join(''))}`;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Basenames only, and unique. Two chapters can ship `cover.jpg` from
 * different folders; one must not overwrite the other on the way to the phone.
 */
export function assignImageNames(paths: string[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const path of paths) {
    const base = (path.split('/').pop() ?? 'image').replace(/[^A-Za-z0-9._-]/g, '');
    const cleaned = base.replace(/^\.+/, '') || 'image';
    let name = cleaned;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const dot = cleaned.lastIndexOf('.');
      name = dot > 0 ? `${cleaned.slice(0, dot)}-${n}${cleaned.slice(dot)}` : `${cleaned}-${n}`;
      n++;
    }
    used.add(name.toLowerCase());
    map.set(path, name);
  }
  return map;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Keep only the inline whitelist, with no attributes. Script and style bodies
 * are removed first — stripping the tags alone would leave the program text
 * sitting in the paragraph.
 */
export function safeInline(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, '');
  const out: string[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] !== '<') {
      const next = stripped.indexOf('<', i);
      const end = next === -1 ? stripped.length : next;
      out.push(escapeHtml(unescapeHtml(stripped.slice(i, end))));
      i = end;
      continue;
    }
    const close = stripped.indexOf('>', i);
    if (close === -1) {
      // `a < b` is prose, not a tag.
      out.push(escapeHtml(unescapeHtml(stripped.slice(i))));
      break;
    }
    const token = stripped.slice(i, close + 1);
    const tag = /^<(\/?)([a-zA-Z0-9]+)\s*>$/.exec(token);
    const name = tag?.[2]?.toLowerCase();
    if (tag && name && INLINE.has(name)) {
      if (tag[1]) {
        if (stack.length > 0 && stack[stack.length - 1] === name) {
          stack.pop();
          out.push(`</${name}>`);
        }
      } else {
        stack.push(name);
        out.push(`<${name}>`);
      }
      i = close + 1;
      continue;
    }
    if (/^<\/?[a-zA-Z][^>]*>$/.test(token)) {
      // A real tag we do not keep, attributes and all. Drop it.
      i = close + 1;
      continue;
    }
    out.push('&lt;');
    i += 1;
  }
  while (stack.length > 0) out.push(`</${stack.pop()!}>`);
  return out.join('');
}

export function renderChapterHtml(
  chapter: Chapter,
  blocks: Block[],
  notes: Map<string, string> | undefined,
  images: Map<string, string>,
): string {
  const parts: string[] = [];
  const definitions: { n: number; text: string }[] = [];
  let list: string[] | null = null;

  const flushList = (): void => {
    if (!list) return;
    parts.push(`<ul>${list.join('')}</ul>`);
    list = null;
  };

  for (let i = chapter.start; i < chapter.end; i++) {
    const block = blocks[i];
    if (!block) continue;
    if (block.tag === 'li' && !block.image) {
      const inner = inlineOf(block, notes, definitions);
      if (!inner) continue;
      (list ??= []).push(`<li>${inner}</li>`);
      continue;
    }
    flushList();
    const html = renderBlock(block, notes, definitions, images);
    if (html) parts.push(html);
  }
  flushList();

  if (definitions.length === 0) return parts.join('\n');
  const items = definitions
    .map((def) => `<li id="fn-${def.n}">${escapeHtml(def.text)} <a href="#ref-${def.n}">Back</a></li>`)
    .join('');
  return `${parts.join('\n')}\n<section class="notes"><h2>Notes</h2><ol>${items}</ol></section>`;
}

function renderBlock(
  block: Block,
  notes: Map<string, string> | undefined,
  definitions: { n: number; text: string }[],
  images: Map<string, string>,
): string {
  if (block.image) {
    const name = images.get(block.image);
    if (!name) return '';
    const alt = escapeHtml(block.alt ?? '');
    return `<figure><img src="images/${name}" alt="${alt}"></figure>`;
  }
  const inner = inlineOf(block, notes, definitions);
  if (!inner) return '';
  if (block.heading > 0) {
    const level = Math.min(block.heading, 6);
    return `<h${level}>${inner}</h${level}>`;
  }
  if (block.tag === 'blockquote') return `<blockquote>${inner}</blockquote>`;
  if (block.tag === 'pre') return `<pre>${escapeHtml(block.text)}</pre>`;
  return `<p>${inner}</p>`;
}

function inlineOf(
  block: Block,
  notes: Map<string, string> | undefined,
  definitions: { n: number; text: string }[],
): string {
  const source = block.html || escapeHtml(block.text);
  let refIndex = 0;
  const marked = source.replace(/<noteref>[\s\S]*?<\/noteref>/g, () => {
    const ref: NoteRef | undefined = block.noterefs?.[refIndex++];
    const n = definitions.length + 1;
    const body = ref ? notes?.get(ref.key) : undefined;
    definitions.push({
      n,
      text: body ?? (ref ? `The note "${ref.label}" is missing from this book.` : 'A note marker had no target.'),
    });
    return `\u0000${n}\u0000`;
  });
  return safeInline(marked).replace(/\u0000(\d+)\u0000/g, (_all, n: string) => {
    return `<sup><a href="#fn-${n}" id="ref-${n}">${n}</a></sup>`;
  });
}
