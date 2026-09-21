# AutoLearn

Turn a learning topic into a learning path in Jira.

You write a topic as an **Epic**, for example *"Learn to use Grafana to monitor
an AKS application in Azure"*. AutoLearn researches it and breaks it down:

```
Epic      Learn to use Grafana to monitor an AKS application     ← your topic
├─ Story  1. Grafana deployment models                           ← subtopic
│  ├─ Sub-task  1.1 Grafana OSS, self-hosted on AKS              ← detail
│  ├─ Sub-task  1.2 Grafana Cloud
│  └─ Sub-task  1.3 Azure Managed Grafana
├─ Story  2. How Prometheus collects and stores metrics
│  └─ …
└─ Story  6. Dashboards and alerts for your AKS app
```

Each story carries objectives phrased as what you can do afterwards, key
concepts, a hands-on exercise, an effort estimate and links to real resources.
The links are found by web search, not recalled from memory. Each sub-task
carries the concrete facts worth knowing.

AutoLearn does not teach and does not build anything. You work through the
items and move them to Done yourself.

It runs on your **Claude subscription** via `claude -p`. No Anthropic API key
is used, and the runner actively prevents one from being used.

> A slimmed-down sibling of [AutoSDLC](https://github.com/trananhvi/AutoSDLC):
> the same Jira polling, `claude -p` runner and subscription safeguards, with
> the code-building agents removed and a single learning planner put in their
> place.

---

## Setup

### 1. Prerequisites

- Node 24+ (uses the built-in `node:sqlite`)
- Claude Code CLI, logged in with your **subscription**:
  `claude -p "say OK" --output-format json` should return `"result":"OK"`
- A Jira Cloud site

### 2. Install

```bash
npm install
cp .env.example .env      # then fill in .env — never .env.example
```

```ini
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=           # https://id.atlassian.com/manage-profile/security/api-tokens
JIRA_PROJECTS=LEARN
```

### 3. Create the Jira project

Create a **team-managed** project, Kanban template, with the key `LEARN`. It
comes with Epic, Story and Subtask types and the To Do / In Progress / Done
columns, which is enough to run.

Optionally add these statuses under **Space settings → Work types → Epic →
Workflow**, so you can see where a topic is:

| Status | Used for |
|---|---|
| `Ready for AI` | Where a topic waits to be picked up |
| `Planning` | While the planner is running |
| `Blocked` | When planning failed |

Without them, AutoLearn falls back to `To Do` / `In Progress` and tells you
what it merged.

### 4. Check

```bash
npm run cli -- health       # anthropicApiKeyPresent must be false
npm run cli -- jira:ping    # auth, issue types, statuses, trigger query
```

---

## Using it

### Try a topic without Jira first

```bash
npm run cli -- plan "Learn Rust ownership and borrowing" --details "I write TypeScript daily"
```

This prints the path it would create and saves it to `data/plans/`. Nothing is
written to Jira. Add `--no-web` for a faster, link-free plan, or
`--model sonnet` to spend less of your plan allocation.

### The normal flow

```bash
npm run dev                 # starts the watcher; leave it running
```

1. Create an **Epic** in `LEARN`. The title is the topic. In the description,
   write what you already know and what you want to be able to do. This is the
   most useful thing you can give it.
2. Add the label **`autolearn`**.
3. Move it to **`Ready for AI`** (or `To Do` if you did not add that status).

Within 30 seconds the epic moves to `Planning`. A few minutes later the stories
and sub-tasks appear. The epic then moves to `In Progress`, with a comment
showing the whole path in order, its total hours, and any questions the
planner had for you.

**Both the label and the status are required**, so a topic you are still
writing never fires early.

### Learning

Work through the stories in number order. The numbers follow the
prerequisites. Move sub-tasks and stories to Done as you finish them. Every
item carries the label `learning`, so the JQL `labels = learning AND status !=
Done` is your to-do list across all topics.

### Plan one topic by hand

```bash
npm run cli -- topic LEARN-12             # skip the trigger, plan it now
npm run cli -- topic LEARN-12 --replan    # ignore the saved plan and research again
```

### History

```bash
npm run cli -- history
```

---

## How it behaves

| Situation | What happens |
|---|---|
| Topic picked up | Label changes `autolearn` → `autolearn-planning`; that alone takes it out of the query, so it can never be planned twice |
| Planned | Label becomes `autolearn-planned`, epic moves to `In Progress` |
| Planning failed | Label becomes `autolearn-failed`, epic moves to `Blocked` if that status exists, and a comment explains why. To retry, add `autolearn` back. |
| Epic already has children | Refused, so you never get a second set of stories under one topic |
| Jira rejected part of the publish | The plan was saved first, so the retry reuses it instead of researching again |
| Rate limited by your plan | The topic is handed back to the trigger status and retried after the pause |
| Claude login broken | The watcher stops, because retrying will not fix it |
| Daily cap reached | Topics wait; `MAX_PLANS_PER_DAY` (default 20) |

## What the planner can and cannot do

It runs with exactly two tools, **WebSearch and WebFetch**. It has no file
access, no shell and no MCP connectors: `--strict-mcp-config` keeps your
claude.ai integrations such as mail and drive out of reach. It runs in an empty
directory, and it returns its plan as schema-validated structured output
(`--json-schema`), never as prose to be parsed. An invalid plan, for example
one with a prerequisite cycle or too many stories, gets one repair turn in the
same session.

It is told to include only URLs it actually saw in a search result or fetched.
That makes an invented link much less likely, but it is still worth a glance
before you rely on one.

## Configuration

All settings live in `.env`. See [.env.example](./.env.example).

| Setting | Default | |
|---|---|---|
| `JIRA_PROJECTS` | `LEARN` | Comma-separated project keys to watch |
| `TRIGGER_LABEL` | `autolearn` | The state labels derive from it (`-planning`, `-planned`, `-failed`) |
| `TRIGGER_STATUS` | `Ready for AI` | Falls back to `To Do` if the board lacks it |
| `PLANNER_MODEL` | `opus` | `sonnet` uses less of your plan allocation |
| `WEB_RESEARCH` | `true` | `false` gives no tools at all and no links |
| `MAX_STORIES` | `12` | Subtopics per topic |
| `MAX_SUBTASKS_PER_STORY` | `6` | |
| `STEP_TIMEOUT_MS` | `1200000` | 20 minutes per plan |
| `MAX_PLANS_PER_DAY` | `20` | |

The planner's instructions are in [prompts/planner.md](./prompts/planner.md).
Edit them to change how paths are shaped.

## Development

```bash
npm test            # unit tests, including a scan for credentials in tracked files
npm run typecheck
```
