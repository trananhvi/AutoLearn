/**
 * The `--output-format stream-json` wire format.
 *
 * Typed permissively on purpose: Claude Code adds message types and fields
 * between versions, and a parser that throws on an unrecognised `type` would
 * turn a routine CLI upgrade into a broken orchestrator. Unknown messages are
 * preserved as `UnknownMessage` rather than dropped.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown };

export interface SystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  mcp_server_errors?: Array<{ name: string; type: string; message: string }>;
  plugins?: Array<{ name: string; path: string }>;
  plugin_errors?: Array<{ plugin: string; type: string; message: string }>;
  capabilities?: string[];
  uuid?: string;
}

/**
 * Emitted before Claude Code retries a failed request. This is the
 * orchestrator's primary backpressure signal — `error: "rate_limit"` means
 * pause dispatch; `authentication_failed` means stop entirely, because
 * retrying a broken login only wastes the window.
 */
export interface ApiRetryMessage {
  type: 'system';
  subtype: 'api_retry';
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error:
    | 'authentication_failed'
    | 'oauth_org_not_allowed'
    | 'billing_error'
    | 'rate_limit'
    | 'overloaded'
    | 'invalid_request'
    | 'model_not_found'
    | 'server_error'
    | 'max_output_tokens'
    | 'unknown'
    | string;
  session_id?: string;
  uuid?: string;
}

export interface OtherSystemMessage {
  type: 'system';
  subtype: string;
  session_id?: string;
  uuid?: string;
  [key: string]: unknown;
}

export interface AssistantMessage {
  type: 'assistant';
  message: { content: ContentBlock[]; model?: string; [key: string]: unknown };
  /** Non-null means this came from a subagent, not the main conversation. */
  parent_tool_use_id: string | null;
  session_id?: string;
  uuid?: string;
}

export interface UserMessage {
  type: 'user';
  message: { content: ContentBlock[]; [key: string]: unknown };
  parent_tool_use_id: string | null;
  session_id?: string;
  uuid?: string;
}

export interface StreamEventMessage {
  type: 'stream_event';
  event: { type: string; delta?: { type: string; text?: string }; [key: string]: unknown };
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: unknown;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  [key: string]: unknown;
}

export interface ResultMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | string;
  is_error: boolean;
  result?: string;
  /** Present when the run used `--json-schema`. */
  structured_output?: unknown;
  session_id: string;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  stop_reason?: string;
  terminal_reason?: string;
  api_error_status?: number | null;
  /** A client-side ESTIMATE. Under a subscription this is not a bill. */
  total_cost_usd?: number;
  usage?: Usage;
  modelUsage?: Record<string, ModelUsage>;
  permission_denials?: unknown[];
  uuid?: string;
}

export interface UnknownMessage {
  type: '__unknown';
  raw: unknown;
}

export type RunnerMessage =
  | SystemInitMessage
  | ApiRetryMessage
  | OtherSystemMessage
  | AssistantMessage
  | UserMessage
  | StreamEventMessage
  | ResultMessage
  | UnknownMessage;

// ── narrowing helpers ────────────────────────────────────────────────────────

export function isSystemInit(m: RunnerMessage): m is SystemInitMessage {
  return m.type === 'system' && (m as OtherSystemMessage).subtype === 'init';
}

export function isApiRetry(m: RunnerMessage): m is ApiRetryMessage {
  return m.type === 'system' && (m as OtherSystemMessage).subtype === 'api_retry';
}

export function isAssistant(m: RunnerMessage): m is AssistantMessage {
  return m.type === 'assistant';
}

export function isUser(m: RunnerMessage): m is UserMessage {
  return m.type === 'user';
}

export function isResult(m: RunnerMessage): m is ResultMessage {
  return m.type === 'result';
}

/** Messages produced by a subagent rather than the main conversation. */
export function isSubagentMessage(m: RunnerMessage): boolean {
  return (
    (m.type === 'assistant' || m.type === 'user' || m.type === 'stream_event') &&
    typeof (m as AssistantMessage).parent_tool_use_id === 'string'
  );
}

export function textOf(m: RunnerMessage): string {
  if (!isAssistant(m)) return '';
  return m.message.content
    .filter((b): b is TextBlock => b.type === 'text' && typeof (b as TextBlock).text === 'string')
    .map((b) => b.text)
    .join('');
}

export function thinkingOf(m: RunnerMessage): string {
  if (!isAssistant(m)) return '';
  return m.message.content
    .filter((b): b is ThinkingBlock => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('');
}

export function toolUsesOf(m: RunnerMessage): ToolUseBlock[] {
  if (!isAssistant(m)) return [];
  return m.message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

export function toolResultsOf(m: RunnerMessage): ToolResultBlock[] {
  if (!isUser(m)) return [];
  return m.message.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
}
