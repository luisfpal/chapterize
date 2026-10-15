/**
 * End-to-end gate that does not need the maintainer's shelf.
 *
 * Real EPUBs stay out of the repo. This builds one book in memory, with the
 * shapes that have already shipped bugs — a page-list nav, a repeated h1,
 * a mid-file cut, a wrapped line, a display title, a footnote outside the
 * flow — and runs the same split and export the app runs. An assertion that
 * fails here is a lesson. Loosening it to match the output is how the lesson
 * gets lost.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import {
  chapterFilename,
  countWords,
  deriveTitles,
  detect,
  mergeStubs,
  openEpub,
  readingMinutes,
  renderChapter,
  toChapters,
} from '../packages/core/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

function assertTsconfigs() {
  const base = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8'));
  for (const flag of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) {
    if (base.compilerOptions?.[flag] !== true) {
      fail(`tsconfig.base.json compilerOptions.${flag} must be true`);
    }
  }
  for (const group of ['packages', 'apps']) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pkg = join(dir, name);
      if (!statSync(pkg).isDirectory()) continue;
      const file = join(pkg, 'tsconfig.json');
      if (!existsSync(file)) continue;
      const config = JSON.parse(readFileSync(file, 'utf8'));
      if (config.extends !== '../../tsconfig.base.json') {
        fail(`${group}/${name}/tsconfig.json must extend ../../tsconfig.base.json`);
      }
    }
  }
}

const xhtml = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title></head>${body}</html>`;

function syntheticEpub() {
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Synthetic Laws</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="uid">synthetic-laws</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="law1" href="text/law1.xhtml" media-type="application/xhtml+xml"/>
    <item id="laws" href="text/laws.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="law1"/>
    <itemref idref="laws"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>`;

  // page-list is first on purpose. Using the first <nav> would invent a chapter
  // per printed page. Only epub:type="toc" is a table of contents.
  const pages = Array.from(
    { length: 8 },
    (_, i) => `<li><a href="text/law1.xhtml#p${i + 1}">${i + 1}</a></li>`,
  ).join('');
  const nav = xhtml(`<body>
    <nav epub:type="page-list"><ol>${pages}</ol></nav>
    <nav epub:type="toc"><ol>
      <li><a href="text/cover.xhtml">Cover</a></li>
      <li><a href="text/law1.xhtml">LAW 1</a></li>
      <li><a href="text/laws.xhtml#law2">LAW 2</a></li>
      <li><a href="text/laws.xhtml#law3">LAW 3</a></li>
      <li><a href="text/missing.xhtml">Ghost</a></li>
    </ol></nav>
  </body>`);

  const cover = xhtml(`<body>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>
  </body>`);

  const law1 = xhtml(`<body>
    <h1>Synthetic Laws</h1>
    <h2>LAW 1</h2>
    <p>NEVER</p>
    <p>OUTSHINE</p>
    <p>THE MASTER</p>
    <p>The stars in the</p>
    <p>sky tonight are bright.</p>
    <p>Authority ends here.</p>
    <p>A <b>Productivity compounds. </b>rest of the sentence.</p>
    <p>See the claim<a epub:type="noteref" href="notes.xhtml#n1">*</a> now.</p>
    <p>This paragraph exists so the chapter is long enough to remain a chapter after stub merging. A part divider with almost no text of its own must not become the page a reader opens on. The sentence is ordinary prose and it ends.</p>
    <script>alert('no')</script>
  </body>`);

  const laws = xhtml(`<body>
    <h2 id="law2">LAW 2</h2>
    <h1>Synthetic Laws</h1>
    <p>CONCEAL</p>
    <p>YOUR INTENTIONS</p>
    <p>This chapter shares its file with the next one. The cut is the fragment in the table of contents, not the file boundary, and the prose here is long enough that stub merging must leave the boundary alone.</p>
    <h2 id="law3">LAW 3</h2>
    <h1>Synthetic Laws</h1>
    <p>KEEP</p>
    <p>YOUR MOUTH SHUT</p>
    <p>Still the same file. A later fragment is a later chapter, and the blocks between the two cuts belong to the earlier chapter rather than to both. This paragraph is long on purpose: a chapter under 200 characters is a stub and merges away, and the repeated heading is only boilerplate once a third chapter exists to outvote it.</p>
  </body>`);

  const notes = xhtml(`<body>
    <aside id="n1"><p>* The note body explains the claim.</p></aside>
  </body>`);

  // Zip entry order is the reverse of the spine. A parser that walks the
  // archive instead of <itemref> reads the book backwards.
  const text = (value) => strToU8(value);
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'OEBPS/text/notes.xhtml': text(notes),
    'OEBPS/text/laws.xhtml': text(laws),
    'OEBPS/text/law1.xhtml': text(law1),
    'OEBPS/text/cover.xhtml': text(cover),
    'OEBPS/nav.xhtml': text(nav),
    'OEBPS/content.opf': text(opf),
    'META-INF/container.xml': text(container),
  });
}

function plain(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function assertBook() {
  const book = openEpub(syntheticEpub());
  if (book.metadata.title !== 'Synthetic Laws') fail(`title: ${book.metadata.title}`);
  if (book.metadata.author !== 'Test Author') fail(`author: ${String(book.metadata.author)}`);
  if (book.metadata.epubVersion !== '3.0') fail(`epub version: ${book.metadata.epubVersion}`);
  if (book.tocSource !== 'nav') fail(`toc source: ${book.tocSource}`);

  const labels = book.toc.map((entry) => entry.label);
  const expectedLabels = ['Cover', 'LAW 1', 'LAW 2', 'LAW 3', 'Ghost'];
  if (labels.join('|') !== expectedLabels.join('|')) {
    fail(`toc labels: ${JSON.stringify(labels)} (a page-list must not become chapters)`);
  }

  const detection = detect(book);
  // Set when a count or a title is wrong and the assertion does not show the cuts.
  if (process.env['VERIFY_DEBUG']) {
    console.error(
      JSON.stringify(
        {
          toc: book.toc,
          unresolved: detection.unresolved,
          cuts: detection.cuts,
          blocks: book.blocks.map((block) => ({
            path: block.path,
            ids: block.ids,
            tag: block.tag,
            text: block.text.slice(0, 60),
          })),
        },
        null,
        2,
      ),
    );
  }
  if (detection.strategy !== 'toc') fail(`strategy: ${detection.strategy}`);
  const reasons = detection.unresolved.map((entry) => entry.reason).sort();
  if (reasons.join('|') !== 'document-has-no-text|path-not-in-spine') {
    fail(`unresolved: ${JSON.stringify(detection.unresolved.map((entry) => entry.reason))}`);
  }

  const paths = book.blocks.map((block) => block.path);
  if (paths.some((path) => path.endsWith('notes.xhtml') || path.endsWith('cover.xhtml'))) {
    fail(`notes or the image-only cover leaked into the reading order: ${JSON.stringify(paths)}`);
  }
  const first = paths[0];
  if (first === undefined || !first.endsWith('law1.xhtml')) {
    fail(`reading order did not follow the spine: ${JSON.stringify(paths)}`);
  }
  if (paths.some((path) => path.endsWith('laws.xhtml')) === false) {
    fail('the two-chapter file produced no blocks');
  }
  if (book.blocks.some((block) => block.text.includes('alert'))) {
    fail('a script element was treated as prose');
  }
  for (const block of book.blocks) {
    if (/<[a-z]+\s/i.test(block.html)) fail(`attribute survived in html: ${block.html}`);
    if (block.image) continue;
    if (plain(block.html) !== block.text) {
      fail(`html text !== block text\n html: ${block.html}\n text: ${block.text}`);
    }
  }
  if (!book.blocks.some((block) => block.text === 'NEVER')) {
    fail('a display title was joined into the paragraph under it');
  }
  if (!book.blocks.some((block) => block.text === 'The stars in the sky tonight are bright.')) {
    fail(
      `wrapped lines were not rejoined: ${JSON.stringify(book.blocks.map((block) => block.text))}`,
    );
  }
  if (!book.blocks.some((block) => block.text === 'Authority ends here.')) {
    fail('a sentence that already ended was glued to the next paragraph');
  }

  // 200 is the stub threshold the desktop importer uses. Below it, a part
  // divider becomes the chapter a reader opens on.
  const cuts = mergeStubs(detection.cuts, book.blocks, 200);
  const chapters = deriveTitles(toChapters(cuts, book.blocks), book.blocks);
  if (chapters.length !== 3) {
    fail(
      `chapter count: ${chapters.length} (${chapters.map((chapter) => chapter.title).join(' | ')})`,
    );
  }
  const titles = chapters.map((chapter) => chapter.title);
  const want = [
    'LAW 1 — Never Outshine the Master',
    'LAW 2 — Conceal Your Intentions',
    'LAW 3 — Keep Your Mouth Shut',
  ];
  if (titles.join('|') !== want.join('|')) fail(`titles: ${JSON.stringify(titles)}`);
  if (titles.some((title) => title === 'Synthetic Laws')) {
    fail('the repeated h1 became a chapter title');
  }

  if (chapters[0]?.start !== 0) fail('chapters do not start at the first block');
  const last = chapters[chapters.length - 1];
  if (last?.end !== book.blocks.length) fail('chapters do not cover the last block');
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i]?.start !== chapters[i - 1]?.end) fail(`gap or overlap before chapter ${i}`);
  }

  const law2 = chapters[1];
  const law3 = chapters[2];
  if (law2 === undefined || law3 === undefined) return;
  const path2 = book.blocks[law2.start]?.path;
  const path3 = book.blocks[law3.start]?.path;
  if (path2 === undefined || path2 !== path3) {
    fail(`mid-file cut landed in different files: ${String(path2)} vs ${String(path3)}`);
  }
  if (law2.start === law3.start) fail('the two fragments resolved to the same block');

  const files = chapters.map((chapter) => {
    const words = countWords(
      book.blocks
        .slice(chapter.start, chapter.end)
        .map((block) => block.text)
        .join(' '),
    );
    const markdown = renderChapter(chapter, book.blocks, chapter.title, {
      bookTitle: book.metadata.title,
      author: book.metadata.author,
      totalChapters: chapters.length,
      notes: book.notes,
      minutes: readingMinutes(words),
    });
    return { name: chapterFilename(chapter, chapter.title), markdown };
  });

  const law1File = files[0];
  if (law1File === undefined) return;
  if (law1File.name !== '000-law-1-never-outshine-the-master.md') {
    fail(`filename: ${law1File.name}`);
  }
  const markdown = law1File.markdown;
  if (!markdown.startsWith('# LAW 1 — Never Outshine the Master\n')) {
    fail(`export did not open with the chapter title:\n${markdown.slice(0, 200)}`);
  }
  if (!markdown.includes('Synthetic Laws — Test Author · 1 of 3 · ~')) {
    fail(`provenance line missing:\n${markdown.slice(0, 300)}`);
  }
  if (markdown.includes('NaN')) fail('reading time was NaN');
  if (!markdown.includes('**Productivity compounds.** rest of the sentence.')) {
    fail(`emphasis was not valid Markdown:\n${markdown}`);
  }
  if (markdown.includes('**Productivity compounds. **')) {
    fail('closing emphasis marker sits against a space');
  }
  if (!markdown.includes('See the claim[^1] now.')) fail(`footnote marker missing:\n${markdown}`);
  if (!markdown.includes('[^1]: The note body explains the claim.')) {
    fail(`footnote body missing:\n${markdown}`);
  }
  if (markdown.includes('[^0]')) fail('footnote numbering did not start at 1');
}

assertTsconfigs();
assertBook();

if (failures.length) {
  console.error(`verify: ${failures.length} failure${failures.length === 1 ? '' : 's'}`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log('verify: synthetic EPUB split into 3 chapters and exported');
