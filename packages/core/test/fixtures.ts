import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Real books, not synthetic ones. These cover every structural case that
 * matters — 1:1 files, chapters spanning many files, chapters starting mid-file,
 * EPUB 2 NCX and EPUB 3 nav, and a book with more chapters than most tools
 * expect. They are the user's own library and are never committed.
 */
const ROOT = join(process.env['HOME'] ?? '', '$CHAPTERIZE_FIXTURES');
/** Scratch copies made during calibration would otherwise be counted twice. */
const EXCLUDE = /_chapterize_experiment/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (EXCLUDE.test(path)) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.toLowerCase().endsWith('.epub')) out.push(path);
  }
  return out;
}

export function allBooks(): string[] {
  return walk(ROOT);
}

export function libraryAvailable(): boolean {
  return allBooks().length > 0;
}

/** Find a book by a distinctive substring of its filename. */
export function bookPath(needle: string): string {
  const want = needle.toLowerCase();
  const match = allBooks().find((p) => p.toLowerCase().includes(want));
  if (!match) throw new Error(`No fixture matching "${needle}" under ${ROOT}`);
  return match;
}

export function loadBook(needle: string): Uint8Array {
  return new Uint8Array(readFileSync(bookPath(needle)));
}
