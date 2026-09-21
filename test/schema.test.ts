import { describe, it, expect } from 'vitest';
import { LearningPlanSchema, findCycle, orderStories, planJsonSchema, planStats } from '../src/plan/schema.ts';
import { plan, story } from './fixtures.ts';

describe('LearningPlanSchema', () => {
  it('accepts a well-formed plan', () => {
    expect(LearningPlanSchema.safeParse(plan()).success).toBe(true);
  });

  it('rejects a prerequisite cycle, naming it', () => {
    const cyclic = plan({ stories: [story(0, { prerequisites: [1] }), story(1, { prerequisites: [0] })] });
    const result = LearningPlanSchema.safeParse(cyclic);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/prerequisite cycle/);
  });

  it('rejects a prerequisite that does not exist', () => {
    const result = LearningPlanSchema.safeParse(plan({ stories: [story(0, { prerequisites: [7] })] }));
    expect(JSON.stringify(result.error?.issues)).toMatch(/requires ordinal 7/);
  });

  it('rejects duplicate ordinals and self-prerequisites', () => {
    expect(LearningPlanSchema.safeParse(plan({ stories: [story(0), story(0)] })).success).toBe(false);
    expect(LearningPlanSchema.safeParse(plan({ stories: [story(0, { prerequisites: [0] })] })).success).toBe(false);
  });

  it('rejects a resource that is not an absolute http(s) URL', () => {
    const bad = plan({ stories: [story(0, { resources: [{ title: 'x', url: 'docs/grafana', kind: 'docs' }] })] });
    expect(LearningPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a story with no objectives', () => {
    expect(LearningPlanSchema.safeParse(plan({ stories: [story(0, { objectives: [] })] })).success).toBe(false);
  });
});

describe('orderStories', () => {
  it('puts prerequisites first, whatever order they were written in', () => {
    const ordered = orderStories([
      story(0, { prerequisites: [2] }),
      story(1),
      story(2, { prerequisites: [1] }),
    ]);
    expect(ordered.map((s) => s.ordinal)).toEqual([1, 2, 0]);
  });

  it('breaks ties by ordinal, so the order is deterministic', () => {
    expect(orderStories([story(3), story(1), story(2)]).map((s) => s.ordinal)).toEqual([1, 2, 3]);
  });

  it('findCycle returns null for a DAG', () => {
    expect(findCycle(plan().stories)).toBeNull();
  });
});

describe('planJsonSchema', () => {
  const schema = planJsonSchema() as { type: string; required: string[]; properties: Record<string, unknown> };

  it('is a plain object schema the CLI can take', () => {
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('$schema');
  });

  it('requires every top-level field, so the model cannot leave one out', () => {
    expect(schema.required.sort()).toEqual(
      ['assumedLevel', 'assumptions', 'goal', 'openQuestions', 'outOfScope', 'stories'].sort(),
    );
  });

  it('requires every story field', () => {
    const storySchema = (schema.properties.stories as { items: { required: string[] } }).items;
    expect(storySchema.required).toContain('prerequisites');
    expect(storySchema.required).toContain('subtopics');
    expect(storySchema.required).toContain('resources');
  });
});

describe('planStats', () => {
  it('totals stories, sub-tasks and hours', () => {
    expect(planStats(plan())).toEqual({ stories: 3, subtasks: 6, hours: 6, resources: 3 });
  });
});
