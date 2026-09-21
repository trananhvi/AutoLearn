import { describe, it, expect } from 'vitest';
import { STRIPPED_ENV_VARS, assertSafeArgs, buildArgs, childEnv, classify, type RunClaudeOptions } from '../src/runner/spawn.ts';
import type { ApiRetryMessage, ResultMessage } from '../src/runner/messages.ts';

const base: RunClaudeOptions = { prompt: 'plan this', cwd: '/tmp/sandbox', permissionMode: 'dontAsk' };

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

describe('buildArgs', () => {
  it('always requests stream-json with --verbose and a permission mode', () => {
    const args = buildArgs(base);
    expect(flagValue(args, '--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(flagValue(args, '--permission-mode')).toBe('dontAsk');
  });

  it('restricts the tool set with --tools, and pre-approves with --allowedTools', () => {
    const args = buildArgs({ ...base, tools: ['WebSearch', 'WebFetch'], allowedTools: ['WebSearch', 'WebFetch'] });
    expect(flagValue(args, '--tools')).toBe('WebSearch,WebFetch');
    expect(flagValue(args, '--allowedTools')).toBe('WebSearch,WebFetch');
  });

  it('spells "no tools" as an empty --tools, never by omitting it', () => {
    expect(flagValue(buildArgs({ ...base, tools: [] }), '--tools')).toBe('');
    expect(buildArgs(base)).not.toContain('--tools');
  });

  it('passes the JSON Schema and isolates MCP when asked', () => {
    const args = buildArgs({ ...base, jsonSchema: { type: 'object' }, strictMcp: true });
    expect(flagValue(args, '--json-schema')).toBe('{"type":"object"}');
    expect(args).toContain('--strict-mcp-config');
  });

  it('refuses --bare before a process is ever created', () => {
    expect(() => buildArgs({ ...base, extraArgs: ['--bare'] })).toThrow(/never bills an API key/);
    expect(() => assertSafeArgs(['-p', 'x', '--bare'])).toThrow(/bare mode/);
  });
});

describe('childEnv', () => {
  it('strips every variable that could route inference somewhere billable', () => {
    const polluted: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const key of STRIPPED_ENV_VARS) polluted[key] = 'set';
    const env = childEnv(polluted);
    for (const key of STRIPPED_ENV_VARS) expect(env[key], key).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('classify', () => {
  const ok = (over: Partial<ResultMessage> = {}): ResultMessage => ({
    type: 'result', subtype: 'success', is_error: false, session_id: 's', ...over,
  });
  const retry = (error: string): ApiRetryMessage => ({
    type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 1000, error_status: 429, error,
  });

  it('is ok only on exit 0 with a non-error result', () => {
    expect(classify({ exit: { code: 0 }, result: ok(), retries: [], abortReason: null })).toBe('ok');
    expect(classify({ exit: { code: 0 }, result: ok({ is_error: true }), retries: [], abortReason: null })).toBe('failed');
  });

  it('separates auth failure, which stops the daemon, from a rate limit, which waits', () => {
    expect(classify({ exit: { code: 1 }, result: null, retries: [retry('authentication_failed')], abortReason: null })).toBe('auth_failed');
    expect(classify({ exit: { code: 1 }, result: null, retries: [retry('rate_limit')], abortReason: null })).toBe('rate_limited');
  });

  it('reports timeout and abort distinctly', () => {
    expect(classify({ exit: { code: null }, result: null, retries: [], abortReason: 'timeout' })).toBe('timeout');
    expect(classify({ exit: { code: null }, result: null, retries: [], abortReason: 'user' })).toBe('aborted');
  });
});
