import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * Show failures instead of a white rectangle.
 *
 * A webview that throws during render paints nothing and logs nowhere the user
 * can see — the app simply appears broken. Anything that escapes React lands
 * here and is written into the page.
 */
function showFatal(what: string, detail: unknown): void {
  const message = detail instanceof Error
    ? `${detail.name}: ${detail.message}\n\n${detail.stack ?? ''}`
    : String(detail);
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal';
  box.innerHTML =
    `<h1>Chapterize hit an error it could not recover from</h1><p>${what}</p><pre></pre>` +
    '<p class="hint">Your library is untouched — it is plain files on disk.</p>';
  (box.querySelector('pre') as HTMLElement).textContent = message;
  root.appendChild(box);
}

window.addEventListener('error', (e) => showFatal('While running', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showFatal('In a background task', e.reason));

try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (error) {
  showFatal('While starting up', error);
}
