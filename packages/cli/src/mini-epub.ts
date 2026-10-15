import { strToU8, zipSync } from 'fflate';
import { slugify } from '@chapterize/core';
import type { Book, Chapter } from '@chapterize/core';
import { escapeHtml, renderBody } from './html.js';
import { contentType } from './media.js';

const STYLE = [
  'img { max-width: 100%; height: auto; }',
  'body { line-height: 1.5; }',
  'blockquote { margin-left: 0; padding-left: 1em; border-left: 2px solid #b4541f; }',
  '',
].join('\n');

/**
 * A stable id so opening the same chapter in Books again is the same book,
 * not a second copy. This is a name, not a secret.
 */
function chapterId(book: Book, chapter: Chapter): string {
  const author = book.metadata.author ?? 'none';
  return `urn:chapterize:${slugify(book.metadata.title)}:${slugify(author)}:${chapter.index}:${slugify(chapter.title)}`;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * One chapter as an EPUB 3 file Apple Books will open.
 *
 * The mimetype entry has to be first and stored, with no extra field. A
 * compressed mimetype is the usual reason Books says the file is unreadable.
 */
export function chapterEpub(
  book: Book,
  chapter: Chapter,
  names: Map<string, string>,
  boilerplate: Set<string>,
  now = new Date(),
): Uint8Array {
  const blocks = book.blocks.slice(chapter.start, chapter.end);
  const images: { name: string; bytes: Uint8Array }[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (!block.image) continue;
    const name = names.get(block.image);
    const bytes = book.images.get(block.image);
    if (!name || !bytes || seen.has(name)) continue;
    seen.add(name);
    images.push({ name, bytes });
  }

  const rendered = renderBody({
    blocks,
    notes: book.notes,
    imageSrc: (imagePath) => {
      const name = names.get(imagePath);
      return name && book.images.has(imagePath) ? `images/${name}` : null;
    },
    chapterTitle: chapter.title,
    bookTitle: book.metadata.title,
    boilerplate,
  });

  const lang = book.metadata.language ?? 'en';
  const label = chapter.title.includes(book.metadata.title)
    ? chapter.title
    : `${chapter.title} — ${book.metadata.title}`;
  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeHtml(lang)}" xml:lang="${escapeHtml(lang)}">
<head>
<title>${escapeHtml(label)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
<h1>${escapeHtml(chapter.title)}</h1>
${rendered.body}
${rendered.notesHtml}
</body>
</html>
`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeHtml(lang)}" xml:lang="${escapeHtml(lang)}">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc">
<ol><li><a href="chapter.xhtml">${escapeHtml(chapter.title)}</a></li></ol>
</nav>
</body>
</html>
`;
  const imageItems = images.map((image, i) =>
    `<item id="img-${i}" href="images/${escapeHtml(image.name)}" media-type="${contentType(image.name)}"/>`,
  ).join('\n    ');
  const creator = book.metadata.author
    ? `\n    <dc:creator>${escapeHtml(book.metadata.author)}</dc:creator>`
    : '';
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${escapeHtml(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${escapeHtml(chapterId(book, chapter))}</dc:identifier>
    <dc:title>${escapeHtml(label)}</dc:title>${creator}
    <dc:language>${escapeHtml(lang)}</dc:language>
    <meta property="dcterms:modified">${stamp(now)}</meta>
  </metadata>
  <manifest>
    <item id="chap" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${imageItems}
  </manifest>
  <spine>
    <itemref idref="chap"/>
  </spine>
</package>
`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

  // Insertion order is the zip order. mimetype must stay first.
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/style.css': strToU8(STYLE),
    'OEBPS/chapter.xhtml': strToU8(xhtml),
  };
  for (const image of images) entries[`OEBPS/images/${image.name}`] = image.bytes;
  return zipSync(entries);
}

const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A name that can sit in a URL, an OPF href, and a filesystem path unchanged.
 * The original basename is kept when it already qualifies — cover.png stays
 * cover.png — because that is the name a person sees in the folder.
 */
function safeImageBasename(imagePath: string): string {
  // The basename, not the core export name. Core keeps the directory in the
  // name so two charts cannot overwrite each other. This pass prefers the
  // name a person sees, and imageFileNames disambiguates when two basenames match.
  const base = imagePath.split('/').pop() || imagePath;
  if (SAFE_IMAGE.test(base) && !base.includes('..')) return base;
  const extMatch = /\.(png|jpe?g|gif|svg|webp)$/i.exec(base);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  const stem = (ext ? base.slice(0, base.length - extMatch![0].length) : base)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${stem || 'image'}${ext}`;
}

/** Basename collision: two figures named cover.png must not overwrite each other. */
export function imageFileNames(paths: Iterable<string>): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const imagePath of paths) {
    let name = safeImageBasename(imagePath);
    if (used.has(name)) {
      const slug = imagePath
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
      const candidate = slug && SAFE_IMAGE.test(slug) && !slug.includes('..') && !used.has(slug) ? slug : '';
      // used.size does not change inside this loop. Counting from it would
      // spin forever once image-N was already taken.
      let n = used.size;
      name = candidate || `image-${n}${ext}`;
      while (used.has(name)) name = `image-${++n}${ext}`;
    }
    used.add(name);
    out.set(imagePath, name);
  }
  return out;
}

