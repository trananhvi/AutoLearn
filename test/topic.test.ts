import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, expect } from 'vitest';
import type { AdfDoc } from '../src/jira/adf.ts';
import { toPlainText } from '../src/jira/adf.ts';
import type { JiraIssue, NewIssue } from '../src/jira/client.ts';
import type { ProjectSetup } from '../src/jira/project.ts';
import { silentLogger } from '../src/logger.ts';
import type { RunClaudeOptions, RunnerResult } from '../src/runner/spawn.ts';
import { Store } from '../src/store.ts';
import { ITEM_LABEL, runTopic, type JiraPort } from '../src/topic.ts';
import { plan } from './fixtures.ts';

/** An in-memory Jira holding just what a topic run touches. */
class FakeJira implements JiraPort {
  issues = new Map<string, { summary: string; description: string; status: string; labels: string[]; parent: string | null; type: string }>();
  comments: Array<{ key: string; text: string }> = [];
  bulkCalls = 0;
  #next = 100;
  failSubtasks = false;

  add(key: string, over: Partial<{ summary: string; status: string; labels: string[] }> = {}) {
    this.issues.set(key, { summary: 'Grafana on AKS', description: '', status: 'Ready for AI', labels: ['autolearn'], parent: null, type: 'Epic', ...over });
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const i = this.issues.get(key);
    if (!i) throw new Error(`no ${key}`);
    return {
      id: key, key,
      fields: {
        summary: i.summary, description: null, status: { name: i.status, id: '1' },
        issuetype: { name: i.type, id: '1' }, labels: i.labels, updated: '', created: '',
      },
    };
  }

  async children(key: string) {
    const issues = [...this.issues.entries()].filter(([, i]) => i.parent === key).map(([k]) => ({ key: k }) as JiraIssue);
    return { issues };
  }

  async createIssues(list: NewIssue[]) {
    this.bulkCalls++;
    if (this.failSubtasks && list[0]?.issueType === 'Subtask') {
      return { issues: [], errors: [{ status: 400, elementErrors: { errors: { parent: 'nope' } } }] };
    }
    const created = list.map((n) => {
      const key = `LEARN-${this.#next++}`;
      this.issues.set(key, {
        summary: n.summary, description: toPlainText(n.description), status: 'To Do',
        labels: n.labels ?? [], parent: n.parentKey ?? null, type: n.issueType,
      });
      return { id: key, key };
    });
    return { issues: created, errors: [] };
  }

  async addComment(key: string, body: AdfDoc) {
    this.comments.push({ key, text: toPlainText(body) });
  }

  async setLabels(key: string, add: string[] = [], remove: string[] = []) {
    const i = this.issues.get(key)!;
    i.labels = [...i.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !i.labels.includes(l))];
  }

  async moveTo(key: string, status: string) {
    const i = this.issues.get(key)!;
    if (i.status === status) return false;
    i.status = status;
    return true;
  }
}

const project: ProjectSetup = {
  key: 'LEARN',
  storyType: { id: '10', name: 'Story', subtask: false, hierarchyLevel: 0 },
  subtaskType: { id: '11', name: 'Subtask', subtask: true, hierarchyLevel: -1 },
  statuses: { trigger: 'Ready for AI', planning: 'Planning', planned: 'In Progress', failed: 'Blocked' },
  warnings: [],
};

function okRunner(structured: unknown = plan()) {
  let calls = 0;
  const run = async (_o: RunClaudeOptions): Promise<RunnerResult> => {
    calls++;
    return {
      status: 'ok', sessionId: 's', exitCode: 0, retries: [], malformed: [], durationMs: 5, stderr: '',
      result: { type: 'result', subtype: 'success', is_error: false, session_id: 's', structured_output: structured },
    };
  };
  return { run, count: () => calls };
}

let jira: FakeJira;
let store: Store;
let dir: string;

function deps(runner = okRunner(), over: Partial<Parameters<typeof runTopic>[1]> = {}) {
  return {
    jira,
    project,
    store,
    log: silentLogger,
    config: {
      trigger: { label: 'autolearn', status: 'Ready for AI', pollIntervalMs: 30_000 },
      planner: { model: 'opus', webResearch: true, maxStories: 12, maxSubtasksPerStory: 6, timeoutMs: 60_000, maxPlansPerDay: 20 },
      paths: { data: dir, plans: join(dir, 'plans'), sandbox: join(dir, 'sandbox'), db: ':memory:' },
    },
    planner: { run: runner.run },
    ...over,
  };
}

beforeEach(() => {
  jira = new FakeJira();
  jira.add('LEARN-1');
  store = new Store(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'autolearn-topic-'));
});

describe('runTopic', () => {
  it('creates stories under the epic and sub-tasks under each story, in learning order', async () => {
    const result = await runTopic('LEARN-1', deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.storyKeys).toHaveLength(3);
    expect(result.subtaskKeys).toHaveLength(6);
    const stories = result.storyKeys.map((k) => jira.issues.get(k)!);
    expect(stories.map((s) => s.summary)).toEqual(['1. Story 0', '2. Story 1', '3. Story 2']);
    expect(stories.every((s) => s.parent === 'LEARN-1' && s.labels.includes(ITEM_LABEL))).toBe(true);

    const firstSub = jira.issues.get(result.subtaskKeys[0]!)!;
    expect(firstSub.parent).toBe(result.storyKeys[0]);
    expect(firstSub.summary).toBe('1.1 Detail 0a');
  });

  it('uses two bulk requests, not one per issue', async () => {
    await runTopic('LEARN-1', deps());
    expect(jira.bulkCalls).toBe(2);
  });

  it('moves the epic on and swaps its label, so it never fires twice', async () => {
    await runTopic('LEARN-1', deps());
    const epic = jira.issues.get('LEARN-1')!;
    expect(epic.status).toBe('In Progress');
    expect(epic.labels).toEqual(['autolearn-planned']);
    expect(jira.comments.find((c) => c.key === 'LEARN-1')?.text).toMatch(/3 stories, 6 sub-tasks/);
  });

  it('refuses a topic that already has children, rather than duplicating the path', async () => {
    jira.issues.set('LEARN-50', { summary: 'x', description: '', status: 'To Do', labels: [], parent: 'LEARN-1', type: 'Story' });
    const runner = okRunner();
    const result = await runTopic('LEARN-1', deps(runner));

    expect(result.ok).toBe(false);
    expect(runner.count()).toBe(0);
    expect(jira.issues.get('LEARN-1')!.labels).toEqual(['autolearn-failed']);
  });

  it('writes subtopics into the story when the project has no sub-task type', async () => {
    const result = await runTopic('LEARN-1', deps(okRunner(), { project: { ...project, subtaskType: null } }));
    if (!result.ok) throw new Error(result.error);
    expect(result.subtaskKeys).toEqual([]);
    expect(jira.issues.get(result.storyKeys[0]!)!.description).toMatch(/Detail 0a/);
  });

  it('marks the topic failed and says what was already created when Jira rejects sub-tasks', async () => {
    jira.failSubtasks = true;
    const result = await runTopic('LEARN-1', deps());
    expect(result.ok).toBe(false);
    const epic = jira.issues.get('LEARN-1')!;
    expect(epic.status).toBe('Blocked');
    expect(epic.labels).toContain('autolearn-failed');
    expect(jira.comments.at(-1)!.text).toMatch(/Already created before the failure: LEARN-100/);
  });

  it('reuses a saved plan instead of paying for the planner again', async () => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    writeFileSync(join(dir, 'plans', 'LEARN-1.json'), JSON.stringify(plan()));
    const runner = okRunner();
    const result = await runTopic('LEARN-1', deps(runner));
    expect(result.ok && result.reusedPlan).toBe(true);
    expect(runner.count()).toBe(0);
  });

  it('hands a rate-limited topic back to the trigger status for a later retry', async () => {
    const limited = async (): Promise<RunnerResult> => ({
      status: 'rate_limited', sessionId: null, exitCode: 1, result: null, malformed: [], durationMs: 1, stderr: '',
      retries: [{ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 3, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' }],
    });
    const result = await runTopic('LEARN-1', deps({ run: limited, count: () => 1 }));
    expect(result.ok).toBe(false);
    const epic = jira.issues.get('LEARN-1')!;
    expect(epic.status).toBe('Ready for AI');
    expect(epic.labels).toEqual(['autolearn']);
  });

  it('records each run for the daily cap', async () => {
    await runTopic('LEARN-1', deps());
    expect(store.countSince(Date.now() - 60_000)).toBe(1);
    expect(store.recent()[0]).toMatchObject({ issueKey: 'LEARN-1', status: 'planned', stories: 3, subtasks: 6 });
  });
});
