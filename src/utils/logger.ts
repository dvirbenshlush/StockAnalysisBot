type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const configuredLevel = (process.env.LOG_LEVEL ?? 'info') as LogLevel;

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVELS[level] < LEVELS[configuredLevel]) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const metaStr = meta ? ` ${JSON.stringify(meta, null, 0)}` : '';

  const output = `${prefix} ${message}${metaStr}`;

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
};
