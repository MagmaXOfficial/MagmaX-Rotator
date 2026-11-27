import { getDb, getSettings } from './db.js';
import type { ModelRecord } from './types.js';
import { listCooldowns } from './router/state.js';

export type WindowKey = '1h' | '6h' | '24h' | '7d' | '30d';

export const WINDOWS: Record<WindowKey, { ms: number; bucketMs: number }> = {
  '1h': { ms: 60 * 60_000, bucketMs: 60_000 },
  '6h': { ms: 6 * 60 * 60_000, bucketMs: 5 * 60_000 },
  '24h': { ms: 24 * 60 * 60_000, bucketMs: 30 * 60_000 },
  '7d': { ms: 7 * 24 * 60 * 60_000, bucketMs: 3 * 60 * 60_000 },
  '30d': { ms: 30 * 24 * 60 * 60_000, bucketMs: 12 * 60 * 60_000 },
};

interface Totals {
  total: number;
  success: number;
  error: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  costKnownRequests: number;
  avgLatency: number | null;
  avgTtfb: number | null;
  fallbackRequests: number;
}

function queryTotals(since: number): Totals {
  const row = getDb()
    .prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
        COALESCE(SUM(inputTokens), 0) AS inputTokens,
        COALESCE(SUM(outputTokens), 0) AS outputTokens,
        COALESCE(SUM(costUsd), 0) AS cost,
        COALESCE(SUM(CASE WHEN costUsd IS NOT NULL THEN 1 ELSE 0 END), 0) AS costKnownRequests,
        AVG(latencyMs) AS avgLatency,
        AVG(ttfbMs) AS avgTtfb,
        COALESCE(SUM(CASE WHEN fallbackCount > 0 THEN 1 ELSE 0 END), 0) AS fallbackRequests
      FROM requests WHERE ts >= ?`,
    )
    .get(since) as Record<string, number | null>;
  return {
    total: Number(row.total ?? 0),
    success: Number(row.success ?? 0),
    error: Number(row.error ?? 0),
    cancelled: Number(row.cancelled ?? 0),
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    cost: Number(row.cost ?? 0),
    costKnownRequests: Number(row.costKnownRequests ?? 0),
    avgLatency: row.avgLatency === null ? null : Number(row.avgLatency),
    avgTtfb: row.avgTtfb === null ? null : Number(row.avgTtfb),
    fallbackRequests: Number(row.fallbackRequests ?? 0),
  };
}

export interface Bucket {
  ts: number;
  total: number;
  success: number;
  error: number;
  tokens: number;
  latencyMs: number | null;
}

function querySeries(since: number, bucketMs: number): Bucket[] {
  const rows = getDb()
    .prepare(
      `SELECT CAST(ts / ? AS INTEGER) * ? AS bucket,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error,
        COALESCE(SUM(COALESCE(inputTokens, 0) + COALESCE(outputTokens, 0)), 0) AS tokens,
        AVG(latencyMs) AS latencyMs
      FROM requests WHERE ts >= ? GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(bucketMs, bucketMs, since) as Array<Record<string, number | null>>;
  return rows.map((r) => ({
    ts: Number(r.bucket ?? 0),
    total: Number(r.total ?? 0),
    success: Number(r.success ?? 0),
    error: Number(r.error ?? 0),
    tokens: Number(r.tokens ?? 0),
    latencyMs: r.latencyMs === null ? null : Number(r.latencyMs),
  }));
}

function queryByProvider(since: number): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT providerRowId, providerName,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error,
        COALESCE(SUM(COALESCE(inputTokens,0) + COALESCE(outputTokens,0)), 0) AS tokens,
        COALESCE(SUM(costUsd), 0) AS cost,
        AVG(latencyMs) AS avgLatency,
        MAX(ts) AS lastAt
      FROM requests WHERE ts >= ? AND providerRowId IS NOT NULL
      GROUP BY providerRowId ORDER BY total DESC`,
    )
    .all(since)
    .map((r) => ({ ...(r as Record<string, unknown>) }));
}

function queryByModel(since: number): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT modelId, providerName,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error,
        COALESCE(SUM(COALESCE(inputTokens,0) + COALESCE(outputTokens,0)), 0) AS tokens,
        COALESCE(SUM(costUsd), 0) AS cost,
        AVG(latencyMs) AS avgLatency
      FROM requests WHERE ts >= ? AND modelId IS NOT NULL
      GROUP BY modelId ORDER BY total DESC LIMIT 40`,
    )
    .all(since)
    .map((r) => ({ ...(r as Record<string, unknown>) }));
}

function queryErrors(since: number): Array<{ code: string; count: number; lastMessage: string | null }> {
  return getDb()
    .prepare(
      `SELECT COALESCE(errorCode, 'unknown') AS code, COUNT(*) AS count, MAX(errorMessage) AS lastMessage
       FROM requests WHERE ts >= ? AND status = 'error' GROUP BY code ORDER BY count DESC LIMIT 12`,
    )
    .all(since)
    .map((r) => {
      const rec = r as Record<string, string | number | null>;
      return { code: String(rec.code), count: Number(rec.count), lastMessage: rec.lastMessage ? String(rec.lastMessage) : null };
    });
}

function countEvents(since: number, type: string): number {
  const r = getDb().prepare('SELECT COUNT(*) AS c FROM events WHERE ts >= ? AND type = ?').get(since, type) as { c: number };
  return Number(r.c ?? 0);
}

export function getDashboardStats(windowKey: WindowKey = '24h') {
  const window = WINDOWS[windowKey] ?? WINDOWS['24h'];
  const since = Date.now() - window.ms;
  const totals = queryTotals(since);
  const lastMinute = queryTotals(Date.now() - 60_000);
  const lastHour = queryTotals(Date.now() - 3_600_000);
  const cooldowns = listCooldowns();
  return {
    window: windowKey,
    since,
    totals,
    requestsPerMinute: Math.round((lastMinute.total / 1) * 10) / 10,
    requestsLastHour: lastHour.total,
    successRate: totals.total ? Math.round((totals.success / totals.total) * 1000) / 10 : null,
    series: querySeries(since, window.bucketMs),
    bucketMs: window.bucketMs,
    byProvider: queryByProvider(since),
    byModel: queryByModel(since),
    errors: queryErrors(since),
    fallbackEvents: countEvents(since, 'route_attempt_failed'),
    rateLimitEvents: countEvents(since, 'rate_limit'),
    cooldowns: cooldowns.map((c) => ({ modelId: c.modelId, until: c.until, reason: c.reason, failures: c.failures, message: c.message })),
    storage: {
      payloadLogging: getSettings().storePayloads,
    },
  };
}

/** Cost estimation helper shared by the dashboard (never invents prices). */
export function estimateCostFromPrices(model: ModelRecord | null, inputTokens: number | null, outputTokens: number | null): number | null {
  if (!model || (inputTokens === null && outputTokens === null)) return null;
  if (model.inputPrice === null && model.outputPrice === null) return null;
  const cost = ((inputTokens ?? 0) / 1_000_000) * (model.inputPrice ?? 0) + ((outputTokens ?? 0) / 1_000_000) * (model.outputPrice ?? 0);
  return Math.round(cost * 1e6) / 1e6;
}

