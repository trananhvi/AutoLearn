import { describe, it, expect } from 'vitest';
import { buildTriggerJql, pickIssueTypes, planProjectStatuses, type ProjectSetup } from '../src/jira/project.ts';

describe('pickIssueTypes', () => {
  it('finds Story and a team-managed "Subtask"', () => {
    const picked = pickIssueTypes([
      { id: '1', name: 'Epic', subtask: false, hierarchyLevel: 1 },
      { id: '2', name: 'Task', subtask: false, hierarchyLevel: 0 },
      { id: '3', name: 'Story', subtask: false, hierarchyLevel: 0 },
      { id: '4', name: 'Subtask', subtask: true, hierarchyLevel: -1 },
    ]);
    expect(picked.story?.name).toBe('Story');
    expect(picked.subtask?.name).toBe('Subtask');
  });

  it('falls back to Task, and to a company-managed "Sub-task"', () => {
    const picked = pickIssueTypes([
      { id: '2', name: 'Task', subtask: false },
      { id: '4', name: 'Sub-task', subtask: true },
    ]);
    expect(picked.story?.name).toBe('Task');
    expect(picked.subtask?.name).toBe('Sub-task');
  });

  it('never picks the Epic as the story type', () => {
    expect(pickIssueTypes([{ id: '1', name: 'Epic', subtask: false, hierarchyLevel: 1 }]).story).toBeNull();
  });
});

describe('planProjectStatuses', () => {
  it('uses the full set when the board has it', () => {
    const { statuses, warnings } = planProjectStatuses(['To Do', 'Ready for AI', 'Planning', 'In Progress', 'Blocked', 'Done'], 'Ready for AI');
    expect(statuses).toEqual({ trigger: 'Ready for AI', planning: 'Planning', planned: 'In Progress', failed: 'Blocked' });
    expect(warnings).toEqual([]);
  });

  it('falls back on a default board, and says so', () => {
    const { statuses, warnings } = planProjectStatuses(['To Do', 'In Progress', 'Done'], 'Ready for AI');
    expect(statuses).toEqual({ trigger: 'To Do', planning: 'In Progress', planned: 'In Progress', failed: null });
    expect(warnings.join(' ')).toMatch(/No "Ready for AI"/);
    expect(warnings.join(' ')).toMatch(/No "Blocked"/);
  });

  it('matches status names case-insensitively, keeping the board spelling', () => {
    expect(planProjectStatuses(['READY FOR AI', 'in progress'], 'Ready for AI').statuses.trigger).toBe('READY FOR AI');
  });
});

describe('buildTriggerJql', () => {
  const setup = (key: string, trigger: string) => ({ key, statuses: { trigger } }) as ProjectSetup;

  it('requires an Epic, the label, and each project’s own trigger status', () => {
    expect(buildTriggerJql([setup('LEARN', 'Ready for AI'), setup('STUDY', 'To Do')], 'autolearn')).toBe(
      '((project = LEARN AND status = "Ready for AI") OR (project = STUDY AND status = "To Do")) ' +
        'AND issuetype = Epic AND labels = "autolearn" ORDER BY created ASC',
    );
  });

  it('refuses to build a query with no projects', () => {
    expect(() => buildTriggerJql([], 'autolearn')).toThrow(/JIRA_PROJECTS/);
  });
});
