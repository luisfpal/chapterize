import { strToU8, zipSync } from 'fflate';
import { must } from '../src/must.js';

/**
 * Build an EPUB in memory from original text.
 *
 * The bytes are a real zip with a real package document, so the parser cannot
 * tell them from a book. Nothing in here is taken from a published book.
 */

export interface TocItem {
  label: string;
  href: string;
  children?: TocItem[];
}

export interface ChapterFile {
  /** Zip path, e.g. "OEBPS/ch1.xhtml". */
  href: string;
  /** Inner HTML of `<body>`. Ignored when `rawBytes` is set. */
  body: string;
  /** Id on `<body>`, which is where some converters anchor a chapter. */
  bodyId?: string;
  linear?: boolean;
  mediaType?: string;
  /** Write the spine entry but not the file, so the archive is incomplete. */
  omit?: boolean;
  rawBytes?: Uint8Array;
  /** Byte encoding of the generated document. */
  encoding?: 'utf-8' | 'windows-1252';
  /**
   * Value of the XML encoding declaration. Defaults to `encoding`.
   * `''` omits the declaration, which is how old files hide that they are
   * Windows-1252.
   */
  declare?: string;
}

export interface BuildEpubOptions {
  title?: string;
  author?: string;
  language?: string;
  version?: '2.0' | '3.0';
  chapters?: ChapterFile[];
  toc?: TocItem[];
  /**
   * Defaults from `version` when `toc` is set (nav for 3.0, ncx for 2.0),
   * and to nav when `navBody` is set. Otherwise none.
   */
  tocKind?: 'nav' | 'ncx' | 'both' | 'none';
  /** When set, the NCX carries these entries instead of `toc`. */
  ncxToc?: TocItem[];
  pageList?: { label: string; href: string }[];
  /** navPoints parked in the NCX pageList. A correct reader ignores them. */
  ncxPageTargets?: number;
  /** Default true. False omits `properties="nav"`. */
  navProperties?: boolean;
  /** Default true. False omits `spine toc="ncx"`. */
  ncxOnSpine?: boolean;
  navInSpine?: boolean;
  /**
   * Replace the generated nav body. The file is still a nav document, and
   * passing this emits one even when `toc` is omitted — a custom body that
   * silently produced no nav made fragment-only links untestable.
   */
  navBody?: string;
  /** `opf:` / `dc:` prefixes, which real package documents use inconsistently. */
  prefixed?: boolean;
  /** Spine href order. Default is the chapter array order. */
  spineOrder?: string[];
  files?: Record<string, Uint8Array>;
  encryption?: 'content' | 'font' | 'adobe';
  container?: 'ok' | 'missing' | 'no-rootfile';
  /** An itemref whose id is not in the manifest. */
  brokenSpineId?: string;
}

const OPF = 'OEBPS/content.opf';
const NAV = 'OEBPS/nav.xhtml';
const NCX = 'OEBPS/toc.ncx';

/** Windows-1252 bytes for the characters this suite actually uses. */
const CP1252: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

function encode1252(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = must(ch.codePointAt(0), 'ch.codePointAt(0)');
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) bytes.push(cp);
    else {
      const mapped = CP1252[cp];
      if (mapped === undefined)
        throw new Error(`Cannot encode U+${cp.toString(16)} as windows-1252`);
      bytes.push(mapped);
    }
  }
  return Uint8Array.from(bytes);
}

function rel(fromFile: string, toFile: string): string {
  const from = fromFile.split('/').slice(0, -1);
  const to = toFile.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
  return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function chapterDoc(ch: ChapterFile): string {
  const encoding = ch.encoding ?? 'utf-8';
  const declared = ch.declare !== undefined ? ch.declare : encoding;
  const decl = declared === '' ? '' : `<?xml version="1.0" encoding="${esc(declared)}"?>\n`;
  const bodyId = ch.bodyId ? ` id="${esc(ch.bodyId)}"` : '';
  return `${decl}<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(ch.href)}</title></head><body${bodyId}>\n${ch.body}\n</body></html>`;
}

function chapterBytes(ch: ChapterFile): Uint8Array {
  if (ch.rawBytes) return ch.rawBytes;
  const text = chapterDoc(ch);
  return ch.encoding === 'windows-1252' ? encode1252(text) : strToU8(text);
}

function tocOl(items: TocItem[]): string {
  const lis = items.map((item) => {
    const nested = item.children?.length ? tocOl(item.children) : '';
    return `<li><a href="${esc(item.href)}">${esc(item.label)}</a>${nested}</li>`;
  });
  return `<ol>${lis.join('')}</ol>`;
}

function navDocument(toc: TocItem[], options: BuildEpubOptions): string {
  if (options.navBody !== undefined) {
    return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>
${options.navBody}
</body></html>`;
  }
  const pages = (options.pageList ?? [])
    .map((p) => `<li><a href="${esc(p.href)}">${esc(p.label)}</a></li>`)
    .join('');
  const pageNav = pages ? `<nav epub:type="page-list"><ol>${pages}</ol></nav>` : '';
  const landmarks = `<nav epub:type="landmarks"><ol><li><a href="${esc(toc[0]?.href ?? '')}">Start</a></li></ol></nav>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body>
${pageNav}
<nav epub:type="toc" id="toc">${tocOl(toc)}</nav>
${landmarks}
</body></html>`;
}

function ncxPoints(items: TocItem[], start: { n: number }): string {
  return items
    .map((item) => {
      const id = start.n++;
      const nested = item.children?.length ? ncxPoints(item.children, start) : '';
      return `<navPoint id="np${id}" playOrder="${id}"><navLabel><text>${esc(item.label)}</text></navLabel><content src="${esc(item.href)}"/>${nested}</navPoint>`;
    })
    .join('');
}

function ncxDocument(toc: TocItem[], options: BuildEpubOptions): string {
  const counter = { n: 1 };
  const pages = Array.from(
    { length: options.ncxPageTargets ?? 0 },
    (_, i) =>
      `<navPoint id="pg${i}"><navLabel><text>Page ${i + 1}</text></navLabel><content src="${esc(toc[0]?.href ?? 'ch.xhtml')}#page${i}"/></navPoint>`,
  ).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${ncxPoints(toc, counter)}</navMap><pageList>${pages}</pageList></ncx>`;
}

function manifestItem(id: string, href: string, media: string, properties = ''): string {
  const prop = properties ? ` properties="${properties}"` : '';
  return `<item id="${id}" href="${esc(href)}" media-type="${media}"${prop}/>`;
}

export function buildEpub(options: BuildEpubOptions = {}): Uint8Array {
  const version = options.version ?? '3.0';
  const chapters = options.chapters ?? [];
  const tocKind =
    options.tocKind ??
    (options.navBody !== undefined
      ? 'nav'
      : options.toc
        ? version === '3.0'
          ? 'nav'
          : 'ncx'
        : 'none');
  const toc = options.toc ?? [];
  const ncxToc = options.ncxToc ?? toc;
  const wantNav = tocKind === 'nav' || tocKind === 'both';
  const wantNcx = tocKind === 'ncx' || tocKind === 'both';
  const navProperties = options.navProperties !== false;
  const ncxOnSpine = options.ncxOnSpine !== false;
  const prefixed = options.prefixed === true;

  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
  };
  if ((options.container ?? 'ok') === 'ok') {
    files[CONTAINER_PATH] = strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${OPF}" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    );
  } else if (options.container === 'no-rootfile') {
    files[CONTAINER_PATH] = strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles></rootfiles></container>`,
    );
  }

  const manifest: string[] = [];
  const spine: string[] = [];
  chapters.forEach((ch, i) => {
    const id = `c${i}`;
    manifest.push(manifestItem(id, rel(OPF, ch.href), ch.mediaType ?? 'application/xhtml+xml'));
    if (!ch.omit) files[ch.href] = chapterBytes(ch);
  });
  if (wantNav) {
    manifest.push(
      manifestItem('nav', rel(OPF, NAV), 'application/xhtml+xml', navProperties ? 'nav' : ''),
    );
    files[NAV] = strToU8(navDocument(toc, options));
  }
  if (wantNcx) {
    manifest.push(manifestItem('ncx', rel(OPF, NCX), 'application/x-dtbncx+xml'));
    files[NCX] = strToU8(ncxDocument(ncxToc, options));
  }
  for (const [path, bytes] of Object.entries(options.files ?? {})) files[path] = bytes;

  const order = options.spineOrder ?? chapters.map((ch) => ch.href);
  for (const href of order) {
    const index = chapters.findIndex((ch) => ch.href === href);
    if (index < 0) throw new Error(`spineOrder names "${href}", which is not a chapter`);
    const ch = must(chapters[index], 'chapters[index]');
    const linear = ch.linear === false ? ' linear="no"' : '';
    spine.push(`<itemref idref="c${index}"${linear}/>`);
  }
  if (options.navInSpine && wantNav) spine.unshift(`<itemref idref="nav"/>`);
  if (options.brokenSpineId) spine.push(`<itemref idref="${esc(options.brokenSpineId)}"/>`);

  const tocAttr = wantNcx && ncxOnSpine ? ' toc="ncx"' : '';
  const title = options.title ?? 'Untitled';
  const author = options.author ? `<dc:creator>${esc(options.author)}</dc:creator>` : '';
  const language = options.language ?? 'en';
  const metadata = `<dc:identifier id="uid">urn:uuid:chapterize-test</dc:identifier><dc:title>${esc(title)}</dc:title>${author}<dc:language>${esc(language)}</dc:language>`;
  const manifestXml = prefixed
    ? manifest.map((item) => item.replace('<item ', '<opf:item ')).join('')
    : manifest.join('');
  const spineXml = prefixed
    ? spine.map((ref) => ref.replace('<itemref ', '<opf:itemref ')).join('')
    : spine.join('');
  // Prefixed and unprefixed trees carry the same information. Real books use both.
  const opf = prefixed
    ? `<?xml version="1.0" encoding="utf-8"?><opf:package version="${version}" unique-identifier="uid" xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><opf:metadata>${metadata}</opf:metadata><opf:manifest>${manifestXml}</opf:manifest><opf:spine${tocAttr}>${spineXml}</opf:spine></opf:package>`
    : `<?xml version="1.0" encoding="utf-8"?><package version="${version}" unique-identifier="uid" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${metadata}</metadata><manifest>${manifestXml}</manifest><spine${tocAttr}>${spineXml}</spine></package>`;
  files[OPF] = strToU8(opf);

  if (options.encryption) {
    const target =
      options.encryption === 'font'
        ? 'OEBPS/fonts/text.otf'
        : (chapters[0]?.href ?? 'OEBPS/ch1.xhtml');
    const adept = options.encryption === 'adobe' ? ' xmlns:adept="http://ns.adobe.com/adept"' : '';
    files['META-INF/encryption.xml'] = strToU8(
      `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"${adept}><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="${esc(target)}"/></CipherData></EncryptedData></encryption>`,
    );
  }

  return zipSync(files);
}

const CONTAINER_PATH = 'META-INF/container.xml';
