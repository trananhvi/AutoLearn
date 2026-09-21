import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type TopicStatus = 'running' | 'planned' | 'failed';

export interface TopicRun {
  id: number;
  issueKey: string;
  title: string;
  status: TopicStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  stories: number;
  subtasks: number;
  webSearches: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  durationMs: number;
  sessionId: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS topic_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key     TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  error         TEXT,
  stories       INTEGER NOT NULL DEFAULT 0,
  subtasks      INTEGER NOT NULL DEFAULT 0,
  web_searches  INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost_usd  REAL NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  session_id    TEXT
);
CREATE INDEX IF NOT EXISTS topic_runs_key ON topic_runs (issue_key, id);
CREATE INDEX IF NOT EXISTS topic_runs_started ON topic_runs (started_at);
`;

/**
 * A record of every topic planned: what it produced and what it used.
 *
 * Jira is the source of truth for the learning path itself; this exists for
 * the daily cap and for `npm run cli -- history`.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  start(issueKey: string, title: string): number {
    const row = this.db
      .prepare(`INSERT INTO topic_runs (issue_key, title, status, started_at) VALUES (?, ?, 'running', ?) RETURNING id`)
      .get(issueKey, title, new Date().toISOString()) as { id: number };
    return row.id;
  }

  finish(
    id: number,
    outcome: {
      status: Exclude<TopicStatus, 'running'>;
      error?: string | null;
      stories?: number;
      subtasks?: number;
      webSearches?: number;
      inputTokens?: number;
      outputTokens?: number;
      estCostUsd?: number;
      durationMs?: number;
      sessionId?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE topic_runs SET status = ?, finished_at = ?, error = ?, stories = ?, subtasks = ?,
           web_searches = ?, input_tokens = ?, output_tokens = ?, est_cost_usd = ?, duration_ms = ?,
           session_id = COALESCE(?, session_id)
         WHERE id = ?`,
      )
      .run(
        outcome.status,
        new Date().toISOString(),
        outcome.error ?? null,
        outcome.stories ?? 0,
        outcome.subtasks ?? 0,
        outcome.webSearches ?? 0,
        outcome.inputTokens ?? 0,
        outcome.outputTokens ?? 0,
        outcome.estCostUsd ?? 0,
        outcome.durationMs ?? 0,
        outcome.sessionId ?? null,
        id,
      );
  }

  /** Plans started in the window — the daily cap counts attempts, not successes. */
  countSince(sinceMs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM topic_runs WHERE started_at >= ?')
      .get(new Date(sinceMs).toISOString()) as { n: number };
    return row.n;
  }

  recent(limit = 20): TopicRun[] {
    const rows = this.db.prepare('SELECT * FROM topic_runs ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      issueKey: r.issue_key as string,
      title: r.title as string,
      status: r.status as TopicStatus,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      stories: r.stories as number,
      subtasks: r.subtasks as number,
      webSearches: r.web_searches as number,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      estCostUsd: r.est_cost_usd as number,
      durationMs: r.duration_ms as number,
      sessionId: (r.session_id as string | null) ?? null,
    }));
  }

  /** Runs left `running` by a crash are not running any more. */
  markInterrupted(): number {
    const result = this.db
      .prepare(`UPDATE topic_runs SET status = 'failed', finished_at = ?, error = 'interrupted' WHERE status = 'running'`)
      .run(new Date().toISOString());
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
