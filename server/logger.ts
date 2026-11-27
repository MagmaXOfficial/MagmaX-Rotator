type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: Level;
  msg: string;
  meta?: Record<string, unknown>;
}

const RING_LIMIT = 400;
const ring: LogEntry[] = [];

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = (process.env.MAGMAX_LOG_LEVEL as Level) || 'info';

/** Redacts values that look like credentials before anything is logged. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/(sk-[A-Za-z0-9_-]{8,})/g, 'sk-***')
      .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
      .replace(/(key=)[A-Za-z0-9._-]{8,}/gi, '$1***');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/key|secret|token|authorization|password/i.test(k)) out[k] = '***';
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry: LogEntry = { ts: Date.now(), level, msg, meta: meta ? (redact(meta) as Record<string, unknown>) : undefined };
  ring.push(entry);
  if (ring.length > RING_LIMIT) ring.shift();
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
  recent: (limit = 200): LogEntry[] => ring.slice(-limit),
};
