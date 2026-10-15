/**
 * Tiny original EPUBs for the pipeline tests.
 *
 * These are not a substitute for a real shelf. They exist to pin failure
 * modes the parser already got wrong on books we could read: a page-list
 * nav, an id sitting inside a heading, a footnote on a wrapped line, a
 * sentence beside an image. The text is invented. Nothing here is from a
 * published book.
 *
 *   node packages/core/test/fixtures/build-epub.ts
 *
 * writes them under test/fixtures/out/ so a reader can open one. vite-node
 * does not put the script on argv, so that command writes nothing. The tests
 * call the same builders, so the files on disk cannot drift from the suite.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

/** Enough prose that a stub-merge cannot swallow a real chapter. */
export const TIDE =
  'The harbor kept its own clock, and the tide was the only schedule the crew agreed to follow.';

export function long(seed: string, min = 280): string {
  let out = seed.trim();
  while (out.length < min) out = `${out} ${TIDE}`;
  return out;
}

export function epubZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    // The mimetype has to be stored, not deflated, or a strict reader rejects it.
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  };
  for (const [name, body] of Object.entries(files)) {
    entries[name] = typeof body === 'string' ? strToU8(body) : body;
  }
  return zipSync(entries);
}

function xhtml(body: string, attrs = ''): string {
  return `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml" ${attrs}>
  <head><title>Harbor</title></head>
  <body>${body}</body>
</html>`;
}

interface Doc {
  id: string;
  href: string;
  html: string;
  linear?: boolean;
  properties?: string;
}

function pack(opts: {
  title: string;
  author?: string;
  version?: '2.0' | '3.0';
  docs: Doc[];
  ncx?: { id: string; href: string; xml: string };
  extras?: Record<string, string | Uint8Array>;
}): Uint8Array {
  const version = opts.version ?? '3.0';
  const manifest = [
    ...opts.docs.map((doc) =>
      `<item id="${doc.id}" href="${doc.href}" media-type="application/xhtml+xml"${
        doc.properties ? ` properties="${doc.properties}"` : ''}/>`),
    ...(opts.ncx
      ? [`<item id="${opts.ncx.id}" href="${opts.ncx.href}" media-type="application/x-dtbncx+xml"/>`]
      : []),
    ...Object.keys(opts.extras ?? {})
      .filter((path) => path.endsWith('.png'))
      .map((path, i) => `<item id="img${i}" href="${path.replace(/^OEBPS\//, '')}" media-type="image/png"/>`),
  ].join('\n    ');
  const spine = opts.docs
    .filter((doc) => !doc.properties?.split(/\s+/).includes('nav'))
    .map((doc) => `<itemref idref="${doc.id}"${doc.linear === false ? ' linear="no"' : ''}/>`)
    .join('\n    ');
  const opf = `<?xml version="1.0"?>
<package version="${version}" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${opts.title}</dc:title>
    <dc:creator>${opts.author ?? 'N. Harbor'}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine${opts.ncx ? ` toc="${opts.ncx.id}"` : ''}>
    ${spine}
  </spine>
</package>`;
  const files: Record<string, string | Uint8Array> = {
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
  };
  for (const doc of opts.docs) files[`OEBPS/${doc.href}`] = doc.html;
  if (opts.ncx) files[`OEBPS/${opts.ncx.href}`] = opts.ncx.xml;
  for (const [path, body] of Object.entries(opts.extras ?? {})) files[path] = body;
  return epubZip(files);
}

/** One file, two chapters, ids inside the headings, a page-list written first. */
export function harborBook(): Uint8Array {
  const story = xhtml(`
    <h1><a id="salt"></a>Salt</h1>
    <p>NEVER TRUST A</p>
    <p>QUIET HARBOR</p>
    <p>The rope held</p>
    <p>fast<a epub:type="noteref" href="notes.xhtml#n1">*</a> against the</p>
    <p>wind, and the</p>
    <p>crew slept.</p>
    <p>${long('Tom &amp; Jerry sailed at dusk.')}</p>
    <h1><span id="iron"></span>Iron</h1>
    <blockquote><p>A harbor is a <em>promise</em> the sea keeps breaking.</p></blockquote>
    <ul>
      <li><p>Coil the rope.</p></li>
      <li><p>Count the <strong>oars</strong>.</p></li>
    </ul>
    <p>Hello<br/>harbor and see the chart <img src="img/chart.png" alt="Depth chart"/> before sailing.</p>
    <div>
      The loose sentence belongs in the chapter.
      <p>${long('The marked paragraph follows it exactly.')}</p>
    </div>
  `, 'xmlns:epub="http://www.idpf.org/2007/ops"');
  const notes = xhtml(`
    <p id="n1">* Measured at dawn.</p>
  `);
  const nav = xhtml(`
    <nav epub:type="page-list">
      <ol>
        <li><a href="story.xhtml#p1">1</a></li>
        <li><a href="story.xhtml#p2">2</a></li>
        <li><a href="story.xhtml#p3">3</a></li>
      </ol>
    </nav>
    <nav epub:type="toc">
      <ol>
        <li><a href="story.xhtml#salt">Salt</a></li>
        <li><a href="story.xhtml#iron">Iron</a></li>
      </ol>
    </nav>
  `, 'xmlns:epub="http://www.idpf.org/2007/ops"');
  return pack({
    title: 'Harbor Notes',
    docs: [
      { id: 'nav', href: 'nav.xhtml', html: nav, properties: 'nav' },
      { id: 'story', href: 'story.xhtml', html: story },
      { id: 'notes', href: 'notes.xhtml', html: notes, linear: false },
    ],
    extras: { 'OEBPS/img/chart.png': new Uint8Array([137, 80, 78, 71, 1]) },
  });
}

/** A page-list and nothing else must not become the table of contents. */
export function pageListOnlyBook(): Uint8Array {
  const story = xhtml(`
    <h1 id="salt">Salt</h1>
    <p>${long('Salt sits in the timbers.')}</p>
    <h1 id="iron">Iron</h1>
    <p>${long('Iron remembers the hinge.')}</p>
  `);
  const nav = xhtml(`
    <nav epub:type="page-list" id="pages">
      <ol>
        <li><a href="story.xhtml#p1">1</a></li>
        <li><a href="story.xhtml#p2">2</a></li>
      </ol>
    </nav>
  `, 'xmlns:epub="http://www.idpf.org/2007/ops"');
  return pack({
    title: 'Pages Without Contents',
    docs: [
      { id: 'nav', href: 'nav.xhtml', html: nav, properties: 'nav' },
      { id: 'story', href: 'story.xhtml', html: story },
    ],
  });
}

/**
 * The real contents nav has no epub:type, and the page-list is written first.
 * Taking "the first nav" reads the page numbers and ignores the chapters.
 */
export function tocAfterPageList(kind: 'unlabeled' | 'role'): Uint8Array {
  const story = xhtml(`
    <h1 id="salt">Salt</h1>
    <p>${long('Salt crusts the rope.')}</p>
    <h1 id="iron">Iron</h1>
    <p>${long('Iron holds the gate.')}</p>
  `);
  const tocAttrs = kind === 'role' ? 'role="doc-toc"' : 'id="toc"';
  const nav = xhtml(`
    <nav epub:type="page-list">
      <ol>
        <li><a href="story.xhtml#p1">1</a></li>
        <li><a href="story.xhtml#p2">2</a></li>
        <li><a href="story.xhtml#p3">3</a></li>
      </ol>
    </nav>
    <nav ${tocAttrs}>
      <ol>
        <li><a href="story.xhtml#salt">Salt</a></li>
        <li><a href="story.xhtml#iron">Iron</a></li>
      </ol>
    </nav>
  `, 'xmlns:epub="http://www.idpf.org/2007/ops"');
  return pack({
    title: 'Contents After the Page List',
    docs: [
      { id: 'nav', href: 'nav.xhtml', html: nav, properties: 'nav' },
      { id: 'story', href: 'story.xhtml', html: story },
    ],
  });
}

/** The `<ol>` is wrapped. The entries are still the contents. */
export function wrappedNavBook(): Uint8Array {
  const salt = xhtml(`<h1>Salt</h1><p>${long('A barrel of salt.')}</p>`);
  const iron = xhtml(`<h1>Iron</h1><p>${long('A barrel of nails.')}</p>`);
  const nav = xhtml(`
    <nav epub:type="toc">
      <div>
        <ol>
          <li><a href="salt.xhtml">Salt</a></li>
          <li><a href="iron.xhtml">Iron</a></li>
        </ol>
      </div>
    </nav>
  `, 'xmlns:epub="http://www.idpf.org/2007/ops"');
  return pack({
    title: 'Wrapped Contents',
    docs: [
      { id: 'nav', href: 'nav.xhtml', html: nav, properties: 'nav' },
      { id: 'salt', href: 'salt.xhtml', html: salt },
      { id: 'iron', href: 'iron.xhtml', html: iron },
    ],
  });
}

/** One fragment points nowhere. The chapter that does resolve must still land. */
export function missingFragmentBook(): Uint8Array {
  const story = xhtml(`
    <p>${long('This page is only a cover.')}</p>
    <h1 id="salt">Salt</h1>
    <p>${long('The real chapter starts here.')}</p>
  `);
  const nav = xhtml(`
    <nav epub:type="toc">
      <ol>
        <li><a href="story.xhtml#missing">Missing</a></li>
        <li><a href="story.xhtml#salt">Salt</a></li>
      </ol>
    </nav>
  `, 'xmlns:epub="http://www.idpf.org/2007/ops"');
  return pack({
    title: 'A Broken Link',
    docs: [
      { id: 'nav', href: 'nav.xhtml', html: nav, properties: 'nav' },
      { id: 'story', href: 'story.xhtml', html: story },
    ],
  });
}

/** No nav at all, and each chapter is only a heading plus a paragraph. */
export function shortHeadingBook(): Uint8Array {
  const story = xhtml(`
    <h1>Salt</h1>
    <p>Salt in the cut.</p>
    <h1>Iron</h1>
    <p>Iron on the hinge.</p>
  `);
  return pack({
    title: 'A Pamphlet',
    docs: [{ id: 'story', href: 'story.xhtml', html: story }],
  });
}

/** A number at the start of a note is the note, not a marker to peel off. */
export function numberedNoteBook(): Uint8Array {
  const story = xhtml(`<h1>Salt</h1><p>${long('See the note.')}</p>`);
  const notes = xhtml(`
    <p id="n1">* Measured at dawn.</p>
    <p id="n2">12 men remained on the wall.</p>
    <p id="n3">1. The tide turned after all.</p>
  `);
  return pack({
    title: 'Notes',
    docs: [
      { id: 'story', href: 'story.xhtml', html: story },
      { id: 'notes', href: 'notes.xhtml', html: notes, linear: false },
    ],
  });
}

/** Two figures share a basename and live in different folders. */
export function duplicateImageBook(): Uint8Array {
  const story = xhtml(`
    <h1>Plates</h1>
    <p>First mark <img src="a/mark.png" alt="One"/>.</p>
    <p>Second mark <img src="b/mark.png" alt="Two"/>.</p>
    <p>${long('The plates sit at the back.')}</p>
  `);
  return pack({
    title: 'Two Marks',
    docs: [{ id: 'story', href: 'story.xhtml', html: story }],
    extras: {
      'OEBPS/a/mark.png': new Uint8Array([1, 2, 3]),
      'OEBPS/b/mark.png': new Uint8Array([4, 5, 6]),
    },
  });
}

/** Two charts in one paragraph. The second used to be dropped. */
export function pairedFigureBook(): Uint8Array {
  const story = xhtml(`
    <h1>Charts</h1>
    <p>See <img src="img/tide.png" alt="Tide"/> and <img src="img/depth.png" alt="Depth"/> before sailing.</p>
    <p>${long('Both charts belong on the page.')}</p>
  `);
  return pack({
    title: 'Two Charts',
    docs: [{ id: 'story', href: 'story.xhtml', html: story }],
    extras: {
      'OEBPS/img/tide.png': new Uint8Array([1]),
      'OEBPS/img/depth.png': new Uint8Array([2]),
    },
  });
}

/** "Chapter 1" is an enumerator. "Iron" is already a title. */
export function enumeratorBook(): Uint8Array {
  const story = xhtml(`
    <h1 id="c1">Chapter 1</h1>
    <p>NEVER TRUST A</p>
    <p>QUIET HARBOR</p>
    <p>${long('The name of the chapter was split across the lines above.')}</p>
    <h1 id="c2">Iron</h1>
    <p>${long('This label is already the title, and it must not grow a suffix.')}</p>
  `);
  const nav = xhtml(`
    <nav epub:type="toc">
      <ol>
        <li><a href="story.xhtml#c1">Chapter 1</a></li>
        <li><a href="story.xhtml#c2">Iron</a></li>
      </ol>
    </nav>
  `, 'xmlns:epub="http://www.idpf.org/2007/ops"');
  return pack({
    title: 'Enumerated',
    docs: [
      { id: 'nav', href: 'nav.xhtml', html: nav, properties: 'nav' },
      { id: 'story', href: 'story.xhtml', html: story },
    ],
  });
}

/** A part divider is not a chapter. It introduces the chapter after it. */
export function partDividerBook(): Uint8Array {
  const story = xhtml(`
    <h1 id="part">Part One</h1>
    <p>II</p>
    <h1 id="salt">Salt</h1>
    <p>${long('The part heading belongs to this chapter, not to a chapter of its own.')}</p>
  `);
  const nav = xhtml(`
    <nav epub:type="toc">
      <ol>
        <li><a href="story.xhtml#part">Part One</a></li>
        <li><a href="story.xhtml#salt">Salt</a></li>
      </ol>
    </nav>
  `, 'xmlns:epub="http://www.idpf.org/2007/ops"');
  return pack({
    title: 'Parts',
    docs: [
      { id: 'nav', href: 'nav.xhtml', html: nav, properties: 'nav' },
      { id: 'story', href: 'story.xhtml', html: story },
    ],
  });
}

/** EPUB 2: the NCX is the only table of contents, one file per chapter. */
export function ncxBook(): Uint8Array {
  const salt = xhtml(`<h1>Salt</h1><p>${long('From the NCX.')}</p>`);
  const iron = xhtml(`<h1>Iron</h1><p>${long('Also from the NCX.')}</p>`);
  const ncx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="c1">
      <navLabel><text>Salt</text></navLabel>
      <content src="salt.xhtml"/>
    </navPoint>
    <navPoint id="c2">
      <navLabel><text>Iron</text></navLabel>
      <content src="iron.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;
  return pack({
    title: 'NCX Harbor',
    version: '2.0',
    docs: [
      { id: 'salt', href: 'salt.xhtml', html: salt },
      { id: 'iron', href: 'iron.xhtml', html: iron },
    ],
    ncx: { id: 'ncx', href: 'toc.ncx', xml: ncx },
  });
}

export const FIXTURES: Record<string, () => Uint8Array> = {
  'harbor.epub': harborBook,
  'page-list-only.epub': pageListOnlyBook,
  'toc-after-page-list.epub': () => tocAfterPageList('unlabeled'),
  'wrapped-nav.epub': wrappedNavBook,
  'missing-fragment.epub': missingFragmentBook,
  'pamphlet.epub': shortHeadingBook,
  'numbered-note.epub': numberedNoteBook,
  'two-marks.epub': duplicateImageBook,
  'two-charts.epub': pairedFigureBook,
  'enumerated.epub': enumeratorBook,
  'part-divider.epub': partDividerBook,
  'ncx.epub': ncxBook,
};

// Importing this module from the suite must not write. The script is the
// entry point only when node was asked to run it.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const out = join(dirname(fileURLToPath(import.meta.url)), 'out');
  mkdirSync(out, { recursive: true });
  for (const [name, build] of Object.entries(FIXTURES)) {
    writeFileSync(join(out, name), build());
    console.log(join(out, name));
  }
}
