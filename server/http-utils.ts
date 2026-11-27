import type { Context, MiddlewareHandler } from 'hono';
import { getSettings } from './db.js';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function clientLabel(c: Context): string {
  const ua = c.req.header('user-agent') ?? 'unknown';
  if (/claude-cli|claude-code|anthropic/i.test(ua)) return `Claude Code (${ua.slice(0, 60)})`;
  if (/opencode/i.test(ua)) return 'OpenCode';
  if (/cline/i.test(ua)) return 'Cline';
  if (/kilo/i.test(ua)) return 'Kilo Code';
  if (/openai-node|openai-python|openai\//i.test(ua)) return `OpenAI SDK (${ua.slice(0, 40)})`;
  if (/curl/i.test(ua)) return 'curl';
  return ua.slice(0, 80);
}

export async function readJsonBody<T>(c: Context, maxKb?: number): Promise<T> {
  const limitKb = maxKb ?? getSettings().maxBodyKb;
  const text = await c.req.text();
  if (Buffer.byteLength(text, 'utf8') > limitKb * 1024) {
    throw new HttpError(413, `Request body exceeds the configured ${limitKb}KB limit`, 'request_too_large');
  }
  if (!text.trim()) throw new HttpError(400, 'Request body is required', 'invalid_json');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON', 'invalid_json');
  }
}

function extractToken(c: Context): string | null {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const apiKey = c.req.header('x-api-key');
  if (apiKey) return apiKey.trim();
  return c.req.header('x-admin-token') ?? c.req.query('token') ?? null;
}

/** Optional admin protection for the dashboard API (enabled by setting an admin token). */
export const adminGuard: MiddlewareHandler = async (c, next) => {
  const { adminToken } = getSettings();
  if (adminToken && extractToken(c) !== adminToken) {
    return c.json({ error: 'Admin token required', code: 'unauthorized' }, 401);
  }
  await next();
};

export const apiGuard: MiddlewareHandler = async (c, next) => {
  const { requireApiKey, apiKey } = getSettings();
  if (!requireApiKey) {
    await next();
    return;
  }
  const token = extractToken(c);
  if (token !== apiKey) {
    return c.json(
      {
        error: {
          message: 'Invalid or missing API key. Use Authorization: Bearer <your MagmaX key> (Settings → API endpoints).',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      },
      401,
    );
  }
  await next();
};

const buckets = new Map<string, number[]>();

/** Sliding-window rate limit for the gateway endpoints. */
export const rateLimit: MiddlewareHandler = async (c, next) => {
  const limit = Math.max(10, getSettings().rateLimitPerMinute);
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'local';
  const key = `${ip}:${c.req.path.startsWith('/v1') ? 'v1' : 'api'}`;
  const now = Date.now();
  const windowStart = now - 60_000;
  const hits = (buckets.get(key) ?? []).filter((t) => t > windowStart);
  if (hits.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((hits[0]! + 60_000 - now) / 1000));
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: { message: `Rate limit exceeded (${limit}/min). Retry in ${retryAfter}s.`, type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, 429);
  }
  hits.push(now);
  buckets.set(key, hits);
  await next();
};

export function openAiError(c: Context, status: number, message: string, code = 'upstream_error') {
  return c.json({ error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code, param: null } }, status as 400);
}

export function anthropicError(c: Context, status: number, message: string, type = 'api_error') {
  return c.json({ type: 'error', error: { type, message } }, status as 400);
}

export function jsonBody<T>(c: Context, data: T, status = 200) {
  return c.json(data as Record<string, unknown>, status as 200);
}
