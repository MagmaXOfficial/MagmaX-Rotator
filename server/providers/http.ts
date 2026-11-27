import { classifyFetchError, classifyHttpError } from './errors.js';
import { UpstreamError } from './types.js';
import type { ProviderTarget } from './types.js';
import { buildHeaders } from './types.js';

export interface TimedSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  externallyCancelled: () => boolean;
  cleanup: () => void;
}

export function createTimedSignal(external: AbortSignal | undefined, timeoutMs: number): TimedSignal {
  const controller = new AbortController();
  let didTimeout = false;
  let cancelled = false;
      const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, Math.max(1000, timeoutMs));
  timer.unref?.();
  const onAbort = () => {
    cancelled = true;
    controller.abort();
  };
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    externallyCancelled: () => cancelled,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

export interface StreamHandle {
  response: Response;
  timed: TimedSignal;
}

/**
 * Starts a streaming request. The timeout signal stays armed for the whole stream
 * (requestTimeoutMs is the per-attempt budget), so a stalled stream is aborted.
 */
export async function startStream(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<StreamHandle> {
  const timed = createTimedSignal(externalSignal, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: timed.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      timed.cleanup();
      throw classifyHttpError(response.status, body, response.headers);
    }
    return { response, timed };
  } catch (err) {
    timed.cleanup();
    if (err instanceof UpstreamError) throw err;
    throw classifyFetchError(err, timed.timedOut(), timed.externallyCancelled());
  }
}

export async function requestUpstream(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const timed = createTimedSignal(externalSignal, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: timed.signal });
  } catch (err) {
    throw classifyFetchError(err, timed.timedOut(), timed.externallyCancelled());
  } finally {
    timed.cleanup();
  }
}

/** Throws a classified UpstreamError for non-2xx responses. */
export async function assertOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  throw classifyHttpError(response.status, body, response.headers);
}

export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError('server', `Invalid JSON from provider: ${text.slice(0, 200)}`, {
      statusCode: response.status,
      retryable: true,
    });
  }
}

export interface SseMessage {
  event?: string;
  data: string;
}

/** Minimal, spec-compliant SSE reader (multi-line data, CRLF, comments). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.search(/\r?\n\r?\n/);
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === '\r' ? 4 : 2));
        const msg = parseSseBlock(raw);
        if (msg) yield msg;
        sep = buffer.search(/\r?\n\r?\n/);
      }
    }
    if (buffer.trim()) {
      const msg = parseSseBlock(buffer);
      if (msg) yield msg;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(raw: string): SseMessage | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

export function authHeadersFor(target: ProviderTarget, extra: Record<string, string> = {}): Record<string, string> {
  return buildHeaders(target, extra);
}

export function joinUrl(base: string, suffix: string): string {
  if (/^https?:\/\//i.test(suffix)) return suffix;
  const cleanBase = base.replace(/\/+$/, '');
  const cleanSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return cleanBase + cleanSuffix;
}
