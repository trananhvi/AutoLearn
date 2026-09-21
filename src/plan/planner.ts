import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT_DIR, type Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { textOf, toolUsesOf, type RunnerMessage } from '../runner/messages.ts';
import { runClaude, usageOf, type RunClaudeOptions, type RunnerResult, type StepStatus } from '../runner/spawn.ts';
import { plannerPrompt, repairPrompt, type TopicInput } from './prompt.ts';
import { LearningPlanSchema, planJsonSchema, type LearningPlan } from './schema.ts';

export const PLANNER_PROMPT_FILE = resolve(ROOT_DIR, 'prompts', 'planner.md');

/** Web tools only. No Read, Write, Bash — the planner has no business with files. */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];

export type PlanOutcome =
  | { ok: true; plan: LearningPlan; sessionId: string | null; usage: Usage; repaired: boolean }
  | { ok: false; status: StepStatus | 'invalid_output'; error: string; sessionId: string | null; usage: Usage };

export type Usage = ReturnType<typeof usageOf> & { durationMs: number; webSearches: number };

export interface PlannerDeps {
  planner: Config['planner'];
  sandboxDir: string;
  log: Logger;
  signal?: AbortSignal;
  /** Injected in tests; the real one spawns `claude -p`. */
  run?: (options: RunClaudeOptions) => Promise<RunnerResult>;
  onRateLimit?(retryDelayMs: number): void;
}

/**
 * Plans one topic: one `claude -p` call, validated, with one repair turn.
 *
 * The repair resumes the same session rather than starting cold, so the
 * planner keeps everything it already researched and only fixes what failed.
 */
export async function planTopic(topic: TopicInput, deps: PlannerDeps): Promise<PlanOutcome> {
  const { planner, log } = deps;
  const run = deps.run ?? runClaude;
  mkdirSync(deps.sandboxDir, { recursive: true });

  let webSearches = 0;
  const onMessage = (message: RunnerMessage) => {
    for (const use of toolUsesOf(message)) {
      if (use.name === 'WebSearch') {
        webSearches++;
        log.info('searching', { query: String(use.input.query ?? '').slice(0, 120) });
      } else if (use.name === 'WebFetch') {
        log.info('reading', { url: String(use.input.url ?? '').slice(0, 160) });
      }
    }
    const text = textOf(message).trim();
    if (text) log.debug('planner', { text: text.slice(0, 300) });
  };

  const tools = planner.webResearch ? WEB_TOOLS : [];
  const invoke = (prompt: string, resumeSessionId?: string) =>
    run({
      prompt,
      // An empty directory: no repository, no CLAUDE.md, nothing to read.
      cwd: deps.sandboxDir,
      model: planner.model,
      permissionMode: 'dontAsk',
      tools,
      allowedTools: tools,
      appendSystemPromptFile: PLANNER_PROMPT_FILE,
      jsonSchema: planJsonSchema(),
      strictMcp: true,
      resumeSessionId,
      maxTurns: 80,
      timeoutMs: planner.timeoutMs,
      signal: deps.signal,
      onMessage,
    });

  const limits = {
    maxStories: planner.maxStories,
    maxSubtasksPerStory: planner.maxSubtasksPerStory,
    webResearch: planner.webResearch,
  };

  let result = await invoke(plannerPrompt(topic, limits));
  noteRetries(result, deps);
  let usage = sumUsage(undefined, result, webSearches);

  if (result.status !== 'ok') {
    return { ok: false, status: result.status, error: describeFailure(result), sessionId: result.sessionId, usage };
  }

  let checked = validate(result, limits);
  let repaired = false;

  if (!checked.ok && result.sessionId) {
    log.warn('plan failed validation; asking for a repair', { error: checked.error.slice(0, 300) });
    result = await invoke(repairPrompt(checked.error), result.sessionId);
    noteRetries(result, deps);
    usage = sumUsage(usage, result, webSearches);
    if (result.status !== 'ok') {
      return { ok: false, status: result.status, error: describeFailure(result), sessionId: result.sessionId, usage };
    }
    checked = validate(result, limits);
    repaired = true;
  }

  if (!checked.ok) {
    return { ok: false, status: 'invalid_output', error: checked.error, sessionId: result.sessionId, usage };
  }
  return { ok: true, plan: checked.plan, sessionId: result.sessionId, usage, repaired };
}

type Checked = { ok: true; plan: LearningPlan } | { ok: false; error: string };

/**
 * Schema validation plus the configured limits.
 *
 * The limits are checked here rather than baked into the JSON Schema, so that
 * changing them in `.env` never needs a schema change.
 */
export function validate(
  result: RunnerResult,
  limits: { maxStories: number; maxSubtasksPerStory: number },
): Checked {
  const raw = result.result?.structured_output ?? tryParse(result.result?.result);
  if (raw === undefined) return { ok: false, error: 'No structured output was returned.' };

  const parsed = LearningPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, error: issues.join('\n') };
  }

  const problems: string[] = [];
  if (parsed.data.stories.length > limits.maxStories) {
    problems.push(`stories: ${parsed.data.stories.length} stories, above the limit of ${limits.maxStories}`);
  }
  for (const story of parsed.data.stories) {
    if (story.subtopics.length > limits.maxSubtasksPerStory) {
      problems.push(
        `stories[ordinal ${story.ordinal}].subtopics: ${story.subtopics.length}, above the limit of ${limits.maxSubtasksPerStory}`,
      );
    }
  }
  return problems.length > 0 ? { ok: false, error: problems.join('\n') } : { ok: true, plan: parsed.data };
}

function tryParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function noteRetries(result: RunnerResult, deps: PlannerDeps): void {
  for (const retry of result.retries) {
    if (retry.error === 'rate_limit') deps.onRateLimit?.(retry.retry_delay_ms);
  }
}

function sumUsage(previous: Usage | undefined, result: RunnerResult, webSearches: number): Usage {
  const now = usageOf(result.result);
  if (!previous) return { ...now, durationMs: result.durationMs, webSearches };
  return {
    inputTokens: previous.inputTokens + now.inputTokens,
    outputTokens: previous.outputTokens + now.outputTokens,
    cacheReadTokens: previous.cacheReadTokens + now.cacheReadTokens,
    cacheCreationTokens: previous.cacheCreationTokens + now.cacheCreationTokens,
    estCostUsd: previous.estCostUsd + now.estCostUsd,
    numTurns: previous.numTurns + now.numTurns,
    durationMs: previous.durationMs + result.durationMs,
    webSearches,
  };
}

function describeFailure(result: RunnerResult): string {
  switch (result.status) {
    case 'auth_failed':
      return 'Claude authentication failed. Run `claude login` with your subscription account.';
    case 'rate_limited':
      return 'Rate limited by the Claude plan. The topic can be retried once the window resets.';
    case 'timeout':
      return 'The planner ran past its time limit (STEP_TIMEOUT_MS).';
    case 'aborted':
      return 'Aborted.';
    default: {
      const detail = result.result?.subtype && result.result.subtype !== 'success'
        ? result.result.subtype
        : result.error ?? result.stderr.trim().split('\n').slice(-3).join(' ');
      return `The planner failed (exit ${result.exitCode ?? '?'}): ${detail || 'no detail'}`;
    }
  }
}
