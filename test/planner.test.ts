import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { silentLogger } from '../src/logger.ts';
import { WEB_TOOLS, planTopic } from '../src/plan/planner.ts';
import type { RunClaudeOptions, RunnerResult } from '../src/runner/spawn.ts';
import { plan, story } from './fixtures.ts';

const planner = {
  model: 'opus',
  webResearch: true,
  maxStories: 12,
  maxSubtasksPerStory: 6,
  timeoutMs: 60_000,
  maxPlansPerDay: 20,
};

function result(structured: unknown, over: Partial<RunnerResult> = {}): RunnerResult {
  return {
    status: 'ok',
    sessionId: 'sess-1',
    exitCode: 0,
    result: {
      type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1',
      structured_output: structured, total_cost_usd: 0.5, num_turns: 4,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    retries: [],
    malformed: [],
    durationMs: 1000,
    stderr: '',
    ...over,
  };
}

/** A fake `claude -p` that returns the queued results in order and records each call. */
function fakeRunner(...queue: RunnerResult[]) {
  const calls: RunClaudeOptions[] = [];
  const run = async (options: RunClaudeOptions) => {
    calls.push(options);
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra planner call');
    return next;
  };
  return { run, calls };
}

const sandboxDir = mkdtempSync(join(tmpdir(), 'autolearn-'));
const topic = { key: 'LEARN-1', title: 'Grafana on AKS', description: 'I know Kubernetes.' };

describe('planTopic', () => {
  it('returns a valid plan from structured output in one call', async () => {
    const fake = fakeRunner(result(plan()));
    const outcome = await planTopic(topic, { planner, sandboxDir, log: silentLogger, run: fake.run });
    expect(outcome.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('gives the planner web tools only, no MCP, and a schema', async () => {
    const fake = fakeRunner(result(plan()));
    await planTopic(topic, { planner, sandboxDir, log: silentLogger, run: fake.run });
    const call = fake.calls[0]!;
    expect(call.tools).toEqual(WEB_TOOLS);
    expect(call.strictMcp).toBe(true);
    expect(call.jsonSchema).toBeTypeOf('object');
    expect(call.cwd).toBe(sandboxDir);
  });

  it('gives no tools at all when web research is off', async () => {
    const fake = fakeRunner(result(plan()));
    await planTopic(topic, { planner: { ...planner, webResearch: false }, sandboxDir, log: silentLogger, run: fake.run });
    expect(fake.calls[0]!.tools).toEqual([]);
    expect(fake.calls[0]!.prompt).toMatch(/Web search is NOT available/);
  });

  it('repairs an invalid plan by resuming the same session', async () => {
    const cyclic = plan({ stories: [story(0, { prerequisites: [1] }), story(1, { prerequisites: [0] })] });
    const fake = fakeRunner(result(cyclic), result(plan()));
    const outcome = await planTopic(topic, { planner, sandboxDir, log: silentLogger, run: fake.run });

    expect(outcome.ok && outcome.repaired).toBe(true);
    expect(fake.calls[1]!.resumeSessionId).toBe('sess-1');
    expect(fake.calls[1]!.prompt).toMatch(/prerequisite cycle/);
  });

  it('enforces the configured limits, not only the schema', async () => {
    const tooMany = plan({ stories: [0, 1, 2, 3].map((i) => story(i)) });
    const fake = fakeRunner(result(tooMany), result(tooMany));
    const outcome = await planTopic(topic, { planner: { ...planner, maxStories: 3 }, sandboxDir, log: silentLogger, run: fake.run });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/above the limit of 3/);
  });

  it('gives up after one repair', async () => {
    const fake = fakeRunner(result({ nope: true }), result({ still: 'nope' }));
    const outcome = await planTopic(topic, { planner, sandboxDir, log: silentLogger, run: fake.run });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe('invalid_output');
    expect(fake.calls).toHaveLength(2);
  });

  it('reports a rate limit without repairing, and tells the caller to back off', async () => {
    const limited = result(undefined, {
      status: 'rate_limited',
      retries: [{ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 3, retry_delay_ms: 60_000, error_status: 429, error: 'rate_limit' }],
    });
    const waits: number[] = [];
    const fake = fakeRunner(limited);
    const outcome = await planTopic(topic, {
      planner, sandboxDir, log: silentLogger, run: fake.run, onRateLimit: (ms) => waits.push(ms),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe('rate_limited');
    expect(waits).toEqual([60_000]);
  });

  it('adds usage across the repair turn', async () => {
    const fake = fakeRunner(result({ bad: 1 }), result(plan()));
    const outcome = await planTopic(topic, { planner, sandboxDir, log: silentLogger, run: fake.run });
    expect(outcome.usage.estCostUsd).toBeCloseTo(1.0);
    expect(outcome.usage.durationMs).toBe(2000);
  });
});
