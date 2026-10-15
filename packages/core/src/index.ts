/**
 * Bump whenever parsing changes what blocks or chapters come out.
 *
 * A book carries the version it was split with; when it no longer matches, the
 * app re-splits it on open. A reader should never be asked to re-split
 * anything — that is the parser's business leaking onto their screen.
 */
export const PARSER_VERSION = 3;

export * from './types.js';
export { openEpub, EpubError, resolvePath } from './epub.js';
export { detect, detectFromToc, detectFromHeadings, detectFromSpine } from './detect.js';
export {
  toChapters, splitAt, mergeUp, retitle, mergeSmall, limitCount, mergeStubs,
} from './chapters.js';
export { deriveTitles, deriveTitle, findBoilerplate } from './titles.js';
export {
  renderChapter, countWords, readingMinutes,
  slugify, chapterFilename, imageFilename, inlineMarkdown,
  type RenderOptions,
} from './markdown.js';
export {
  buildStudy, slicePassage, MAX_STUDY_STEPS,
  type OutlineItem, type StudyStep, type ChapterStudy,
} from './study.js';
export {
  prepareReader, renderChapterHtml, safeInline, escapeHtml, assignImageNames, readerId,
  type ReaderModel, type ReaderChapter, type ReaderImage,
} from './reader.js';
