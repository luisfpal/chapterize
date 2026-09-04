import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Block, CutPoint } from '@chapterize/core';
import { readingMinutes, splitAt, mergeUp, retitle } from '@chapterize/core';
import { writeText as copyToClipboard } from '@tauri-apps/plugin-clipboard-manager';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { native, type Annotation, type BookIndex, type LoadedBook } from './native';
import { saveSplit } from './ingest';
import { Analysis } from './Analysis';
import { SearchPanel, useSpeech, define, type Definition } from './Tools';

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
    else if (tag === 'noteref') node = <>{node}</>;
    else node = <span>{node}</span>;
  }
  return run.mark
    ? <mark key={key} className={`c${run.mark.color}`} title={run.mark.note || undefined}>{node}</mark>
    : <span key={key}>{node}</span>;
}

function BlockView({
  block, index, marks, imageUrls, onNote,
}: {
  block: Block; index: number; marks: Annotation[];
  imageUrls: Map<string, string>;
  onNote: (key: string) => void;
}) {
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

  let noteSeq = 0;
  const content = runs(block.html || block.text, block.text, marks).map((run, i) => {
    if (!run.tags.includes('noteref')) return renderRun(run, i);
    const ref = block.noterefs?.[noteSeq++];
    return (
      <sup key={i} className="noteref" role="button" tabIndex={0}
           title="Show this footnote"
           onClick={(e) => { e.stopPropagation(); if (ref) onNote(ref.key); }}>
        {run.text}
      </sup>
    );
  });
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
  const [current, setCurrent] = useState(() => resumeAt(book.index));
  const [pending, setPending] = useState<Omit<Annotation, 'note'> | null>(null);
  const [draft, setDraft] = useState('');
  const [size, setSize] = useState(18);
  const [widths, setWidths] = useState(loadWidths);
  const [tab, setTab] = useState<'notes' | 'analysis' | 'search'>('notes');
  const [lookup, setLookup] = useState<{ word: string; defs: Definition[]; error: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cuts, setCuts] = useState<CutPoint[] | null>(null);
  const [history, setHistory] = useState<CutPoint[][]>([]);
  const [note, setNote] = useState<{ key: string; text: string } | null>(null);
  const [flash, setFlash] = useState('');
  const readerRef = useRef<HTMLDivElement>(null);

  const chapter = index.chapters[current];
  const speech = useSpeech();

  /** Jump to a search hit: switch chapter, then scroll the block into view. */
  const goToBlock = useCallback((chapterIndex: number, block: number) => {
    if (chapterIndex >= 0) setCurrent(chapterIndex);
    window.setTimeout(() => {
      readerRef.current
        ?.querySelector(`[data-block="${block}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
  }, []);

  /** Double-clicking a word looks it up — this library is half language study. */
  const onDoubleClick = useCallback(async () => {
    const word = window.getSelection()?.toString().trim() ?? '';
    if (!word || /\s/.test(word)) return;
    setLookup({ word, defs: [], error: '' });
    try {
      setLookup({ word, defs: await define(word), error: '' });
    } catch (e) {
      setLookup({ word, defs: [], error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const setPane = useCallback((side: 'left' | 'right', next: number) => {
    setWidths((c) => {
      const updated = { ...c, [side]: next };
      localStorage.setItem(WIDTH_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const save = useCallback(async (next: Annotation[]) => {
    setAnnotations(next);
    await native.writeText(`${book.dir}/annotations.json`, JSON.stringify(next, null, 2));
  }, [book.dir]);

  const saveIndex = useCallback(async (next: BookIndex) => {
    setIndex(next);
    await native.writeText(`${book.dir}/index.json`, JSON.stringify(next, null, 2));
  }, [book.dir]);

  const say = useCallback((message: string) => {
    setFlash(message);
    window.setTimeout(() => setFlash(''), 2600);
  }, []);

  /* ── reading position ────────────────────────────────────────────── */

  // Restore on chapter change; a reader that always opens at the top forgets
  // where you were, which is the whole point of tracking progress.
  useEffect(() => {
    const pane = readerRef.current;
    if (!pane) return;
    const fraction = index.progress[String(current)] ?? 0;
    requestAnimationFrame(() => {
      pane.scrollTop = fraction * Math.max(1, pane.scrollHeight - pane.clientHeight);
    });
  }, [current, index.progress]);

  // Persist on a timer rather than on every scroll event, so reading a chapter
  // is not thousands of writes to index.json.
  useEffect(() => {
    const pane = readerRef.current;
    if (!pane || editing) return;
    let timer = 0;
    const onScroll = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const span = Math.max(1, pane.scrollHeight - pane.clientHeight);
        const fraction = Math.min(1, Math.max(0, pane.scrollTop / span));
        setIndex((prev) => {
          const next: BookIndex = {
            ...prev,
            progress: { ...prev.progress, [String(current)]: fraction },
            lastChapter: current,
          };
          void native.writeText(`${book.dir}/index.json`, JSON.stringify(next, null, 2));
          return next;
        });
      }, 800);
    };
    pane.addEventListener('scroll', onScroll, { passive: true });
    return () => { pane.removeEventListener('scroll', onScroll); window.clearTimeout(timer); };
  }, [book.dir, current, editing]);

  /* ── annotations ─────────────────────────────────────────────────── */

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
    if (editing) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString().trim();
    if (!text) return;
    const anchor = selection.anchorNode;
    const host = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('[data-block]');
    if (!host) return;
    const range = selection.getRangeAt(0);
    const start = offsetWithin(host, range.startContainer, range.startOffset);
    const end = offsetWithin(host, range.endContainer, range.endOffset);
    if (end <= start) return;
    setPending({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      block: Number(host.getAttribute('data-block')),
      start, end, quote: text, color: 1, createdAt: new Date().toISOString(),
    });
    setDraft('');
    setTab('notes');
  }, [editing]);

  const commit = useCallback(async (color: Annotation['color']) => {
    if (!pending) return;
    await save([...annotations, { ...pending, color, note: draft.trim() }]);
    setPending(null);
    setDraft('');
    window.getSelection()?.removeAllRanges();
  }, [annotations, draft, pending, save]);

  /* ── split editing ───────────────────────────────────────────────── */

  const enterEdit = useCallback(() => {
    setCuts(index.chapters.map((c) => ({
      at: c.start, title: c.title, source: 'manual' as const, depth: 0,
    })));
    setHistory([]);
    setEditing(true);
  }, [index.chapters]);

  const apply = useCallback((next: CutPoint[]) => {
    setCuts((prev) => {
      if (prev) setHistory((h) => [...h.slice(-49), prev]);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      const last = h[h.length - 1];
      if (last) setCuts(last);
      return h.slice(0, -1);
    });
  }, []);

  const commitSplit = useCallback(async () => {
    if (!cuts) return;
    try {
      const next = await saveSplit(book, cuts);
      setIndex(next);
      setCurrent((c) => Math.min(c, next.chapters.length - 1));
      setEditing(false);
      setCuts(null);
      setHistory([]);
      say(`Saved — ${next.chapters.length} chapters rewritten. analysis/ untouched.`);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  }, [book, cuts, say]);

  /* ── paths for agents ────────────────────────────────────────────── */

  const copy = useCallback(async (value: string, label: string) => {
    await copyToClipboard(value);
    say(`Copied ${label}`);
  }, [say]);

  const agentPrompt = useCallback(() => {
    if (!chapter) return '';
    return [
      `Book: ${index.title}${index.author ? ` — ${index.author}` : ''}`,
      `Chapter: ${chapter.title}  (~${readingMinutes(chapter.words)} min)`,
      `Read:  ${book.dir}/chapters/${chapter.file}`,
      `Write: ${book.dir}/analysis/`,
      '',
      `Name what you write ${String(chapter.index).padStart(3, '0')}-<what-it-is>.md so it appears beside this chapter.`,
    ].join('\n');
  }, [book.dir, chapter, index.author, index.title]);

  /* ── keyboard ────────────────────────────────────────────────────── */

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
      else if (e.key === 'h' && !editing) capture();
      else if (e.key === 'm' && !editing) void toggleFinished();
      else if (e.key === 'e') editing ? setEditing(false) : enterEdit();
      else if (e.key === '/') { e.preventDefault(); setTab('search'); }
      else if (e.key === 'u' && editing) undo();
      else if (e.key === 'Escape') {
        if (lookup) setLookup(null);
        else if (speech.speaking) void speech.stop();
        else if (note) setNote(null);
        else if (pending) setPending(null);
        else if (editing) { setEditing(false); setCuts(null); }
        else onBack();
      }
      else if (e.key === '=' || e.key === '+') setSize((v) => Math.min(26, v + 1));
      else if (e.key === '-') setSize((v) => Math.max(13, v - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [capture, editing, enterEdit, go, note, onBack, pending, toggleFinished, undo]);

  if (!chapter) return <div className="empty">This book has no chapters.</div>;

  // One shape for the list whichever mode is active, so the row does not have to
  // discriminate a union while rendering.
  const rows: { title: string; detail: string }[] = editing && cuts
    ? cuts.map((c) => ({ title: c.title, detail: `block ${c.at}` }))
    : index.chapters.map((c) => ({ title: c.title, detail: `~${readingMinutes(c.words)} min` }));

  return (
    <>
      <div className="topbar">
        <button className="btn ghost" onClick={onBack} title="Back to library (Esc)">←</button>
        <h1>{index.title}</h1>
        <span className="sub">{index.author}</span>
        <span className="spacer" />
        {flash && <span className="sub flash">{flash}</span>}
        {editing ? (
          <>
            <button className="btn ghost" disabled={!history.length} onClick={undo} title="Undo (u)">Undo</button>
            <button className="btn" onClick={() => { setEditing(false); setCuts(null); }}>Cancel</button>
            <button className="btn primary" onClick={() => void commitSplit()}>Save split</button>
          </>
        ) : (
          <>
            {speech.available && (
              <button className="btn ghost" title={speech.speaking ? 'Stop reading aloud' : 'Read this chapter aloud'}
                      onClick={() => void (speech.speaking
                        ? speech.stop()
                        : speech.start(
                            book.blocks.slice(chapter.start, chapter.end)
                              .map((b) => b.text).filter((t) => t.length > 1).join('. ')))}>
                {speech.speaking ? '■ Stop' : '▶ Listen'}
              </button>
            )}
            <button className="btn ghost" onClick={() => setSize((v) => Math.max(13, v - 1))}>A−</button>
            <button className="btn ghost" onClick={() => setSize((v) => Math.min(26, v + 1))}>A+</button>
            <button className="btn" onClick={enterEdit} title="Edit chapter boundaries (e)">Edit split</button>
            <button className="btn primary" onClick={() => setExporting(true)}>Export…</button>
          </>
        )}
      </div>

      <div className="panes">
        <div className="pane left" style={{ flexBasis: widths.left }}>
          <div className="pane-head">
            Chapters<span className="spacer" />
            {editing ? `${cuts?.length ?? 0} after edit` : `${index.finished.length}/${index.chapters.length} read`}
          </div>
          <div className="pane-body">
            {rows.map((c, i) => (
              <div key={i} className="chapter-row">
                <button
                  className={`chapter${!editing && index.finished.includes(i) ? ' read' : ''}`}
                  aria-current={i === current}
                  onClick={() => setCurrent(i)}
                >
                  <span className="t">
                    {!editing && index.finished.includes(i) && <span className="dot" />}
                    {c.title}
                  </span>
                  <span className="n">{String(i).padStart(3, '0')}</span>
                  <span className="meta">{c.detail}</span>
                </button>
                {editing && i > 0 && cuts && (
                  <div className="chapter-tools">
                    <button className="btn ghost tiny" title="Merge into the chapter above (m)"
                            onClick={() => apply(mergeUp(cuts, i))}>Merge up</button>
                    <button className="btn ghost tiny" title="Rename"
                            onClick={() => {
                              const name = window.prompt('Chapter title', c.title);
                              if (name !== null) apply(retitle(cuts, i, name.trim() || c.title));
                            }}>Rename</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <Resizer side="left" width={widths.left} onChange={(n) => setPane('left', n)} />

        <div className="pane center">
          <div className="pane-body" ref={readerRef} onMouseUp={capture}
               onDoubleClick={() => void onDoubleClick()}>
            <div className="reader" style={{ ['--reader-size' as string]: `${size}px` }}>
              <div className="reader-title">
                <h2>{chapter.title}</h2>
                <div className="prov">
                  {chapter.index + 1} of {index.chapters.length} in reading order ·
                  {' '}~{readingMinutes(chapter.words)} min read
                </div>
              </div>
              <div className={`reader-col${editing ? ' editing' : ''}`}>
                {book.blocks.slice(chapter.start, chapter.end).map((b, i) => {
                  const at = chapter.start + i;
                  return (
                    <div key={at}>
                      {editing && cuts && i > 0 && (
                        <button className="cutter" title={`Start a new chapter here (block ${at})`}
                                onClick={() => apply(splitAt(cuts, at, 'Untitled'))}>
                          <span>split here</span>
                        </button>
                      )}
                      <BlockView
                        block={b} index={at}
                        marks={byBlock.get(at) ?? []}
                        imageUrls={book.imageUrls}
                        onNote={(key) => setNote({ key, text: book.notes.get(key) ?? 'Note not found.' })}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <Resizer side="right" width={widths.right} onChange={(n) => setPane('right', n)} />

        <div className="pane right" style={{ flexBasis: widths.right }}>
          <div className="tabs">
            <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>
              Notes {chapterAnnotations.length > 0 && <b>{chapterAnnotations.length}</b>}
            </button>
            <button className={tab === 'analysis' ? 'on' : ''} onClick={() => setTab('analysis')}>
              Analysis
            </button>
            <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>
              Find
            </button>
          </div>

          {tab === 'analysis' ? (
            <Analysis dir={book.dir} chapterIndex={chapter.index} />
          ) : tab === 'search' ? (
            <div className="pane-body">
              <SearchPanel blocks={book.blocks} chapters={index.chapters} onGo={goToBlock} />
            </div>
          ) : (
            <div className="pane-body">
              {pending && (
                <div className="field">
                  <label>New highlight</label>
                  <div className="quote">{pending.quote}</div>
                  <textarea autoFocus placeholder="Why does this matter? (optional)"
                            value={draft} onChange={(e) => setDraft(e.target.value)}
                            style={{ marginTop: 8 }} />
                  <div className="row" style={{ marginTop: 8 }}>
                    {COLORS.map((c) => (
                      <button key={c} className="btn" title={`Save with colour ${c}`}
                              onClick={() => void commit(c)}
                              style={{ background: `var(--hl-${c})`, width: 30, height: 26 }} />
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
                <div key={a.id} className="note" title="Click to delete"
                     onClick={() => void save(annotations.filter((x) => x.id !== a.id))}>
                  <div className="quote" style={{ borderLeftColor: `var(--hl-${a.color})` }}>{a.quote}</div>
                  {a.note && <div className="body">{a.note}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="pathbar">
        <span className="label">For your agents</span>
        <button className="btn tiny" title="Puts the book, chapter, and both folder paths on the clipboard"
                onClick={() => void copy(agentPrompt(), 'a ready prompt')}>
          Copy for agent
        </button>
        <button className="btn ghost tiny" onClick={() => void revealItemInDir(`${book.dir}/index.json`)}>
          Open folder
        </button>
        <span className="spacer" />
        {flash && <span className="sub flash">{flash}</span>}
      </div>

      <div className="keys">
        <span><kbd>j</kbd><kbd>k</kbd> scroll</span>
        <span><kbd>n</kbd><kbd>p</kbd> chapter</span>
        {editing
          ? <><span><kbd>u</kbd> undo</span><span><kbd>e</kbd> leave edit</span></>
          : <><span><kbd>h</kbd> highlight</span><span><kbd>m</kbd> mark read</span><span><kbd>e</kbd> edit split</span></>}
        <span><kbd>/</kbd> find</span>
        <span>double-click a word to define it</span>
        <span><kbd>−</kbd><kbd>+</kbd> size</span>
        <span><kbd>Esc</kbd> back</span>
      </div>

      {exporting && (
        <div className="note-popup" role="dialog" onClick={() => setExporting(false)}>
          <div className="note-popup-inner" onClick={(e) => e.stopPropagation()}>
            <div className="pane-head">Export as Markdown<span className="spacer" />
              <button className="btn ghost tiny" onClick={() => setExporting(false)}>Close</button>
            </div>
            <div className="define">
              <p className="hint">Writes files to a folder you choose, with your highlights appended.</p>
              <div className="row">
                <button className="btn" onClick={() => { setExporting(false); onExport(current); }}>
                  This chapter
                </button>
                <button className="btn primary" onClick={() => { setExporting(false); onExport('all'); }}>
                  All {index.chapters.length} chapters
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {lookup && (
        <div className="note-popup" role="dialog" onClick={() => setLookup(null)}>
          <div className="note-popup-inner" onClick={(e) => e.stopPropagation()}>
            <div className="pane-head">
              {lookup.word}<span className="spacer" />
              <button className="btn ghost tiny" onClick={() => setLookup(null)}>Close</button>
            </div>
            <div className="define">
              {lookup.error && <p className="hint">{lookup.error}</p>}
              {!lookup.error && !lookup.defs.length && <p className="hint">Looking up…</p>}
              {lookup.defs.map((d, i) => (
                <p key={i}><em>{d.partOfSpeech}</em> {d.sense}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      {note && (
        <div className="note-popup" role="dialog" onClick={() => setNote(null)}>
          <div className="note-popup-inner" onClick={(e) => e.stopPropagation()}>
            <div className="pane-head">Footnote<span className="spacer" />
              <button className="btn ghost tiny" onClick={() => setNote(null)}>Close</button>
            </div>
            <p>{note.text}</p>
          </div>
        </div>
      )}
    </>
  );
}

/** Reopen where the reader stopped, else the first unread chapter. */
function resumeAt(index: BookIndex): number {
  if (index.lastChapter !== undefined && index.chapters[index.lastChapter]) {
    return index.lastChapter;
  }
  for (let i = 0; i < index.chapters.length; i++) {
    if (!index.finished.includes(i)) return i;
  }
  return 0;
}
