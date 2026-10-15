import { strToU8, zipSync } from 'fflate';

/** A minimal EPUB 3. The bytes go through `openEpub`, so the fixture is a book, not a bag of blocks. */
export function makeEpub(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) entries[name] = strToU8(body);
  return zipSync(entries);
}

function xhtml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Mechanisms</title></head>
<body>
${body}
</body>
</html>
`;
}

/**
 * Three chapters with a shape a lazy summary would ruin:
 * a repeated running header, a nested heading, a list, a sentence in the
 * middle, a short cover, a chapter with no headings at all, and a footnote
 * cited twice whose text is not in the reading flow.
 */
export function mechanismsBook(): Uint8Array {
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">mechanisms-fixture</dc:identifier>
    <dc:title>A Book of Mechanisms</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>
`;
  const nav = xhtml(`<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc">
  <ol>
    <li><a href="c1.xhtml">Levers</a></li>
    <li><a href="c2.xhtml">Friction</a></li>
    <li><a href="c3.xhtml">Cover</a></li>
  </ol>
</nav>`);

  const levers = xhtml(`<h1>A Book of Mechanisms</h1>
<h2>Levers</h2>
<p>A lever moves a load by trading distance for force.</p>
<p>The sentence that must not be skipped sits in the middle of the setup. Archimedes stated the rule as a bargain.</p>
<h3>The fulcrum</h3>
<p>The fulcrum is the fixed point the bar turns on.<a epub:type="noteref" href="notes.xhtml#n1"></a></p>
<p>Place the fulcrum close to the load because the king, here the load, notices small hands only when the arm is long.</p>
<h3>The long arm</h3>
<p>A longer arm multiplies the force you can apply.</p>
<ul>
<li>Mark the fulcrum before you push.</li>
<li>Push farther from the fulcrum than the load sits.</li>
<li>Stop when the load moves, because extra force wastes the bargain.</li>
</ul>
<h2>Where it fails</h2>
<p>The bargain fails when the bar bends.<a epub:type="noteref" href="notes.xhtml#n1"></a></p>
<p>A bent bar <strong>turns distance into nothing</strong> because the fulcrum no longer defines a circle. A note that reads &lt;script&gt;alert(1)&lt;/script&gt; is still a note, and force &amp; distance stay paired.</p>`);

  const friction = xhtml(`<h1>A Book of Mechanisms</h1>
<p>Friction is the tax on every slide.</p>
<p>Oil cuts the tax. Sand raises it.</p>
<p>This middle sentence is the one a summary would drop, and the outline must keep it.</p>
<p>Readers of A Book of Mechanisms still have to learn friction.</p>
<p>Name the surface before you predict the motion.</p>`);

  const cover = xhtml(`<h1>A Book of Mechanisms</h1>
<p>Cover page.</p>`);

  // The angle bracket is content. Written as an entity so the markup parser
  // cannot treat it as a tag, which is the bug the study-pack HTML test locks.
  const notes = xhtml(`<p id="n1">The story about lifting a ship is later embroidery, and a &lt; margin is not a lever.</p>`);

  return makeEpub({
    'META-INF/container.xml': container,
    'OEBPS/content.opf': opf,
    'OEBPS/nav.xhtml': nav,
    'OEBPS/c1.xhtml': levers,
    'OEBPS/c2.xhtml': friction,
    'OEBPS/c3.xhtml': cover,
    'OEBPS/notes.xhtml': notes,
  });
}

/**
 * A chapter under the study-pack word floor whose only real claim is a
 * footnote, plus a blank page. Counting the body and ignoring the note would
 * skip the chapter that has something to study.
 */
export function notedBook(): Uint8Array {
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">noted-fixture</dc:identifier>
    <dc:title>Notes Carry The Claim</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>
`;
  const nav = xhtml(`<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc">
  <ol>
    <li><a href="c1.xhtml">The rule</a></li>
    <li><a href="c2.xhtml">Blank</a></li>
  </ol>
</nav>`);
  const rule = xhtml(`<p>See the note.<a epub:type="noteref" href="notes.xhtml#n1"></a></p>`);
  const blank = xhtml(`<p>Hi.</p>`);
  const notes = xhtml(`<p id="n1">The argument lives in the note, and a chapter this short is still worth studying because the citation carries the claim.</p>`);
  return makeEpub({
    'META-INF/container.xml': container,
    'OEBPS/content.opf': opf,
    'OEBPS/nav.xhtml': nav,
    'OEBPS/c1.xhtml': rule,
    'OEBPS/c2.xhtml': blank,
    'OEBPS/notes.xhtml': notes,
  });
}
