import { describe, it, expect } from 'vitest';
import {
  bullets,
  code,
  codeBlock,
  doc,
  fromText,
  heading,
  link,
  p,
  panel,
  strong,
  text,
  toPlainText,
} from '../src/jira/adf.ts';

describe('empty-value guards', () => {
  it('never emits an empty text node, which Jira rejects', () => {
    expect(text('')).toBeNull();
    expect(strong('')).toBeNull();
    expect(code('')).toBeNull();
    expect(link('', 'https://example.com')).toBeNull();
  });

  it('never emits an empty paragraph', () => {
    expect(p('')).toBeNull();
    expect(p(null)).toBeNull();
    expect(p('', null, '')).toBeNull();
  });

  it('drops empty items from a list, and an empty list entirely', () => {
    expect(bullets([])).toBeNull();
    expect(bullets(['', null])).toBeNull();
    const list = bullets(['one', '', 'two'])!;
    expect(list.content).toHaveLength(2);
  });

  it('falls back to a non-empty doc rather than failing the request', () => {
    // A blank comment is a small problem; a 400 mid-run is a large one.
    const empty = doc(null, null);
    expect(empty.content).toHaveLength(1);
    expect(empty.content[0]!.type).toBe('paragraph');
  });
});

describe('node shapes', () => {
  it('builds a document envelope Jira accepts', () => {
    const d = doc(p('hello'));
    expect(d.type).toBe('doc');
    expect(d.version).toBe(1);
  });

  it('builds a paragraph of text', () => {
    expect(p('hello')).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] });
  });

  it('puts the heading level in attrs', () => {
    expect(heading(3, 'Acceptance criteria')).toMatchObject({
      type: 'heading',
      attrs: { level: 3 },
    });
  });

  it('wraps each list item in a paragraph', () => {
    const list = bullets(['first'])!;
    expect(list.content![0]).toEqual({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
    });
  });

  it('attaches marks for strong, code, and link', () => {
    expect(strong('x')!.marks).toEqual([{ type: 'strong' }]);
    expect(code('x')!.marks).toEqual([{ type: 'code' }]);
    expect(link('PR #7', 'https://github.com/x/y/pull/7')!.marks).toEqual([
      { type: 'link', attrs: { href: 'https://github.com/x/y/pull/7' } },
    ]);
  });

  it('sets codeBlock language only when given', () => {
    expect(codeBlock('const x = 1', 'ts')!.attrs).toEqual({ language: 'ts' });
    expect(codeBlock('plain')!.attrs).toBeUndefined();
  });

  it('builds a panel with a type', () => {
    expect(panel('warning', p('careful'))!.attrs).toEqual({ panelType: 'warning' });
    expect(panel('info', null)).toBeNull();
  });

  it('mixes inline nodes and bare strings in one paragraph', () => {
    const para = p('Opened ', link('PR #7', 'https://example.com'), ' for review')!;
    expect(para.content).toHaveLength(3);
    expect(toPlainText(para)).toBe('Opened PR #7 for review');
  });
});

describe('fromText', () => {
  it('splits blank-line-separated blocks into paragraphs', () => {
    const d = fromText('First para.\n\nSecond para.');
    expect(d.content).toHaveLength(2);
    expect(toPlainText(d)).toBe('First para.\nSecond para.');
  });

  it('keeps single newlines inside one paragraph', () => {
    expect(fromText('line one\nline two').content).toHaveLength(1);
  });

  it('survives whatever an agent produces, including nothing', () => {
    expect(() => fromText('')).not.toThrow();
    expect(fromText('').content).toHaveLength(1);
    expect(fromText('\n\n\n').content).toHaveLength(1);
  });
});

describe('toPlainText', () => {
  it('round-trips a structured document', () => {
    const d = doc(
      heading(3, 'Acceptance criteria'),
      bullets(['Returns 200', 'Totals by category']),
      p('See ', link('PR #7', 'https://example.com')),
    );
    expect(toPlainText(d)).toBe(
      'Acceptance criteria\n- Returns 200\n- Totals by category\nSee PR #7',
    );
  });

  it('handles null and undefined', () => {
    expect(toPlainText(null)).toBe('');
    expect(toPlainText(undefined)).toBe('');
  });
});
