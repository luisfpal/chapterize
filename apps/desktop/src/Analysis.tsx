import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { native, type AnalysisFile } from './native';

/**
 * The Analysis tab.
 *
 * `analysis/` belongs to the user and their agents; this pane only reads it.
 * An agent writes `007-....summary.md`, and it appears here beside chapter 7.
 */

/** Leading chapter number, by the convention the folder's README documents. */
function chapterOf(name: string): number | null {
  const match = /^(\d{1,4})\b/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Render Mermaid blocks into SVG.
 *
 * Mermaid is ~800 kB, so it is imported only when a document actually contains a
 * diagram — most never will, and a reader should not pay for what it does not use.
 */
async function renderDiagrams(root: HTMLElement, dark: boolean): Promise<void> {
  const blocks = [...root.querySelectorAll('pre > code.language-mermaid')];
  if (!blocks.length) return;

  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });

  for (const [i, block] of blocks.entries()) {
    const pre = block.parentElement;
    if (!pre) continue;
    try {
      const { svg } = await mermaid.render(`d${Date.now()}-${i}`, block.textContent ?? '');
      const holder = document.createElement('div');
      holder.className = 'diagram';
      holder.innerHTML = svg;
      pre.replaceWith(holder);
    } catch (error) {
      // A malformed diagram must not blank the document around it.
      const note = document.createElement('div');
      note.className = 'diagram-error';
      note.textContent = `Diagram could not be drawn: ${String(error).slice(0, 160)}`;
      pre.replaceWith(note);
    }
  }
}

interface Props {
  dir: string;
  /** Show only files belonging to this chapter, or all when undefined. */
  chapterIndex?: number;
}

export function Analysis({ dir, chapterIndex }: Props) {
  const [files, setFiles] = useState<AnalysisFile[]>([]);
  const [openFile, setOpenFile] = useState<AnalysisFile | null>(null);
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const body = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      await native.ensureAnalysis(dir);
      setFiles(await native.listAnalysis(dir));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [dir]);

  useEffect(() => { void refresh(); }, [refresh]);

  // An agent writes the file in another window; re-reading on focus is what makes
  // it appear without a manual refresh.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const visible = useMemo(() => {
    if (chapterIndex === undefined) return files;
    return files.filter((f) => {
      const owner = chapterOf(f.name);
      return owner === null || owner === chapterIndex;
    });
  }, [files, chapterIndex]);

  const open = useCallback(async (file: AnalysisFile) => {
    setOpenFile(file);
    setError('');
    try {
      const text = await native.readText(file.path);
      setHtml(text === null ? '' : await marked.parse(text, { async: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!html || !body.current) return;
    const dark = !document.documentElement.matches('[data-theme="light"]')
      && (document.documentElement.matches('[data-theme="dark"]')
        || window.matchMedia('(prefers-color-scheme: dark)').matches);
    void renderDiagrams(body.current, dark);
  }, [html]);

  if (openFile) {
    return (
      <>
        <div className="pane-head">
          <button className="btn ghost tiny" onClick={() => { setOpenFile(null); setHtml(''); }}>←</button>
          <span className="ellipsis">{openFile.name}</span>
          <span className="spacer" />
          <button className="btn ghost tiny" onClick={() => void revealItemInDir(openFile.path)}>Reveal</button>
        </div>
        <div className="pane-body">
          {error && <div className="banner error">{error}</div>}
          <div className="analysis-doc" ref={body} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="pane-head">
        Analysis<span className="spacer" />{visible.length}
        <button className="btn ghost tiny" onClick={() => void refresh()} title="Re-read the folder">↻</button>
      </div>
      <div className="pane-body">
        {error && <div className="banner error">{error}</div>}
        {visible.length === 0 ? (
          <div className="empty">
            Nothing here yet.<br />
            Point an agent at <code>analysis/</code> and whatever Markdown it writes
            shows up here, beside the chapter it belongs to.
          </div>
        ) : (
          visible.map((file) => (
            <button key={file.path} className="analysis-row" onClick={() => void open(file)}>
              <span className="t">{file.name}</span>
              <span className="meta">
                {new Date(file.modified * 1000).toLocaleDateString()} · {(file.size / 1024).toFixed(1)} kB
              </span>
            </button>
          ))
        )}
      </div>
    </>
  );
}
