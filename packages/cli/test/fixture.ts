import { strToU8, zipSync } from 'fflate';

/**
 * A small EPUB built in memory. The repository ignores *.epub, and a hand-saved
 * fixture would encode the same assumptions as the code. This one still has the
 * parts that have broken real books: a nav, a repeated running head, a note
 * outside the reading flow, and a figure.
 */
const FILL = 'This sentence exists so the chapter is long enough to survive stub merging, which would otherwise fold a short page into the next one and the bundle would then count the wrong chapters. ';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function xhtml(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
${body}
</body>
</html>
`;
}

function xmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fixtureEpub(opts: { title?: string; author?: string | null } = {}): Uint8Array {
  const title = opts.title ?? 'Phone Fixture';
  const author = opts.author === undefined ? 'Ada Test' : opts.author;
  const ch1 = xhtml(`
<h1>Phone Fixture</h1>
<p>${FILL}${FILL}</p>
<p>Emphasis lives <em>inside</em> the sentence, and a footnote follows<a epub:type="noteref" role="doc-noteref" href="notes.xhtml#n1">*</a>.</p>
<p>UNIQUE_ALPHA marks the first chapter.</p>
<p><img src="images/dot.png" alt="A single dot"/></p>
`);
  const ch2 = xhtml(`
<h1>Phone Fixture</h1>
<h2>A real heading</h2>
<p>${FILL}UNIQUE_BETA marks the second chapter so a neighbour cannot claim this sentence.</p>
<ul>
  <li>First item of the list</li>
  <li>Second item of the list</li>
</ul>
<blockquote>A quoted line that should stay a quote.</blockquote>
`);
  const ch3 = xhtml(`
<h1>Phone Fixture</h1>
<p>${FILL}UNIQUE_GAMMA_SENTENCE is the sentinel that must not appear in any other chapter.</p>
`);
  const notes = xhtml(`<aside id="n1"><p>* The note body says ORIGIN.</p></aside>`);
  const nav = xhtml(`
<nav epub:type="toc">
  <ol>
    <li><a href="ch1.xhtml">The Quiet Start</a></li>
    <li><a href="ch2.xhtml">Lists and Lines</a>
      <ol><li><a href="ch3.xhtml">Marks &amp; &lt;Angles&gt;</a></li></ol>
    </li>
  </ol>
</nav>
`);
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:fixture:phone</dc:identifier>
    <dc:title>${xmlText(title)}</dc:title>${author ? `\n    <dc:creator>${xmlText(author)}</dc:creator>` : ''}
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="images/dot.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>
`;
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/ch1.xhtml': strToU8(ch1),
    'OEBPS/ch2.xhtml': strToU8(ch2),
    'OEBPS/ch3.xhtml': strToU8(ch3),
    'OEBPS/notes.xhtml': strToU8(notes),
    'OEBPS/images/dot.png': new Uint8Array(PNG),
  });
}
