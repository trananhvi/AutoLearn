export interface TopicInput {
  /** Jira key, or null for a dry run from the command line. */
  key: string | null;
  title: string;
  description: string;
}

export interface PromptLimits {
  maxStories: number;
  maxSubtasksPerStory: number;
  webResearch: boolean;
}

/** The per-topic user prompt. The standing instructions live in prompts/planner.md. */
export function plannerPrompt(topic: TopicInput, limits: PromptLimits): string {
  return [
    `Design a learning path for this topic${topic.key ? ` (${topic.key})` : ''}.`,
    '',
    `## Topic`,
    '',
    topic.title.trim(),
    '',
    '## What the learner wrote',
    '',
    topic.description.trim() || '(nothing beyond the title — infer a sensible goal and say so in `assumptions`)',
    '',
    '## Limits',
    '',
    `- At most ${limits.maxStories} stories.`,
    `- At most ${limits.maxSubtasksPerStory} subtopics per story.`,
    limits.webResearch
      ? '- Web search is available. Use it to find real, current resources, and to confirm that product names and features are current.'
      : '- Web search is NOT available. Leave every `resources` array empty rather than recall URLs from memory.',
    '',
    'Return the plan as structured output.',
  ].join('\n');
}

/** Sent on `--resume` when the plan failed validation, so the planner fixes rather than restarts. */
export function repairPrompt(error: string): string {
  return [
    'The plan you returned failed validation:',
    '',
    '```',
    error.slice(0, 3000),
    '```',
    '',
    'Fix exactly these problems and return the complete corrected plan as structured output.',
    'Do not research again unless a fix needs it.',
  ].join('\n');
}
