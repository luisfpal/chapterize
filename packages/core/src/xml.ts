import { parseDocument } from 'htmlparser2';
import type { Document, Element, AnyNode } from 'domhandler';

/** Parse XML (OPF, NCX, container.xml). Namespace prefixes are kept verbatim. */
export function parseXml(source: string): Document {
  return parseDocument(source, { xmlMode: true, decodeEntities: true });
}

/** Parse XHTML content documents. Lenient: real books contain malformed markup. */
export function parseHtml(source: string): Document {
  return parseDocument(source, { xmlMode: false, decodeEntities: true });
}

export function isElement(node: AnyNode): node is Element {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}

/**
 * Match a tag name ignoring any namespace prefix, so `<opf:spine>` and `<spine>`
 * are the same element. Real EPUBs are inconsistent about this.
 */
function tagMatches(node: Element, name: string): boolean {
  const local = node.name.includes(':') ? node.name.split(':').pop()! : node.name;
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
    if ('children' in node && node.children) {
      for (const child of node.children as AnyNode[]) visit(child);
    }
  };
  for (const node of Array.isArray(root) ? root : [root]) visit(node);
  return out;
}

export function findFirst(root: AnyNode | AnyNode[], name: string): Element | undefined {
  return findAll(root, name)[0];
}

/** Direct element children with the given local name. */
export function children(node: Element, name: string): Element[] {
  return (node.children ?? []).filter(
    (c): c is Element => isElement(c) && tagMatches(c, name),
  );
}

export function attr(node: Element, name: string): string | undefined {
  const direct = node.attribs?.[name];
  if (direct !== undefined) return direct;
  // Fall back to a namespace-prefixed form, e.g. `epub:type`.
  for (const [k, v] of Object.entries(node.attribs ?? {})) {
    if (k.includes(':') && k.split(':').pop() === name) return v;
  }
  return undefined;
}

/** Concatenated descendant text, whitespace-collapsed. */
export function textOf(node: AnyNode): string {
  let out = '';
  const walk = (n: AnyNode): void => {
    if (n.type === 'text') out += (n as unknown as { data: string }).data;
    else if ('children' in n && n.children) {
      if (isElement(n) && (n.name === 'script' || n.name === 'style')) return;
      for (const c of n.children as AnyNode[]) walk(c);
    }
  };
  walk(node);
  return collapse(out);
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
