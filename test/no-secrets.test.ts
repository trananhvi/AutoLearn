import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT_DIR } from '../src/config.ts';

/**
 * A tripwire for credentials in tracked files. The repository is public, and a
 * `.env.example` sitting next to a `.env` is an easy place to paste the wrong
 * thing — AutoSDLC nearly shipped real Jira credentials that way.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'Atlassian API token', re: /\bATATT3[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub personal access token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

const SKIP = /\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|zip)$|package-lock\.json$/i;

function trackedFiles(): string[] {
  // Before the first commit nothing is tracked yet, so scan what would be added.
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  return out.split('\0').filter((f) => f.length > 0 && !SKIP.test(f));
}

describe('no secrets in tracked files', () => {
  it('finds files to scan', () => {
    expect(trackedFiles().length).toBeGreaterThan(10);
  });

  it('contains no credentials', () => {
    const findings: string[] = [];
    for (const file of trackedFiles()) {
      let contents: string;
      try {
        contents = readFileSync(resolve(ROOT_DIR, file), 'utf8');
      } catch {
        continue;
      }
      for (const { name, re } of SECRET_PATTERNS) {
        const match = re.exec(contents);
        if (match) {
          // Report the location, never the value.
          const line = contents.slice(0, match.index).split('\n').length;
          findings.push(`${file}:${line} looks like a ${name}`);
        }
      }
    }
    expect(findings, 'Credentials must live in .env, which is gitignored.').toEqual([]);
  });

  it('.env.example ships placeholders, not values', () => {
    const example = readFileSync(resolve(ROOT_DIR, '.env.example'), 'utf8');
    const filled = example.split('\n').filter((line) => /^JIRA_API_TOKEN=.+/.test(line.trim()));
    expect(filled, 'secret keys in .env.example must be left empty').toEqual([]);
  });
});
