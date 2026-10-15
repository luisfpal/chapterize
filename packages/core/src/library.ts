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
