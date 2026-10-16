import { invoke } from '@tauri-apps/api/core';
import type { Block } from '@chapterize/core';

/**
 * A command whose payload the UI does not read.
 *
 * `invoke<void>` is a generic on a call, which the void-type rule rejects.
 * Discarding `unknown` keeps the return type honest: there is nothing to use.
 */
async function run(cmd: string, args?: Record<string, unknown>): Promise<void> {
  await invoke<unknown>(cmd, args);
}

/** Everything the Rust side exposes, in one place, typed. */
export const native = {
  /** Platform-conventional data and config locations, resolved by Tauri. */
  appDirs: () => invoke<AppDirs>('app_dirs'),
  readFile: (path: string) => invoke<number[]>('read_file', { path }),
  readText: (path: string) => invoke<string | null>('read_text', { path }),
  writeText: (path: string, contents: string) => run('write_text', { path, contents }),
  writeBytes: (path: string, contents: number[]) => run('write_bytes', { path, contents }),
  writeChapters: (dir: string, files: OutputFile[]) =>
    invoke<string>('write_chapters', { dir, files }),
  /** Create `analysis/` with its README. Never overwrites anything present. */
  ensureAnalysis: (dir: string) => invoke<string>('ensure_analysis', { dir }),
  /** Markdown the user or their agents put in `analysis/`, newest first. */
  listAnalysis: (dir: string) => invoke<AnalysisFile[]>('list_analysis', { dir }),
  copyInto: (source: string, dir: string, name: string) =>
    invoke<string>('copy_into', { source, dir, name }),
  /** Moves the book aside and returns where; nothing is destroyed. */
  removeBook: (dir: string) => invoke<string>('remove_book', { dir }),
  restoreBook: (trashed: string, library: string) => run('restore_book', { trashed, library }),
  listLibrary: (dir: string) => invoke<string[]>('list_library', { dir }),
  /** Speech via the OS, because WebKitGTK ships no Web Speech API. */
  speak: (text: string) => run('speak', { text }),
  stopSpeaking: () => run('stop_speaking'),
  speechAvailable: () => invoke<boolean>('speech_available'),
  /** Kindle, through the app's own signed-in Amazon window. No credentials. */
  kindleConnected: () => invoke<boolean>('kindle_connected'),
  openKindleWindow: () => run('open_kindle_window'),
  sendViaAmazon: (path: string) => invoke<string>('send_via_amazon', { path }),
  /** EPUBs the OS handed us — drains the queue, so each file imports once. */
  pendingFiles: () => invoke<string[]>('pending_files'),
};

export interface AppDirs {
  library: string;
  config: string;
}
export interface AnalysisFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}
export interface OutputFile {
  name: string;
  contents: string;
}

/** A highlight, anchored to our own block model rather than to CSS selectors. */
export interface Annotation {
  id: string;
  /** Index into the flattened book — stable across re-splitting. */
  block: number;
  /** Character offsets within that block's text. */
  start: number;
  end: number;
  /** The highlighted text, kept so a note survives the book being re-split. */
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
  /** When this book was last handed to Amazon, so the library can show it. */
  sentToKindle?: string;
  /** Parser that produced these chapters; a mismatch triggers a silent re-split. */
  parserVersion?: number;
  finished: number[];
}

export interface StoredChapter {
  index: number;
  title: string;
  start: number;
  end: number;
  chars: number;
  file: string;
  /**
   * Words of prose. Absent on books split before reading time existed;
   * `readingMinutes` treats that as unknown rather than as NaN.
   */
  words?: number;
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

/** `JSON.parse` is typed `any`. Unknown is the type the guards below narrow. */
export function readJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredChapter(value: unknown): value is StoredChapter {
  if (!isRecord(value)) return false;
  const words = value['words'];
  return (
    typeof value['title'] === 'string' &&
    typeof value['file'] === 'string' &&
    typeof value['index'] === 'number' &&
    typeof value['start'] === 'number' &&
    typeof value['end'] === 'number' &&
    typeof value['chars'] === 'number' &&
    (words === undefined || typeof words === 'number')
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => typeof item === 'number');
}

function isBookIndex(value: unknown): value is BookIndex {
  if (!isRecord(value)) return false;
  const author = value['author'];
  const parserVersion = value['parserVersion'];
  const lastChapter = value['lastChapter'];
  const sentToKindle = value['sentToKindle'];
  const chapters = value['chapters'];
  const finished = value['finished'];
  return (
    value['version'] === 2 &&
    typeof value['title'] === 'string' &&
    typeof value['epubFile'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    (author === undefined || typeof author === 'string') &&
    (parserVersion === undefined || typeof parserVersion === 'number') &&
    (lastChapter === undefined || typeof lastChapter === 'number') &&
    (sentToKindle === undefined || typeof sentToKindle === 'string') &&
    Array.isArray(chapters) &&
    chapters.every(isStoredChapter) &&
    Array.isArray(finished) &&
    finished.every((item) => typeof item === 'number') &&
    isNumberRecord(value['progress'])
  );
}

/**
 * Accept `index.json` only when it has the fields the reader actually uses.
 * A partial file used to throw later, inside render, with no mention of which
 * book. This names the directory and leaves the file untouched.
 */
export function parseBookIndex(text: string, dir: string): BookIndex {
  let value: unknown;
  try {
    value = readJson(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${dir}/index.json is not valid JSON (${detail}). The file was not modified. ` +
        'Restore it from a backup, or correct it by hand, then open the library again.',
      { cause },
    );
  }
  // An older index, or one repaired by hand, may omit these. They are display
  // state, not the book. Filling them here does not rewrite the file.
  if (isRecord(value)) {
    if (!Array.isArray(value['finished'])) value['finished'] = [];
    if (!isNumberRecord(value['progress'])) value['progress'] = {};
  }
  if (!isBookIndex(value)) throw badIndex(dir);
  return value;
}

function badIndex(dir: string): Error {
  return new Error(`${dir}/index.json is not a Chapterize book index. The file was not modified.`);
}

function isAnnotation(value: unknown): value is Annotation {
  if (!isRecord(value)) return false;
  const color = value['color'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['block'] === 'number' &&
    typeof value['start'] === 'number' &&
    typeof value['end'] === 'number' &&
    typeof value['quote'] === 'string' &&
    value['quote'].length > 0 &&
    typeof value['start'] === 'number' &&
    typeof value['end'] === 'number' &&
    value['start'] >= 0 &&
    value['end'] >= value['start'] &&
    typeof value['note'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    (color === 1 || color === 2 || color === 3 || color === 4)
  );
}

export function parseAnnotations(text: string, dir: string): Annotation[] {
  let value: unknown;
  try {
    value = readJson(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${dir}/annotations.json is not valid JSON (${detail}). The file was not modified. ` +
        'Restore it from a backup, or correct it by hand, then open the book again.',
      { cause },
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `${dir}/annotations.json is not a list of highlights. The file was not modified. ` +
        'Restore it from a backup, or correct it by hand, then open the book again.',
    );
  }
  // A row with no id, or a negative offset, stays in the file and is left off
  // the reader. One bad highlight must not refuse the book.
  return value.filter(isAnnotation);
}

/** Directory name for a book. Filesystem-safe, still readable in a file manager. */
export function bookFolderName(title: string, author?: string): string {
  const clean = (s: string) =>
    s
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const t = clean(title).slice(0, 70) || 'Untitled';
  const a = author ? clean(author).slice(0, 40) : '';
  return a ? `${t} — ${a}` : t;
}
