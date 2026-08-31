import { unzipSync, strFromU8 } from 'fflate';
import type { AnyNode, Element } from 'domhandler';
import type { Block, Book, BookMetadata, SpineItem, TocEntry } from './types.js';
import { attr, children, findAll, findFirst, isElement, parseHtml, parseXml, textOf } from './xml.js';

const CONTAINER = 'META-INF/container.xml';

/** Elements that carry their own line in the reading flow. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote',
  'pre', 'figcaption', 'td', 'th', 'dt', 'dd', 'section', 'article', 'aside',
]);

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubError';
  }
}

/** Resolve `href` against the directory of `base`, returning a zip-root path. */
export function resolvePath(base: string, href: string): string {
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
  const joined = dir ? `${dir}/${href}` : href;
  const parts: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function splitHref(href: string): { path: string; fragment?: string } {
  const hash = href.indexOf('#');
  if (hash < 0) return { path: decodeURIComponent(href) };
  return {
    path: decodeURIComponent(href.slice(0, hash)),
    fragment: decodeURIComponent(href.slice(hash + 1)),
  };
}

export function openEpub(bytes: Uint8Array): Book {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (cause) {
    throw new EpubError(
      'Not a readable EPUB: the file is not a valid ZIP archive. ' +
      'If it came from a store it may carry DRM, which must be removed before it can be opened.',
    );
  }

  const read = (path: string): string => {
    const raw = files[path];
    if (!raw) throw new EpubError(`EPUB is missing "${path}".`);
    return strFromU8(raw);
  };

  // 1. container.xml -> package document path
  if (!files[CONTAINER]) throw new EpubError(`EPUB is missing "${CONTAINER}"; it is not a valid EPUB.`);
  const rootfile = findFirst(parseXml(read(CONTAINER)), 'rootfile');
  const opfPath = rootfile && attr(rootfile, 'full-path');
  if (!opfPath) throw new EpubError('container.xml does not declare a package document (<rootfile full-path>).');

  // 2. package document -> metadata, manifest, spine
  const opf = parseXml(read(opfPath));
  const pkg = findFirst(opf, 'package');
  const metadata = readMetadata(opf, pkg);

  const manifest = new Map<string, { path: string; properties: string }>();
  for (const item of findAll(opf, 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (!id || !href) continue;
    manifest.set(id, {
      path: resolvePath(opfPath, splitHref(href).path),
      properties: attr(item, 'properties') ?? '',
    });
  }

  const spineEl = findFirst(opf, 'spine');
  const spine: SpineItem[] = [];
  for (const ref of spineEl ? findAll(spineEl, 'itemref') : []) {
    const idref = attr(ref, 'idref');
    const entry = idref ? manifest.get(idref) : undefined;
    if (!idref || !entry) continue;
    spine.push({ id: idref, path: entry.path, linear: attr(ref, 'linear') !== 'no' });
  }
  if (spine.length === 0) throw new EpubError('EPUB spine is empty: there is no readable content.');

  // 3. Table of contents: EPUB 3 nav preferred, EPUB 2 NCX as fallback.
  let toc: TocEntry[] = [];
  let tocSource: Book['tocSource'] = 'none';

  const navEntry = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes('nav'));
  if (navEntry && files[navEntry.path]) {
    toc = readNav(read(navEntry.path), navEntry.path);
    if (toc.length) tocSource = 'nav';
  }
  if (!toc.length) {
    const ncxId = spineEl ? attr(spineEl, 'toc') : undefined;
    const ncx = ncxId ? manifest.get(ncxId) : undefined;
    if (ncx && files[ncx.path]) {
      toc = readNcx(read(ncx.path), ncx.path);
      if (toc.length) tocSource = 'ncx';
    }
  }

  // 4. Flatten the spine into one linear block array.
  const raw: Block[] = [];
  spine.forEach((item, spineIndex) => {
    const data = files[item.path];
    if (!data) return;
    collectBlocks(strFromU8(data), item.path, spineIndex, raw);
  });
  const blocks = joinWrappedLines(raw);

  // Only the figures the text actually references, so an unused cover gallery
  // does not sit in memory for the whole session.
  const wanted = new Set(blocks.map((b) => b.image).filter((p): p is string => p !== undefined));
  const images = new Map<string, Uint8Array>();
  for (const path of wanted) {
    const data = files[path];
    if (data) images.set(path, data);
  }

  return { metadata, spine, blocks, toc, tocSource, images };
}

function readMetadata(opf: ReturnType<typeof parseXml>, pkg: Element | undefined): BookMetadata {
  const meta = findFirst(opf, 'metadata');
  const pick = (name: string): string | undefined => {
    const el = meta ? findAll(meta, name)[0] : undefined;
    const value = el ? textOf(el) : '';
    return value || undefined;
  };
  return {
    title: pick('title') ?? 'Untitled',
    ...(pick('creator') !== undefined ? { author: pick('creator')! } : {}),
    ...(pick('language') !== undefined ? { language: pick('language')! } : {}),
    epubVersion: (pkg && attr(pkg, 'version')) || '2.0',
  };
}

/** EPUB 3: `<nav epub:type="toc">` containing nested `<ol><li><a href>`. */
function readNav(source: string, navPath: string): TocEntry[] {
  const doc = parseHtml(source);
  const navs = findAll(doc, 'nav');
  const tocNav = navs.find((n) => (attr(n, 'type') ?? '').split(/\s+/).includes('toc')) ?? navs[0];
  if (!tocNav) return [];

  const out: TocEntry[] = [];
  const walkList = (list: Element, depth: number): void => {
    for (const li of children(list, 'li')) {
      const anchor = findAll(li, 'a')[0];
      const href = anchor ? attr(anchor, 'href') : undefined;
      if (anchor && href) {
        const { path, fragment } = splitHref(href);
        out.push({
          label: textOf(anchor),
          path: resolvePath(navPath, path),
          ...(fragment !== undefined ? { fragment } : {}),
          depth,
        });
      }
      for (const sub of children(li, 'ol')) walkList(sub, depth + 1);
    }
  };
  for (const list of children(tocNav, 'ol')) walkList(list, 0);
  return out;
}

/** EPUB 2: `<navMap>` containing nested `<navPoint><navLabel><text>` + `<content src>`. */
function readNcx(source: string, ncxPath: string): TocEntry[] {
  const doc = parseXml(source);
  const navMap = findFirst(doc, 'navMap');
  if (!navMap) return [];

  const out: TocEntry[] = [];
  const walkPoints = (parent: Element, depth: number): void => {
    for (const point of children(parent, 'navPoint')) {
      const label = children(point, 'navLabel')[0];
      const content = children(point, 'content')[0];
      const src = content ? attr(content, 'src') : undefined;
      if (src) {
        const { path, fragment } = splitHref(src);
        out.push({
          label: label ? textOf(label) : '',
          path: resolvePath(ncxPath, path),
          ...(fragment !== undefined ? { fragment } : {}),
          depth,
        });
      }
      walkPoints(point, depth + 1);
    }
  };
  walkPoints(navMap, 0);
  return out;
}

/**
 * Inline elements worth keeping. Everything else is unwrapped to its text, and
 * NO attributes survive — the rendered HTML carries no href, src or handler, so
 * book content cannot reach anything outside the paragraph it lives in.
 */
const INLINE_KEEP = new Set(['em', 'i', 'strong', 'b', 'sup', 'sub', 'code', 'cite', 'q', 'small', 'u']);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Serialise inline markup, stripping tags outside the whitelist but keeping their
 * text. The concatenated text nodes equal `textOf(el)`, which annotation offsets
 * depend on.
 */
function inlineHtml(node: AnyNode): string {
  let out = '';
  const walk = (n: AnyNode): void => {
    if (n.type === 'text') {
      out += escapeHtml((n as unknown as { data: string }).data);
      return;
    }
    if (!isElement(n)) return;
    const tag = n.name.toLowerCase();
    if (tag === 'script' || tag === 'style') return;
    const keep = INLINE_KEEP.has(tag);
    if (keep) out += `<${tag}>`;
    for (const child of (n.children ?? []) as AnyNode[]) walk(child);
    if (keep) out += `</${tag}>`;
  };
  for (const child of ('children' in node ? (node.children as AnyNode[]) ?? [] : [])) walk(child);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Sentence-final punctuation. A semicolon is deliberately absent: a line ending
 * in one is mid-sentence, and treating it as final cut the sidebar below in half.
 */
const TERMINAL = /[.!?:\u2026\u201d\u2019"')\]]\s*$/;

/** Trailing dangling punctuation that can only be mid-sentence. */
const DANGLING = /[,;\u2013\u2014-]\s*$/;

/**
 * Words a sentence does not end on. A line finishing here was wrapped by the
 * converter, not by the author.
 */
const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'to', 'for', 'with', 'at',
  'by', 'from', 'as', 'is', 'was', 'were', 'are', 'be', 'been', 'that', 'which',
  'who', 'his', 'her', 'its', 'their', 'this', 'these', 'those', 'on', 'into',
  'than', 'then', 'when', 'while', 'if', 'not', 'no', 'so', 'he', 'she', 'they',
  'it', 'you', 'we', 'i', 'him', 'them', 'us', 'my', 'your', 'our',
]);

function lastWord(text: string): string {
  const words = text.trim().split(/\s+/);
  return (words[words.length - 1] ?? '').toLowerCase().replace(/[^a-z']/g, '');
}

/** All-caps lines are display titles, never wrapped body text. */
function isDisplayLine(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  return letters === letters.toUpperCase();
}

/**
 * Rejoin paragraphs that are really one paragraph split across printed lines.
 *
 * Books converted from scans emit one `<p>` per line of the original page —
 * `<p>The Stars in the</p><p>Sky. There can be only</p>` — which is faithful
 * markup and unreadable prose.
 *
 * Ending without sentence punctuation is necessary but not sufficient: display
 * titles such as `NEVER OUTSHINE THE MASTER` end that way too, and swallowing
 * one into the body below it destroys the chapter's title. So a join also needs
 * positive evidence of continuation — the next line starting lowercase, or this
 * line ending on a comma or a word no sentence ends on.
 */
function joinWrappedLines(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    const structurallyJoinable =
      prev !== undefined &&
      prev.heading === 0 && block.heading === 0 &&
      prev.image === undefined && block.image === undefined &&
      prev.tag === 'p' && block.tag === 'p' &&
      prev.path === block.path &&
      prev.text.length > 0 && block.text.length > 0 &&
      !isDisplayLine(prev.text) &&
      !TERMINAL.test(prev.text);

    const continues =
      structurallyJoinable &&
      (/^[a-z]/.test(block.text) ||
        DANGLING.test(prev!.text) ||
        FUNCTION_WORDS.has(lastWord(prev!.text)));

    if (continues) {
      prev!.text = `${prev!.text} ${block.text}`;
      prev!.html = `${prev!.html} ${block.html}`;
      prev!.ids.push(...block.ids);
    } else {
      out.push(block);
    }
  }
  return out;
}

/**
 * Emit one Block per leaf block-level element, in document order.
 *
 * An `id` on a wrapper (`<div id="ch7"><p>…`) is carried down to the first leaf
 * inside it, so TOC fragments pointing at containers still resolve to a block.
 */
function collectBlocks(source: string, path: string, spineIndex: number, out: Block[]): void {
  const doc = parseHtml(source);
  const body = findFirst(doc, 'body') ?? doc;

  /** Ids seen since the last emitted block; they all point at the next one. */
  let pendingIds: string[] = [];

  // An id on <body> addresses the start of the document, and books converted
  // from Word anchor whole chapters there. Missing it loses every such cut.
  const bodyId = body.type === 'tag' ? attr(body as Element, 'id') : undefined;
  if (bodyId) pendingIds.push(bodyId);

  const emit = (el: Element, tag: string): void => {
    const text = textOf(el);
    const own = attr(el, 'id');
    const ids = own ? [...pendingIds, own] : pendingIds;
    pendingIds = [];
    const figure = findAll(el, 'img')[0] ?? findAll(el, 'image')[0];
    const src = figure ? (attr(figure, 'src') ?? attr(figure, 'href')) : undefined;
    if (!text && !ids.length && !src) return;
    const headingMatch = /^h([1-6])$/.exec(tag);
    const alt = figure ? attr(figure, 'alt') : undefined;
    out.push({
      spineIndex,
      path,
      ids,
      tag,
      heading: headingMatch ? Number(headingMatch[1]) : 0,
      text,
      html: inlineHtml(el),
      ...(src !== undefined ? { image: resolvePath(path, splitHref(src).path) } : {}),
      ...(alt ? { alt } : {}),
    });
  };

  const hasBlockChild = (el: Element): boolean =>
    (el.children ?? []).some(
      (c) => c.type === 'tag' && BLOCK_TAGS.has((c as Element).name.toLowerCase()),
    );

  const walk = (node: Element): void => {
    for (const child of node.children ?? []) {
      if (child.type !== 'tag') continue;
      const el = child as Element;
      const tag = el.name.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'head') continue;

      if (tag === 'img' || tag === 'image') {
        // Figures carry no text, so they would otherwise vanish entirely.
        emit(el, 'figure');
      } else if (BLOCK_TAGS.has(tag) && !hasBlockChild(el)) {
        emit(el, tag);
      } else {
        // Not a leaf block: keep its id so it lands on the next real block.
        const id = attr(el, 'id');
        if (id) pendingIds.push(id);
        walk(el);
      }
    }
  };
  walk(body as Element);

  // Ids trailing at the end of a document belong to its last block.
  if (pendingIds.length && out.length) {
    const last = out[out.length - 1]!;
    if (last.path === path) last.ids.push(...pendingIds);
  }
}
