import { unzipSync } from 'fflate';
import type { AnyNode, Document, Element } from 'domhandler';
import type { Block, Book, BookMetadata, NoteRef, SpineItem, TocEntry } from './types.js';
import { attr, children, findAll, findFirst, isElement, parseHtml, parseXml, textOf } from './xml.js';

const CONTAINER = 'META-INF/container.xml';

/** Elements that carry their own line in the reading flow. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote',
  'pre', 'figcaption', 'td', 'th', 'dt', 'dd', 'section', 'article', 'aside',
]);

/**
 * Inline elements worth keeping. Everything else is unwrapped to its text, and
 * NO attributes survive — the rendered HTML carries no href, src or handler, so
 * book content cannot reach anything outside the paragraph it lives in.
 */
const INLINE_KEEP = new Set(['em', 'i', 'strong', 'b', 'sup', 'sub', 'code', 'cite', 'q', 'small', 'u']);

/** One footnote, as opposed to the section that holds several of them. */
const NOTE_TYPES = new Set(['footnote', 'endnote', 'rearnote', 'doc-footnote', 'doc-endnote']);

const NOTE_GROUPS = new Set(['footnotes', 'endnotes', 'rearnotes', 'doc-endnotes', 'doc-footnotes']);

/** A nav that must never be read as the table of contents. */
const AUX_NAV = new Set([
  'page-list', 'landmarks', 'lot', 'loi', 'loa', 'lov', 'doc-pagelist', 'doc-landmarks',
]);

const CONTENT_FILE = /\.(xhtml|html|htm|opf|ncx)(?:$|\?)/i;

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubError';
  }
}

/**
 * Collapse `.`, `..`, backslashes and duplicate slashes.
 *
 * Zip entries, manifest hrefs and content links disagree about all four, and a
 * mismatch drops the file silently — the spine then points at a path the
 * archive does not have.
 */
function canonicalPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Resolve `href` against the directory of `base`, returning a zip-root path. */
export function resolvePath(base: string, href: string): string {
  const clean = href.replace(/\\/g, '/');
  // A leading slash is the zip root. Resolving it against the OPF directory
  // produced `OEBPS/OEBPS/...` and every chapter in that book failed to open.
  if (clean.startsWith('/')) return canonicalPath(clean);
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
  return canonicalPath(dir ? `${dir}/${clean}` : clean);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // A stray "%" is a bad escape, not a reason to reject the book. The link
    // then fails to resolve and the contents entry says so.
    return s;
  }
}

/** Split and resolve one href from a document at `base`. */
function resolveHref(base: string, href: string): { path: string; fragment?: string } {
  const clean = href.trim().replace(/\\/g, '/');
  const hash = clean.indexOf('#');
  let rawPath = hash < 0 ? clean : clean.slice(0, hash);
  const fragRaw = hash < 0 ? '' : clean.slice(hash + 1);
  const query = rawPath.indexOf('?');
  if (query >= 0) rawPath = rawPath.slice(0, query);
  rawPath = safeDecode(rawPath);
  // "#id" is this document, not its directory. Resolving the empty path
  // against the directory landed on the folder and the id was never found.
  const path = rawPath === '' ? canonicalPath(base) : resolvePath(base, rawPath);
  const fragment = fragRaw ? safeDecode(fragRaw) : undefined;
  return fragment ? { path, fragment } : { path };
}

interface Archive {
  get(path: string): Uint8Array | undefined;
}

/**
 * Paths are matched case-insensitively because a book packed on Windows and a
 * manifest written as `Text/ch1.xhtml` otherwise disagree, and the chapter
 * vanishes.
 */
function indexArchive(entries: Record<string, Uint8Array>): Archive {
  const byPath = new Map<string, Uint8Array>();
  const byLower = new Map<string, Uint8Array>();
  for (const [rawKey, bytes] of Object.entries(entries)) {
    if (!rawKey || rawKey.endsWith('/')) continue;
    const key = canonicalPath(rawKey);
    if (!key || byPath.has(key)) continue;
    byPath.set(key, bytes);
    const lower = key.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, bytes);
  }
  return {
    get(path: string): Uint8Array | undefined {
      const key = canonicalPath(path);
      return byPath.get(key) ?? byLower.get(key.toLowerCase());
    },
  };
}

function latin1Prefix(bytes: Uint8Array, n: number): string {
  const end = Math.min(bytes.length, n);
  let out = '';
  for (let i = 0; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/** Encoding from an XML declaration or an HTML charset, both of which are ASCII. */
function declaredEncoding(bytes: Uint8Array): string | undefined {
  const head = latin1Prefix(bytes, 800);
  const xml = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  if (xml?.[1]) return xml[1];
  const meta = /charset\s*=\s*["']?\s*([^"'>\s;]+)/i.exec(head);
  return meta?.[1];
}

function normalizeEncoding(label: string): string {
  const key = label.trim().toLowerCase().replace(/_/g, '-');
  if (key === 'cp1252' || key === 'windows1252') return 'windows-1252';
  if (key === 'utf8') return 'utf-8';
  return key;
}

/**
 * EPUB 3 is UTF-8. EPUB 2 is whatever the file declares, and a lot of EPUB 2
 * never declares anything and is Windows-1252. `strFromU8` is UTF-8 only, so a
 * curly quote became a replacement character and the quote no longer matched
 * the text the reader had highlighted.
 */
function decode(bytes: Uint8Array, path: string): string {
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  const declared = declaredEncoding(bytes);
  if (declared) {
    try {
      return new TextDecoder(normalizeEncoding(declared)).decode(bytes);
    } catch {
      throw new EpubError(
        `Cannot read "${path}": encoding "${declared}" is not supported. Re-save the book as UTF-8 and try again.`,
      );
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

interface ManifestItem {
  path: string;
  properties: string;
  mediaType: string;
}

function mediaKind(mediaType: string): 'image' | 'markup' | 'skip' {
  if (mediaType.includes('ncx') || mediaType.includes('dtbncx')) return 'skip';
  if (mediaType.includes('svg')) return 'markup';
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.includes('html') || mediaType.includes('xml') || mediaType === '') return 'markup';
  return 'skip';
}

/**
 * Font obfuscation ships an encryption.xml that lists only font files. DRM
 * lists the chapters. Treating every encryption.xml as fatal rejected books
 * whose text was fine and whose fonts were scrambled on purpose.
 */
function assertNotEncrypted(archive: Archive): void {
  const bytes = archive.get('META-INF/encryption.xml');
  if (!bytes) return;
  const xml = decode(bytes, 'META-INF/encryption.xml');
  if (/ns\.adobe\.com\/adept/i.test(xml)) {
    throw new EpubError(
      'Cannot open this EPUB: it is DRM-protected (Adobe Adept, META-INF/encryption.xml). Chapterize cannot remove DRM.',
    );
  }
  let doc: Document;
  try {
    doc = parseXml(xml);
  } catch {
    // Unreadable XML is not evidence of DRM. Rejecting the book here would
    // refuse a file whose chapters are plain text and whose encryption
    // manifest is just corrupt.
    return;
  }
  const protectedContent: string[] = [];
  for (const ref of findAll(doc, 'CipherReference')) {
    const uri = attr(ref, 'URI');
    if (!uri) continue;
    const path = safeDecode(uri.replace(/\\/g, '/').replace(/^\/+/, ''));
    if (CONTENT_FILE.test(path)) protectedContent.push(path);
  }
  const sample = protectedContent[0];
  if (sample) {
    throw new EpubError(
      `Cannot open this EPUB: "${sample}" is encrypted (META-INF/encryption.xml). Chapterize cannot open DRM-protected books.`,
    );
  }
}

export function openEpub(bytes: Uint8Array): Book {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : '';
    throw new EpubError(
      `Cannot open this file as an EPUB: it is not a valid ZIP archive${detail}. ` +
      'If it came from a store, it may be DRM-protected — remove the DRM and try again.',
    );
  }
  const archive = indexArchive(entries);

  const container = archive.get(CONTAINER);
  if (!container) {
    throw new EpubError(
      `Cannot open this file as an EPUB: "${CONTAINER}" is missing, so there is no package to read.`,
    );
  }
  assertNotEncrypted(archive);
  const rootfile = findFirst(parseXml(decode(container, CONTAINER)), 'rootfile');
  const opfPathRaw = rootfile && attr(rootfile, 'full-path');
  if (!opfPathRaw) {
    throw new EpubError(
      'Cannot open this EPUB: META-INF/container.xml has no <rootfile full-path> pointing at the package document.',
    );
  }
  const opfPath = canonicalPath(opfPathRaw);
  const opfBytes = archive.get(opfPath);
  if (!opfBytes) {
    throw new EpubError(
      `Cannot open this EPUB: the package document "${opfPath}" listed in container.xml is not in the archive.`,
    );
  }

  const opf = parseXml(decode(opfBytes, opfPath));
  const pkg = findFirst(opf, 'package');
  const metadata = readMetadata(opf, pkg);

  const manifest = new Map<string, ManifestItem>();
  for (const item of findAll(opf, 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (!id || !href) continue;
    manifest.set(id, {
      path: resolveHref(opfPath, href).path,
      properties: attr(item, 'properties') ?? '',
      mediaType: (attr(item, 'media-type') ?? '').toLowerCase(),
    });
  }

  const spineEl = findFirst(opf, 'spine');
  const spine: SpineItem[] = [];
  const mediaTypes: string[] = [];
  const unknown: string[] = [];
  for (const ref of spineEl ? findAll(spineEl, 'itemref') : []) {
    const idref = attr(ref, 'idref');
    if (!idref) continue;
    const entry = manifest.get(idref);
    if (!entry) {
      unknown.push(idref);
      continue;
    }
    spine.push({
      id: idref,
      path: entry.path,
      linear: (attr(ref, 'linear') ?? 'yes').toLowerCase() !== 'no',
    });
    mediaTypes.push(entry.mediaType);
  }
  if (spine.length === 0) {
    throw new EpubError(
      unknown.length
        ? `Cannot open this EPUB: the spine ids (${unknown.slice(0, 5).join(', ')}) do not match any manifest item.`
        : 'Cannot open this EPUB: the spine lists no documents to read.',
    );
  }

  const { toc, tocSource } = loadToc(manifest, spine, spineEl, archive);

  const raw: Block[] = [];
  const aside: Block[] = [];
  const noteHits: NoteHit[] = [];
  spine.forEach((item, spineIndex) => {
    const data = archive.get(item.path);
    if (!data) {
      // A missing chapter is the book being incomplete. A missing footnote file
      // is one note; the chapter it belongs to is still readable.
      if (item.linear) {
        throw new EpubError(
          `Cannot open this EPUB: spine item "${item.id}" points at "${item.path}", which is not in the archive. The book is incomplete.`,
        );
      }
      return;
    }
    const kind = mediaKind(mediaTypes[spineIndex] ?? '');
    if (kind === 'skip') return;
    if (kind === 'image') {
      if (item.linear) raw.push(imageBlock(spineIndex, item.path));
      return;
    }
    let collected: { blocks: Block[]; notes: NoteHit[] };
    try {
      collected = collectBlocks(decode(data, item.path), item.path, spineIndex);
    } catch (cause) {
      if (cause instanceof EpubError) throw cause;
      const detail = cause instanceof Error ? cause.message : 'the markup could not be parsed';
      throw new EpubError(
        `Cannot read "${item.path}": ${detail}. The file may be truncated or not HTML.`,
      );
    }
    (item.linear ? raw : aside).push(...collected.blocks);
    noteHits.push(...collected.notes);
  });
  const blocks = joinWrappedLines(raw);

  const notes = new Map<string, string>();
  const addNote = (key: string, text: string): void => {
    const cleaned = stripNoteMarker(text);
    if (!cleaned) return;
    const existing = notes.get(key);
    notes.set(key, existing ? `${existing} ${cleaned}` : cleaned);
  };
  for (const hit of noteHits) addNote(hit.key, hit.text);
  // Non-linear documents are notes in their entirety, including ones the
  // publisher never marked with epub:type. Joining first so a note split into
  // one <p> per printed line is stored as one paragraph, not one sentence per id.
  for (const block of joinWrappedLines(aside)) {
    if (!block.text) continue;
    for (const id of block.ids) addNote(`${block.path}#${id}`, block.text);
    addNote(block.path, block.text);
  }

  const wanted = new Set(blocks.map((b) => b.image).filter((p): p is string => p !== undefined));
  const images = new Map<string, Uint8Array>();
  for (const path of wanted) {
    const data = archive.get(path);
    if (data) images.set(path, data);
  }

  return { metadata, spine, blocks, toc, tocSource, images, notes };
}

function imageBlock(spineIndex: number, path: string): Block {
  return {
    spineIndex,
    path,
    ids: [],
    tag: 'figure',
    heading: 0,
    text: '',
    html: '',
    image: path,
  };
}

function readMetadata(opf: Document, pkg: Element | undefined): BookMetadata {
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

function typeTokens(el: Element): string[] {
  return `${attr(el, 'type') ?? ''} ${attr(el, 'role') ?? ''}`
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function isTocNav(el: Element): boolean {
  const tokens = typeTokens(el);
  return tokens.includes('toc') || tokens.includes('doc-toc');
}

function isAuxNav(el: Element): boolean {
  return typeTokens(el).some((token) => AUX_NAV.has(token));
}

/**
 * EPUB 3 nav. Only `epub:type="toc"` is a table of contents. `page-list` is
 * print-page anchors — one book had 174 of them — and reading it invents a
 * chapter per page.
 */
function readNav(source: string, navPath: string, requireTocType: boolean): TocEntry[] {
  const doc = parseHtml(source);
  const navs = findAll(doc, 'nav');
  const tocNav = navs.find(isTocNav) ?? (requireTocType ? undefined : navs.find((n) => !isAuxNav(n)));
  if (!tocNav) return [];

  const out: TocEntry[] = [];
  const pushAnchor = (anchor: Element, depth: number): void => {
    const href = attr(anchor, 'href');
    if (!href) return;
    const located = resolveHref(navPath, href);
    out.push({
      label: textOf(anchor),
      path: located.path,
      ...(located.fragment !== undefined ? { fragment: located.fragment } : {}),
      depth,
    });
  };
  const walkList = (list: Element, depth: number): void => {
    for (const li of children(list, 'li')) {
      const anchor = findAll(li, 'a')[0];
      if (anchor) pushAnchor(anchor, depth);
      for (const sub of sublists(li)) walkList(sub, depth + 1);
    }
  };
  const lists = topLists(tocNav);
  if (lists.length) {
    for (const list of lists) walkList(list, 0);
  } else {
    // A contents list written as bare links, with no <ol>, is still a contents
    // list. Dropping it sent the book to the heading fallback for no reason.
    for (const anchor of findAll(tocNav, 'a')) pushAnchor(anchor, 0);
  }
  return out;
}

/** An `<ol>` wrapped in a `<div>` under `<nav>` is still the contents list. */
function topLists(nav: Element): Element[] {
  const direct = children(nav, 'ol');
  if (direct.length) return direct;
  const all = findAll(nav, 'ol');
  return all.filter((ol) => !all.some((other) => other !== ol && containsNode(other, ol)));
}

function sublists(li: Element): Element[] {
  const direct = children(li, 'ol');
  if (direct.length) return direct;
  const nested = findAll(li, 'ol').filter((ol) => !findAll(li, 'ol').some(
    (other) => other !== ol && containsNode(other, ol),
  ));
  return nested;
}

function containsNode(ancestor: Element, node: Element): boolean {
  return findAll(ancestor, node.name).includes(node);
}

/** EPUB 2 NCX. `pageList` is print pages and is ignored, same as EPUB 3 page-list. */
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
        const located = resolveHref(ncxPath, src);
        out.push({
          label: label ? textOf(label) : '',
          path: located.path,
          ...(located.fragment !== undefined ? { fragment: located.fragment } : {}),
          depth,
        });
      }
      walkPoints(point, depth + 1);
    }
  };
  walkPoints(navMap, 0);
  return out;
}

function loadToc(
  manifest: Map<string, ManifestItem>,
  spine: SpineItem[],
  spineEl: Element | undefined,
  archive: Archive,
): { toc: TocEntry[]; tocSource: Book['tocSource'] } {
  const items = [...manifest.values()];
  const navItem = items.find((m) => m.properties.split(/\s+/).includes('nav'))
    ?? items.find((m) => /(?:^|\/)nav\.xhtml$/i.test(m.path));
  if (navItem) {
    const bytes = archive.get(navItem.path);
    if (bytes) {
      const toc = readNav(decode(bytes, navItem.path), navItem.path, false);
      if (toc.length) return { toc, tocSource: 'nav' };
    }
  }

  const ncxId = spineEl ? attr(spineEl, 'toc') : undefined;
  const ncx = (ncxId ? manifest.get(ncxId) : undefined)
    ?? items.find((m) => m.mediaType.includes('ncx') || m.path.toLowerCase().endsWith('.ncx'));
  if (ncx) {
    const bytes = archive.get(ncx.path);
    if (bytes) {
      const toc = readNcx(decode(bytes, ncx.path), ncx.path);
      if (toc.length) return { toc, tocSource: 'ncx' };
    }
  }

  // The nav document is in the spine but nobody set properties="nav". Require
  // an explicit toc type so a chapter that happens to contain a <nav> of links
  // does not become the table of contents.
  for (const item of spine) {
    const bytes = archive.get(item.path);
    if (!bytes) continue;
    if (!/<nav[\s>]/i.test(latin1Prefix(bytes, Math.min(bytes.length, 200_000)))) continue;
    const text = decode(bytes, item.path);
    const toc = readNav(text, item.path, true);
    if (toc.length) return { toc, tocSource: 'nav' };
  }
  return { toc: [], tocSource: 'none' };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Serialise inline markup so its text nodes concatenate to `textOf`.
 *
 * A space inside a tag and a space after it are one space in the reading
 * text (`<b>bold </b> stay` is "bold stay"). Collapsing the serialised string
 * cannot see that, because the tag sits between the two spaces, and annotation
 * offsets then point at the wrong character. Edge whitespace is walked out of
 * the tags first, empty tags are dropped, and only then is whitespace collapsed.
 */
function serializeNodes(nodes: AnyNode[]): string {
  let out = '';
  const walk = (n: AnyNode): void => {
    if (n.type === 'text') {
      out += escapeHtml((n as unknown as { data: string }).data);
      return;
    }
    if (!isElement(n)) return;
    const tag = n.name.toLowerCase();
    if (tag === 'script' || tag === 'style') return;
    if (tag === 'br' || tag === 'hr') {
      out += ' ';
      return;
    }
    const isNoteref = tag === 'a' && typeTokens(n).some((token) => token.includes('noteref'));
    const emitted = isNoteref ? 'noteref' : tag;
    const keep = isNoteref || INLINE_KEEP.has(tag);
    if (keep) out += `<${emitted}>`;
    for (const child of (n.children ?? []) as AnyNode[]) walk(child);
    if (keep) out += `</${emitted}>`;
  };
  for (const node of nodes) walk(node);
  return normaliseInlineHtml(out);
}

function normaliseInlineHtml(html: string): string {
  let cur = html;
  // Nesting: the inner tag has to shed its space before the outer one can.
  for (let i = 0; i < 8; i++) {
    const next = cur
      .replace(/<([a-z0-9]+)>\s+/g, ' <$1>')
      .replace(/\s+<\/([a-z0-9]+)>/g, '</$1> ');
    if (next === cur) break;
    cur = next;
  }
  // An empty tag left between two spaces would stop them collapsing into one.
  cur = cur.replace(/<([a-z0-9]+)><\/\1>/g, '');
  return cur.replace(/\s+/g, ' ').trim();
}

function idsIn(node: AnyNode): string[] {
  const out: string[] = [];
  const walk = (n: AnyNode): void => {
    if (!isElement(n)) return;
    const id = attr(n, 'id');
    if (id) out.push(id);
    for (const child of (n.children ?? []) as AnyNode[]) walk(child);
  };
  walk(node);
  return out;
}

function unique(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Sentence-final punctuation. A semicolon is deliberately absent: a line ending
 * in one is mid-sentence, and treating it as final cut a sidebar in half.
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
 * Books converted from scans emit one `<p>` per line of the original page,
 * which is faithful markup and unreadable prose. Ending without sentence
 * punctuation is not enough: display titles end that way too, and swallowing
 * one destroys the chapter's name. A join also needs positive evidence of
 * continuation, and it never crosses a display line in either direction.
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
      !isDisplayLine(block.text) &&
      !TERMINAL.test(prev.text);

    const continues =
      structurallyJoinable &&
      (/^[a-z]/.test(block.text) ||
        DANGLING.test(prev!.text) ||
        FUNCTION_WORDS.has(lastWord(prev!.text)));

    if (continues && prev) {
      prev.text = `${prev.text} ${block.text}`;
      prev.html = `${prev.html} ${block.html}`;
      prev.ids.push(...block.ids);
      if (block.noterefs?.length) prev.noterefs = [...(prev.noterefs ?? []), ...block.noterefs];
    } else {
      out.push(block);
    }
  }
  return out;
}

/** The marker a note body repeats ("1." or "*") — the Markdown footnote supplies its own. */
function stripNoteMarker(text: string): string {
  // A star, or a number with its own punctuation ("1.", "12)"), is the marker
  // the footnote repeats. So is "1 Measured", where the number introduces a
  // capitalised sentence. A number that continues in words ("12 men remained")
  // is the note itself, and stripping it deletes what the author wrote.
  return text.replace(
    /^\s*(?:[*\u2020\u2021\u00a7]+|\d{1,3}[.)]|\d{1,3}(?=\s+[A-Z]))\s+/,
    '',
  ).trim();
}

function isFootnote(el: Element): boolean {
  const tokens = typeTokens(el);
  if (tokens.some((token) => token.includes('noteref'))) return false;
  return tokens.some((token) => NOTE_TYPES.has(token));
}

function isNoteGroup(el: Element): boolean {
  return typeTokens(el).some((token) => NOTE_GROUPS.has(token));
}

function collectNoterefs(el: Element, path: string): NoteRef[] {
  const out: NoteRef[] = [];
  const anchors = el.name.toLowerCase() === 'a' ? [el, ...findAll(el, 'a').slice(1)] : findAll(el, 'a');
  for (const anchor of anchors) {
    if (!typeTokens(anchor).some((token) => token.includes('noteref'))) continue;
    const href = attr(anchor, 'href');
    if (!href) continue;
    const located = resolveHref(path, href);
    out.push({
      label: textOf(anchor) || '*',
      key: located.fragment ? `${located.path}#${located.fragment}` : located.path,
    });
  }
  return out;
}

function noteTargetsIn(doc: Document | Element, docPath: string): Set<string> {
  const ids = new Set<string>();
  for (const anchor of findAll(doc, 'a')) {
    if (!typeTokens(anchor).some((token) => token.includes('noteref'))) continue;
    const href = attr(anchor, 'href');
    if (!href) continue;
    const located = resolveHref(docPath, href);
    if (located.fragment && located.path === docPath) ids.add(located.fragment);
  }
  return ids;
}

function hasBlockDescendant(el: Element): boolean {
  for (const child of (el.children ?? []) as AnyNode[]) {
    if (!isElement(child)) continue;
    const tag = child.name.toLowerCase();
    if (tag === 'script' || tag === 'style') continue;
    if (BLOCK_TAGS.has(tag)) return true;
    if (hasBlockDescendant(child)) return true;
  }
  return false;
}

interface NoteHit {
  key: string;
  text: string;
}

function blockFrom(
  spineIndex: number,
  path: string,
  ids: string[],
  tag: string,
  text: string,
  html: string,
  image: { src?: string; alt?: string },
  noterefs: NoteRef[],
): Block | undefined {
  if (!text && !ids.length && !image.src) return undefined;
  const headingMatch = /^h([1-6])$/.exec(tag);
  return {
    spineIndex,
    path,
    ids,
    tag,
    heading: headingMatch ? Number(headingMatch[1]) : 0,
    text,
    html,
    ...(image.src !== undefined ? { image: image.src } : {}),
    ...(image.alt ? { alt: image.alt } : {}),
    ...(noterefs.length ? { noterefs } : {}),
  };
}

/** Every figure in document order. A paragraph can hold more than one. */
function imagesIn(nodes: AnyNode[], base: string): { src: string; alt?: string }[] {
  const found = nodes.flatMap((node) => (
    isElement(node) ? [node, ...findAll(node, 'img'), ...findAll(node, 'image')] : []
  ));
  const out: { src: string; alt?: string }[] = [];
  const seen = new Set<Element>();
  for (const el of found) {
    const name = el.name.toLowerCase();
    if ((name !== 'img' && name !== 'image') || seen.has(el)) continue;
    seen.add(el);
    const src = attr(el, 'src') ?? attr(el, 'href');
    if (!src) continue;
    const alt = attr(el, 'alt');
    out.push({
      src: resolveHref(base, src).path,
      ...(alt ? { alt } : {}),
    });
  }
  return out;
}

/**
 * A paragraph inside a list item or a quotation is still that item or quote.
 * Emitting the inner `<p>` as a paragraph dropped the list and the quote.
 */
function inheritedTag(tag: string, inherited: string | undefined): string {
  if (inherited && (tag === 'p' || tag === 'div')) return inherited;
  return tag;
}

/**
 * Emit one Block per leaf block-level element, in document order.
 *
 * An id on a wrapper, on `<body>`, or on an inline anchor with no text of its
 * own is carried onto the next real block. An id inside the block is kept on
 * that block — contents entries point at `<span id>` inside a paragraph often
 * enough that ignoring it loses the mid-file cut.
 *
 * Footnotes are returned separately and never become blocks. A note left in the
 * flow shows up as a paragraph of its own, then again under the marker.
 */
function collectBlocks(
  source: string,
  path: string,
  spineIndex: number,
): { blocks: Block[]; notes: NoteHit[] } {
  const doc = parseHtml(source);
  const targets = noteTargetsIn(doc, path);
  const blocks: Block[] = [];
  const notes: NoteHit[] = [];
  let pendingIds: string[] = [];
  const body = findFirst(doc, 'body');

  const takePending = (): string[] => {
    const ids = pendingIds;
    pendingIds = [];
    return ids;
  };

  const swallow = (el: Element): void => {
    // Ancestor ids stay pending. Swallowing them would steal a chapter anchor
    // that happens to sit on a wrapper above the footnote.
    const text = textOf(el);
    if (!text) return;
    for (const id of unique(idsIn(el))) notes.push({ key: `${path}#${id}`, text });
  };

  const isNote = (el: Element): boolean =>
    isFootnote(el) || (attr(el, 'id') !== undefined && targets.has(attr(el, 'id')!));

  const emitExtras = (images: { src: string; alt?: string }[]): void => {
    // A block carries one image. Further figures in the same paragraph used
    // to vanish, so a page with two charts exported the first and lost the rest.
    for (const extra of images.slice(1)) {
      const more = blockFrom(spineIndex, path, [], 'figure', '', '', extra, []);
      if (more) blocks.push(more);
    }
  };

  const emitElement = (el: Element, tag: string): void => {
    const text = textOf(el);
    const images = imagesIn([el], path);
    const image: { src?: string; alt?: string } = images[0] ?? {};
    // An empty paragraph is an anchor, not a blank line. Emitting it would sit
    // between two wrapped lines and stop them being joined back into a sentence.
    if (!text && !image.src) {
      pendingIds.push(...idsIn(el));
      return;
    }
    const block = blockFrom(
      spineIndex,
      path,
      unique([...takePending(), ...idsIn(el)]),
      tag,
      text,
      serializeNodes((el.children ?? []) as AnyNode[]),
      image,
      collectNoterefs(el, path),
    );
    if (block) blocks.push(block);
    emitExtras(images);
  };

  const emitInline = (nodes: AnyNode[], tag = 'p'): void => {
    if (!nodes.length) return;
    const text = textOf(nodes);
    const images = imagesIn(nodes, path);
    const image: { src?: string; alt?: string } = images[0] ?? {};
    const ownIds = nodes.flatMap((node) => idsIn(node));
    // A run of whitespace between two paragraphs must not swallow the id of an
    // anchor that belongs to the next paragraph.
    if (!text && !image.src) {
      pendingIds.push(...ownIds);
      return;
    }
    const noterefs = nodes.flatMap((node) => (isElement(node) ? collectNoterefs(node, path) : []));
    const block = blockFrom(
      spineIndex,
      path,
      unique([...takePending(), ...ownIds]),
      tag,
      text,
      serializeNodes(nodes),
      image,
      noterefs,
    );
    if (block) blocks.push(block);
    emitExtras(images);
  };

  const walk = (node: Element, inherited?: string): void => {
    let inline: AnyNode[] = [];
    const flush = (): void => {
      const nodes = inline;
      inline = [];
      // A sentence written beside a child block is its own block. Inside a
      // list or a quotation it stays one, rather than becoming a paragraph.
      emitInline(nodes, inherited ?? 'p');
    };
    for (const child of (node.children ?? []) as AnyNode[]) {
      if (child.type === 'text') {
        inline.push(child);
        continue;
      }
      if (!isElement(child)) continue;
      const tag = child.name.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'head') continue;

      if (isNote(child)) {
        flush();
        swallow(child);
        continue;
      }
      if (isNoteGroup(child)) {
        flush();
        walk(child, inherited);
        continue;
      }
      if (tag === 'img' || tag === 'image') {
        flush();
        emitElement(child, 'figure');
        continue;
      }
      if (BLOCK_TAGS.has(tag) && !hasBlockDescendant(child)) {
        flush();
        emitElement(child, inheritedTag(tag, inherited));
        continue;
      }
      if (BLOCK_TAGS.has(tag) || hasBlockDescendant(child)) {
        flush();
        const id = attr(child, 'id');
        if (id) pendingIds.push(id);
        const next = tag === 'blockquote' || tag === 'li' ? tag : inherited;
        walk(child, next);
        continue;
      }
      // An empty <a id> is how publishers mark a chapter start. It is not a
      // paragraph, and emitting one would put the cut on a blank block.
      if (!textOf(child) && imagesIn([child], path).length === 0) {
        pendingIds.push(...idsIn(child));
        continue;
      }
      inline.push(child);
    }
    flush();
  };

  if (body) {
    const bodyId = attr(body, 'id');
    if (bodyId) pendingIds.push(bodyId);
    walk(body);
  } else {
    // No <body>: walk the document's children. `walk` only reads `children`.
    walk(doc as unknown as Element);
  }

  if (pendingIds.length && blocks.length) {
    const last = blocks[blocks.length - 1]!;
    if (last.path === path) last.ids.push(...pendingIds);
  }
  return { blocks, notes };
}
