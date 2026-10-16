import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mechanismsBook } from '../../core/test/make-epub.js';
import { outputPath, parseStudyArgs, run, type Io } from '../src/study-cli.js';

function memory(bytes: Uint8Array | undefined): {
  io: Io;
  files: Map<string, string>;
  out: string[];
  err: string[];
} {
  const files = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    readFile: (path) => {
      if (bytes === undefined || path !== 'book.epub') throw new Error('missing');
      return bytes;
    },
    writeFile: (path, body) => files.set(path, body),
    mkdir: () => {},
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
  return { io, files, out, err };
}

describe('parseStudyArgs', () => {
  it('reads repeated chapters and an inline mode', () => {
    const parsed = parseStudyArgs([
      'book.epub',
      '--chapter',
      '2',
      '--chapter=4',
      '--mode=prompt',
      '--out',
      'notes',
    ]);
    expect(parsed.epubPath).toBe('book.epub');
    expect(parsed.chapters).toEqual([2, 4]);
    expect(parsed.mode).toBe('prompt');
    expect(parsed.outDir).toBe('notes');
  });

  it('rejects a mode that is not one of the three', () => {
    expect(() => parseStudyArgs(['book.epub', '--mode', 'live'])).toThrow(
      /offline, prompt, or both/,
    );
  });
});

describe('run', () => {
  const book = mechanismsBook();

  it('writes the phone file and the paste file, and skips the cover', () => {
    const mem = memory(book);
    const code = run(['study', 'book.epub', '--out', 'out'], mem.io);
    expect(code).toBe(0);
    const written = [...mem.files.keys()].sort();
    expect(written).toEqual(
      [
        '000-levers-prompt.md',
        '000-levers-study.html',
        '000-levers-study.md',
        '001-friction-prompt.md',
        '001-friction-study.html',
        '001-friction-study.md',
      ]
        .map((name) => resolve('out', name))
        .sort(),
    );
    const html = mem.files.get(resolve('out', '000-levers-study.html'));
    if (html === undefined) throw new Error('missing levers html');
    expect(html).toContain('must not be skipped');
    expect(html).not.toMatch(/<script/i);
    const prompt = mem.files.get(resolve('out', '000-levers-prompt.md'));
    if (prompt === undefined) throw new Error('missing levers prompt');
    const start = prompt.indexOf('\nCHAPTER-START\n');
    const end = prompt.indexOf('\nCHAPTER-END\n');
    expect(prompt.slice(start, end)).toContain('must not be skipped');
    expect(mem.out.join('\n')).toContain('Wrote 2 chapters');
    expect(mem.out.join('\n')).toContain('Cover');
  });

  it('writes only a prompt when asked, and writes a short chapter when it is named', () => {
    const prompt = memory(book);
    expect(run(['study', 'book.epub', '--mode', 'prompt', '--chapter', '2'], prompt.io)).toBe(0);
    expect([...prompt.files.keys()]).toEqual([resolve('study', '001-friction-prompt.md')]);
    expect(prompt.out.join('\n')).toContain('does not call one');
    expect(prompt.out.join('\n')).not.toContain('.html file');

    const offline = memory(book);
    expect(run(['study', 'book.epub', '--mode', 'offline', '--chapter', '1'], offline.io)).toBe(0);
    expect([...offline.files.keys()].some((path) => path.endsWith('-prompt.md'))).toBe(false);
    expect(offline.out.join('\n')).toContain('.html file');
    expect(offline.out.join('\n')).not.toContain('prompt.md');

    const cover = memory(book);
    expect(run(['study', 'book.epub', '--chapter', '3', '--out', 'out'], cover.io)).toBe(0);
    expect([...cover.files.keys()]).toContain(resolve('out', '002-cover-study.html'));
  });

  it('says what to do when the file or the chapter is missing', () => {
    const missing = memory(undefined);
    expect(run(['study', 'nope.epub'], missing.io)).toBe(1);
    expect(missing.err[0]).toContain('Cannot read “nope.epub”');

    const range = memory(book);
    expect(run(['study', 'book.epub', '--chapter', '9'], range.io)).toBe(1);
    expect(range.err[0]).toContain('3 chapters');

    const unknown = memory(book);
    expect(run(['boil'], unknown.io)).toBe(1);
    expect(unknown.err[0]).toContain('Unknown command');
  });
});

describe('outputPath', () => {
  it('stays inside the directory the user named', () => {
    expect(outputPath('/tmp/study', '000-levers-study.html')).toBe(
      '/tmp/study/000-levers-study.html',
    );
    expect(outputPath('/tmp/study', '../etc/passwd')).toBeUndefined();
    expect(outputPath('/tmp/study', 'nested/file.html')).toBeUndefined();
    expect(outputPath('/tmp/study', '')).toBeUndefined();
  });
});

describe('the built command', () => {
  it('writes a pack from an epub on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chapterize-study-'));
    try {
      const epub = join(dir, 'book.epub');
      const out = join(dir, 'out');
      writeFileSync(epub, mechanismsBook());
      const cli = fileURLToPath(new URL('../bin/chapterize.js', import.meta.url));
      const stdout = execFileSync(
        process.execPath,
        [cli, 'study', epub, '--out', out, '--chapter', '1'],
        {
          encoding: 'utf8',
        },
      );
      expect(stdout).toContain('Wrote 1 chapter');
      const html = readFileSync(join(out, '000-levers-study.html'), 'utf8');
      expect(html).toContain('The sentence that must not be skipped');
      expect(html).not.toMatch(/<script/i);
      const prompt = readFileSync(join(out, '000-levers-prompt.md'), 'utf8');
      expect(prompt).toContain('Do not browse');
      expect(prompt).toContain('Archimedes stated the rule as a bargain.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
