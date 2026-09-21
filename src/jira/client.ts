import type { Logger } from '../logger.ts';
import type { AdfDoc } from './adf.ts';

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export class JiraError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`Jira ${method} ${path} failed with ${status}: ${summarize(body)}`);
    this.name = 'JiraError';
  }

  /** 429 and 5xx are worth another attempt; 4xx means we asked for the wrong thing. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

function summarize(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 300);
  const messages = (body as { errorMessages?: string[]; errors?: Record<string, string> })?.errorMessages;
  const fieldErrors = (body as { errors?: Record<string, string> })?.errors;
  const parts = [...(messages ?? []), ...Object.entries(fieldErrors ?? {}).map(([k, v]) => `${k}: ${v}`)];
  return parts.length > 0 ? parts.join('; ') : JSON.stringify(body).slice(0, 300);
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: AdfDoc | null;
    status: { name: string; id: string; statusCategory?: { key: string } };
    issuetype: { name: string; id: string };
    labels: string[];
    parent?: { key: string; id: string };
    updated: string;
    created: string;
    [key: string]: unknown;
  };
}

export interface SearchResult {
  issues: JiraIssue[];
  isLast?: boolean;
  nextPageToken?: string;
}

export interface IssueType {
  id: string;
  name: string;
  subtask: boolean;
  /** 1 = epic, 0 = story/task, -1 = sub-task. */
  hierarchyLevel?: number;
}

const BULK_LIMIT = 50;

export interface NewIssue {
  projectKey: string;
  issueType: string;
  /** Preferred over the name when known: names differ between project styles. */
  issueTypeId?: string;
  summary: string;
  description?: AdfDoc;
  labels?: string[];
  /** Team-managed projects link an epic through `parent`, not "Epic Link". */
  parentKey?: string;
}

/**
 * A thin, typed Jira Cloud REST v3 client.
 *
 * Deliberately small: only the calls the orchestrator makes, each one shaped so
 * the caller cannot forget an ADF conversion or a required header.
 */
export class JiraClient {
  readonly #auth: string;
  readonly #baseUrl: string;
  readonly #log: Logger | undefined;
  readonly #fetch: typeof fetch;

  constructor(credentials: JiraCredentials, options: { log?: Logger; fetch?: typeof fetch } = {}) {
    this.#baseUrl = credentials.baseUrl.replace(/\/+$/, '');
    this.#auth = Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64');
    this.#log = options.log;
    this.#fetch = options.fetch ?? fetch;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const response = await this.#fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${this.#auth}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const raw = await response.text();
    let parsed: unknown = raw;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Leave it as text; the error path reports it verbatim.
      }
    }

    if (!response.ok) {
      this.#log?.warn('jira request failed', { method, path, status: response.status });
      throw new JiraError(response.status, method, path, parsed);
    }

    return parsed as T;
  }

  /** Who the credentials belong to. The cheapest possible auth check. */
  myself(): Promise<{ accountId: string; displayName: string; emailAddress?: string }> {
    return this.request('GET', '/rest/api/3/myself');
  }

  /** Includes the project's issue types, which is how Story and Sub-task ids are found. */
  project(key: string): Promise<{
    id: string;
    key: string;
    name: string;
    style?: string;
    issueTypes?: IssueType[];
  }> {
    return this.request('GET', `/rest/api/3/project/${encodeURIComponent(key)}`);
  }

  getIssue(key: string, fields = DEFAULT_FIELDS): Promise<JiraIssue> {
    return this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`);
  }

  /**
   * JQL search. Uses the token-paginated `/search/jql` endpoint; the older
   * `startAt` form is deprecated on Jira Cloud.
   */
  async search(
    jql: string,
    options: { maxResults?: number; fields?: string[]; nextPageToken?: string } = {},
  ): Promise<SearchResult> {
    const params = new URLSearchParams({
      jql,
      maxResults: String(options.maxResults ?? 50),
      fields: (options.fields ?? DEFAULT_FIELDS).join(','),
    });
    if (options.nextPageToken) params.set('nextPageToken', options.nextPageToken);
    return this.request('GET', `/rest/api/3/search/jql?${params.toString()}`);
  }

  async createIssue(issue: NewIssue): Promise<{ id: string; key: string }> {
    return this.request('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: issue.projectKey },
        issuetype: { name: issue.issueType },
        summary: issue.summary,
        ...(issue.description ? { description: issue.description } : {}),
        ...(issue.labels?.length ? { labels: issue.labels } : {}),
        ...(issue.parentKey ? { parent: { key: issue.parentKey } } : {}),
      },
    });
  }

  /**
   * Bulk create. Jira caps one request at 50 issues, so larger sets are sent in
   * chunks; results come back in input order either way.
   */
  async createIssues(issues: NewIssue[]): Promise<{
    issues: Array<{ id: string; key: string }>;
    errors: unknown[];
  }> {
    const all = { issues: [] as Array<{ id: string; key: string }>, errors: [] as unknown[] };
    for (let i = 0; i < issues.length; i += BULK_LIMIT) {
      const chunk = issues.slice(i, i + BULK_LIMIT);
      const result = await this.request<{ issues?: Array<{ id: string; key: string }>; errors?: unknown[] }>(
        'POST',
        '/rest/api/3/issue/bulk',
        {
          issueUpdates: chunk.map((issue) => ({
            fields: {
              project: { key: issue.projectKey },
              issuetype: issue.issueTypeId ? { id: issue.issueTypeId } : { name: issue.issueType },
              summary: issue.summary,
              ...(issue.description ? { description: issue.description } : {}),
              ...(issue.labels?.length ? { labels: issue.labels } : {}),
              ...(issue.parentKey ? { parent: { key: issue.parentKey } } : {}),
            },
          })),
        },
      );
      all.issues.push(...(result.issues ?? []));
      all.errors.push(...(result.errors ?? []));
    }
    return all;
  }

  addComment(key: string, body: AdfDoc): Promise<{ id: string }> {
    return this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body });
  }

  setDescription(key: string, description: AdfDoc): Promise<void> {
    return this.request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      fields: { description },
    });
  }

  setLabels(key: string, add: string[] = [], remove: string[] = []): Promise<void> {
    return this.request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      update: {
        labels: [...add.map((l) => ({ add: l })), ...remove.map((l) => ({ remove: l }))],
      },
    });
  }

  transitions(key: string): Promise<{ transitions: Array<{ id: string; name: string; to: { name: string; id: string } }> }> {
    return this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  }

  doTransition(key: string, transitionId: string): Promise<void> {
    return this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  deleteIssue(key: string): Promise<void> {
    return this.request('DELETE', `/rest/api/3/issue/${encodeURIComponent(key)}`);
  }

  children(parentKey: string): Promise<SearchResult> {
    return this.search(`parent = ${parentKey} ORDER BY created ASC`, { maxResults: 100 });
  }
}

export const DEFAULT_FIELDS = [
  'summary',
  'description',
  'status',
  'issuetype',
  'labels',
  'parent',
  'updated',
  'created',
];
