import type { JiraClient } from './client.ts';

export class TransitionError extends Error {
  constructor(
    readonly issueKey: string,
    readonly target: string,
    readonly available: string[],
  ) {
    super(
      `Cannot move ${issueKey} to "${target}". Reachable from its current status: ` +
        `${available.join(', ') || '(none)'}. If the status exists but is not listed, it is not ` +
        `wired into the project workflow yet.`,
    );
    this.name = 'TransitionError';
  }
}

const norm = (value: string) => value.trim().toLowerCase();

/**
 * Moves an issue to a status by name.
 *
 * Jira has no "set status" call: you fetch the transitions legal from the
 * issue's *current* status and post one by id. Those ids differ per project and
 * per workflow, so they are always resolved at runtime rather than configured.
 *
 * Returns false when the issue is already in the target status, which makes
 * the call idempotent and safe to run on resume after a crash.
 */
export async function moveTo(client: JiraClient, issueKey: string, target: string): Promise<boolean> {
  const issue = await client.getIssue(issueKey, ['status']);
  if (norm(issue.fields.status.name) === norm(target)) return false;

  const { transitions } = await client.transitions(issueKey);
  const match = transitions.find((t) => norm(t.to.name) === norm(target));

  if (!match) {
    throw new TransitionError(issueKey, target, transitions.map((t) => t.to.name));
  }

  await client.doTransition(issueKey, match.id);
  return true;
}

/** Every status configured on the project, across all issue types. */
export async function projectStatuses(client: JiraClient, projectKey: string): Promise<string[]> {
  const byType = await client.request<Array<{ name: string; statuses: Array<{ name: string }> }>>(
    'GET',
    `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`,
  );
  return [...new Set(byType.flatMap((t) => t.statuses.map((s) => s.name)))];
}

