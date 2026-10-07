import { env } from '../config/env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = env.isTest ? 'error' : env.isProduction ? 'info' : 'debug';

/** Keys whose values must never reach the logs (PRD section 28). */
const REDACTED_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'passwordhash',
  'code',
  'otp',
  'otpcode',
  'codehash',
  'token',
  'accesstoken',
  'refreshtoken',
  'registrationtoken',
  'authorization',
  'secret',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(raw, depth + 1);
  }
  return output;
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

  const safeMeta = meta ? (redact(meta) as Record<string, unknown>) : undefined;
  const timestamp = new Date().toISOString();

  const line = env.isProduction
    ? JSON.stringify({ ts: timestamp, level, message, ...safeMeta })
    : [timestamp, level.toUpperCase(), message, safeMeta ? JSON.stringify(safeMeta) : '']
        .filter(Boolean)
        .join(' ');

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};
