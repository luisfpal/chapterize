import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { main } from '../src/main.js';
import { serveSite } from '../src/server.js';

const dirs: string[] = [];
const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const server of servers) await server.close();
  servers.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chapterize-'));
  dirs.push(dir);
  return dir;
}

describe('chapterize command', () => {
  it('writes a site and does not serve it when asked not to', async () => {
    const out = tempDir();
    const logs: string[] = [];
    const code = await main(
      [writeEpub(tempDir()), '--no-serve', '--out', out],
      { log: (line) => logs.push(line), error: (line) => logs.push(line) },
    );
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain(out);
    const index = await fetchText(join(out, 'index.html'));
    expect(index).toContain('reader.js');
    expect(index).toContain('apple-mobile-web-app-capable');
    const book = JSON.parse(await fetchText(join(out, 'book.json'))) as { title: string; chapters: { html: string }[] };
    expect(book.title).toBe('Sample & Test');
    expect(JSON.stringify(book)).not.toContain('OEBPS');
    expect(book.chapters[1]?.html).toContain('<em>Let them</em>');
    expect(book.chapters[1]?.html).not.toContain('alert(1)');
  });

  it('refuses a directory that is not a site it created', async () => {
    const out = tempDir();
    writeFileSync(join(out, 'notes.txt'), 'keep me');
    const logs: string[] = [];
    const code = await main(
      [writeEpub(tempDir()), '--no-serve', '--out', out],
      { log: (line) => logs.push(line), error: (line) => logs.push(line) },
    );
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('Refusing to overwrite');
    expect(await fetchText(join(out, 'notes.txt'))).toBe('keep me');
  });

  it('serves the book only at its token', async () => {
    const out = tempDir();
    const code = await main([writeEpub(tempDir()), '--no-serve', '--out', out], { log: () => {}, error: () => {} });
    expect(code).toBe(0);
    const token = 'a'.repeat(32);
    const serving = await serveSite({ dir: out, token, port: 0, host: '127.0.0.1' });
    servers.push(serving);
    const base = `http://127.0.0.1:${serving.port}`;

    const home = await fetch(`${base}/`);
    expect(home.status).toBe(404);
    expect(await home.text()).not.toContain('Sample');

    const wrong = await fetch(`${base}/${'b'.repeat(32)}/book.json`);
    expect(wrong.status).toBe(404);

    const book = await fetch(`${base}/${token}/book.json`);
    expect(book.status).toBe(200);
    expect(book.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await book.text()).toContain('Sample & Test');

    const image = await fetch(`${base}/${token}/images/dot.png`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');

    const escaped = await fetch(`${base}/${token}/%2e%2e/%2e%2e/etc/passwd`);
    expect(escaped.status).toBe(404);
    const dotted = await fetch(`${base}/${token}/../../etc/passwd`);
    expect(dotted.status).toBe(404);

    const icon = readFileSync(join(out, 'icon.png'));
    expect(icon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    expect(sw).toContain('./book.json');
    // The computer is asked before the saved copy, and an unreachable
    // address is abandoned rather than hung.
    expect(sw.indexOf('await fetch(event.request')).toBeLessThan(sw.indexOf('cache.match(event.request)'));
    expect(sw).toContain('AbortController');
  });

  it('keeps the same link when the book is built again', async () => {
    const out = tempDir();
    const epub = writeEpub(tempDir());
    const quiet = { log: () => {}, error: () => {} };
    expect(await main([epub, '--no-serve', '--out', out], quiet)).toBe(0);
    const first = JSON.parse(readFileSync(join(out, 'chapterize.json'), 'utf8')) as { token: string };
    expect(first.token).toMatch(/^[0-9a-f]{32}$/);
    expect(await main([epub, '--no-serve', '--out', out], quiet)).toBe(0);
    const second = JSON.parse(readFileSync(join(out, 'chapterize.json'), 'utf8')) as { token: string };
    expect(second.token).toBe(first.token);
    expect(readFileSync(join(out, 'book.json'), 'utf8')).toContain('Sample & Test');
  });

  it('the terminal command serves a URL a phone can open', async () => {
    const out = tempDir();
    const epub = writeEpub(tempDir());
    const bin = fileURLToPath(new URL('../bin.js', import.meta.url));
    const child = spawn(process.execPath, [bin, epub, '--host', '127.0.0.1', '--port', '0', '--out', out], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    let url = '';
    try {
      url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no URL from the command:\n${text}`)), 15000);
        const take = (chunk: Buffer) => {
          text += chunk.toString();
          const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\//);
          if (!match) return;
          clearTimeout(timer);
          resolve(match[0]);
        };
        child.stdout?.on('data', take);
        child.stderr?.on('data', take);
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`command exited ${code} before printing a URL:\n${text}`));
        });
      });
      expect(text).toContain('Anyone on this Wi-Fi');
      expect(text).toContain('not copied back');
      const book = await fetch(`${url}book.json`);
      expect(book.status).toBe(200);
      expect(await book.text()).toContain('Sample & Test');
      const missing = await fetch(url.replace(/\/[0-9a-f]{32}\/$/, '/'));
      expect(missing.status).toBe(404);
    } finally {
      child.kill('SIGTERM');
    }
  });
});

async function fetchText(path: string): Promise<string> {
  return readFileSync(path, 'utf8');
}

function writeEpub(dir: string): string {
  const path = join(dir, 'sample.epub');
  writeFileSync(path, Buffer.from(sampleEpub()));
  return path;
}

function sampleEpub(): Uint8Array {
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Sample &amp; Test</dc:title>
    <dc:creator>A. Reader</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="uid">sample</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="img" href="images/dot.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;
  const ncx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
  <navPoint id="a"><navLabel><text>Copyright</text></navLabel><content src="copyright.xhtml"/></navPoint>
  <navPoint id="b"><navLabel><text>The Opening Claim</text></navLabel><content src="ch.xhtml"/></navPoint>
</navMap></ncx>`;
  const copyright = `<html><body><h1>Copyright</h1><p>Short.</p></body></html>`;
  const chapter = `<html><body>
<h1>The Opening Claim</h1>
<p>The first paragraph says something substantive about power and attention in a court of people who notice everything.</p>
<p>Hide the method. <em>Let them</em> see the result and keep the machinery out of sight. <script>alert(1)</script></p>
<img src="images/dot.png" alt="A dot"/>
</body></html>`;
  return zipSync({
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/toc.ncx': strToU8(ncx),
    'OEBPS/copyright.xhtml': strToU8(copyright),
    'OEBPS/ch.xhtml': strToU8(chapter),
    'OEBPS/images/dot.png': new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]),
  });
}
