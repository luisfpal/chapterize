import { ElementType } from 'domelementtype';
import { isText } from 'domhandler';
import type { Document, Element, AnyNode } from 'domhandler';
import { parseDocument } from 'htmlparser2';

/** Parse XML (OPF, NCX, container.xml). Namespace prefixes are kept verbatim. */
export function parseXml(source: string): Document {
  return parseDocument(source, { xmlMode: true, decodeEntities: true });
}

/** Parse XHTML content documents. Lenient: real books contain malformed markup. */
export function parseHtml(source: string): Document {
  return parseDocument(source, { xmlMode: false, decodeEntities: true });
}

export function isElement(node: AnyNode): node is Element {
  return (
    node.type === ElementType.Tag ||
    node.type === ElementType.Script ||
    node.type === ElementType.Style
  );
}

/**
 * Match a tag name ignoring any namespace prefix, so `<opf:spine>` and `<spine>`
 * are the same element. Real EPUBs are inconsistent about this.
 */
function tagMatches(node: Element, name: string): boolean {
  const local = node.name.split(':').pop() ?? node.name;
  return local.toLowerCase() === name.toLowerCase();
}

/**
 * Every descendant element with the given local name, in DOCUMENT ORDER.
 *
 * Order is load-bearing: the spine is read from `<itemref>` elements, so a
 * reversed result silently reverses the whole book.
 */
export function findAll(root: AnyNode | AnyNode[], name: string): Element[] {
  const out: Element[] = [];
  const visit = (node: AnyNode): void => {
    if (isElement(node) && tagMatches(node, name)) out.push(node);
    if (!('children' in node)) return;
    for (const child of node.children) visit(child);
  };
  const nodes = Array.isArray(root) ? root : [root];
  for (const node of nodes) visit(node);
  return out;
}

export function findFirst(root: AnyNode | AnyNode[], name: string): Element | undefined {
  return findAll(root, name)[0];
}

/** Direct element children with the given local name. */
export function children(node: Element, name: string): Element[] {
  return node.children.filter(
    (child): child is Element => isElement(child) && tagMatches(child, name),
  );
}

export function attr(node: Element, name: string): string | undefined {
  const direct = node.attribs[name];
  if (direct !== undefined) return direct;
  // Fall back to a namespace-prefixed form, e.g. `epub:type`.
  for (const [key, value] of Object.entries(node.attribs)) {
    if (key.includes(':') && key.split(':').pop() === name) return value;
  }
  return undefined;
}

/**
 * Concatenated descendant text, whitespace-collapsed.
 *
 * `<br>` is a space. Converted books use it as a line break inside a paragraph,
 * and dropping it glues the two words into one (`hithere`), which then fails
 * every search and every quote re-anchor.
 */
export function textOf(node: AnyNode | AnyNode[]): string {
  let out = '';
  const walk = (current: AnyNode): void => {
    if (isText(current)) {
      out += current.data;
      return;
    }
    if (!('children' in current)) return;
    if (isElement(current)) {
      const tag = current.name.toLowerCase();
      if (tag === 'script' || tag === 'style') return;
      // A line break is not a character. Dropping it glues the words on either
      // side into one, and every search and quote then misses.
      if (tag === 'br' || tag === 'hr') {
        out += ' ';
        return;
      }
    }
    for (const child of current.children) walk(child);
  };
  for (const n of Array.isArray(node) ? node : [node]) walk(n);
  return collapse(out);
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
