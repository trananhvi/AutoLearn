import { resolve } from 'node:path';
import { loadConfig, loadEnvFile, loadPlannerConfig } from './config.ts';
import { JiraClient } from './jira/client.ts';
import { buildTriggerJql, resolveProject } from './jira/project.ts';
import { createLogger } from './logger.ts';
import { planTopic } from './plan/planner.ts';
import { planMarkdown, hours } from './plan/render.ts';
import { planStats } from './plan/schema.ts';
import { resolveClaudeBin } from './runner/claude-bin.ts';
import { Store } from './store.ts';
import { jiraPort, runTopic, savePlan } from './topic.ts';

loadEnvFile();
const log = createLogger((process.env.LOG_LEVEL as 'info') || 'info', 'cli');

const [command, ...args] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
const has = (name: string) => args.includes(name);

/** Flags that take a value; everything else starting with -- is a switch. */
const VALUE_FLAGS = new Set(['--details', '--model', '--limit']);

function positional(): string[] {
  return args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''));
}

const COMMANDS: Record<string, { summary: string; run: () => Promise<void> }> = {
  health: {
    summary: 'Config, Claude CLI, and whether an API key is present',
    async run() {
      const planner = loadPlannerConfig();
      let claude: string;
      try {
        claude = resolveClaudeBin().file;
      } catch (err) {
        claude = `NOT FOUND — ${err instanceof Error ? err.message : err}`;
      }
      const store = new Store(planner.paths.db);
      console.log(JSON.stringify({
        claude,
        anthropicApiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
        jiraConfigured: Boolean(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN),
        planner: planner.planner,
        plansLast24h: store.countSince(Date.now() - 86_400_000),
        db: planner.paths.db,
      }, null, 2));
      store.close();
    },
  },

  'jira:ping': {
    summary: 'Jira auth, issue types, statuses, and what the trigger query matches',
    async run() {
      const config = loadConfig();
      const client = new JiraClient(config.jira);
      const me = await client.myself();
      console.log(`auth        ok — ${me.displayName}`);

      const setups = [];
      for (const key of config.jira.projects) {
        const setup = await resolveProject(client, key, config.trigger.status);
        setups.push(setup);
        console.log(`\nproject     ${key}`);
        console.log(`  story     ${setup.storyType.name}`);
        console.log(`  sub-task  ${setup.subtaskType?.name ?? '(none — details go inside each story)'}`);
        console.log(`  trigger   "${setup.statuses.trigger}" + label "${config.trigger.label}"`);
        console.log(`  planning  "${setup.statuses.planning}"`);
        console.log(`  planned   "${setup.statuses.planned}"`);
        console.log(`  failed    ${setup.statuses.failed ? `"${setup.statuses.failed}"` : '(status unchanged; label marks it)'}`);
        for (const w of setup.warnings) console.log(`  ! ${w}`);
      }

      const jql = buildTriggerJql(setups, config.trigger.label);
      const { issues } = await client.search(jql, { maxResults: 20, fields: ['summary'] });
      console.log(`\ntrigger     ${jql}`);
      console.log(`matches     ${issues.length}${issues.map((i) => `\n  ${i.key}  ${i.fields.summary}`).join('')}`);
    },
  },

  plan: {
    summary: 'Dry run, no Jira: plan "<topic>" [--details "<text>"] [--no-web] [--model <m>]',
    async run() {
      const title = positional()[0];
      if (!title) throw new Error('usage: npm run cli -- plan "<topic>" [--details "<what you know / want>"]');
      const { planner, paths } = loadPlannerConfig();
      const settings = {
        ...planner,
        ...(has('--no-web') ? { webResearch: false } : {}),
        ...(flag('--model') ? { model: flag('--model')! } : {}),
      };

      log.info('planning (dry run — nothing is written to Jira)', { model: settings.model, web: settings.webResearch });
      const outcome = await planTopic(
        { key: null, title, description: flag('--details') ?? '' },
        { planner: settings, sandboxDir: paths.sandbox, log },
      );
      if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);

      const path = resolve(paths.plans, `dry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      savePlan(path, outcome.plan);
      console.log('\n' + planMarkdown(outcome.plan));
      const stats = planStats(outcome.plan);
      console.log(
        `\n— ${stats.stories} stories, ${stats.subtasks} sub-tasks, ~${hours(stats.hours)}; ` +
          `${outcome.usage.webSearches} searches, ${Math.round(outcome.usage.durationMs / 1000)}s, ` +
          `~$${outcome.usage.estCostUsd.toFixed(2)} api-equivalent (not billed — runs on your plan)`,
      );
      console.log(`— saved to ${path.replace(/\.json$/, '.md')}`);
    },
  },

  topic: {
    summary: 'Plan one Jira topic now, skipping the trigger: topic <KEY> [--replan]',
    async run() {
      const key = positional()[0]?.toUpperCase();
      if (!key) throw new Error('usage: npm run cli -- topic <KEY> [--replan]');
      const config = loadConfig();
      const client = new JiraClient(config.jira);
      const projectKey = key.split('-')[0]!;
      const project = await resolveProject(client, projectKey, config.trigger.status);
      const store = new Store(config.paths.db);

      const controller = new AbortController();
      process.on('SIGINT', () => controller.abort());
      const result = await runTopic(key, {
        jira: jiraPort(client),
        project,
        config,
        store,
        log: log.child(key),
        signal: controller.signal,
        replan: has('--replan'),
      });
      store.close();

      if (!result.ok) throw new Error(result.error);
      console.log(`\n${key}: ${result.storyKeys.length} stories, ${result.subtaskKeys.length} sub-tasks${result.reusedPlan ? ' (reused the saved plan)' : ''}`);
      console.log(`${config.jira.baseUrl.replace(/\/+$/, '')}/browse/${key}`);
    },
  },

  history: {
    summary: 'Recent topics and what each one used',
    async run() {
      const { paths } = loadPlannerConfig();
      const store = new Store(paths.db);
      const rows = store.recent(Number(flag('--limit') ?? 20));
      store.close();
      if (rows.length === 0) return console.log('No topics planned yet.');
      for (const r of rows) {
        const what = r.status === 'planned' ? `${r.stories} stories, ${r.subtasks} sub-tasks` : r.error ?? '';
        console.log(
          `${r.startedAt.slice(0, 16).replace('T', ' ')}  ${r.issueKey.padEnd(9)} ${r.status.padEnd(8)} ` +
            `${Math.round(r.durationMs / 1000)}s  ${r.webSearches} searches  ${what.slice(0, 80)}`,
        );
      }
    },
  },
};

async function main() {
  const entry = command ? COMMANDS[command] : undefined;
  if (!entry) {
    console.log('usage: npm run cli -- <command>\n');
    for (const [name, c] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(10)} ${c.summary}`);
    process.exit(command ? 1 : 0);
  }
  await entry.run();
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
