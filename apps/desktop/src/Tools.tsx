import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Block } from '@chapterize/core';
import { native } from './native';

/* ── search ─────────────────────────────────────────────────────────── */

export interface Hit {
  block: number;
  chapter: number;
  /** Text around the match, with the match itself marked by offsets. */
  context: string;
  at: number;
  length: number;
}

/**
 * Find a phrase across the whole book.
 *
 * Searches `Block.text`, which is the same string annotation offsets index into,
 * so a hit's position is directly usable for scrolling and highlighting.
 */
export function search(
  blocks: Block[],
  chapters: { start: number; end: number }[],
  query: string,
  limit = 200,
): Hit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const hits: Hit[] = [];
  for (let b = 0; b < blocks.length && hits.length < limit; b++) {
    const text = blocks[b]!.text;
    const hay = text.toLowerCase();
    let from = 0;
    while (hits.length < limit) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      const start = Math.max(0, at - 45);
      hits.push({
        block: b,
        chapter: chapters.findIndex((c) => b >= c.start && b < c.end),
        context: (start > 0 ? '…' : '') + text.slice(start, at + needle.length + 55),
        at: at - start + (start > 0 ? 1 : 0),
        length: needle.length,
      });
      from = at + needle.length;
    }
  }
  return hits;
}

export function SearchPanel({
  blocks, chapters, onGo,
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

  const hits = useMemo(
    () => search(blocks, chapters, debounced),
    [blocks, chapters, debounced],
  );

  return (
    <>
      <div className="field">
        <input
          type="text" autoFocus placeholder="Find in this book…"
          value={query} onChange={(e) => setQuery(e.target.value)}
        />
        {debounced.length >= 2 && (
          <p className="hint">{hits.length === 200 ? '200+' : hits.length} match
            {hits.length === 1 ? '' : 'es'}</p>
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

  useEffect(() => { void native.speechAvailable().then(setAvailable); }, []);

  const stop = useCallback(async () => {
    await native.stopSpeaking();
    setSpeaking(false);
  }, []);

  const start = useCallback(async (text: string) => {
    if (!available || !text.trim()) return;
    setSpeaking(true);
    try {
      await native.speak(text);
    } catch {
      setSpeaking(false);
    }
  }, [available]);

  // Speech outlives the window unless it is cancelled on the way out.
  useEffect(() => () => { void native.stopSpeaking(); }, []);

  return { speaking, available, start, stop };
}

/* ── dictionary ─────────────────────────────────────────────────────── */

export interface Definition { partOfSpeech: string; sense: string }

/**
 * Look a word up on Wiktionary.
 *
 * The only network call this application makes, and it sends a single word —
 * never a passage, never anything identifying the book. Half of this library is
 * language-learning material, which is what earns it the exception.
 */
export async function define(word: string, lang = 'en'): Promise<Definition[]> {
  const clean = word.trim().toLowerCase().replace(/[^\p{L}\p{M}'-]/gu, '');
  if (!clean) return [];
  const url = `https://${lang}.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(clean)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 404 ? `No entry for “${clean}”.` : `Lookup failed (${res.status}).`);
  const data = (await res.json()) as Record<string, { partOfSpeech?: string; definitions?: { definition?: string }[] }[]>;
  const strip = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return (data[lang] ?? []).flatMap((entry) =>
    (entry.definitions ?? [])
      .map((d) => ({ partOfSpeech: entry.partOfSpeech ?? '', sense: strip(d.definition ?? '') }))
      .filter((d) => d.sense),
  ).slice(0, 6);
}
