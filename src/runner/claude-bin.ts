import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface ClaudeBin {
  file: string;
  /**
   * `.cmd`/`.bat` shims cannot be spawned directly on Windows (Node refuses
   * since the 2024 argument-injection fix), so they need a shell.
   */
  useShell: boolean;
}

const WINDOWS_CANDIDATES = ['claude.exe', 'claude.cmd', 'claude.bat'];

/**
 * Finds the Claude Code executable.
 *
 * Resolved explicitly rather than left to `spawn`'s PATH lookup, because a
 * silent "command not found" halfway through a run is far more expensive to
 * diagnose than an error at startup.
 */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): ClaudeBin {
  const override = env.CLAUDE_BIN;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CLAUDE_BIN points at a file that does not exist: ${override}`);
    }
    return { file: override, useShell: needsShell(override) };
  }

  const candidates = process.platform === 'win32' ? WINDOWS_CANDIDATES : ['claude'];
  const pathDirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);

  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full)) return { file: full, useShell: needsShell(full) };
    }
  }

  throw new Error(
    'Could not find the Claude Code CLI on PATH. Install it, or set CLAUDE_BIN to its full path.',
  );
}

function needsShell(file: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
}
