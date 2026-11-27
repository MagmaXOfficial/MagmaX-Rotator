import type { ErrorClass } from '../types.js';
import { UpstreamError } from './types.js';

function extractMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return 'Empty response';
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const err = parsed.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const obj = err as Record<string, unknown>;
      if (typeof obj.message === 'string') return obj.message;
      if (typeof obj.code === 'string') return obj.code;
    }
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (Array.isArray(parsed.errors) && parsed.errors.length) return JSON.stringify(parsed.errors[0]);
    return trimmed.slice(0, 400);
  } catch {
    return trimmed.slice(0, 400);
  }
}

function retryAfter(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Classifies an upstream HTTP failure so the router knows whether to fall back. */
export function classifyHttpError(status: number, body: string, headers?: Headers): UpstreamError {
  const message = extractMessage(body);
  const lower = message.toLowerCase();

  if (status === 401 || status === 403) {
    return new UpstreamError('auth', message, { statusCode: status, retryable: false, credentialProblem: true });
  }
  if (status === 402 || /insufficient (balance|credits|quota)|payment required|credit balance/.test(lower)) {
    return new UpstreamError('quota', message, { statusCode: status, retryable: true, credentialProblem: true });
  }
  if (status === 429) {
    return new UpstreamError('rate_limit', message, {
      statusCode: status,
      retryAfterMs: retryAfter(headers),
      retryable: true,
    });
  }
  if (status === 413 || /context length|maximum context|too many tokens|reduce the length|prompt is too long|exceeds? the maximum/.test(lower)) {
    return new UpstreamError('context_length', message, { statusCode: status, retryable: true });
  }
  if (/content (filter|policy)|safety (system|filter)|blocked by|responsible ai/.test(lower)) {
    return new UpstreamError('content_filter', message, { statusCode: status, retryable: false });
  }
  if (status === 404 || /model .*(not found|does not exist|not available|unsupported)|no such model|unknown model/.test(lower)) {
    return new UpstreamError('model_unavailable', message, { statusCode: status, retryable: true });
  }
  if (status === 408 || status === 504 || status === 524) {
    return new UpstreamError('timeout', message, { statusCode: status, retryable: true });
  }
  if (status === 400 || status === 422 || status === 409) {
    if (/api key|authentication|unauthorized|invalid key|token is invalid/.test(lower)) {
      return new UpstreamError('auth', message, { statusCode: status, retryable: false, credentialProblem: true });
    }
    if (/quota|billing|balance/.test(lower)) {
      return new UpstreamError('quota', message, { statusCode: status, retryable: true, credentialProblem: true });
    }
    return new UpstreamError('invalid_request', message, { statusCode: status, retryable: false });
  }
  if (status >= 500) {
    return new UpstreamError('server', message, { statusCode: status, retryable: true });
  }
  return new UpstreamError('unknown', message, { statusCode: status, retryable: status !== 400 });
}

export function classifyFetchError(err: unknown, timedOut: boolean, externallyCancelled: boolean): UpstreamError {
  if (externallyCancelled) {
    return new UpstreamError('cancelled', 'Client cancelled the request', { retryable: false });
  }
  if (timedOut) {
    return new UpstreamError('timeout', 'Upstream request timed out', { retryable: true });
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ECONNRESET|fetch failed|socket hang up|network/i.test(msg)) {
    return new UpstreamError('network', msg, { retryable: true });
  }
  return new UpstreamError('network', msg, { retryable: true });
}

export const ERROR_LABELS: Record<ErrorClass, string> = {
  rate_limit: 'Rate limited',
  auth: 'Authentication failed',
  quota: 'Quota exhausted',
  timeout: 'Timed out',
  network: 'Connection failed',
  server: 'Provider error',
  model_unavailable: 'Model unavailable',
  invalid_request: 'Invalid request',
  context_length: 'Context length exceeded',
  content_filter: 'Blocked by content filter',
  cancelled: 'Cancelled',
  unknown: 'Unknown error',
};
