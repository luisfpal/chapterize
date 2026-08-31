import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { estimateTokens } from '@chapterize/core';
import { native, type BookIndex, type InboxEntry, type LoadedBook } from './native';
import { ingest, load } from './ingest';
import { BookView } from './Book';

interface Shelf { dir: string; index: BookIndex }

const SETTINGS_KEY = 'chapterize.settings.v1';

interface Settings { inbox: string; library: string }

function loadSettings(home: string): Settings {
  const stored = localStorage.getItem(SETTINGS_KEY);
  if (stored) {
    try { return JSON.parse(stored) as Settings; } catch { /* fall through to defaults */ }
  }
  return {
    inbox: `${home}/$CHAPTERIZE_FIXTURES/reading`,
    library: `${home}/$CHAPTERIZE_FIXTURES/library`,
  };
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [shelf, setShelf] = useState<Shelf[]>([]);
  const [inbox, setInbox] = useState<InboxEntry[]>([]);
  const [open_, setOpen] = useState<LoadedBook | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => { void native.homeDir().then((h) => setSettings(loadSettings(h))); }, []);

  const refresh = useCallback(async (s: Settings) => {
    setInbox(await native.listEpubs(s.inbox));
    const dirs = await native.listLibrary(s.library);
    const books: Shelf[] = [];
    for (const dir of dirs) {
      const text = await native.readText(`${dir}/index.json`);
      if (text) books.push({ dir, index: JSON.parse(text) as BookIndex });
    }
    setShelf(books);
  }, []);

  useEffect(() => { if (settings) void refresh(settings); }, [settings, refresh]);

  const persist = useCallback((next: Settings) => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    setSettings(next);
  }, []);

  const doImport = useCallback(async (entry: InboxEntry) => {
    if (!settings) return;
    setError(''); setNotice(''); setBusy(`Splitting ${entry.name}…`);
    try {
      const result = await ingest(entry.path, settings.library);
      await refresh(settings);
      setNotice(
        `${result.index.title}: ${result.index.chapters.length} chapters.` +
        (result.warnings.length ? ` ${result.warnings.join(' ')}` : ''),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, [refresh, settings]);

  const openBook = useCallback(async (dir: string) => {
    setError(''); setBusy('Opening…');
    try { setOpen(await load(dir)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  }, []);

  /** Copy chapter Markdown, with your highlights and notes appended, to a folder. */
  const doExport = useCallback(async (which: number | 'all') => {
    if (!open_) return;
    const target = await open({ directory: true, title: 'Export chapters to…' });
    if (typeof target !== 'string') return;

    setBusy('Exporting…');
    try {
      const wanted = which === 'all'
        ? open_.index.chapters
        : [open_.index.chapters[which]!];
      let written = 0;
      for (const chapter of wanted) {
        const body = await native.readText(`${open_.dir}/chapters/${chapter.file}`);
        if (body === null) continue;
        const notes = open_.annotations.filter((a) => a.block >= chapter.start && a.block < chapter.end);
        const suffix = notes.length
          ? '\n\n---\n\n## My highlights\n\n' + notes
              .map((a) => `> ${a.quote}\n${a.note ? `\n${a.note}\n` : ''}`)
              .join('\n')
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
  }, [open_]);

  if (!settings) return <div className="empty">Starting…</div>;

  if (open_) {
    return (
      <div className="app">
        <BookView book={open_} onBack={() => setOpen(null)} onExport={(c) => void doExport(c)} />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>Chapterize</h1>
        <span className="sub">one chapter at a time</span>
        <span className="spacer" />
        {busy && <span className="sub">{busy}</span>}
        <button className="btn ghost" onClick={() => setShowSettings((v) => !v)}>Folders</button>
        <button className="btn" onClick={() => void refresh(settings)}>Rescan</button>
      </div>

      <div className="library">
        {error && <div className="banner" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{error}</div>}
        {notice && <div className="banner">{notice}</div>}

        {showSettings && (
          <div className="card" style={{ marginBottom: 22 }}>
            <div className="field" style={{ border: 0, padding: '4px 0' }}>
              <label>Inbox — drop new books here</label>
              <input type="text" value={settings.inbox}
                     onChange={(e) => persist({ ...settings, inbox: e.target.value })} />
            </div>
            <div className="field" style={{ border: 0, padding: '4px 0' }}>
              <label>Library — split books are built here</label>
              <input type="text" value={settings.library}
                     onChange={(e) => persist({ ...settings, library: e.target.value })} />
            </div>
          </div>
        )}

        <div className="section-title">Inbox — {inbox.length} waiting</div>
        {inbox.length === 0 && (
          <div className="empty">
            Nothing to import. Put an <code>.epub</code> in <code>{settings.inbox}</code> and press Rescan.
          </div>
        )}
        <div className="grid">
          {inbox.map((entry) => (
            <button key={entry.path} className="card" disabled={busy !== ''} onClick={() => void doImport(entry)}>
              <div className="title">{entry.name.replace(/\.epub$/i, '').slice(0, 70)}</div>
              <div className="stats">{(entry.size / 1024 / 1024).toFixed(1)} MB · click to split</div>
            </button>
          ))}
        </div>

        <div className="section-title">Library — {shelf.length} book{shelf.length === 1 ? '' : 's'}</div>
        {shelf.length === 0 && <div className="empty">No books split yet.</div>}
        <div className="grid">
          {shelf.map(({ dir, index }) => {
            const tokens = index.chapters.reduce((sum, c) => sum + estimateTokens(c.chars), 0);
            return (
              <button key={dir} className="card" onClick={() => void openBook(dir)}>
                <div className="title">{index.title}</div>
                <div className="author">{index.author ?? '—'}</div>
                <div className="stats">
                  {index.chapters.length} chapters · ≈{(tokens / 1000).toFixed(0)}k tokens
                  <br />{index.finished.length} read
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="keys">
        <span>Books are split locally. Nothing leaves this machine.</span>
        <span className="spacer" />
        <span>Library: {shelf.length} · Inbox: {inbox.length}</span>
      </div>
    </div>
  );
}
