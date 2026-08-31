/**
 * The domain model.
 *
 * One idea carries the whole design: a book is a FLAT ARRAY OF BLOCKS, and a
 * chapter is the interval between two CUT POINTS. Every real-world EPUB layout
 * reduces to that, so there are no per-layout branches anywhere in this package.
 *
 *   one file per chapter      -> cuts land on file boundaries
 *   whole book in one file    -> several cuts inside one file
 *   chapter across N files    -> files without a cut merge into the chapter
 */

/** Position in the flattened book. The only coordinate system we use. */
export type BlockIndex = number;

/** One top-level element of one spine document, in reading order. */
export interface Block {
  /** Index into `Book.spine` — which document this came from. */
  spineIndex: number;
  /** Absolute path inside the EPUB zip, e.g. "OEBPS/part3.xhtml". */
  path: string;
  /**
   * Every `id` that points at this block — its own, plus ids on wrappers and
   * inline anchors (`<a id>`, `<span id>`) that precede it with no block
   * between. TOC fragments resolve through this, and books anchor chapters on
   * inline elements often enough that ignoring them loses most fragment cuts.
   */
  ids: string[];
  /** Element tag, lowercased: "p", "h1", "blockquote"… */
  tag: string;
  /** Heading level 1-6, or 0 when this block is not a heading. */
  heading: number;
  /** Plain text content, whitespace-collapsed. */
  text: string;
}

/** Where a chapter begins. Auto-detection and manual edits both produce these. */
export interface CutPoint {
  /** The chapter STARTS at this block. */
  at: BlockIndex;
  title: string;
  source: CutSource;
  /** TOC nesting level; 0 for top-level. Drives the tree view. */
  depth: number;
}

export type CutSource = 'toc' | 'heading' | 'spine' | 'manual';

/** A resolved chapter: a half-open interval [start, end) over the block array. */
export interface Chapter {
  index: number;
  title: string;
  start: BlockIndex;
  /** Exclusive. */
  end: BlockIndex;
  source: CutSource;
  depth: number;
  /** Characters of plain text. Token estimates derive from this. */
  chars: number;
}

/** A TOC entry before it has been resolved to a BlockIndex. */
export interface TocEntry {
  label: string;
  /** Path portion of the href, normalised against the OPF directory. */
  path: string;
  /** Fragment after '#', if any. */
  fragment?: string;
  depth: number;
}

/** A TOC entry we could not place in the block array. Surfaced, never swallowed. */
export interface UnresolvedEntry {
  entry: TocEntry;
  reason: UnresolvedReason;
}

/**
 * Why an entry could not be placed. These are distinct problems and the user
 * acts on them differently, so they are never collapsed into one message:
 * a cover made of a single image is expected and harmless, whereas a TOC
 * pointing outside the spine means the book is malformed.
 */
export type UnresolvedReason =
  /** The href names a document the spine never lists. The book is inconsistent. */
  | 'path-not-in-spine'
  /** The document is in the spine but holds no extractable text (image-only cover). */
  | 'document-has-no-text'
  /** The document was found, but nothing in it carries the requested id. */
  | 'fragment-not-found';

export interface SpineItem {
  id: string;
  path: string;
  /** `linear="no"` marks auxiliary content (notes, ads) outside the main flow. */
  linear: boolean;
}

export interface BookMetadata {
  title: string;
  author?: string;
  language?: string;
  /** "2.0" or "3.0". */
  epubVersion: string;
}

/** A fully parsed EPUB. Everything downstream is a pure function of this. */
export interface Book {
  metadata: BookMetadata;
  spine: SpineItem[];
  blocks: Block[];
  toc: TocEntry[];
  /** How the TOC was obtained; 'none' when the book has neither nav nor NCX. */
  tocSource: 'nav' | 'ncx' | 'none';
}

/** Result of running a detection strategy. */
export interface Detection {
  cuts: CutPoint[];
  strategy: CutSource;
  /** Non-fatal problems the UI must show the user. */
  unresolved: UnresolvedEntry[];
}
