import { loadConfig, loadEnvFile } from './config.ts';
import { JiraClient } from './jira/client.ts';
import { buildTriggerJql, resolveProject, type ProjectSetup } from './jira/project.ts';
import { createLogger } from './logger.ts';
import { Store } from './store.ts';
import { jiraPort, runTopic } from './topic.ts';

loadEnvFile();
const log = createLogger((process.env.LOG_LEVEL as 'info') || 'info', 'autolearn');

/**
 * The daemon: poll Jira every POLL_INTERVAL_MS, plan each triggered topic.
 *
 * Polling rather than webhooks: no public tunnel, works behind any network, and
 * a missed tick is simply picked up by the next one. One topic at a time — the
 * plan rate limit is per account, so concurrency buys nothing.
 */
async function main() {
  if (process.env.ANTHROPIC_API_KEY) {
    log.warn(
      'ANTHROPIC_API_KEY is set in this shell. The planner runs on your Claude subscription and ' +
        'the runner strips it from child processes, but consider unsetting it here too.',
    );
  }

  const config = loadConfig();
  const store = new Store(config.paths.db);
  const interrupted = store.markInterrupted();
  if (interrupted > 0) log.warn('marked runs left over from a crash as failed', { count: interrupted });

  const client = new JiraClient(config.jira, { log: log.child('jira') });
  const me = await client.myself();
  log.info('jira connected', { as: me.displayName, site: config.jira.baseUrl });

  // Resolve every project up front: a missing issue type or status should stop
  // the daemon now, not surface as a failed request halfway through a plan.
  const projects = new Map<string, ProjectSetup>();
  for (const key of config.jira.projects) {
    const setup = await resolveProject(client, key, config.trigger.status);
    projects.set(key, setup);
    log.info('project ready', {
      project: key,
      story: setup.storyType.name,
      subtask: setup.subtaskType?.name ?? '(none)',
      statuses: setup.statuses,
    });
    for (const warning of setup.warnings) log.warn(warning, { project: key });
  }

  const jql = buildTriggerJql([...projects.values()], config.trigger.label);
  const jira = jiraPort(client);
  let busy = false;
  let stopped = false;
  let pausedUntil = 0;
  const controller = new AbortController();

  const pollOnce = async () => {
    if (busy || stopped) return;
    if (Date.now() < pausedUntil) {
      log.debug('rate-limit pause in effect', { resumesInMs: pausedUntil - Date.now() });
      return;
    }
    busy = true;
    try {
      const { issues } = await client.search(jql, { maxResults: 10, fields: ['summary'] });
      for (const issue of issues) {
        if (stopped) break;

        const used = store.countSince(Date.now() - 24 * 60 * 60 * 1000);
        if (used >= config.planner.maxPlansPerDay) {
          log.warn('daily plan cap reached; leaving topics for later', { used, cap: config.planner.maxPlansPerDay });
          break;
        }

        const project = projects.get(issue.key.split('-')[0]!);
        if (!project) continue;

        log.info('topic triggered', { key: issue.key, summary: issue.fields.summary });
        const result = await runTopic(issue.key, {
          jira,
          project,
          config,
          store,
          log: log.child(issue.key),
          signal: controller.signal,
          planner: {
            onRateLimit: (ms) => {
              pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(ms, 5 * 60_000));
            },
          },
        });

        if (!result.ok && result.fatal) {
          log.error('stopping: this failure will not fix itself', { error: result.error });
          shutdown('fatal', 1);
          return;
        }
      }
    } catch (err) {
      // One bad poll must not kill the daemon; the next tick tries again.
      log.error('poll failed', { err: err instanceof Error ? err.message : String(err) });
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void pollOnce(), config.trigger.pollIntervalMs);
  log.info('watching for topics', { everyMs: config.trigger.pollIntervalMs, jql });
  void pollOnce();

  function shutdown(reason: string, code = 0) {
    if (stopped) return;
    stopped = true;
    log.info(`${reason}: shutting down`);
    clearInterval(timer);
    controller.abort();
    // Give an in-flight planner a moment to be killed and recorded.
    setTimeout(() => {
      store.close();
      process.exit(code);
    }, busy ? 3_000 : 0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
