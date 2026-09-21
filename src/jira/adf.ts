/**
 * Atlassian Document Format builders.
 *
 * REST v3 takes ADF for descriptions and comments — not markdown, not plain
 * text. Passing a string is the single most common way this integration fails,
 * and it often fails *quietly*: the request succeeds and the field renders
 * empty.
 *
 * Two rules the schema enforces and it is easy to violate by accident:
 *   - a text node's `text` must be non-empty
 *   - a paragraph with no content is invalid
 * Both are guarded here so callers can pass whatever an agent produced.
 */

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

export type PanelType = 'info' | 'note' | 'warning' | 'success' | 'error';

/** A text node, or null when there is nothing to render. */
export function text(value: string): AdfNode | null {
  return value.length === 0 ? null : { type: 'text', text: value };
}

export function strong(value: string): AdfNode | null {
  const node = text(value);
  return node && { ...node, marks: [{ type: 'strong' }] };
}

export function code(value: string): AdfNode | null {
  const node = text(value);
  return node && { ...node, marks: [{ type: 'code' }] };
}

export function link(value: string, href: string): AdfNode | null {
  const node = text(value);
  return node && { ...node, marks: [{ type: 'link', attrs: { href } }] };
}

function inlines(parts: Array<AdfNode | string | null>): AdfNode[] {
  return parts
    .map((part) => (typeof part === 'string' ? text(part) : part))
    .filter((node): node is AdfNode => node !== null);
}

/** A paragraph. Returns null when every part was empty. */
export function p(...parts: Array<AdfNode | string | null>): AdfNode | null {
  const content = inlines(parts);
  return content.length === 0 ? null : { type: 'paragraph', content };
}

export function heading(level: 1 | 2 | 3 | 4 | 5 | 6, value: string): AdfNode | null {
  const content = inlines([value]);
  return content.length === 0 ? null : { type: 'heading', attrs: { level }, content };
}

/** A bullet list; empty strings are dropped, and an empty list returns null. */
export function bullets(items: Array<string | AdfNode | null>): AdfNode | null {
  const listItems = items
    .map((item) => (typeof item === 'string' || item === null ? p(item) : item))
    .filter((node): node is AdfNode => node !== null)
    .map((node) => ({
      type: 'listItem',
      content: [node.type === 'paragraph' ? node : { type: 'paragraph', content: [node] }],
    }));

  return listItems.length === 0 ? null : { type: 'bulletList', content: listItems };
}

export function codeBlock(value: string, language?: string): AdfNode | null {
  const node = text(value);
  if (!node) return null;
  return {
    type: 'codeBlock',
    ...(language ? { attrs: { language } } : {}),
    content: [node],
  };
}

export function panel(panelType: PanelType, ...blocks: Array<AdfNode | null>): AdfNode | null {
  const content = blocks.filter((node): node is AdfNode => node !== null);
  return content.length === 0 ? null : { type: 'panel', attrs: { panelType }, content };
}

export function rule(): AdfNode {
  return { type: 'rule' };
}

/**
 * Assembles a document, dropping nulls.
 *
 * Jira rejects a doc with empty content, so an all-null document falls back to
 * a single space rather than failing the request. A blank comment is a small
 * problem; a failed transition mid-run is a large one.
 */
export function doc(...blocks: Array<AdfNode | null>): AdfDoc {
  const content = blocks.filter((node): node is AdfNode => node !== null);
  return {
    type: 'doc',
    version: 1,
    content: content.length > 0 ? content : [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }],
  };
}

/**
 * Renders plain text — including multi-line agent output — as paragraphs.
 * Blank lines separate paragraphs rather than producing invalid empty ones.
 */
export function fromText(value: string): AdfDoc {
  return doc(...value.split(/\n{2,}/).map((block) => p(block.trim())));
}

/** Flattens an ADF document back to text, for logs, tests, and the dashboard. */
export function toPlainText(node: AdfNode | AdfDoc | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return (node as AdfNode).text ?? '';
  const children = (node as AdfNode).content ?? [];
  const joined = children.map(toPlainText).join(node.type === 'paragraph' ? '' : '\n');
  return node.type === 'listItem' ? `- ${joined}` : joined;
}
