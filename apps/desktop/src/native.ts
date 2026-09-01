import { invoke } from '@tauri-apps/api/core';
import type { Block } from '@chapterize/core';

/** Everything the Rust side exposes, in one place, typed. */
export const native = {
  /** Platform-conventional data and config locations, resolved by Tauri. */
  appDirs: () => invoke<AppDirs>('app_dirs'),
  readFile: (path: string) => invoke<number[]>('read_file', { path }),
  readText: (path: string) => invoke<string | null>('read_text', { path }),
  writeText: (path: string, contents: string) => invoke<void>('write_text', { path, contents }),
  writeBytes: (path: string, contents: number[]) => invoke<void>('write_bytes', { path, contents }),
  writeChapters: (dir: string, files: OutputFile[]) => invoke<string>('write_chapters', { dir, files }),
  /** Create `analysis/` with its README. Never overwrites anything present. */
  ensureAnalysis: (dir: string) => invoke<string>('ensure_analysis', { dir }),
  /** Markdown the user or their agents put in `analysis/`, newest first. */
  listAnalysis: (dir: string) => invoke<AnalysisFile[]>('list_analysis', { dir }),
  copyInto: (source: string, dir: string, name: string) => invoke<string>('copy_into', { source, dir, name }),
  removeBook: (dir: string) => invoke<void>('remove_book', { dir }),
  listLibrary: (dir: string) => invoke<string[]>('list_library', { dir }),
  /** Send-to-Kindle: the app password lives in the OS keyring, never on disk. */
  saveKindlePassword: (password: string) => invoke<void>('save_kindle_password', { password }),
  hasKindlePassword: () => invoke<boolean>('has_kindle_password'),
  forgetKindlePassword: () => invoke<void>('forget_kindle_password'),
  sendToKindle: (path: string, config: KindleConfig) =>
    invoke<string>('send_to_kindle', { path, config }),
  /** EPUBs the OS handed us — drains the queue, so each file imports once. */
  pendingFiles: () => invoke<string[]>('pending_files'),
};

export interface AppDirs { library: string; config: string }
export interface AnalysisFile { name: string; path: string; size: number; modified: number }

/** Non-secret half of the Kindle setup; the password is in the OS keyring. */
export interface KindleConfig { to: string; from: string; host: string; port: number }

export const KINDLE_KEY = 'chapterize.kindle.v1';

export function loadKindleConfig(): KindleConfig {
  try {
    const raw = localStorage.getItem(KINDLE_KEY);
    if (raw) return JSON.parse(raw) as KindleConfig;
  } catch { /* fall through to defaults */ }
  return { to: '', from: '', host: 'smtp.gmail.com', port: 587 };
}
export interface OutputFile { name: string; contents: string }

/** A highlight, anchored to our own block model rather than to CSS selectors. */
export interface Annotation {
  id: string;
  /** Index into the flattened book — stable across re-splitting. */
  block: number;
  /** Character offsets within that block's text. */
  start: number;
  end: number;
  /** The highlighted text, kept so a note survives even if the book is replaced. */
  quote: string;
  note: string;
  color: 1 | 2 | 3 | 4;
  createdAt: string;
}

/** `index.json`: the durable description of a split book. Plain, greppable JSON. */
export interface BookIndex {
  version: 2;
  title: string;
  author?: string;
  epubFile: string;
  createdAt: string;
  chapters: StoredChapter[];
  /** chapter index -> scroll fraction, so the reader resumes where you stopped. */
  progress: Record<string, number>;
  /** Chapter last opened, so the book reopens where it was left. */
  lastChapter?: number;
  finished: number[];
}

export interface StoredChapter {
  index: number;
  title: string;
  start: number;
  end: number;
  chars: number;
  file: string;
  /** Words of prose. Reading time derives from this. */
  words: number;
}

export interface LoadedBook {
  dir: string;
  index: BookIndex;
  blocks: Block[];
  annotations: Annotation[];
  /** Figure path inside the EPUB -> object URL the reader can display. */
  imageUrls: Map<string, string>;
  /** Footnote bodies by `path#id`, for the reader's note popups. */
  notes: Map<string, string>;
}

export function bytesOf(numbers: number[]): Uint8Array {
  return new Uint8Array(numbers);
}

/** Directory name for a book. Filesystem-safe, still readable in a file manager. */
export function bookFolderName(title: string, author?: string): string {
  const clean = (s: string) => s.replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  const t = clean(title).slice(0, 70) || 'Untitled';
  const a = author ? clean(author).slice(0, 40) : '';
  return a ? `${t} — ${a}` : t;
}
