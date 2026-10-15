/**
 * What a key does in the reader.
 *
 * Escape has a stack: the dictionary, then speech, then a footnote, then a
 * highlight being written, then split-editing, and only then the library.
 * Getting that order wrong sends the reader back to the shelf while a
 * definition is still open, or while the chapter is still being read aloud.
 */
export interface ReaderKeyState {
  editing: boolean;
  lookup: boolean;
  speaking: boolean;
  note: boolean;
  pending: boolean;
}

export type ReaderCommand =
  | { kind: 'chapter'; delta: 1 | -1 }
  | { kind: 'scroll'; delta: number }
  | { kind: 'highlight' }
  | { kind: 'mark-read' }
  | { kind: 'toggle-edit' }
  | { kind: 'search' }
  | { kind: 'undo-edit' }
  | { kind: 'close-lookup' }
  | { kind: 'stop-speech' }
  | { kind: 'close-note' }
  | { kind: 'close-pending' }
  | { kind: 'cancel-edit' }
  | { kind: 'back' }
  | { kind: 'text-size'; delta: number }
  | { kind: 'ignore' };

export function readerCommand(key: string, state: ReaderKeyState, modified = false): ReaderCommand {
  // Command, Control, and Alt belong to the system (copy, close, a shortcut).
  // Escape still dismisses whatever is open; a modified letter must not also
  // turn the page.
  if (modified && key !== 'Escape') return { kind: 'ignore' };
  if (key === 'n') return { kind: 'chapter', delta: 1 };
  if (key === 'p') return { kind: 'chapter', delta: -1 };
  if (key === 'j') return { kind: 'scroll', delta: 120 };
  if (key === 'k') return { kind: 'scroll', delta: -120 };
  if (key === 'h') return state.editing ? { kind: 'ignore' } : { kind: 'highlight' };
  if (key === 'm') return state.editing ? { kind: 'ignore' } : { kind: 'mark-read' };
  if (key === 'e') return { kind: 'toggle-edit' };
  if (key === '/') return { kind: 'search' };
  if (key === 'u') return state.editing ? { kind: 'undo-edit' } : { kind: 'ignore' };
  if (key === '=' || key === '+') return { kind: 'text-size', delta: 1 };
  if (key === '-') return { kind: 'text-size', delta: -1 };
  if (key === 'Escape') {
    if (state.lookup) return { kind: 'close-lookup' };
    if (state.speaking) return { kind: 'stop-speech' };
    if (state.note) return { kind: 'close-note' };
    if (state.pending) return { kind: 'close-pending' };
    if (state.editing) return { kind: 'cancel-edit' };
    return { kind: 'back' };
  }
  return { kind: 'ignore' };
}
