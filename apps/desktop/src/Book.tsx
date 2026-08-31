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

/** One inline tag stack plus highlight, covering a run of characters. */
interface Run {
  text: string;
  tags: string[];
  mark: Annotation | null;
}

const TAG_RE = /<(\/?)([a-z]+)>/g;

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Lay the block's highlights over its inline markup.
 *
 * Highlight ranges are offsets into plain text, while emphasis lives in the
 * HTML, so inserting <mark> into the markup directly would produce crossed tags
 * (`<em>a<mark>b</em>c</mark>`). Instead every character is resolved to its tag
 * stack and its highlight, then equal neighbours are grouped — which cannot
 * produce invalid nesting because each run is emitted whole.
 */
function runs(html: string, text: string, marks: Annotation[]): Run[] {
  const chars: { ch: string; tags: string[] }[] = [];
  const stack: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;

  const pushText = (raw: string): void => {
    for (const ch of decodeEntities(raw)) chars.push({ ch, tags: [...stack] });
  };

  while ((match = TAG_RE.exec(html)) !== null) {
    pushText(html.slice(last, match.index));
    if (match[1]) stack.pop();
    else stack.push(match[2]!);
    last = match.index + match[0].length;
  }
  pushText(html.slice(last));

  // Fall back to plain text if the markup and the text ever disagree; offsets
  // must index into exactly what the annotation was recorded against.
  const source = chars.length === text.length
    ? chars
    : [...text].map((ch) => ({ ch, tags: [] as string[] }));

  const markAt = (i: number): Annotation | null =>
    marks.find((m) => i >= m.start && i < m.end) ?? null;

  const out: Run[] = [];
  source.forEach((c, i) => {
    const mark = markAt(i);
    const prev = out[out.length - 1];
    const key = c.tags.join(',');
    if (prev && prev.tags.join(',') === key && prev.mark === mark) prev.text += c.ch;
    else out.push({ text: c.ch, tags: c.tags, mark });
  });
  return out;
}

function renderRun(run: Run, key: number) {
  let node: React.ReactNode = run.text;
  for (const tag of [...run.tags].reverse()) {
    if (tag === 'strong' || tag === 'b') node = <strong>{node}</strong>;
    else if (tag === 'em' || tag === 'i') node = <em>{node}</em>;
    else if (tag === 'sup') node = <sup>{node}</sup>;
    else if (tag === 'sub') node = <sub>{node}</sub>;
    else if (tag === 'code') node = <code>{node}</code>;
    else if (tag === 'u') node = <u>{node}</u>;
    else node = <span>{node}</span>;
  }
  return run.mark
    ? <mark key={key} className={`c${run.mark.color}`} title={run.mark.note || undefined}>{node}</mark>
    : <span key={key}>{node}</span>;
}

function BlockView({
  block, index, marks, imageUrls,
}: { block: Block; index: number; marks: Annotation[]; imageUrls: Map<string, string> }) {
  if (block.image) {
    const src = imageUrls.get(block.image);
    return (
      <figure data-block={index} className="figure">
        {src
          ? <img src={src} alt={block.alt ?? ''} loading="lazy" />
          : <span className="figure-missing">Figure not found in this book</span>}
        {block.alt && <figcaption>{block.alt}</figcaption>}
      </figure>
    );
  }

  const content = runs(block.html || block.text, block.text, marks).map(renderRun);
  const props = { 'data-block': index };
  if (block.heading === 1) return <h1 {...props}>{content}</h1>;
  if (block.heading === 2) return <h2 {...props}>{content}</h2>;
  if (block.heading >= 3) return <h3 {...props}>{content}</h3>;
  if (block.tag === 'blockquote') return <blockquote {...props}>{content}</blockquote>;
  if (block.tag === 'li') return <li {...props}>{content}</li>;
  return <p {...props}>{content}</p>;
}

const WIDTH_KEY = 'chapterize.panes.v1';
const LIMITS = { left: [190, 560], right: [180, 560] } as const;

function loadWidths(): { left: number; right: number } {
  try {
    const stored = localStorage.getItem(WIDTH_KEY);
    if (stored) return JSON.parse(stored) as { left: number; right: number };
  } catch { /* fall through to defaults */ }
  return { left: 288, right: 268 };
}

/**
 * Drag handle between panes. Width is committed on every move so the layout
 * tracks the cursor, and persisted so it survives closing the book.
 */
function Resizer({ side, width, onChange }: {
  side: 'left' | 'right';
  width: number;
  onChange: (next: number) => void;
}) {
  const start = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const originX = event.clientX;
    const originWidth = width;
    const [min, max] = LIMITS[side];

    const move = (e: MouseEvent): void => {
      const delta = side === 'left' ? e.clientX - originX : originX - e.clientX;
      onChange(Math.max(min, Math.min(max, originWidth + delta)));
    };
    const stop = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    // Suppress selection while dragging, or the reader text highlights instead.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  }, [onChange, side, width]);

  return <div className="resizer" onMouseDown={start} role="separator" aria-orientation="vertical" />;
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
  const [widths, setWidths] = useState(loadWidths);
  const readerRef = useRef<HTMLDivElement>(null);

  const setPane = useCallback((side: 'left' | 'right', next: number) => {
    setWidths((current) => {
      const updated = { ...current, [side]: next };
      localStorage.setItem(WIDTH_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

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
        <div className="pane left" style={{ flexBasis: widths.left }}>
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

        <Resizer side="left" width={widths.left} onChange={(n) => setPane('left', n)} />

        <div className="pane center">
          <div className="pane-body" ref={readerRef} onMouseUp={capture}>
            <div className="reader" style={{ ['--reader-size' as string]: `${size}px` }}>
              <div className="reader-title">
                <h2>{chapter.title}</h2>
                <div className="prov">
                  {chapter.index + 1} of {index.chapters.length} in reading order ·
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
                    imageUrls={book.imageUrls}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <Resizer side="right" width={widths.right} onChange={(n) => setPane('right', n)} />

        <div className="pane right" style={{ flexBasis: widths.right }}>
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
