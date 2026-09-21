import type { LearningPlan, LearningStory } from '../src/plan/schema.ts';

export function story(ordinal: number, over: Partial<LearningStory> = {}): LearningStory {
  return {
    ordinal,
    title: `Story ${ordinal}`,
    summary: `Why story ${ordinal} matters.`,
    objectives: [`You can explain concept ${ordinal}.`],
    keyConcepts: [`concept-${ordinal}`],
    subtopics: [
      { title: `Detail ${ordinal}a`, summary: 'First detail.', keyPoints: ['a fact'] },
      { title: `Detail ${ordinal}b`, summary: 'Second detail.', keyPoints: ['another fact'] },
    ],
    exercise: `Do exercise ${ordinal}.`,
    resources: [{ title: 'Official docs', url: 'https://example.com/docs', kind: 'docs' }],
    prerequisites: [],
    estimatedHours: 2,
    ...over,
  };
}

export function plan(over: Partial<LearningPlan> = {}): LearningPlan {
  return {
    goal: 'Monitor an AKS application with Grafana.',
    assumedLevel: 'Knows Kubernetes basics.',
    stories: [story(0), story(1, { prerequisites: [0] }), story(2, { prerequisites: [1] })],
    outOfScope: ['Loki log aggregation'],
    assumptions: ['Azure subscription available'],
    openQuestions: [],
    ...over,
  };
}
