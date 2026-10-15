/**
 * Bump whenever parsing changes what blocks or chapters come out.
 *
 * A book carries the version it was split with; when it no longer matches, the
 * app re-splits it on open. A reader should never be asked to re-split
 * anything — that is the parser's business leaking onto their screen.
 *
 * v4: ids inside a block resolve, same-file footnotes leave the reading flow,
 * a `<br>` is a space, books that are not UTF-8 decode from the encoding they
 * declare, and a space on each side of an inline tag collapses to one. Any of
 * those moves a block boundary or an annotation offset, so old splits are stale.
 */
export const PARSER_VERSION = 4;

export * from './types.js';
export { openEpub, EpubError, resolvePath } from './epub.js';
export { detect, detectFromToc, detectFromHeadings, detectFromSpine, explainUnresolved } from './detect.js';
export {
  toChapters, splitAt, mergeUp, retitle, mergeSmall, limitCount, mergeStubs,
} from './chapters.js';
export { deriveTitles, deriveTitle, findBoilerplate } from './titles.js';
export {
  renderChapter, countWords, readingMinutes,
  slugify, chapterFilename, imageFilename, inlineMarkdown,
  type RenderOptions,
} from './markdown.js';
