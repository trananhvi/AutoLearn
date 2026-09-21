import { spawn } from 'node:child_process';
import { resolveClaudeBin } from './claude-bin.ts';
import { StreamParser, type MalformedLine } from './stream-parser.ts';
import {
  isApiRetry,
  isResult,
  isSystemInit,
  type ApiRetryMessage,
  type ResultMessage,
  type RunnerMessage,
} from './messages.ts';

export type StepStatus = 'ok' | 'failed' | 'timeout' | 'aborted' | 'rate_limited' | 'auth_failed';

export type PermissionMode = 'acceptEdits' | 'dontAsk' | 'auto' | 'plan' | 'manual';

export interface RunClaudeOptions {
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  /**
   * The tools that exist at all (`--tools`). Stronger than an allow list: a
   * tool left out here is not in the model's context, so it cannot be called.
   * An empty array means no tools.
   */
  tools?: string[];
  /** Tools that run without a permission prompt (`--allowedTools`). */
  allowedTools?: string[];
  appendSystemPromptFile?: string;
  /** Validated structured output, returned in `result.structured_output`. */
  jsonSchema?: object;
  /**
   * Ignore every MCP server from user and claude.ai settings. Without it the
   * planner would load whatever connectors the logged-in account has — mail,
   * drive, calendar — none of which it should be able to see.
   */
  strictMcp?: boolean;
  resumeSessionId?: string;
  maxTurns?: number;
  timeoutMs?: number;
  extraArgs?: string[];
  signal?: AbortSignal;
  onMessage?(message: RunnerMessage): void;
  env?: NodeJS.ProcessEnv;
}

export interface RunnerResult {
  status: StepStatus;
  sessionId: string | null;
  exitCode: number | null;
  result: ResultMessage | null;
  retries: ApiRetryMessage[];
  malformed: MalformedLine[];
  durationMs: number;
  stderr: string;
  error?: string;
}

/**
 * Environment variables that would route inference somewhere billable.
 *
 * Stripped from every child process. `--bare` is separately refused in
 * `assertSafeArgs`. Between the two, a plan cannot spend money on an API key
 * even if the surrounding shell is configured to.
 */
export const STRIPPED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
] as const;

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV_VARS) delete env[key];
  return env;
}

/**
 * `--bare` skips OAuth entirely and demands an API key. It is the single flag
 * that would silently turn this project into a billed one, so it is refused
 * before a process is ever created.
 */
export function assertSafeArgs(args: readonly string[]): void {
  if (args.includes('--bare')) {
    throw new Error(
      'Refusing to spawn `claude --bare`: bare mode does not read the subscription login ' +
        'and requires ANTHROPIC_API_KEY. AutoLearn never bills an API key.',
    );
  }
}

/** Pure and separately testable — the flag list is easy to get subtly wrong. */
export function buildArgs(options: RunClaudeOptions): string[] {
  const args = ['-p', options.prompt, '--output-format', 'stream-json', '--verbose'];

  if (options.model) args.push('--model', options.model);

  // Mandatory: `-p` starts in Manual mode, so without this every tool call
  // would block forever waiting for a prompt nobody can answer.
  args.push('--permission-mode', options.permissionMode);

  // `--tools ""` is how the CLI spells "no tools"; omitting the flag means all.
  if (options.tools) args.push('--tools', options.tools.join(','));
  if (options.allowedTools?.length) args.push('--allowedTools', options.allowedTools.join(','));
  if (options.appendSystemPromptFile) {
    args.push('--append-system-prompt-file', options.appendSystemPromptFile);
  }
  if (options.jsonSchema) args.push('--json-schema', JSON.stringify(options.jsonSchema));
  if (options.strictMcp) args.push('--strict-mcp-config');
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  if (options.maxTurns !== undefined) args.push('--max-turns', String(options.maxTurns));
  if (options.extraArgs?.length) args.push(...options.extraArgs);

  assertSafeArgs(args);
  return args;
}

/** Windows has no POSIX signals; SIGINT would map to TerminateProcess anyway. */
const STOP_SIGNAL: NodeJS.Signals = process.platform === 'win32' ? 'SIGTERM' : 'SIGINT';
const HARD_KILL_GRACE_MS = 10_000;
/** After this, stop waiting for `close` and report the result we have. */
const ABANDON_AFTER_KILL_MS = 30_000;

/**
 * Kills the whole process tree.
 *
 * On Windows `child.kill()` signals only `claude.exe`, whose own children keep
 * the stdio pipes open, so `close` never fires. AutoSDLC once waited 6.6 hours
 * on a 15-minute timeout this way.
 */
function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill(signal));
    return;
  }
  child.kill(signal);
}

export async function runClaude(options: RunClaudeOptions): Promise<RunnerResult> {
  const startedAt = Date.now();
  const bin = resolveClaudeBin(options.env);
  const args = buildArgs(options);

  const parser = new StreamParser();
  const retries: ApiRetryMessage[] = [];
  let sessionId: string | null = options.resumeSessionId ?? null;
  let result: ResultMessage | null = null;
  let stderr = '';
  let abortReason: 'user' | 'timeout' | null = null;

  const child = spawn(bin.file, args, {
    cwd: options.cwd,
    env: childEnv(options.env),
    shell: bin.useShell,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const handle = (messages: RunnerMessage[]) => {
    for (const message of messages) {
      if (isSystemInit(message) && message.session_id) sessionId = message.session_id;
      if (isApiRetry(message)) retries.push(message);
      if (isResult(message)) {
        result = message;
        if (message.session_id) sessionId = message.session_id;
      }
      options.onMessage?.(message);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => handle(parser.push(chunk)));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let hardKill: NodeJS.Timeout | undefined;
  let abandon: NodeJS.Timeout | undefined;
  let abandoned = false;
  const stop = (reason: 'user' | 'timeout') => {
    if (abortReason) return;
    abortReason = reason;
    killTree(child, STOP_SIGNAL);

    hardKill = setTimeout(() => killTree(child, 'SIGKILL'), HARD_KILL_GRACE_MS);
    hardKill.unref();

    abandon = setTimeout(() => {
      abandoned = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.emit('close', null, null);
    }, ABANDON_AFTER_KILL_MS);
    abandon.unref();
  };

  const onAbort = () => stop('user');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = options.timeoutMs ? setTimeout(() => stop('timeout'), options.timeoutMs) : undefined;

  const exit = await new Promise<{ code: number | null; error?: Error }>((resolveExit) => {
    child.on('error', (error) => resolveExit({ code: null, error }));
    child.once('close', (code) => resolveExit({ code }));
  });

  handle(parser.flush());
  if (timeout) clearTimeout(timeout);
  if (hardKill) clearTimeout(hardKill);
  if (abandon) clearTimeout(abandon);
  if (abandoned) stderr += '\n[runner] process tree would not exit; abandoned after kill.';
  options.signal?.removeEventListener('abort', onAbort);

  return {
    status: classify({ exit, result, retries, abortReason }),
    sessionId,
    exitCode: exit.code,
    result,
    retries,
    malformed: parser.malformed,
    durationMs: Date.now() - startedAt,
    stderr,
    error: exit.error?.message,
  };
}

const FATAL_AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'billing_error']);

/**
 * Turns an exit into a status the caller can act on. Auth failures are kept
 * apart from ordinary failures: a broken login must stop the daemon, a failed
 * plan is just one topic.
 */
export function classify(input: {
  exit: { code: number | null; error?: Error };
  result: ResultMessage | null;
  retries: ApiRetryMessage[];
  abortReason: 'user' | 'timeout' | null;
}): StepStatus {
  const { exit, result, retries, abortReason } = input;

  if (abortReason === 'timeout') return 'timeout';
  if (abortReason === 'user') return 'aborted';
  if (exit.error) return 'failed';
  if (retries.some((r) => FATAL_AUTH_ERRORS.has(r.error))) return 'auth_failed';
  if (exit.code === 0 && result && !result.is_error) return 'ok';
  if (retries.some((r) => r.error === 'rate_limit')) return 'rate_limited';
  return 'failed';
}

/** Token and cost totals, defaulted so callers never juggle undefined. */
export function usageOf(result: ResultMessage | null) {
  return {
    inputTokens: result?.usage?.input_tokens ?? 0,
    outputTokens: result?.usage?.output_tokens ?? 0,
    cacheReadTokens: result?.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: result?.usage?.cache_creation_input_tokens ?? 0,
    estCostUsd: result?.total_cost_usd ?? 0,
    numTurns: result?.num_turns ?? 0,
  };
}
