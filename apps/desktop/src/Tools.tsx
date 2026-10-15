import { useCallback, useEffect, useMemo, useState } from 'react';
import { search, type Block, type Hit } from '@chapterize/core';
import { native } from './native';

export type { Hit };
export { search };

export function SearchPanel({
  blocks,
  chapters,
  onGo,
}: {
  blocks: Block[];
  chapters: { start: number; end: number; title: string }[];
  onGo: (chapter: number, block: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query), 220);
    return () => window.clearTimeout(t);
  }, [query]);

  const hits = useMemo(() => search(blocks, chapters, debounced), [blocks, chapters, debounced]);

  return (
    <>
      <div className="field">
        <input
          type="text"
          autoFocus
          placeholder="Find in this book…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {debounced.length >= 2 && (
          <p className="hint">
            {hits.length === 200 ? '200+' : hits.length} match
            {hits.length === 1 ? '' : 'es'}
          </p>
        )}
      </div>
      {hits.map((h, i) => (
        <button key={i} className="analysis-row" onClick={() => onGo(h.chapter, h.block)}>
          <span className="meta">{chapters[h.chapter]?.title ?? '—'}</span>
          <span className="t">
            {h.context.slice(0, h.at)}
            <mark className="c3">{h.context.slice(h.at, h.at + h.length)}</mark>
            {h.context.slice(h.at + h.length)}
          </span>
        </button>
      ))}
    </>
  );
}

/* ── text to speech ─────────────────────────────────────────────────── */

/**
 * Read a chapter aloud, one block at a time.
 *
 * Speaking block by block rather than as one utterance is what makes the
 * current sentence highlightable and makes stopping immediate; a single long
 * utterance cannot be tracked or interrupted cleanly.
 */
export function useSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    void native.speechAvailable().then(setAvailable);
  }, []);

  const stop = useCallback(async () => {
    await native.stopSpeaking();
    setSpeaking(false);
  }, []);

  const start = useCallback(async (text: string): Promise<string | null> => {
    if (!available) return 'Reading aloud is unavailable on this system.';
    if (!text.trim()) return null;
    setSpeaking(true);
    try {
      await native.speak(text);
      return null;
    } catch (cause) {
      setSpeaking(false);
      const detail = cause instanceof Error ? cause.message : String(cause);
      return `Could not read this chapter aloud: ${detail}`;
    }
  }, [available]);

  // Speech outlives the window unless it is cancelled on the way out.
  useEffect(
    () => () => {
      void native.stopSpeaking();
    },
    [],
  );

  return { speaking, available, start, stop };
}

/* ── dictionary ─────────────────────────────────────────────────────── */

export interface Definition {
  partOfSpeech: string;
  sense: string;
}

/**
 * Look a word up on Wiktionary.
 *
 * The only network call this application makes, and it sends a single word —
 * never a passage, never anything identifying the book. Half of this library is
 * language-learning material, which is what earns it the exception.
 */
export async function define(word: string, lang = 'en'): Promise<Definition[]> {
  const clean = word
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}'-]/gu, '');
  if (!clean) return [];
  const url = `https://${lang}.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(clean)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok)
    throw new Error(
      res.status === 404 ? `No entry for “${clean}”.` : `Lookup failed (${res.status}).`,
    );
  const data = (await res.json()) as Record<
    string,
    { partOfSpeech?: string; definitions?: { definition?: string }[] }[]
  >;
  const strip = (html: string) =>
    html
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  return (data[lang] ?? [])
    .flatMap((entry) =>
      (entry.definitions ?? [])
        .map((d) => ({ partOfSpeech: entry.partOfSpeech ?? '', sense: strip(d.definition ?? '') }))
        .filter((d) => d.sense),
    )
    .slice(0, 6);
}
