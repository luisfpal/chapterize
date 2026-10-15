/**
 * Facts about a book on disk that parsing does not own.
 *
 * A re-split rewrites `index.json` from the EPUB. Reading progress is
 * chapter-indexed and has to be dropped, because the indices just moved.
 * When the book was sent to Kindle, and when it was first imported, are
 * properties of the copy in the library. Replacing them makes a book look
 * unsent and newly added every time the parser changes.
 */
export function carryBookState<T extends { createdAt: string; sentToKindle?: string }>(
  previous: { createdAt?: string; sentToKindle?: string },
  next: T,
): T & { createdAt: string; sentToKindle?: string } {
  const createdAt = previous.createdAt ? previous.createdAt : next.createdAt;
  if (previous.sentToKindle) {
    return { ...next, createdAt, sentToKindle: previous.sentToKindle };
  }
  if (createdAt === next.createdAt) return next;
  return { ...next, createdAt };
}

/**
 * Parse a JSON file the user can open and repair.
 *
 * `JSON.parse` throws "Unexpected token" and names neither the file nor what
 * to do about it. A corrupt `annotations.json` then looks like the app is
 * broken, and the book underneath it will not open.
 */
export function parseStoredJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${what} is not valid JSON (${detail}). The file was not modified. ` +
      'Restore it from a backup, or correct it by hand, then open the book again.',
    );
  }
}

/**
 * One shelf entry. A file that does not parse, or that is not a book, is an
 * error string rather than a throw: the caller still opens every other book.
 * One corrupt `index.json` used to reject the whole library with "Unexpected
 * token" and no path.
 */
export function tryParseBookIndex(
  text: string,
  what: string,
): { ok: true; index: { title: string; chapters: unknown[]; finished: unknown[] } }
  | { ok: false; error: string } {
  let value: unknown;
  try {
    value = parseStoredJson<unknown>(text, what);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      error:
        `${what} is not a book index. The file was not modified. ` +
        'Restore it from a backup, or correct it by hand, then open the library again.',
    };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.title !== 'string' || !record.title.trim()) {
    return {
      ok: false,
      error:
        `${what} has no title, so it cannot be shown on the shelf. The file was not modified. ` +
        'Restore it from a backup, or correct it by hand.',
    };
  }
  if (!Array.isArray(record.chapters) || record.chapters.some((chapter) => !chapter || typeof chapter !== 'object')) {
    return {
      ok: false,
      error:
        `${what} has no chapter list. The file was not modified. ` +
        'Restore it from a backup, or correct it by hand, then open the library again.',
    };
  }
  // The shelf reads these as arrays. An index written by an older build, or
  // repaired by hand, may omit them; inventing an empty one here is display
  // only — the file is not rewritten.
  if (!Array.isArray(record.finished)) record.finished = [];
  if (!record.progress || typeof record.progress !== 'object' || Array.isArray(record.progress)) {
    record.progress = {};
  }
  return {
    ok: true,
    index: record as { title: string; chapters: unknown[]; finished: unknown[] },
  };
}

/**
 * Highlights are a list. `{}` is valid JSON and still not a list; treating it
 * as one crashes the reader with "filter is not a function" and never says
 * which file to repair.
 */
export function parseAnnotationList(text: string, what: string): unknown[] {
  const value = parseStoredJson<unknown>(text, what);
  if (!Array.isArray(value)) {
    throw new Error(
      `${what} is not a list of highlights. The file was not modified. ` +
      'Restore it from a backup, or correct it by hand, then open the book again.',
    );
  }
  return value;
}
