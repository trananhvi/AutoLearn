import type { IssueType, JiraClient } from './client.ts';
import { projectStatuses } from './transitions.ts';

/**
 * What one Jira project offers, resolved once at startup.
 *
 * Issue type names differ by project style (team-managed calls it "Subtask",
 * company-managed "Sub-task"), and boards differ in which statuses exist. Both
 * are resolved here rather than configured, and anything missing is reported
 * up front instead of at the first failed request mid-plan.
 */
export interface ProjectSetup {
  key: string;
  storyType: IssueType;
  /** Null when the project has no sub-task type; details then stay in the story. */
  subtaskType: IssueType | null;
  statuses: {
    /** Where a topic waits to be picked up. */
    trigger: string;
    /** Where it sits while the planner runs. Leaving `trigger` is the claim. */
    planning: string;
    /** Where it goes once the path exists: you are now learning. */
    planned: string;
    /** Where a failed topic goes, or null to leave it where it is. */
    failed: string | null;
  };
  /** Human-readable notes on anything that fell back. */
  warnings: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

function pick(available: string[], options: string[]): string | null {
  const have = new Map(available.map((s) => [norm(s), s]));
  for (const option of options) {
    const found = have.get(norm(option));
    if (found) return found;
  }
  return null;
}

export function pickIssueTypes(types: IssueType[]): { story: IssueType | null; subtask: IssueType | null } {
  const standard = types.filter((t) => !t.subtask && (t.hierarchyLevel ?? 0) === 0);
  const subtasks = types.filter((t) => t.subtask || t.hierarchyLevel === -1);
  const byName = (list: IssueType[], names: string[]) =>
    names.map((n) => list.find((t) => norm(t.name) === norm(n))).find(Boolean) ?? null;

  return {
    story: byName(standard, ['Story', 'Task']) ?? standard[0] ?? null,
    subtask: byName(subtasks, ['Subtask', 'Sub-task']) ?? subtasks[0] ?? null,
  };
}

export function planProjectStatuses(available: string[], triggerStatus: string): { statuses: ProjectSetup['statuses']; warnings: string[] } {
  const warnings: string[] = [];

  const trigger = pick(available, [triggerStatus, 'To Do']) ?? triggerStatus;
  if (norm(trigger) !== norm(triggerStatus)) {
    warnings.push(`No "${triggerStatus}" status; topics trigger from "${trigger}" (the label still has to be present).`);
  }

  const planning = pick(available, ['Planning', 'Decomposing', 'In Progress']) ?? 'In Progress';
  const planned = pick(available, ['In Progress', 'Learning']) ?? 'In Progress';
  const failed = pick(available, ['Blocked']);
  if (!failed) warnings.push('No "Blocked" status; a failed topic keeps its status and loses its label instead.');

  if (norm(planning) === norm(trigger)) {
    // The status change is the claim; if they are the same column there is no
    // claim at all, and only the label swap stops a second pickup.
    warnings.push(`"Planning" resolves to the trigger status "${trigger}"; relying on the label alone to claim topics.`);
  }
  return { statuses: { trigger, planning, planned, failed }, warnings };
}

export async function resolveProject(client: JiraClient, key: string, triggerStatus: string): Promise<ProjectSetup> {
  const project = await client.project(key);
  const { story, subtask } = pickIssueTypes(project.issueTypes ?? []);
  if (!story) throw new Error(`Project ${key} has no Story or Task issue type.`);

  const { statuses, warnings } = planProjectStatuses(await projectStatuses(client, key), triggerStatus);
  if (!subtask) warnings.unshift('No sub-task issue type; subtopics will be listed inside each story instead.');

  return { key, storyType: story, subtaskType: subtask, statuses, warnings };
}

/**
 * The trigger query: an Epic, carrying the label, in the trigger status.
 *
 * Both conditions are required, so neither a card dragged into the column
 * while still being written nor a leftover label fires on its own.
 */
export function buildTriggerJql(projects: ProjectSetup[], label: string): string {
  if (projects.length === 0) throw new Error('No Jira projects configured (JIRA_PROJECTS).');
  const scope = projects
    .map((p) => `(project = ${p.key} AND status = "${p.statuses.trigger}")`)
    .join(' OR ');
  return `(${scope}) AND issuetype = Epic AND labels = "${label}" ORDER BY created ASC`;
}
