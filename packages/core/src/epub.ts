import { unzipSync, strFromU8 } from 'fflate';
import type { Element } from 'domhandler';
import type { Block, Book, BookMetadata, SpineItem, TocEntry } from './types.js';
import { attr, children, collapse, findAll, findFirst, parseHtml, parseXml, textOf } from './xml.js';

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
  const blocks: Block[] = [];
  spine.forEach((item, spineIndex) => {
    const raw = files[item.path];
    if (!raw) return;
    collectBlocks(strFromU8(raw), item.path, spineIndex, blocks);
  });

  return { metadata, spine, blocks, toc, tocSource };
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
    if (!text && !ids.length) return;
    const headingMatch = /^h([1-6])$/.exec(tag);
    out.push({
      spineIndex,
      path,
      ids,
      tag,
      heading: headingMatch ? Number(headingMatch[1]) : 0,
      text,
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

      if (BLOCK_TAGS.has(tag) && !hasBlockChild(el)) {
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
