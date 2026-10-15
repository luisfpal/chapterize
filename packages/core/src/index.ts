/**
 * Bump whenever parsing changes what blocks or chapters come out.
 *
 * A book carries the version it was split with; when it no longer matches, the
 * app re-splits it on open. A reader should never be asked to re-split
 * anything — that is the parser's business leaking onto their screen.
 *
 * v4 moved boundaries for ids, footnotes, line breaks, encodings, and inline
 * whitespace. v5 also keeps every figure in a paragraph and the wrapper on a
 * list item or quotation. Either one moves a block, so a v4 library is stale.
 */
export const PARSER_VERSION = 5;

export * from './types.js';
export { openEpub, EpubError, resolvePath } from './epub.js';
export { detect, detectFromToc, detectFromHeadings, detectFromSpine, explainUnresolved } from './detect.js';
export {
  toChapters,
  splitAt,
  mergeUp,
  retitle,
  mergeSmall,
  limitCount,
  mergeStubs,
} from './chapters.js';
export { deriveTitles, deriveTitle, findBoilerplate } from './titles.js';
export {
  renderChapter,
  countWords,
  readingMinutes,
  slugify,
  chapterFilename,
  imageFilename,
  inlineMarkdown,
  type RenderOptions,
} from './markdown.js';
export {
  annotationRange, reanchorAnnotations, withHighlights,
  type HighlightNote, type AnnotationRange,
} from './annotations.js';
export { search, type Hit } from './search.js';
export { readerCommand, type ReaderCommand, type ReaderKeyState } from './reader.js';
export { carryBookState, parseStoredJson, parseAnnotationList, tryParseBookIndex } from './library.js';
