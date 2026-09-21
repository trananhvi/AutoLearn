import { z } from 'zod';

/**
 * The shape of a learning plan.
 *
 * Epic → Story → Sub-task maps onto topic → subtopic → detail. The planner
 * returns this as validated structured output; nothing downstream ever parses
 * its prose.
 *
 * Every field is required (empty arrays are fine) rather than defaulted. The
 * JSON Schema handed to the CLI is generated from this, and a field that is
 * optional there is one the model will sometimes leave out.
 */

export const ResourceKindSchema = z.enum(['docs', 'article', 'video', 'course', 'book', 'repo', 'tutorial', 'other']);

export const ResourceSchema = z.object({
  title: z.string().min(1).max(200),
  url: z.string().regex(/^https?:\/\/\S+$/, 'must be an absolute http(s) URL'),
  kind: ResourceKindSchema,
});
export type Resource = z.infer<typeof ResourceSchema>;

export const SubtopicSchema = z.object({
  title: z.string().min(1).max(150),
  /** What this detail is, in two or three sentences. */
  summary: z.string().min(1),
  /** The facts worth remembering. Concrete, not "understand X". */
  keyPoints: z.array(z.string().min(1)).min(1).max(10),
});
export type Subtopic = z.infer<typeof SubtopicSchema>;

export const LearningStorySchema = z.object({
  /** Stable handle used by `prerequisites`; assigned by the planner, 0-based. */
  ordinal: z.number().int().nonnegative(),
  title: z.string().min(1).max(150),
  /** Why this subtopic matters for the learner's goal. */
  summary: z.string().min(1),
  /** Phrased as what the learner can do afterwards: "You can explain…". */
  objectives: z.array(z.string().min(1)).min(1).max(8),
  keyConcepts: z.array(z.string().min(1)).max(15),
  /** Each becomes a Jira sub-task. */
  subtopics: z.array(SubtopicSchema).max(10),
  /** Something to do with the hands, not just read. Empty when nothing fits. */
  exercise: z.string(),
  resources: z.array(ResourceSchema).max(8),
  /** Ordinals of stories to learn first. */
  prerequisites: z.array(z.number().int().nonnegative()),
  estimatedHours: z.number().positive().max(80),
});
export type LearningStory = z.infer<typeof LearningStorySchema>;

/** The object shape alone, without cross-field checks — this is what becomes JSON Schema. */
export const LearningPlanShape = z.object({
  /** The goal as the planner understood it, so a misreading is visible. */
  goal: z.string().min(1),
  /** The starting level assumed, so a wrong assumption is visible. */
  assumedLevel: z.string().min(1),
  stories: z.array(LearningStorySchema).min(1).max(20),
  /** What a reader might expect but this path deliberately excludes. */
  outOfScope: z.array(z.string()),
  assumptions: z.array(z.string()),
  /** What the planner could not decide without the learner. */
  openQuestions: z.array(z.string()),
});

/**
 * Returns the ordinals forming a prerequisite cycle, or null.
 *
 * A cycle has no valid learning order, so it is rejected at validation time and
 * sent back to the planner as a repair.
 */
export function findCycle(stories: Array<{ ordinal: number; prerequisites: number[] }>): number[] | null {
  const byOrdinal = new Map(stories.map((s) => [s.ordinal, s]));
  const state = new Map<number, 'visiting' | 'done'>();
  const stack: number[] = [];

  const visit = (ordinal: number): number[] | null => {
    if (state.get(ordinal) === 'done') return null;
    if (state.get(ordinal) === 'visiting') return [...stack.slice(stack.indexOf(ordinal)), ordinal];

    state.set(ordinal, 'visiting');
    stack.push(ordinal);
    for (const next of byOrdinal.get(ordinal)?.prerequisites ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(ordinal, 'done');
    return null;
  };

  for (const story of stories) {
    const cycle = visit(story.ordinal);
    if (cycle) return cycle;
  }
  return null;
}

export const LearningPlanSchema = LearningPlanShape.superRefine((plan, ctx) => {
  const seen = new Set<number>();
  for (const story of plan.stories) {
    if (seen.has(story.ordinal)) {
      ctx.addIssue({ code: 'custom', path: ['stories'], message: `duplicate ordinal ${story.ordinal}` });
    }
    seen.add(story.ordinal);
  }

  for (const story of plan.stories) {
    for (const pre of story.prerequisites) {
      if (pre === story.ordinal) {
        ctx.addIssue({ code: 'custom', path: ['stories'], message: `story ${story.ordinal} lists itself as a prerequisite` });
      } else if (!seen.has(pre)) {
        ctx.addIssue({
          code: 'custom',
          path: ['stories'],
          message: `story ${story.ordinal} requires ordinal ${pre}, which does not exist`,
        });
      }
    }
  }

  const cycle = findCycle(plan.stories);
  if (cycle) {
    ctx.addIssue({ code: 'custom', path: ['stories'], message: `prerequisite cycle: ${cycle.join(' -> ')}` });
  }
});
export type LearningPlan = z.infer<typeof LearningPlanSchema>;

/**
 * Learning order: prerequisites first, ties broken by the planner's own
 * ordinal, so the sequence is deterministic and matches how it wrote the plan.
 */
export function orderStories<T extends { ordinal: number; prerequisites: number[] }>(stories: T[]): T[] {
  const remaining = new Map(stories.map((s) => [s.ordinal, s]));
  const done = new Set<number>();
  const ordered: T[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((s) => s.prerequisites.every((d) => done.has(d) || !remaining.has(d)))
      .sort((a, b) => a.ordinal - b.ordinal);

    // Guarded by schema validation; this would only fire on a cycle.
    if (ready.length === 0) break;

    for (const story of ready) {
      ordered.push(story);
      done.add(story.ordinal);
      remaining.delete(story.ordinal);
    }
  }
  return ordered;
}

/** The JSON Schema passed to `claude -p --json-schema`. */
export function planJsonSchema(): object {
  const schema = z.toJSONSchema(LearningPlanShape, { target: 'draft-7' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Totals for summaries and logs. */
export function planStats(plan: LearningPlan) {
  return {
    stories: plan.stories.length,
    subtasks: plan.stories.reduce((n, s) => n + s.subtopics.length, 0),
    hours: Math.round(plan.stories.reduce((n, s) => n + s.estimatedHours, 0) * 10) / 10,
    resources: plan.stories.reduce((n, s) => n + s.resources.length, 0),
  };
}
