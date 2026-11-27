import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, streamUrl } from './api';

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useApi<T>(path: string | null, opts: { refreshMs?: number; enabled?: boolean } = {}): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!path || !enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    api
      .get<T>(path, controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, nonce, enabled]);

  useEffect(() => {
    if (!opts.refreshMs || !path || !enabled) return;
    const timer = setInterval(() => setNonce((n) => n + 1), opts.refreshMs);
    return () => clearInterval(timer);
  }, [opts.refreshMs, path, enabled]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refresh };
}

export interface LiveEvent {
  id: number;
  ts: number;
  type: string;
  data: Record<string, unknown>;
}

export function useEventStream(onEvent: (event: LiveEvent) => void, enabled = true): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const source = new EventSource(streamUrl());
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    const names = [
      'hello',
      'ping',
      'route_started',
      'route_success',
      'route_attempt_failed',
      'route_continued',
      'provider_status',
      'provider_removed',
      'skill_run',
      'skill_installed',
      'settings_updated',
      'cooldowns_cleared',
      'api_key_rotated',
      'settings_reset',
    ];
    const listeners: Array<[string, EventListener]> = names.map((name) => {
      const listener = (raw: Event) => {
        const message = raw as MessageEvent<string>;
        try {
          const parsed = JSON.parse(message.data) as LiveEvent;
          handler.current(parsed);
        } catch {
          /* ignore malformed frames */
        }
      };
      source.addEventListener(name, listener);
      return [name, listener];
    });
    return () => {
      for (const [name, listener] of listeners) source.removeEventListener(name, listener);
      source.close();
      setConnected(false);
    };
  }, [enabled]);

  return { connected };
}

export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(320, entry.contentRect.width));
    });
    observer.observe(element);
    setWidth(Math.max(320, element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
