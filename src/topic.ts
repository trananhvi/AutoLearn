import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config.ts';
import type { AdfDoc } from './jira/adf.ts';
import { toPlainText } from './jira/adf.ts';
import type { JiraClient, JiraIssue, NewIssue } from './jira/client.ts';
import type { ProjectSetup } from './jira/project.ts';
import { moveTo } from './jira/transitions.ts';
import type { Logger } from './logger.ts';
import { planTopic, type PlannerDeps, type Usage } from './plan/planner.ts';
import {
  failureComment,
  planComment,
  planMarkdown,
  storyDescription,
  storyTitle,
  subtaskDescription,
  subtaskTitle,
} from './plan/render.ts';
import { LearningPlanSchema, orderStories, planStats, type LearningPlan } from './plan/schema.ts';
import type { Store } from './store.ts';

/** The Jira calls a topic run makes — narrow, so tests can fake it. */
export interface JiraPort {
  getIssue(key: string): Promise<JiraIssue>;
  children(key: string): Promise<{ issues: JiraIssue[] }>;
  createIssues(issues: NewIssue[]): Promise<{ issues: Array<{ id: string; key: string }>; errors: unknown[] }>;
  addComment(key: string, body: AdfDoc): Promise<unknown>;
  setLabels(key: string, add?: string[], remove?: string[]): Promise<void>;
  moveTo(key: string, status: string): Promise<boolean>;
}

export function jiraPort(client: JiraClient): JiraPort {
  return {
    getIssue: (key) => client.getIssue(key),
    children: (key) => client.children(key),
    createIssues: (issues) => client.createIssues(issues),
    addComment: (key, body) => client.addComment(key, body),
    setLabels: (key, add, remove) => client.setLabels(key, add, remove),
    moveTo: (key, status) => moveTo(client, key, status),
  };
}

/** Labels that record where a topic is. Swapping them is also the claim. */
export function stateLabels(trigger: string) {
  return {
    trigger,
    planning: `${trigger}-planning`,
    planned: `${trigger}-planned`,
    failed: `${trigger}-failed`,
  };
}

/** Put on every story and sub-task, so the learning items are easy to filter. */
export const ITEM_LABEL = 'learning';

export interface TopicDeps {
  jira: JiraPort;
  project: ProjectSetup;
  config: Pick<Config, 'planner' | 'paths' | 'trigger'>;
  store: Store;
  log: Logger;
  signal?: AbortSignal;
  /** Re-plan even when a saved plan for this topic exists. */
  replan?: boolean;
  planner?: Pick<PlannerDeps, 'run' | 'onRateLimit'>;
}

export type TopicResult =
  | { ok: true; storyKeys: string[]; subtaskKeys: string[]; plan: LearningPlan; reusedPlan: boolean }
  | { ok: false; error: string; fatal: boolean };

/**
 * Plans one topic end to end: claim, plan, publish, record.
 *
 * The expensive step — the planner — runs once per topic. Its output is saved
 * before anything is written to Jira, so if publishing fails the retry reuses
 * the plan instead of paying for it again.
 */
export async function runTopic(key: string, deps: TopicDeps): Promise<TopicResult> {
  const { jira, project, config, store, log } = deps;
  const labels = stateLabels(config.trigger.label);

  const issue = await jira.getIssue(key);
  const title = issue.fields.summary;
  const runId = store.start(key, title);
  let usage: Usage | undefined;
  let sessionId: string | null = null;
  let created: string[] = [];

  const fail = async (error: string, fatal = false): Promise<TopicResult> => {
    log.error('topic failed', { key, error });
    store.finish(runId, {
      status: 'failed',
      error,
      stories: created.length,
      sessionId,
      ...usageFields(usage),
    });
    const note = created.length > 0 ? `${error}\n\nAlready created before the failure: ${created.join(', ')}.` : error;
    await safely(log, () => jira.addComment(key, failureComment(note, labels.trigger)));
    await safely(log, () => jira.setLabels(key, [labels.failed], [labels.trigger, labels.planning]));
    if (project.statuses.failed) await safely(log, () => jira.moveTo(key, project.statuses.failed!));
    return { ok: false, error, fatal };
  };

  try {
    // Never plan into a topic that already has items: a second set of stories
    // under the same epic is worse than no plan at all.
    const existing = await jira.children(key);
    if (existing.issues.length > 0) {
      return await fail(
        `${key} already has ${existing.issues.length} child issue(s). AutoLearn only plans empty topics — ` +
          'delete them, or create a new epic.',
      );
    }

    // ── claim ─────────────────────────────────────────────────────────────
    // The label swap alone takes the topic out of the trigger query; the
    // status change shows you it has been picked up.
    await jira.setLabels(key, [labels.planning], [labels.trigger, labels.failed]);
    await safely(log, () => jira.moveTo(key, project.statuses.planning));

    // ── plan ──────────────────────────────────────────────────────────────
    const planPath = resolve(config.paths.plans, `${key}.json`);
    let plan = deps.replan ? null : loadSavedPlan(planPath);
    const reusedPlan = plan !== null;

    if (plan) {
      log.info('reusing the saved plan for this topic', { path: planPath });
    } else {
      log.info('planning', { key, title, model: config.planner.model, web: config.planner.webResearch });
      const outcome = await planTopic(
        { key, title, description: toPlainText(issue.fields.description ?? null) },
        {
          planner: config.planner,
          sandboxDir: config.paths.sandbox,
          log,
          signal: deps.signal,
          ...deps.planner,
        },
      );
      usage = outcome.usage;
      sessionId = outcome.sessionId;
      if (!outcome.ok && outcome.status === 'rate_limited') {
        // Not the topic's fault. Hand it back so the next poll after the pause
        // picks it up again, rather than making you re-trigger it by hand.
        store.finish(runId, { status: 'failed', error: outcome.error, sessionId, ...usageFields(usage) });
        await safely(log, () => jira.setLabels(key, [labels.trigger], [labels.planning]));
        await safely(log, () => jira.moveTo(key, project.statuses.trigger));
        log.warn('rate limited; topic handed back for a later retry', { key });
        return { ok: false, error: outcome.error, fatal: false };
      }
      if (!outcome.ok) return await fail(outcome.error, outcome.status === 'auth_failed');
      plan = outcome.plan;
      savePlan(planPath, plan);
      log.info('planned', { ...planStats(plan), repaired: outcome.repaired, webSearches: outcome.usage.webSearches });
    }

    // ── publish ───────────────────────────────────────────────────────────
    const { storyKeys, subtaskKeys } = await publish(key, plan, deps, (keys) => {
      created = keys;
    });
    created = [...storyKeys, ...subtaskKeys];

    await safely(log, () => jira.addComment(key, planComment(plan, storyKeys)));
    await safely(log, () => jira.setLabels(key, [labels.planned], [labels.planning]));
    await safely(log, () => jira.moveTo(key, project.statuses.planned));

    const stats = planStats(plan);
    store.finish(runId, {
      status: 'planned',
      stories: storyKeys.length,
      subtasks: subtaskKeys.length,
      sessionId,
      ...usageFields(usage),
    });
    log.info('topic planned', { key, stories: storyKeys.length, subtasks: subtaskKeys.length, hours: stats.hours });
    return { ok: true, storyKeys, subtaskKeys, plan, reusedPlan };
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Creates the stories in learning order, then their sub-tasks.
 *
 * Two bulk requests rather than one per issue: sub-tasks need their parent's
 * key, so stories must exist first, but within each level one call does it.
 */
async function publish(
  epicKey: string,
  plan: LearningPlan,
  deps: TopicDeps,
  onProgress: (keys: string[]) => void,
): Promise<{ storyKeys: string[]; subtaskKeys: string[] }> {
  const { jira, project } = deps;
  const ordered = orderStories(plan.stories);
  const position = new Map(ordered.map((s, i) => [s.ordinal, i + 1]));
  const inline = project.subtaskType === null;

  // Prerequisites are named by position until the keys exist; Jira shows the
  // numbered titles, so "#2" is unambiguous on the board.
  const stories = await jira.createIssues(
    ordered.map((story, i) => ({
      projectKey: project.key,
      issueType: project.storyType.name,
      issueTypeId: project.storyType.id,
      summary: storyTitle(i + 1, story),
      description: storyDescription(
        story,
        story.prerequisites.map((p) => `#${position.get(p) ?? p}`),
        { inlineSubtopics: inline },
      ),
      labels: [ITEM_LABEL],
      parentKey: epicKey,
    })),
  );
  const storyKeys = stories.issues.map((i) => i.key);
  onProgress(storyKeys);
  if (stories.errors.length > 0 || storyKeys.length !== ordered.length) {
    throw new Error(`Jira rejected some stories: ${JSON.stringify(stories.errors).slice(0, 500)}`);
  }

  if (inline) return { storyKeys, subtaskKeys: [] };

  const subtasks: NewIssue[] = ordered.flatMap((story, i) =>
    story.subtopics.map((sub, j) => ({
      projectKey: project.key,
      issueType: project.subtaskType!.name,
      issueTypeId: project.subtaskType!.id,
      summary: subtaskTitle(i + 1, j, sub),
      description: subtaskDescription(sub),
      labels: [ITEM_LABEL],
      parentKey: storyKeys[i]!,
    })),
  );
  if (subtasks.length === 0) return { storyKeys, subtaskKeys: [] };

  const created = await jira.createIssues(subtasks);
  const subtaskKeys = created.issues.map((i) => i.key);
  onProgress([...storyKeys, ...subtaskKeys]);
  if (created.errors.length > 0 || subtaskKeys.length !== subtasks.length) {
    throw new Error(`Jira rejected some sub-tasks: ${JSON.stringify(created.errors).slice(0, 500)}`);
  }
  return { storyKeys, subtaskKeys };
}

/** Saves the plan as JSON (reusable) and Markdown (readable). */
export function savePlan(path: string, plan: LearningPlan): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(plan, null, 2), 'utf8');
  writeFileSync(path.replace(/\.json$/, '.md'), planMarkdown(plan), 'utf8');
}

export function loadSavedPlan(path: string): LearningPlan | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = LearningPlanSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function usageFields(usage: Usage | undefined) {
  return usage
    ? {
        webSearches: usage.webSearches,
        inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
        outputTokens: usage.outputTokens,
        estCostUsd: usage.estCostUsd,
        durationMs: usage.durationMs,
      }
    : {};
}

async function safely(log: Logger, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn('non-fatal Jira call failed', { err: err instanceof Error ? err.message : String(err) });
  }
}
