import { useCallback, useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen } from '@tauri-apps/api/event';
import { estimateTokens } from '@chapterize/core';
import { native, type AppDirs, type BookIndex, type LoadedBook } from './native';
import { ingest, load } from './ingest';
import { BookView } from './Book';

interface Shelf { dir: string; index: BookIndex }

export function App() {
  const [dirs, setDirs] = useState<AppDirs | null>(null);
  const [shelf, setShelf] = useState<Shelf[]>([]);
  const [opened, setOpened] = useState<LoadedBook | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const importing = useRef(false);

  const refresh = useCallback(async (library: string) => {
    const found = await native.listLibrary(library);
    const books: Shelf[] = [];
    for (const dir of found) {
      const text = await native.readText(`${dir}/index.json`);
      if (text) books.push({ dir, index: JSON.parse(text) as BookIndex });
    }
    books.sort((a, b) => a.index.title.localeCompare(b.index.title));
    setShelf(books);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const resolved = await native.appDirs();
        setDirs(resolved);
        await refresh(resolved.library);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [refresh]);

  /** Split every path given, reporting each failure without abandoning the rest. */
  const importPaths = useCallback(async (paths: string[]) => {
    if (!dirs || importing.current) return;
    const epubs = paths.filter((p) => p.toLowerCase().endsWith('.epub'));
    const skipped = paths.length - epubs.length;
    if (!epubs.length) {
      setError(skipped ? 'Those files are not EPUBs. Chapterize reads .epub only.' : '');
      return;
    }

    importing.current = true;
    setError(''); setNotice('');
    const done: string[] = [];
    const failed: string[] = [];
    try {
      for (const [i, path] of epubs.entries()) {
        const name = path.split('/').pop() ?? path;
        setBusy(`Splitting ${name}${epubs.length > 1 ? ` (${i + 1}/${epubs.length})` : ''}…`);
        try {
          const result = await ingest(path, dirs.library);
          done.push(`${result.index.title} — ${result.index.chapters.length} chapters`);
          if (result.warnings.length) failed.push(`${result.index.title}: ${result.warnings.join(' ')}`);
        } catch (e) {
          failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await refresh(dirs.library);
      if (done.length) setNotice(`Added ${done.join(' · ')}`);
      if (failed.length) setError(failed.join('\n'));
      if (skipped) setError((prev) => [prev, `${skipped} non-EPUB file ignored.`].filter(Boolean).join('\n'));
    } finally {
      importing.current = false;
      setBusy('');
    }
  }, [dirs, refresh]);

  const pickBooks = useCallback(async () => {
    const picked = await open({
      multiple: true,
      title: 'Add books',
      filters: [{ name: 'EPUB books', extensions: ['epub'] }],
    });
    if (!picked) return;
    await importPaths(Array.isArray(picked) ? picked : [picked]);
  }, [importPaths]);

  // Books opened from the file manager, or passed to a second launch that the
  // single-instance guard routed here instead of starting another copy.
  const drainPending = useCallback(async () => {
    const queued = await native.pendingFiles();
    if (queued.length) await importPaths(queued);
  }, [importPaths]);

  useEffect(() => {
    if (!dirs) return;
    void drainPending();
    const unlisten = listen('files-opened', () => void drainPending());
    return () => { void unlisten.then((f) => f()); };
  }, [dirs, drainPending]);

  // Dropping books on the window is the other half of "books live anywhere".
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'over') setDropping(true);
      else if (event.payload.type === 'drop') {
        setDropping(false);
        void importPaths(event.payload.paths);
      } else setDropping(false);
    });
    return () => { void unlisten.then((f) => f()); };
  }, [importPaths]);

  const openBook = useCallback(async (dir: string) => {
    setError(''); setBusy('Opening…');
    try { setOpened(await load(dir)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  }, []);

  const deleteBook = useCallback(async (dir: string) => {
    if (!dirs) return;
    setConfirming(null);
    try {
      await native.removeBook(dir);
      await refresh(dirs.library);
      setNotice('Book removed. The file you imported from was not touched.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [dirs, refresh]);

  /** Chapter Markdown plus your highlights, written wherever you choose. */
  const doExport = useCallback(async (which: number | 'all') => {
    if (!opened) return;
    const target = await open({ directory: true, title: 'Export chapters to…' });
    if (typeof target !== 'string') return;

    setBusy('Exporting…');
    try {
      const wanted = which === 'all' ? opened.index.chapters : [opened.index.chapters[which]!];
      let written = 0;
      for (const chapter of wanted) {
        const body = await native.readText(`${opened.dir}/chapters/${chapter.file}`);
        if (body === null) continue;
        const notes = opened.annotations.filter((a) => a.block >= chapter.start && a.block < chapter.end);
        const suffix = notes.length
          ? '\n\n---\n\n## My highlights\n\n' +
            notes.map((a) => `> ${a.quote}\n${a.note ? `\n${a.note}\n` : ''}`).join('\n')
          : '';
        await native.writeText(`${target}/${chapter.file}`, body + suffix);
        written++;
      }
      setNotice(`Exported ${written} chapter${written === 1 ? '' : 's'} to ${target}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, [opened]);

  if (!dirs && !error) return <div className="empty">Starting…</div>;

  if (opened) {
    return (
      <div className="app">
        <BookView book={opened} onBack={() => setOpened(null)} onExport={(c) => void doExport(c)} />
      </div>
    );
  }

  return (
    <div className={`app${dropping ? ' dropping' : ''}`}>
      <div className="topbar">
        <h1>Chapterize</h1>
        <span className="sub">one chapter at a time</span>
        <span className="spacer" />
        {busy && <span className="sub">{busy}</span>}
        <button className="btn primary" onClick={() => void pickBooks()} disabled={busy !== ''}>
          Add books…
        </button>
      </div>

      <div className="library">
        {error && <div className="banner error">{error}</div>}
        {notice && <div className="banner">{notice}</div>}

        {shelf.length === 0 ? (
          <div className="welcome">
            <div className="welcome-mark" aria-hidden="true" />
            <h2>Your library is empty</h2>
            <p>
              Add an EPUB from anywhere on your computer. Chapterize splits it into one
              file per chapter, so you can read — and question — a single chapter without
              the rest of the book crowding the answer.
            </p>
            <button className="btn primary big" onClick={() => void pickBooks()}>Add books…</button>
            <p className="hint">or drop EPUB files onto this window</p>
          </div>
        ) : (
          <>
            <div className="section-title">{shelf.length} book{shelf.length === 1 ? '' : 's'}</div>
            <div className="grid">
              {shelf.map(({ dir, index }) => {
                const tokens = index.chapters.reduce((sum, c) => sum + estimateTokens(c.chars), 0);
                const pct = Math.round((index.finished.length / Math.max(1, index.chapters.length)) * 100);
                return (
                  <div key={dir} className="card book">
                    <button className="card-main" onClick={() => void openBook(dir)}>
                      <div className="title">{index.title}</div>
                      <div className="author">{index.author ?? '—'}</div>
                      <div className="stats">
                        {index.chapters.length} chapters · ≈{(tokens / 1000).toFixed(0)}k tokens
                      </div>
                      <div className="bar"><span style={{ width: `${pct}%` }} /></div>
                      <div className="stats">{index.finished.length} of {index.chapters.length} read</div>
                    </button>
                    <div className="card-tools">
                      <button className="btn ghost tiny" title="Show in file manager"
                              onClick={() => void revealItemInDir(`${dir}/index.json`)}>Reveal</button>
                      <button className="btn ghost tiny danger" onClick={() => setConfirming(dir)}>Remove</button>
                    </div>
                    {confirming === dir && (
                      <div className="confirm">
                        <span>Remove this book and its chapters?</span>
                        <div className="row">
                          <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
                          <button className="btn danger" onClick={() => void deleteBook(dir)}>Remove</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="keys">
        <span>Books are split on this machine. Nothing is uploaded.</span>
        <span className="spacer" />
        {dirs && (
          <button className="btn ghost tiny" title={dirs.library}
                  onClick={() => void revealItemInDir(dirs.library)}>
            Library folder
          </button>
        )}
      </div>

      {dropping && <div className="dropzone"><span>Drop EPUB files to add them</span></div>}
    </div>
  );
}
