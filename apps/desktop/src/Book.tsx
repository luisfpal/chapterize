import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Block } from '@chapterize/core';
import { estimateTokens } from '@chapterize/core';
import { native, type Annotation, type BookIndex, type LoadedBook } from './native';

const COLORS = [1, 2, 3, 4] as const;

/** Character offset of `node`/`offset` within the rendered block's text. */
function offsetWithin(root: Element, node: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) return total + offset;
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return total;
}

/** Split one block's text around its highlights so each can be marked. */
function segments(text: string, marks: Annotation[]) {
  if (!marks.length) return [{ text, mark: null as Annotation | null }];
  const ordered = [...marks].sort((a, b) => a.start - b.start);
  const out: { text: string; mark: Annotation | null }[] = [];
  let at = 0;
  for (const m of ordered) {
    const start = Math.max(at, Math.min(m.start, text.length));
    const end = Math.max(start, Math.min(m.end, text.length));
    if (start > at) out.push({ text: text.slice(at, start), mark: null });
    if (end > start) out.push({ text: text.slice(start, end), mark: m });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: null });
  return out;
}

function BlockView({ block, index, marks }: { block: Block; index: number; marks: Annotation[] }) {
  const parts = segments(block.text, marks);
  const content = parts.map((p, i) =>
    p.mark
      ? <mark key={i} className={`c${p.mark.color}`} title={p.mark.note || undefined}>{p.text}</mark>
      : <span key={i}>{p.text}</span>,
  );
  const props = { 'data-block': index };
  if (block.heading === 1) return <h1 {...props}>{content}</h1>;
  if (block.heading === 2) return <h2 {...props}>{content}</h2>;
  if (block.heading >= 3) return <h3 {...props}>{content}</h3>;
  if (block.tag === 'blockquote') return <blockquote {...props}>{content}</blockquote>;
  if (block.tag === 'li') return <li {...props}>{content}</li>;
  return <p {...props}>{content}</p>;
}

interface Props {
  book: LoadedBook;
  onBack: () => void;
  onExport: (chapterIndex: number | 'all') => void;
}

export function BookView({ book, onBack, onExport }: Props) {
  const [index, setIndex] = useState<BookIndex>(book.index);
  const [annotations, setAnnotations] = useState<Annotation[]>(book.annotations);
  const [current, setCurrent] = useState(firstUnread(book.index));
  const [pending, setPending] = useState<Omit<Annotation, 'note'> | null>(null);
  const [draft, setDraft] = useState('');
  const [size, setSize] = useState(18);
  const readerRef = useRef<HTMLDivElement>(null);

  const chapter = index.chapters[current];

  const save = useCallback(async (next: Annotation[]) => {
    setAnnotations(next);
    await native.writeText(`${book.dir}/annotations.json`, JSON.stringify(next, null, 2));
  }, [book.dir]);

  const saveIndex = useCallback(async (next: BookIndex) => {
    setIndex(next);
    await native.writeText(`${book.dir}/index.json`, JSON.stringify(next, null, 2));
  }, [book.dir]);

  // Reset scroll when the chapter changes; a reader should never open mid-page.
  useEffect(() => { readerRef.current?.scrollTo({ top: 0 }); }, [current]);

  const chapterAnnotations = useMemo(
    () => chapter
      ? annotations.filter((a) => a.block >= chapter.start && a.block < chapter.end)
      : [],
    [annotations, chapter],
  );
  const byBlock = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const a of chapterAnnotations) {
      const list = map.get(a.block) ?? [];
      list.push(a);
      map.set(a.block, list);
    }
    return map;
  }, [chapterAnnotations]);

  const capture = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString().trim();
    if (!text) return;

    const anchor = selection.anchorNode;
    const host = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('[data-block]');
    if (!host) return;
    const block = Number(host.getAttribute('data-block'));
    const range = selection.getRangeAt(0);
    const start = offsetWithin(host, range.startContainer, range.startOffset);
    const end = offsetWithin(host, range.endContainer, range.endOffset);
    if (end <= start) return;

    setPending({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      block, start, end, quote: text, color: 1, createdAt: new Date().toISOString(),
    });
    setDraft('');
  }, []);

  const commit = useCallback(async (color: Annotation['color']) => {
    if (!pending) return;
    await save([...annotations, { ...pending, color, note: draft.trim() }]);
    setPending(null);
    setDraft('');
    window.getSelection()?.removeAllRanges();
  }, [annotations, draft, pending, save]);

  const go = useCallback((delta: number) => {
    setCurrent((c) => Math.min(index.chapters.length - 1, Math.max(0, c + delta)));
  }, [index.chapters.length]);

  const toggleFinished = useCallback(async () => {
    const set = new Set(index.finished);
    if (set.has(current)) set.delete(current); else set.add(current);
    await saveIndex({ ...index, finished: [...set].sort((a, b) => a - b) });
  }, [current, index, saveIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
      if (e.key === 'n') go(1);
      else if (e.key === 'p') go(-1);
      else if (e.key === 'j') readerRef.current?.scrollBy({ top: 120 });
      else if (e.key === 'k') readerRef.current?.scrollBy({ top: -120 });
      else if (e.key === 'h') capture();
      else if (e.key === 'm') void toggleFinished();
      else if (e.key === 'Escape') { setPending(null); onBack(); }
      else if (e.key === '=' || e.key === '+') setSize((s) => Math.min(26, s + 1));
      else if (e.key === '-') setSize((s) => Math.max(13, s - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [capture, go, onBack, toggleFinished]);

  if (!chapter) return <div className="empty">This book has no chapters.</div>;

  return (
    <>
      <div className="topbar">
        <button className="btn ghost" onClick={onBack} title="Back to library (Esc)">←</button>
        <h1>{index.title}</h1>
        <span className="sub">{index.author}</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => setSize((s) => Math.max(13, s - 1))}>A−</button>
        <button className="btn ghost" onClick={() => setSize((s) => Math.min(26, s + 1))}>A+</button>
        <button className="btn" onClick={() => onExport(current)}>Export chapter</button>
        <button className="btn primary" onClick={() => onExport('all')}>Export all</button>
      </div>

      <div className="panes">
        <div className="pane left">
          <div className="pane-head">
            Chapters
            <span className="spacer" />
            <span>{index.finished.length}/{index.chapters.length} read</span>
          </div>
          <div className="pane-body">
            {index.chapters.map((c, i) => (
              <button
                key={c.index}
                className={`chapter${index.finished.includes(i) ? ' read' : ''}`}
                aria-current={i === current}
                onClick={() => setCurrent(i)}
              >
                <span className="t">
                  {index.finished.includes(i) && <span className="dot" />}
                  {c.title}
                </span>
                <span className="n">{String(c.index).padStart(3, '0')}</span>
                <span className="meta">≈{estimateTokens(c.chars).toLocaleString()} tokens</span>
              </button>
            ))}
          </div>
        </div>

        <div className="pane center">
          <div className="pane-body" ref={readerRef} onMouseUp={capture}>
            <div className="reader" style={{ ['--reader-size' as string]: `${size}px` }}>
              <div className="reader-title">
                <h2>{chapter.title}</h2>
                <div className="prov">
                  Chapter {chapter.index} of {index.chapters.length - 1} ·
                  {' '}≈{estimateTokens(chapter.chars).toLocaleString()} tokens (estimated)
                </div>
              </div>
              <div className="reader-col">
                {book.blocks.slice(chapter.start, chapter.end).map((b, i) => (
                  <BlockView
                    key={chapter.start + i}
                    block={b}
                    index={chapter.start + i}
                    marks={byBlock.get(chapter.start + i) ?? []}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="pane right">
          <div className="pane-head">
            Notes<span className="spacer" />{chapterAnnotations.length}
          </div>
          <div className="pane-body">
            {pending && (
              <div className="field">
                <label>New highlight</label>
                <div className="note" style={{ padding: 0, border: 0, cursor: 'default' }}>
                  <div className="quote">{pending.quote}</div>
                </div>
                <textarea
                  autoFocus
                  placeholder="Why does this matter? (optional)"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  style={{ marginTop: 8 }}
                />
                <div className="row" style={{ marginTop: 8 }}>
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      className="btn"
                      title={`Save with colour ${c}`}
                      onClick={() => void commit(c)}
                      style={{ background: `var(--hl-${c})`, width: 30, height: 26 }}
                    />
                  ))}
                  <span className="spacer" />
                  <button className="btn ghost" onClick={() => setPending(null)}>Cancel</button>
                </div>
              </div>
            )}
            {!pending && chapterAnnotations.length === 0 && (
              <div className="empty">Select text in the chapter to highlight it.</div>
            )}
            {chapterAnnotations.map((a) => (
              <div key={a.id} className="note" onClick={() => void save(annotations.filter((x) => x.id !== a.id))}
                   title="Click to delete">
                <div className="quote" style={{ borderLeftColor: `var(--hl-${a.color})` }}>{a.quote}</div>
                {a.note && <div className="body">{a.note}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="keys">
        <span><kbd>j</kbd><kbd>k</kbd> scroll</span>
        <span><kbd>n</kbd><kbd>p</kbd> chapter</span>
        <span><kbd>h</kbd> highlight selection</span>
        <span><kbd>m</kbd> mark read</span>
        <span><kbd>−</kbd><kbd>+</kbd> text size</span>
        <span><kbd>Esc</kbd> library</span>
      </div>
    </>
  );
}

function firstUnread(index: BookIndex): number {
  for (let i = 0; i < index.chapters.length; i++) {
    if (!index.finished.includes(i)) return i;
  }
  return 0;
}
