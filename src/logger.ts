export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(level: LogLevel = 'info', scope = 'autolearn'): Logger {
  const min = RANK[level];
  const useColor = process.stdout.isTTY === true;

  const write = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (RANK[lvl] < min) return;
    const time = new Date().toISOString().slice(11, 23);
    const tag = lvl.toUpperCase().padEnd(5);
    const head = useColor ? `${COLOR[lvl]}${tag}${RESET}` : tag;
    const tail = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const line = `${time} ${head} [${scope}] ${msg}${tail}`;
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };

  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    child: (sub: string) => createLogger(level, `${scope}:${sub}`),
  };
}

/** A logger that writes nothing, for tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
