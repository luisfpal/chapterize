import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the real books live.
 *
 * The default suite builds its own books. This loader is the extra pass: point
 * CHAPTERIZE_FIXTURES at a directory of .epub files and the shelf oracles run
 * too. A maintainer's reading list is not something the repository should carry,
 * so without the variable those oracles are simply not registered.
 */
const ROOTS = (process.env['CHAPTERIZE_FIXTURES'] ?? '')
  .split(':')
  .filter(Boolean);

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
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const path of walk(root)) {
      // The library holds a copy of each imported book; count each title once.
      const key = path.split('/').pop() ?? path;
      if (key === 'book.epub') { out.push(path); continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(path);
    }
  }
  return out;
}

export function libraryAvailable(): boolean {
  return allBooks().length > 0;
}

/** Find a book by a distinctive substring of its path. */
export function bookPath(needle: string): string {
  const want = needle.toLowerCase();
  const match = allBooks().find((p) => p.toLowerCase().includes(want));
  if (!match) throw new Error(`No fixture matching "${needle}" under ${ROOTS.join(', ')}`);
  return match;
}

export function loadBook(needle: string): Uint8Array {
  return new Uint8Array(readFileSync(bookPath(needle)));
}

/**
 * Memoised loader for use inside `describe` blocks.
 *
 * `describe.runIf(false)` still executes its callback while collecting tests, so
 * a `loadBook()` call at describe scope throws before the guard can skip
 * anything — taking the whole file down, unit tests included. Defer the read to
 * first use inside an `it`, where the guard has already applied.
 */
const cache = new Map<string, Uint8Array>();
export function lazyBook(needle: string): () => Uint8Array {
  return () => {
    const hit = cache.get(needle);
    if (hit) return hit;
    const bytes = loadBook(needle);
    cache.set(needle, bytes);
    return bytes;
  };
}
