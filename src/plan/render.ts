import * as adf from '../jira/adf.ts';
import type { AdfDoc } from '../jira/adf.ts';
import { orderStories, planStats, type LearningPlan, type LearningStory, type Subtopic } from './schema.ts';

/** "1.5h", "45m" — estimates read better short. */
export function hours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${Math.round(h * 10) / 10}h`;
}

/** Numbered so the Jira backlog reads in learning order even if re-sorted. */
export function storyTitle(position: number, story: LearningStory): string {
  return `${position}. ${story.title}`;
}

export function subtaskTitle(position: number, index: number, subtopic: Subtopic): string {
  return `${position}.${index + 1} ${subtopic.title}`;
}

/**
 * A story's description. `inlineSubtopics` is for projects with no sub-task
 * type: the details are written into the story rather than lost.
 */
export function storyDescription(
  story: LearningStory,
  prerequisiteKeys: string[],
  options: { inlineSubtopics?: boolean } = {},
): AdfDoc {
  const inline = options.inlineSubtopics ? story.subtopics : [];
  return adf.doc(
    adf.p(story.summary),
    adf.heading(3, 'You will be able to'),
    adf.bullets(story.objectives),
    story.keyConcepts.length > 0 ? adf.heading(3, 'Key concepts') : null,
    story.keyConcepts.length > 0 ? adf.p(story.keyConcepts.join(' · ')) : null,
    ...inline.flatMap((sub) => [adf.heading(4, sub.title), adf.p(sub.summary), adf.bullets(sub.keyPoints)]),
    story.exercise.trim() ? adf.heading(3, 'Hands-on') : null,
    story.exercise.trim() ? adf.p(story.exercise.trim()) : null,
    story.resources.length > 0 ? adf.heading(3, 'Resources') : null,
    adf.bullets(story.resources.map((r) => adf.p(adf.link(r.title, r.url), ` (${r.kind})`))),
    prerequisiteKeys.length > 0 ? adf.p(adf.strong('Learn first: '), prerequisiteKeys.join(', ')) : null,
    adf.p(adf.code(`~${hours(story.estimatedHours)}`)),
  );
}

export function subtaskDescription(subtopic: Subtopic): AdfDoc {
  return adf.doc(adf.p(subtopic.summary), adf.heading(3, 'Key points'), adf.bullets(subtopic.keyPoints));
}

/** The comment left on the epic: the whole path at a glance. */
export function planComment(plan: LearningPlan, storyKeys: string[]): AdfDoc {
  const ordered = orderStories(plan.stories);
  const stats = planStats(plan);

  return adf.doc(
    adf.panel(
      plan.openQuestions.length > 0 ? 'warning' : 'success',
      adf.p(
        adf.strong('AutoLearn planned this topic: '),
        `${stats.stories} stories, ${stats.subtasks} sub-tasks, about ${hours(stats.hours)} in total.`,
      ),
    ),
    adf.p(adf.strong('Goal: '), plan.goal),
    adf.p(adf.strong('Assumed starting level: '), plan.assumedLevel),
    adf.heading(3, 'Learning order'),
    adf.bullets(
      ordered.map((s, i) => `${storyKeys[i] ?? `#${s.ordinal}`} — ${storyTitle(i + 1, s)} (${hours(s.estimatedHours)})`),
    ),
    plan.openQuestions.length > 0 ? adf.heading(3, 'Questions for you') : null,
    adf.bullets(plan.openQuestions),
    plan.outOfScope.length > 0 ? adf.heading(3, 'Deliberately left out') : null,
    adf.bullets(plan.outOfScope),
    plan.assumptions.length > 0 ? adf.heading(3, 'Assumptions') : null,
    adf.bullets(plan.assumptions),
  );
}

export function failureComment(reason: string, label: string): AdfDoc {
  return adf.doc(
    adf.panel('error', adf.p(adf.strong('AutoLearn could not plan this topic.'))),
    adf.p(reason),
    adf.p('To retry, add the label ', adf.code(label), ' again and move the epic back to the trigger status.'),
  );
}

/** Markdown for dry runs and the saved plan file — what you would see in Jira, as text. */
export function planMarkdown(plan: LearningPlan): string {
  const ordered = orderStories(plan.stories);
  const position = new Map(ordered.map((s, i) => [s.ordinal, i + 1]));
  const stats = planStats(plan);
  const out: string[] = [];

  out.push(`# Learning path`, '');
  out.push(`**Goal:** ${plan.goal}`, '');
  out.push(`**Assumed level:** ${plan.assumedLevel}`, '');
  out.push(`${stats.stories} stories · ${stats.subtasks} sub-tasks · ~${hours(stats.hours)} · ${stats.resources} resources`, '');

  ordered.forEach((story, i) => {
    out.push(`## ${storyTitle(i + 1, story)}  _(~${hours(story.estimatedHours)})_`, '');
    out.push(story.summary, '');
    if (story.prerequisites.length > 0) {
      out.push(`_Learn first: ${story.prerequisites.map((p) => `#${position.get(p) ?? p}`).join(', ')}_`, '');
    }
    out.push('**You will be able to**', '', ...story.objectives.map((o) => `- ${o}`), '');
    if (story.keyConcepts.length > 0) out.push(`**Key concepts:** ${story.keyConcepts.join(' · ')}`, '');
    story.subtopics.forEach((sub, j) => {
      out.push(`### ${subtaskTitle(i + 1, j, sub)}`, '', sub.summary, '', ...sub.keyPoints.map((k) => `- ${k}`), '');
    });
    if (story.exercise.trim()) out.push(`**Hands-on:** ${story.exercise.trim()}`, '');
    if (story.resources.length > 0) {
      out.push('**Resources**', '', ...story.resources.map((r) => `- [${r.title}](${r.url}) (${r.kind})`), '');
    }
  });

  const section = (title: string, items: string[]) => {
    if (items.length > 0) out.push(`## ${title}`, '', ...items.map((x) => `- ${x}`), '');
  };
  section('Questions for you', plan.openQuestions);
  section('Deliberately left out', plan.outOfScope);
  section('Assumptions', plan.assumptions);

  return out.join('\n');
}
