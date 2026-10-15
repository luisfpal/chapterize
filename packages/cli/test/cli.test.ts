import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { execute, parseArgs, run, type Io } from '../src/main.js';
import { bookFolderName, lanAddress, safeFile } from '../src/paths.js';
import { qrArt } from '../src/serve.js';
import { fixtureEpub } from './fixture.js';

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'chapterize-test-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function io(home: string, cwd: string): Io & { out: string; err: string } {
  const bucket = { out: '', err: '', home, cwd, stdout: (s: string) => { bucket.out += s; }, stderr: (s: string) => { bucket.err += s; } };
  return bucket;
}

function epubFile(dir: string): string {
  const file = path.join(dir, 'fixture.epub');
  writeFileSync(file, fixtureEpub());
  return file;
}

describe('parseArgs', () => {
  it('requires a destination', () => {
    expect(() => parseArgs(['book.epub'])).toThrow(/Nowhere to put the book/);
    expect(() => parseArgs([])).toThrow(/No EPUB was given/);
    expect(() => parseArgs(['a.epub', 'b.epub', '--out', 'x'])).toThrow(/Only one EPUB/);
    expect(() => parseArgs(['a.epub', '--out', 'x', '--icloud'])).toThrow(/not both/);
    expect(() => parseArgs(['a.epub', '--out', 'x', '--port', '1'])).toThrow(/--port applies only/);
    expect(() => parseArgs(['a.epub', '--serve', '--port', 'nope'])).toThrow(/0 to 65535/);
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
  });
});

describe('where the bundle goes', () => {
  it('refuses the home directory and the whole iCloud Drive', async () => {
    const home = scratch();
    const book = epubFile(home);
    const logs = io(home, home);
    expect(await execute([book, '--out', home], logs)).toBe(1);
    expect(logs.err).toMatch(/Refusing to write/);

    const drive = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    mkdirSync(drive, { recursive: true });
    const again = io(home, home);
    expect(await execute([book, '--out', drive], again)).toBe(1);
    expect(again.err).toMatch(/whole iCloud Drive/);
  });

  it('writes under Chapterize in iCloud Drive when the folder exists', async () => {
    const home = scratch();
    const book = epubFile(home);
    const drive = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    mkdirSync(drive, { recursive: true });
    const logs = io(home, home);
    expect(await execute([book, '--icloud'], logs)).toBe(0);
    const index = path.join(drive, 'Chapterize', 'Phone Fixture — Ada Test', 'index.html');
    expect(readFileSync(index, 'utf8')).toContain('The Quiet Start');
    expect(logs.out).toContain('Files → iCloud Drive → Chapterize');
  });

  it('does not let a title of ".." climb out of the Chapterize folder', async () => {
    expect(bookFolderName('..')).toBe('Untitled');
    expect(bookFolderName('.')).toBe('Untitled');
    expect(bookFolderName('..', 'Ada Test')).toBe('.. — Ada Test');

    const home = scratch();
    const book = path.join(home, 'dots.epub');
    writeFileSync(book, fixtureEpub({ title: '..', author: null }));
    const drive = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    mkdirSync(drive, { recursive: true });
    expect(await execute([book, '--icloud'], io(home, home))).toBe(0);
    expect(existsSync(path.join(drive, 'index.html'))).toBe(false);
    expect(existsSync(path.join(drive, 'Chapterize', 'index.html'))).toBe(false);
    expect(readFileSync(path.join(drive, 'Chapterize', 'Untitled', 'index.html'), 'utf8')).toContain('The Quiet Start');
  });

  it('says what to do when iCloud Drive is not there', async () => {
    const home = scratch();
    const book = epubFile(home);
    const logs = io(home, home);
    expect(await execute([book, '--icloud'], logs)).toBe(1);
    expect(logs.err).toMatch(/pass --out/i);
  });

  it('replaces its own folders and leaves a stranger file alone', async () => {
    const home = scratch();
    const book = epubFile(home);
    const out = path.join(home, 'bundle');
    expect(await execute([book, '--out', out], io(home, home))).toBe(0);
    writeFileSync(path.join(out, 'chapters', 'stale.html'), 'old');
    writeFileSync(path.join(out, 'notes.txt'), 'keep me');
    expect(await execute([book, '--out', out], io(home, home))).toBe(0);
    expect(() => readFileSync(path.join(out, 'chapters', 'stale.html'))).toThrow();
    expect(readFileSync(path.join(out, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(readFileSync(path.join(out, 'chapters', '001-the-quiet-start.html'), 'utf8')).toContain('UNIQUE_ALPHA');
  });

  it('refuses to replace a symlinked chapters folder', async () => {
    const home = scratch();
    const book = epubFile(home);
    const out = path.join(home, 'bundle');
    const elsewhere = path.join(home, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(path.join(elsewhere, 'precious.txt'), 'do not touch');
    expect(await execute([book, '--out', out], io(home, home))).toBe(0);
    rmSync(path.join(out, 'chapters'), { recursive: true });
    symlinkSync(elsewhere, path.join(out, 'chapters'));
    const logs = io(home, home);
    expect(await execute([book, '--out', out], logs)).toBe(1);
    expect(logs.err).toMatch(/symlink/);
    expect(readFileSync(path.join(elsewhere, 'precious.txt'), 'utf8')).toBe('do not touch');
  });

  it('names a missing file and a file that is not an EPUB', async () => {
    const home = scratch();
    const missing = io(home, home);
    expect(await execute([path.join(home, 'nope.epub'), '--out', path.join(home, 'out')], missing)).toBe(1);
    expect(missing.err).toMatch(/no such file/);

    const junk = path.join(home, 'junk.epub');
    writeFileSync(junk, 'not a zip');
    const bad = io(home, home);
    expect(await execute([junk, '--out', path.join(home, 'out')], bad)).toBe(1);
    expect(bad.err).toMatch(/Cannot open this file as an EPUB/);
  });
});

describe('LAN address and paths', () => {
  it('prefers Wi-Fi over a tunnel', () => {
    const address = lanAddress({
      utun0: [{ address: '1.2.3.4', family: 'IPv4', internal: false, netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '1.2.3.4/8' }],
      en0: [{ address: '10.0.0.8', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: '10.0.0.8/24' }],
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '127.0.0.1/8' }],
    });
    expect(address).toBe('10.0.0.8');
    expect(lanAddress({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '127.0.0.1/8' }],
    })).toBeNull();
  });

  it('does not let a URL walk out of the bundle', () => {
    const root = '/tmp/bundle';
    expect(safeFile(root, '/')).toBe(path.resolve(root, 'index.html'));
    expect(safeFile(root, '/../../etc/passwd')).toBeNull();
    expect(safeFile(root, '/chapters/../../etc/passwd')).toBeNull();
    expect(safeFile(root, '/chapters/..\\..\\etc\\passwd')).toBeNull();
  });
});

describe('the QR code', () => {
  it('draws a frame for the address the phone would open', async () => {
    const art = await qrArt('http://10.0.0.8:8732/');
    expect(art).toMatch(/[▄▀█]/);
    expect(art.split('\n').length).toBeGreaterThan(8);
  });
});

describe('the server', () => {
  it('serves the chapter, refuses a path that leaves the folder, and does not follow a symlink out', async () => {
    const home = scratch();
    const book = epubFile(home);
    const out = path.join(home, 'bundle');
    const logs = io(home, home);
    const running = await run({ epubPath: book, out, icloud: false, epubs: true, serve: true, port: 0 }, logs);
    if (!running) throw new Error('server did not start');
    closers.push(running.close);

    expect(logs.out).toContain(running.localUrl);
    if (running.url) {
      expect(logs.out).toContain(running.url);
      expect(logs.out).toMatch(/[▄▀█]/);
      expect(logs.out).toContain('Anyone on this network');
    } else {
      expect(logs.out).toContain('No LAN address');
    }

    const index = await fetch(`${running.localUrl}`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('The Quiet Start');

    const chapter = await fetch(`${running.localUrl}chapters/001-the-quiet-start.html`);
    expect(chapter.status).toBe(200);
    expect(await chapter.text()).toContain('UNIQUE_ALPHA');

    const epub = await fetch(`${running.localUrl}epub/001-the-quiet-start.epub`);
    expect(epub.status).toBe(200);
    expect(epub.headers.get('content-type')).toContain('application/epub+zip');
    expect(epub.headers.get('content-disposition')).toContain('attachment');
    const bytes = new Uint8Array(await epub.arrayBuffer());
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    const escaped = await fetch(`${running.localUrl}chapters/${encodeURIComponent('../'.repeat(4) + 'etc/passwd')}`);
    expect(escaped.status).toBe(404);

    const walked = await fetch(`${running.localUrl}chapters/..%2F..%2F..%2Fetc/passwd`);
    expect(walked.status).toBe(404);

    symlinkSync('/etc/passwd', path.join(out, 'secret.txt'));
    const leaked = await fetch(`${running.localUrl}secret.txt`);
    expect(leaked.status).toBe(404);
    expect(await leaked.text()).not.toContain('root:');

    const posted = await fetch(running.localUrl, { method: 'POST' });
    expect(posted.status).toBe(405);

    const listing = await fetch(`${running.localUrl}chapters/`);
    expect(listing.status).toBe(404);

    const icon = await fetch(`${running.localUrl}favicon.ico`);
    expect(icon.status).toBe(204);

    writeFileSync(path.join(out, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const svg = await fetch(`${running.localUrl}evil.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
  });

  it('deletes the temporary copy when the port is already taken', async () => {
    const home = scratch();
    const book = epubFile(home);
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', () => resolve()));
    const address = blocker.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const owned = (name: string) => name.startsWith('chapterize-') && !name.startsWith('chapterize-test-');
    const before = new Set(readdirSync(tmpdir()).filter(owned));
    const logs = io(home, home);
    expect(await execute([book, '--serve', '--port', String(port)], logs)).toBe(1);
    expect(logs.err).toMatch(/already in use/);
    const leaked = readdirSync(tmpdir()).filter(owned).filter((name) => !before.has(name));
    expect(leaked).toEqual([]);
    await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
  });
});

describe('the bin', () => {
  const bin = fileURLToPath(new URL('../bin/chapterize.js', import.meta.url));

  function runBin(args: string[]): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code: code ?? 1, out, err }));
    });
  }

  it('prints help and writes a bundle', async () => {
    const help = await runBin(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--icloud');
    expect(help.out).toContain('--serve');

    const home = scratch();
    const book = epubFile(home);
    const out = path.join(home, 'phone');
    const wrote = await runBin([book, '--out', out, '--epub']);
    expect(wrote.code).toBe(0);
    expect(wrote.err).toBe('');
    expect(readFileSync(path.join(out, 'index.html'), 'utf8')).toContain('Phone Fixture');
    expect(readFileSync(path.join(out, 'epub', '002-lists-and-lines.epub'))[0]).toBe(0x50);
  }, 20000);
});
