import type { RunnerMessage } from './messages.ts';

export interface MalformedLine {
  line: string;
  error: string;
}

/**
 * Incremental NDJSON parser for `claude -p --output-format stream-json`.
 *
 * stdout arrives in arbitrary chunks that split mid-line, so lines are buffered
 * until a newline arrives. A line that fails to parse is recorded rather than
 * thrown: losing one malformed line is recoverable, crashing a Dev step ten
 * minutes in is not.
 */
export class StreamParser {
  #buffer = '';
  readonly malformed: MalformedLine[] = [];

  /** Feed a stdout chunk; returns every message completed by it. */
  push(chunk: string): RunnerMessage[] {
    this.#buffer += chunk;
    const messages: RunnerMessage[] = [];

    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const parsed = this.#parseLine(line);
      if (parsed) messages.push(parsed);
      newline = this.#buffer.indexOf('\n');
    }
    return messages;
  }

  /**
   * Drains a trailing line with no newline after it — which is exactly what a
   * SIGINT mid-write leaves behind.
   */
  flush(): RunnerMessage[] {
    if (this.#buffer.trim().length === 0) {
      this.#buffer = '';
      return [];
    }
    const parsed = this.#parseLine(this.#buffer);
    this.#buffer = '';
    return parsed ? [parsed] : [];
  }

  get pending(): string {
    return this.#buffer;
  }

  #parseLine(rawLine: string): RunnerMessage | null {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0) return null;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      this.malformed.push({ line, error: err instanceof Error ? err.message : String(err) });
      return null;
    }

    if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string') {
      this.malformed.push({ line, error: 'not a message object with a string `type`' });
      return null;
    }

    return value as RunnerMessage;
  }
}
