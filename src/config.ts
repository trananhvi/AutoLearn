import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { LOG_LEVELS } from './logger.ts';

/** Repo root — this file lives at src/config.ts. */
export const ROOT_DIR = resolve(import.meta.dirname, '..');

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : !/^(0|false|no|off)$/i.test(v.trim())));

const ConfigSchema = z.object({
  jira: z.object({
    baseUrl: z.string().url(),
    email: z.string().email(),
    apiToken: z.string().min(1),
    projects: z
      .string()
      .min(1)
      .transform((v) => v.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean)),
  }),
  trigger: z.object({
    label: z.string().min(1).default('autolearn'),
    status: z.string().min(1).default('Ready for AI'),
    pollIntervalMs: z.coerce.number().int().min(5_000).default(30_000),
  }),
  planner: z.object({
    model: z.string().min(1).default('opus'),
    webResearch: bool.default(true),
    maxStories: z.coerce.number().int().min(1).max(20).default(12),
    maxSubtasksPerStory: z.coerce.number().int().min(0).max(10).default(6),
    timeoutMs: z.coerce.number().int().min(60_000).default(1_200_000),
    maxPlansPerDay: z.coerce.number().int().min(1).default(20),
  }),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  paths: z.object({
    data: z.string(),
    plans: z.string(),
    sandbox: z.string(),
    db: z.string(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

let envLoaded = false;

/** Reads `.env` into `process.env`, once. Node's built-in loader; no dotenv. */
export function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  const envFile = resolve(ROOT_DIR, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/**
 * Loads and validates configuration.
 *
 * Note what is NOT read here: ANTHROPIC_API_KEY. The planner runs on the Claude
 * subscription via `claude -p`, and the runner strips that variable from the
 * child environment.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadEnvFile();
  const data = resolve(ROOT_DIR, 'data');

  const parsed = ConfigSchema.safeParse({
    jira: {
      baseUrl: env.JIRA_BASE_URL,
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
      projects: env.JIRA_PROJECTS ?? 'LEARN',
    },
    trigger: {
      label: env.TRIGGER_LABEL || undefined,
      status: env.TRIGGER_STATUS || undefined,
      pollIntervalMs: env.POLL_INTERVAL_MS || undefined,
    },
    planner: {
      model: env.PLANNER_MODEL || undefined,
      webResearch: env.WEB_RESEARCH || undefined,
      maxStories: env.MAX_STORIES || undefined,
      maxSubtasksPerStory: env.MAX_SUBTASKS_PER_STORY || undefined,
      timeoutMs: env.STEP_TIMEOUT_MS || undefined,
      maxPlansPerDay: env.MAX_PLANS_PER_DAY || undefined,
    },
    logLevel: env.LOG_LEVEL || undefined,
    paths: {
      data,
      plans: resolve(data, 'plans'),
      // An empty directory the planner runs in, so it sees no files at all.
      sandbox: resolve(data, 'sandbox'),
      db: resolve(data, 'autolearn.db'),
    },
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration. Copy .env.example to .env and fill it in.\n${issues}`);
  }
  return parsed.data;
}

/** Planner settings alone, for commands that never touch Jira. */
export function loadPlannerConfig(env: NodeJS.ProcessEnv = process.env): Pick<Config, 'planner' | 'paths' | 'logLevel'> {
  loadEnvFile();
  // Jira is irrelevant to a dry run, so a missing or half-filled .env must not
  // stop one. Placeholders satisfy the schema and are never used.
  const full = loadConfig({
    ...env,
    JIRA_BASE_URL: 'https://placeholder.atlassian.net',
    JIRA_EMAIL: 'placeholder@example.com',
    JIRA_API_TOKEN: 'placeholder',
  });
  return { planner: full.planner, paths: full.paths, logLevel: full.logLevel };
}
