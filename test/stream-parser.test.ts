import { describe, it, expect } from 'vitest';
import { StreamParser } from '../src/runner/stream-parser.ts';
import {
  isApiRetry,
  isResult,
  isSubagentMessage,
  isSystemInit,
  textOf,
  thinkingOf,
  toolUsesOf,
} from '../src/runner/messages.ts';

const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-abc',
  model: 'claude-sonnet-5',
  tools: ['Read', 'Edit'],
});

const ASSISTANT = JSON.stringify({
  type: 'assistant',
  parent_tool_use_id: null,
  session_id: 'sess-abc',
  message: {
    content: [
      { type: 'thinking', thinking: 'weighing options' },
      { type: 'text', text: 'Adding the endpoint.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: 'src/app.ts' } },
    ],
  },
});

const SUBAGENT = JSON.stringify({
  type: 'assistant',
  parent_tool_use_id: 'toolu_parent',
  session_id: 'sess-abc',
  message: { content: [{ type: 'text', text: 'from a subagent' }] },
});

// The real shape, taken from an actual `claude -p --output-format json` run.
const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'AUTH_OK',
  session_id: 'sess-abc',
  num_turns: 1,
  duration_ms: 1982,
  total_cost_usd: 0.087616,
  usage: {
    input_tokens: 2,
    output_tokens: 9,
    cache_read_input_tokens: 28014,
    cache_creation_input_tokens: 7242,
  },
  permission_denials: [],
});

describe('StreamParser', () => {
  it('parses whole lines', () => {
    const parser = new StreamParser();
    const messages = parser.push(`${INIT}\n${ASSISTANT}\n`);
    expect(messages).toHaveLength(2);
    expect(isSystemInit(messages[0]!)).toBe(true);
  });

  it('reassembles a message split across chunks', () => {
    const parser = new StreamParser();
    const half = Math.floor(INIT.length / 2);

    expect(parser.push(INIT.slice(0, half))).toEqual([]);
    expect(parser.push(INIT.slice(half))).toEqual([]); // still no newline
    const messages = parser.push('\n');

    expect(messages).toHaveLength(1);
    expect((messages[0] as { session_id: string }).session_id).toBe('sess-abc');
  });

  it('handles several messages arriving in one chunk', () => {
    const parser = new StreamParser();
    expect(parser.push(`${INIT}\n${ASSISTANT}\n${RESULT}\n`)).toHaveLength(3);
  });

  it('tolerates CRLF line endings', () => {
    const parser = new StreamParser();
    expect(parser.push(`${INIT}\r\n`)).toHaveLength(1);
    expect(parser.malformed).toEqual([]);
  });

  it('records a malformed line instead of throwing', () => {
    const parser = new StreamParser();
    const messages = parser.push(`{ not json\n${INIT}\n`);

    expect(messages).toHaveLength(1);
    expect(parser.malformed).toHaveLength(1);
    expect(parser.malformed[0]!.line).toBe('{ not json');
  });

  it('rejects JSON that is not a message object', () => {
    const parser = new StreamParser();
    expect(parser.push('[1,2,3]\n')).toEqual([]);
    expect(parser.push('{"no":"type"}\n')).toEqual([]);
    expect(parser.malformed).toHaveLength(2);
  });

  it('flush recovers a trailing line with no newline, as an abort leaves behind', () => {
    const parser = new StreamParser();
    expect(parser.push(RESULT)).toEqual([]);
    expect(parser.pending).toBe(RESULT);

    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(isResult(flushed[0]!)).toBe(true);
    expect(parser.pending).toBe('');
  });

  it('flush on a truncated line records it rather than losing it silently', () => {
    const parser = new StreamParser();
    parser.push('{"type":"result","is_err');
    expect(parser.flush()).toEqual([]);
    expect(parser.malformed).toHaveLength(1);
  });

  it('ignores blank lines', () => {
    const parser = new StreamParser();
    expect(parser.push('\n\n  \n')).toEqual([]);
    expect(parser.malformed).toEqual([]);
  });

  it('preserves an unrecognised message type rather than dropping it', () => {
    const parser = new StreamParser();
    const messages = parser.push('{"type":"some_future_thing","x":1}\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe('some_future_thing');
  });
});

describe('message accessors', () => {
  const parser = new StreamParser();
  const [init, assistant, subagent, result] = parser.push(
    `${INIT}\n${ASSISTANT}\n${SUBAGENT}\n${RESULT}\n`,
  );

  it('extracts text, thinking, and tool uses separately', () => {
    expect(textOf(assistant!)).toBe('Adding the endpoint.');
    expect(thinkingOf(assistant!)).toBe('weighing options');
    expect(toolUsesOf(assistant!).map((t) => t.name)).toEqual(['Edit']);
  });

  it('distinguishes subagent messages by parent_tool_use_id', () => {
    expect(isSubagentMessage(assistant!)).toBe(false);
    expect(isSubagentMessage(subagent!)).toBe(true);
  });

  it('narrows init and result', () => {
    expect(isSystemInit(init!)).toBe(true);
    expect(isResult(result!)).toBe(true);
    expect(isApiRetry(init!)).toBe(false);
  });
});
