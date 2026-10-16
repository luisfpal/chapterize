import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

interface ReaderApi {
  nextTheme: (current: string, prefersDark: boolean) => string;
  stepSize: (current: number, delta: number) => number;
  swipe: (dx: number, dy: number, startX: number) => 'next' | 'prev' | null;
  prefsFromSearch: (
    search: string,
    storedTheme: string | null,
    storedSize: string | null,
  ) => { theme: string; size: number };
  withPrefs: (href: string, theme: string, size: number) => string;
  placeFromSearch: (search: string) => { file: string | null; y: number };
  sizes: number[];
}

function load(): ReaderApi {
  const code = readFileSync(fileURLToPath(new URL('../assets/reader.js', import.meta.url)), 'utf8');
  // The vm context has no web globals. URLSearchParams is the one these functions need.
  const context: { ChapterizeReader?: ReaderApi; URLSearchParams: typeof URLSearchParams } = {
    URLSearchParams: globalThis.URLSearchParams,
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  if (!context.ChapterizeReader) throw new Error('reader.js did not expose ChapterizeReader');
  return context.ChapterizeReader;
}

describe('reader controls', () => {
  const api = load();

  it('the first appearance tap changes what is on screen', () => {
    expect(api.nextTheme('system', false)).toBe('dark');
    expect(api.nextTheme('system', true)).toBe('light');
    expect(api.nextTheme('dark', false)).toBe('light');
    expect(api.nextTheme('light', false)).toBe('system');
    expect(api.nextTheme('light', true)).toBe('dark');
    expect(api.nextTheme('dark', true)).toBe('system');
    expect(api.nextTheme('nope', false)).toBe('dark');
  });

  it('steps type size and stops at the ends', () => {
    expect(api.stepSize(19, 1)).toBe(21);
    expect(api.stepSize(19, -1)).toBe(17);
    expect(api.stepSize(17, -1)).toBe(17);
    expect(api.stepSize(28, 1)).toBe(28);
    expect(api.stepSize(3, 1)).toBe(21);
    expect(api.sizes).toEqual([17, 19, 21, 24, 28]);
  });

  it('turns a sideways swipe into the next chapter and leaves the back gesture alone', () => {
    expect(api.swipe(-80, 10, 100)).toBe('next');
    expect(api.swipe(80, 10, 100)).toBe('prev');
    expect(api.swipe(-80, 10, 10)).toBeNull();
    expect(api.swipe(-30, 0, 100)).toBeNull();
    expect(api.swipe(-80, 70, 100)).toBeNull();
  });

  it('carries appearance on the link and ignores a query that is not a theme or a size', () => {
    expect(api.prefsFromSearch('?theme=dark&size=28', 'light', '17')).toEqual({
      theme: 'dark',
      size: 28,
    });
    expect(api.prefsFromSearch('?theme=system', 'dark', '21')).toEqual({
      theme: 'system',
      size: 21,
    });
    expect(api.prefsFromSearch('?theme=javascript&size=999', 'light', '17')).toEqual({
      theme: 'light',
      size: 17,
    });
    expect(api.prefsFromSearch('', null, null)).toEqual({ theme: 'system', size: 19 });

    expect(api.withPrefs('002-next.html', 'dark', 21)).toBe('002-next.html?theme=dark&size=21');
    expect(api.withPrefs('002-next.html#note', 'light', 19)).toBe(
      '002-next.html?theme=light&size=19#note',
    );
    expect(api.withPrefs('#fn-1', 'dark', 19)).toBe('#fn-1');
    expect(api.withPrefs('https://example.com/a', 'dark', 19)).toBe('https://example.com/a');
    expect(api.withPrefs('../index.html?at=chapters%2F001-a.html&y=12', 'dark', 24)).toBe(
      '../index.html?at=chapters%2F001-a.html&y=12&theme=dark&size=24',
    );
  });

  it('only accepts a chapter path as the place to continue', () => {
    expect(api.placeFromSearch('?at=chapters/001-a.html&y=40')).toEqual({
      file: 'chapters/001-a.html',
      y: 40,
    });
    expect(api.placeFromSearch('?at=chapters%2F001-a.html&y=40')).toEqual({
      file: 'chapters/001-a.html',
      y: 40,
    });
    expect(api.placeFromSearch('?at=../etc/passwd&y=-5')).toEqual({ file: null, y: 0 });
    expect(api.placeFromSearch('?at=chapters/001-a.html&y=1e999')).toEqual({
      file: 'chapters/001-a.html',
      y: 0,
    });
  });
});
