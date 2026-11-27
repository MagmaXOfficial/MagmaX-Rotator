import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';
import { randomToken } from './crypto.js';
import type {
  AliasRecord,
  AttemptRecord,
  EventRecord,
  McpServerRecord,
  ModelCapabilities,
  ModelRecord,
  ModelTier,
  ProviderDefinition,
  ProviderKeyRecord,
  ProviderRecord,
  RequestRecord,
  RouterSettings,
  SkillManifest,
  SkillRecord,
} from './types.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  providerId TEXT NOT NULL,
  label TEXT NOT NULL,
  baseUrl TEXT NOT NULL,
  accountId TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unconfigured',
  statusMessage TEXT,
  latencyMs INTEGER,
  priority INTEGER NOT NULL DEFAULT 100,
  createdAt INTEGER NOT NULL,
  lastCheckAt INTEGER
);

CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY,
  providerRowId TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  keyCipher TEXT NOT NULL,
  keyHint TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  lastUsedAt INTEGER,
  lastError TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  providerRowId TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  modelId TEXT NOT NULL,
  displayName TEXT NOT NULL,
  contextWindow INTEGER,
  maxOutput INTEGER,
  inputPrice REAL,
  outputPrice REAL,
  tier TEXT NOT NULL DEFAULT 'unknown',
  capabilities TEXT NOT NULL DEFAULT '{"tools":null,"vision":null,"reasoning":null,"streaming":null}',
  enabled INTEGER NOT NULL DEFAULT 1,
  favorite INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  latencyMs REAL,
  requestCount INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'api',
  addedAt INTEGER NOT NULL,
  lastSeenAt INTEGER,
  UNIQUE(providerRowId, modelId)
);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(providerRowId);

CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT PRIMARY KEY,
  providerRowId TEXT,
  modelId TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  requestedModel TEXT,
  routingMode TEXT NOT NULL,
  profile TEXT NOT NULL,
  status TEXT NOT NULL,
  statusCode INTEGER NOT NULL DEFAULT 200,
  providerRowId TEXT,
  providerName TEXT,
  modelId TEXT,
  attempts TEXT NOT NULL DEFAULT '[]',
  latencyMs INTEGER NOT NULL DEFAULT 0,
  ttfbMs INTEGER,
  inputTokens INTEGER,
  outputTokens INTEGER,
  costUsd REAL,
  fallbackCount INTEGER NOT NULL DEFAULT 0,
  errorCode TEXT,
  errorMessage TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  client TEXT,
  promptSample TEXT,
  responseSample TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(providerRowId);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(modelId);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  provider TEXT,
  model TEXT,
  requestId TEXT,
  message TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  permissions TEXT,
  manifest TEXT NOT NULL,
  installedAt INTEGER NOT NULL,
  lastRunAt INTEGER,
  lastStatus TEXT,
  lastError TEXT,
  builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skill_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skillId TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  durationMs INTEGER NOT NULL,
  inputText TEXT,
  outputText TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_runs ON skill_runs(skillId, ts);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL,
  lastStatus TEXT,
  lastError TEXT,
  tools TEXT NOT NULL DEFAULT '[]'
);
`;

export const DEFAULT_SETTINGS: RouterSettings = {
  routingMode: 'priority',
  profile: 'general',
  maxAttempts: 5,
  requestTimeoutMs: 60_000,
  cooldownMs: 60_000,
  cooldownMaxMs: 15 * 60_000,
  autoRecovery: true,
  continuationEnabled: true,
  maxContinuations: 2,
  fallbackOn: {
    rateLimit: true,
    serverError: true,
    timeout: true,
    auth: true,
    network: true,
    modelUnavailable: true,
    invalidRequest: false,
    contextLength: false,
    contentFilter: false,
  },
  excludedModels: [],
  manualModelId: null,
  requireApiKey: false,
  apiKey: '',
  adminToken: '',
  storePayloads: false,
  rateLimitPerMinute: 240,
  maxBodyKb: 2048,
  healthCheckIntervalMs: 180_000,
  logLevel: 'info',
  allowExternalBind: false,
  telemetry: false,
};

/** Claude Code model names that clients send; users can point them at any routed model. */
export const BUILTIN_ALIASES = [
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1',
  'claude-opus-4-1-20250805',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-7-sonnet-20250219',
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
];

let db: DatabaseSync | null = null;
let dbPath = '';

export function initDb(opts: { path?: string } = {}): DatabaseSync {
  if (db) return db;
  dbPath = opts.path ?? path.join(DATA_DIR, 'magmax.db');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  seed();
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) return initDb();
  return db;
}

export function getDbPath(): string {
  return dbPath;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

const bool = (v: boolean) => (v ? 1 : 0);
const num = (v: number | null | undefined) => (v === undefined || v === null || Number.isNaN(v) ? null : v);
const text = (v: string | null | undefined) => (v === undefined || v === null || v === '' ? null : v);
const json = (v: unknown) => JSON.stringify(v ?? null);

function row<T>(r: unknown): T | null {
  return r ? ({ ...(r as Record<string, unknown>) } as T) : null;
}
function rows<T>(r: unknown[]): T[] {
  return r.map((x) => ({ ...(x as Record<string, unknown>) }) as T);
}

function seed(): void {
  const conn = getDb();
  const first = conn.prepare('SELECT COUNT(*) AS c FROM settings').get() as { c: number };
  if (first.c === 0) {
    const apiKey = `mxr_${randomToken(24)}`;
    writeSettings({ ...DEFAULT_SETTINGS, apiKey });
  }
  const now = Date.now();
  const insertAlias = conn.prepare('INSERT OR IGNORE INTO aliases (alias, providerRowId, modelId, builtin, createdAt) VALUES (?, NULL, NULL, 1, ?)');
  for (const alias of BUILTIN_ALIASES) insertAlias.run(alias, now);
}

/* ------------------------------- settings -------------------------------- */

function writeSettings(settings: RouterSettings): void {
  const stmt = getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(settings)) stmt.run(key, json(value));
}

export function getSettings(): RouterSettings {
  const out: Record<string, unknown> = {};
  for (const r of rows<{ key: string; value: string }>(getDb().prepare('SELECT key, value FROM settings').all())) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return {
    ...DEFAULT_SETTINGS,
    ...(out as Partial<RouterSettings>),
    fallbackOn: { ...DEFAULT_SETTINGS.fallbackOn, ...((out.fallbackOn as object) ?? {}) },
  };
}

export function updateSettings(patch: Partial<RouterSettings>): RouterSettings {
  const current = getSettings();
  const merged: RouterSettings = {
    ...current,
    ...patch,
    fallbackOn: { ...current.fallbackOn, ...(patch.fallbackOn ?? {}) },
  };
  writeSettings(merged);
  return merged;
}

export function resetApiKey(): string {
  const key = `mxr_${randomToken(24)}`;
  updateSettings({ apiKey: key });
  return key;
}

/* ------------------------------- providers ------------------------------- */

interface ProviderDbRow {
  id: string;
  providerId: string;
  label: string;
  baseUrl: string;
  accountId: string | null;
  active: number;
  status: ProviderRecord['status'];
  statusMessage: string | null;
  latencyMs: number | null;
  priority: number;
  createdAt: number;
  lastCheckAt: number | null;
}

function mapProvider(r: ProviderDbRow): ProviderRecord {
  return { ...r, active: !!r.active };
}

export function listProviders(): ProviderRecord[] {
  return rows<ProviderDbRow>(getDb().prepare('SELECT * FROM providers ORDER BY priority ASC, createdAt ASC').all()).map(mapProvider);
}

export function getProvider(id: string): ProviderRecord | null {
  const r = row<ProviderDbRow>(getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id));
  return r ? mapProvider(r) : null;
}

export function findProviderByKind(providerId: string): ProviderRecord | null {
  const r = row<ProviderDbRow>(getDb().prepare('SELECT * FROM providers WHERE providerId = ? ORDER BY createdAt ASC LIMIT 1').get(providerId));
  return r ? mapProvider(r) : null;
}

export function createProvider(def: ProviderDefinition, opts: { label?: string; baseUrl?: string; accountId?: string | null } = {}): ProviderRecord {
  const id = `prov_${randomToken(9)}`;
  const baseUrl = (opts.baseUrl || def.baseUrl).replace(/\/+$/, '');
  getDb()
    .prepare('INSERT INTO providers (id, providerId, label, baseUrl, accountId, active, status, priority, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
    .run(id, def.id, opts.label || def.name, baseUrl, text(opts.accountId), def.keyless ? 'connected' : 'unconfigured', 100, Date.now());
  return getProvider(id)!;
}

export function updateProvider(id: string, patch: Partial<Omit<ProviderRecord, 'id' | 'providerId' | 'createdAt'>>): void {
  const current = getProvider(id);
  if (!current) return;
  const next = { ...current, ...patch };
  getDb()
    .prepare('UPDATE providers SET label = ?, baseUrl = ?, accountId = ?, active = ?, status = ?, statusMessage = ?, latencyMs = ?, priority = ?, lastCheckAt = ? WHERE id = ?')
    .run(
      next.label,
      next.baseUrl,
      text(next.accountId ?? null),
      bool(next.active),
      next.status,
      text(next.statusMessage),
      num(next.latencyMs),
      next.priority,
      num(next.lastCheckAt),
      id,
    );
}

export function setProviderStatus(id: string, status: ProviderRecord['status'], message: string | null = null, latencyMs: number | null = null): void {
  getDb()
    .prepare('UPDATE providers SET status = ?, statusMessage = ?, latencyMs = ?, lastCheckAt = ? WHERE id = ?')
    .run(status, text(message), num(latencyMs), Date.now(), id);
}

export function deleteProvider(id: string): void {
  getDb().prepare('DELETE FROM provider_keys WHERE providerRowId = ?').run(id);
  getDb().prepare('DELETE FROM models WHERE providerRowId = ?').run(id);
  getDb().prepare('DELETE FROM providers WHERE id = ?').run(id);
}

export function listProviderKeys(providerRowId: string): ProviderKeyRecord[] {
  return rows<{ id: string; providerRowId: string; label: string; keyHint: string; active: number; failures: number; lastUsedAt: number | null; lastError: string | null; createdAt: number }>(
    getDb().prepare('SELECT id, providerRowId, label, keyHint, active, failures, lastUsedAt, lastError, createdAt FROM provider_keys WHERE providerRowId = ? ORDER BY createdAt ASC').all(providerRowId),
  ).map((r) => ({ ...r, active: !!r.active }));
}

export function listKeyCiphers(providerRowId: string): Array<{ id: string; label: string; keyHint: string; cipher: string; failures: number; lastUsedAt: number | null }> {
  return rows<{ id: string; label: string; keyHint: string; keyCipher: string; failures: number; lastUsedAt: number | null }>(
    getDb().prepare('SELECT id, label, keyHint, keyCipher, failures, lastUsedAt FROM provider_keys WHERE providerRowId = ? AND active = 1 ORDER BY failures ASC, lastUsedAt ASC').all(providerRowId),
  ).map((r) => ({ id: r.id, label: r.label, keyHint: r.keyHint, cipher: r.keyCipher, failures: r.failures, lastUsedAt: r.lastUsedAt }));
}

export function addProviderKey(providerRowId: string, cipher: string, hint: string, label: string): string {
  const id = `key_${randomToken(9)}`;
  getDb()
    .prepare('INSERT INTO provider_keys (id, providerRowId, label, keyCipher, keyHint, active, failures, createdAt) VALUES (?, ?, ?, ?, ?, 1, 0, ?)')
    .run(id, providerRowId, label, cipher, hint, Date.now());
  return id;
}

export function deleteProviderKey(id: string): void {
  getDb().prepare('DELETE FROM provider_keys WHERE id = ?').run(id);
}

export function setKeyActive(id: string, active: boolean): void {
  getDb().prepare('UPDATE provider_keys SET active = ?, failures = ? WHERE id = ?').run(bool(active), active ? 0 : 1, id);
}

export function recordKeyResult(id: string, ok: boolean, error?: string): void {
  if (ok) {
    getDb().prepare('UPDATE provider_keys SET failures = 0, lastError = NULL, lastUsedAt = ? WHERE id = ?').run(Date.now(), id);
  } else {
    getDb().prepare('UPDATE provider_keys SET failures = failures + 1, lastError = ?, lastUsedAt = ? WHERE id = ?').run(text(error), Date.now(), id);
  }
}

/* -------------------------------- models --------------------------------- */

interface ModelDbRow extends Omit<ModelRecord, 'capabilities' | 'enabled' | 'favorite' | 'tier'> {
  capabilities: string;
  enabled: number;
  favorite: number;
  tier: ModelTier;
}

function mapModel(r: ModelDbRow): ModelRecord {
  let caps: ModelCapabilities = { tools: null, vision: null, reasoning: null, streaming: null };
  try {
    caps = { ...caps, ...(JSON.parse(r.capabilities) as ModelCapabilities) };
  } catch {
    /* keep unknown */
  }
  return { ...r, capabilities: caps, enabled: !!r.enabled, favorite: !!r.favorite };
}

export interface ModelUpsert {
  modelId: string;
  displayName?: string;
  contextWindow?: number | null;
  maxOutput?: number | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  tier?: ModelTier;
  capabilities?: Partial<ModelCapabilities>;
  source?: 'api' | 'catalog' | 'manual';
}

export function listModels(filter: { providerRowId?: string; enabledOnly?: boolean } = {}): ModelRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.providerRowId) {
    clauses.push('providerRowId = ?');
    params.push(filter.providerRowId);
  }
  if (filter.enabledOnly) clauses.push('enabled = 1');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return rows<ModelDbRow>(getDb().prepare(`SELECT * FROM models ${where} ORDER BY priority ASC, displayName ASC`).all(...params)).map(mapModel);
}

export function getModelRow(id: string): ModelRecord | null {
  const r = row<ModelDbRow>(getDb().prepare('SELECT * FROM models WHERE id = ?').get(id));
  return r ? mapModel(r) : null;
}

export function upsertModels(providerRowId: string, items: ModelUpsert[], source: 'api' | 'catalog' | 'manual' = 'api'): { added: number; updated: number } {
  const conn = getDb();
  const existing = new Map(listModels({ providerRowId }).map((m) => [m.modelId, m]));
  const now = Date.now();
  let added = 0;
  let updated = 0;
  const insert = conn.prepare(
    `INSERT INTO models (id, providerRowId, modelId, displayName, contextWindow, maxOutput, inputPrice, outputPrice, tier, capabilities, enabled, favorite, priority, latencyMs, requestCount, source, addedAt, lastSeenAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 100, NULL, 0, ?, ?, ?)`,
  );
  const update = conn.prepare(
    `UPDATE models SET displayName = ?, contextWindow = ?, maxOutput = ?, inputPrice = ?, outputPrice = ?, tier = ?, capabilities = ?, lastSeenAt = ?, source = ? WHERE id = ?`,
  );
  conn.exec('BEGIN');
  try {
    for (const item of items) {
      const prior = existing.get(item.modelId);
      if (prior) {
        const caps = { ...prior.capabilities, ...(item.capabilities ?? {}) };
        update.run(
          item.displayName || prior.displayName,
          num(item.contextWindow ?? prior.contextWindow),
          num(item.maxOutput ?? prior.maxOutput),
          num(item.inputPrice ?? prior.inputPrice),
          num(item.outputPrice ?? prior.outputPrice),
          item.tier ?? prior.tier,
          json(caps),
          now,
          prior.source === 'manual' ? 'manual' : item.source ?? source,
          prior.id,
        );
        updated++;
      } else {
        const caps: ModelCapabilities = { tools: null, vision: null, reasoning: null, streaming: null, ...(item.capabilities ?? {}) };
        insert.run(
          `${providerRowId}::${item.modelId}`,
          providerRowId,
          item.modelId,
          item.displayName || item.modelId,
          num(item.contextWindow),
          num(item.maxOutput),
          num(item.inputPrice),
          num(item.outputPrice),
          item.tier ?? 'unknown',
          json(caps),
          item.source ?? source,
          now,
          now,
        );
        added++;
      }
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  return { added, updated };
}

export function updateModel(
  id: string,
  patch: Partial<Pick<ModelRecord, 'enabled' | 'favorite' | 'priority' | 'displayName' | 'contextWindow' | 'maxOutput' | 'inputPrice' | 'outputPrice' | 'tier' | 'latencyMs'>>,
): void {
  const current = getModelRow(id);
  if (!current) return;
  const next = { ...current, ...patch };
  getDb()
    .prepare('UPDATE models SET enabled = ?, favorite = ?, priority = ?, displayName = ?, contextWindow = ?, maxOutput = ?, inputPrice = ?, outputPrice = ?, tier = ?, latencyMs = ? WHERE id = ?')
    .run(
      bool(next.enabled),
      bool(next.favorite),
      next.priority,
      next.displayName,
      num(next.contextWindow),
      num(next.maxOutput),
      num(next.inputPrice),
      num(next.outputPrice),
      next.tier,
      num(next.latencyMs),
      id,
    );
}

export function deleteModel(id: string): void {
  getDb().prepare('DELETE FROM models WHERE id = ?').run(id);
}

export function recordModelUsage(providerRowId: string, modelId: string, latencyMs: number): void {
  getDb()
    .prepare('UPDATE models SET requestCount = requestCount + 1, latencyMs = CASE WHEN latencyMs IS NULL THEN ? ELSE (latencyMs * 0.7 + ? * 0.3) END WHERE providerRowId = ? AND modelId = ?')
    .run(latencyMs, latencyMs, providerRowId, modelId);
}

/* -------------------------------- aliases -------------------------------- */

export function listAliases(): AliasRecord[] {
  return rows<{ alias: string; providerRowId: string | null; modelId: string | null; builtin: number; createdAt: number }>(
    getDb().prepare('SELECT * FROM aliases ORDER BY builtin DESC, alias ASC').all(),
  ).map((r) => ({ ...r, builtin: !!r.builtin }));
}

export function setAlias(alias: string, providerRowId: string | null, modelId: string | null): void {
  getDb()
    .prepare('INSERT INTO aliases (alias, providerRowId, modelId, builtin, createdAt) VALUES (?, ?, ?, 0, ?) ON CONFLICT(alias) DO UPDATE SET providerRowId = excluded.providerRowId, modelId = excluded.modelId, builtin = 0')
    .run(alias.trim(), text(providerRowId), text(modelId), Date.now());
}

export function deleteAlias(alias: string): void {
  getDb().prepare('DELETE FROM aliases WHERE alias = ?').run(alias);
}

export function resolveAlias(alias: string): { providerRowId: string | null; modelId: string | null } | null {
  const r = row<{ providerRowId: string | null; modelId: string | null }>(getDb().prepare('SELECT providerRowId, modelId FROM aliases WHERE alias = ?').get(alias));
  return r ?? null;
}

/* -------------------------------- requests ------------------------------- */

export function insertRequest(rec: RequestRecord): void {
  getDb()
    .prepare(
      `INSERT INTO requests (id, ts, endpoint, requestedModel, routingMode, profile, status, statusCode, providerRowId, providerName, modelId, attempts, latencyMs, ttfbMs, inputTokens, outputTokens, costUsd, fallbackCount, errorCode, errorMessage, stream, client, promptSample, responseSample)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.id,
      rec.ts,
      rec.endpoint,
      text(rec.requestedModel),
      rec.routingMode,
      rec.profile,
      rec.status,
      rec.statusCode,
      text(rec.providerRowId),
      text(rec.providerName),
      text(rec.modelId),
      json(rec.attempts),
      rec.latencyMs,
      num(rec.ttfbMs),
      num(rec.inputTokens),
      num(rec.outputTokens),
      num(rec.costUsd),
      rec.fallbackCount,
      text(rec.errorCode),
      text(rec.errorMessage),
      bool(rec.stream),
      text(rec.client),
      text(rec.promptSample),
      text(rec.responseSample),
    );
}

function mapRequest(r: Record<string, unknown>): RequestRecord {
  let attempts: AttemptRecord[] = [];
  try {
    attempts = JSON.parse(String(r.attempts ?? '[]')) as AttemptRecord[];
  } catch {
    attempts = [];
  }
  return { ...(r as unknown as RequestRecord), attempts, stream: !!r.stream };
}

export function listRequests(filter: {
  limit?: number;
  offset?: number;
  since?: number;
  status?: string;
  providerRowId?: string;
  modelId?: string;
  search?: string;
} = {}): { items: RequestRecord[]; total: number } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.since) {
    clauses.push('ts >= ?');
    params.push(filter.since);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.providerRowId) {
    clauses.push('providerRowId = ?');
    params.push(filter.providerRowId);
  }
  if (filter.modelId) {
    clauses.push('modelId = ?');
    params.push(filter.modelId);
  }
  if (filter.search) {
    clauses.push('(id LIKE ? OR requestedModel LIKE ? OR modelId LIKE ? OR errorMessage LIKE ?)');
    const q = `%${filter.search}%`;
    params.push(q, q, q, q);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = (getDb().prepare(`SELECT COUNT(*) AS c FROM requests ${where}`).get(...params) as { c: number }).c;
  const limit = Math.min(filter.limit ?? 50, 500);
  const offset = filter.offset ?? 0;
  const items = rows<Record<string, unknown>>(
    getDb()
      .prepare(`SELECT id, ts, endpoint, requestedModel, routingMode, profile, status, statusCode, providerRowId, providerName, modelId, attempts, latencyMs, ttfbMs, inputTokens, outputTokens, costUsd, fallbackCount, errorCode, errorMessage, stream, client, promptSample, responseSample FROM requests ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset),
  ).map(mapRequest);
  return { items, total };
}

export function getRequest(id: string): RequestRecord | null {
  const r = row<Record<string, unknown>>(getDb().prepare('SELECT * FROM requests WHERE id = ?').get(id));
  return r ? mapRequest(r) : null;
}

export function finalizeRequest(rec: RequestRecord): void {
  getDb()
    .prepare(
      `UPDATE requests SET status = ?, statusCode = ?, providerRowId = ?, providerName = ?, modelId = ?, attempts = ?, latencyMs = ?, ttfbMs = ?, inputTokens = ?, outputTokens = ?, costUsd = ?, fallbackCount = ?, errorCode = ?, errorMessage = ?, promptSample = ?, responseSample = ? WHERE id = ?`,
    )
    .run(
      rec.status,
      rec.statusCode,
      text(rec.providerRowId),
      text(rec.providerName),
      text(rec.modelId),
      json(rec.attempts),
      rec.latencyMs,
      num(rec.ttfbMs),
      num(rec.inputTokens),
      num(rec.outputTokens),
      num(rec.costUsd),
      rec.fallbackCount,
      text(rec.errorCode),
      text(rec.errorMessage),
      text(rec.promptSample),
      text(rec.responseSample),
      rec.id,
    );
}

export function pruneRequests(olderThanMs: number): number {
  const res = getDb().prepare('DELETE FROM requests WHERE ts < ?').run(Date.now() - olderThanMs);
  return Number(res.changes ?? 0);
}

/* --------------------------------- events -------------------------------- */

export function addEvent(e: Omit<EventRecord, 'id'>): EventRecord {
  const res = getDb()
    .prepare('INSERT INTO events (ts, type, level, provider, model, requestId, message, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(e.ts, e.type, e.level, text(e.provider), text(e.model), text(e.requestId), e.message, json(e.meta));
  return { ...e, id: Number(res.lastInsertRowid) };
}

export function listEvents(filter: { limit?: number; type?: string; since?: number; level?: string } = {}): EventRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter.level) {
    clauses.push('level = ?');
    params.push(filter.level);
  }
  if (filter.since) {
    clauses.push('ts >= ?');
    params.push(filter.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return rows<{ id: number; ts: number; type: string; level: EventRecord['level']; provider: string | null; model: string | null; requestId: string | null; message: string; meta: string | null }>(
    getDb().prepare(`SELECT * FROM events ${where} ORDER BY ts DESC LIMIT ?`).all(...params, Math.min(filter.limit ?? 100, 500)),
  ).map((r) => {
    let meta: Record<string, unknown> | null = null;
    try {
      meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null;
    } catch {
      meta = null;
    }
    return { ...r, meta };
  });
}

/* --------------------------------- skills -------------------------------- */

export function listSkills(): SkillRecord[] {
  return rows<{ id: string; name: string; version: string; description: string; source: SkillRecord['source']; path: string; enabled: number; permissions: string | null; manifest: string; installedAt: number; lastRunAt: number | null; lastStatus: string | null; lastError: string | null; builtin: number }>(
    getDb().prepare('SELECT * FROM skills ORDER BY builtin DESC, name ASC').all(),
  ).map((r) => ({
    ...r,
    enabled: !!r.enabled,
    builtin: !!r.builtin,
    permissions: (r.permissions ? JSON.parse(r.permissions) : {}) as SkillManifest['permissions'],
    manifest: JSON.parse(r.manifest) as SkillManifest,
  }));
}

export function getSkill(id: string): SkillRecord | null {
  return listSkills().find((s) => s.id === id) ?? null;
}

export function upsertSkill(rec: Omit<SkillRecord, 'builtin'> & { builtin?: boolean }): void {
  getDb()
    .prepare(
      `INSERT INTO skills (id, name, version, description, source, path, enabled, permissions, manifest, installedAt, lastRunAt, lastStatus, lastError, builtin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, description = excluded.description, source = excluded.source, path = excluded.path, permissions = excluded.permissions, manifest = excluded.manifest, builtin = excluded.builtin`,
    )
    .run(
      rec.id,
      rec.name,
      rec.version,
      rec.description,
      rec.source,
      rec.path,
      bool(rec.enabled),
      json(rec.permissions ?? {}),
      json(rec.manifest),
      rec.installedAt,
      num(rec.lastRunAt),
      text(rec.lastStatus),
      text(rec.lastError),
      bool(rec.builtin ?? false),
    );
}

export function setSkillEnabled(id: string, enabled: boolean): void {
  getDb().prepare('UPDATE skills SET enabled = ? WHERE id = ?').run(bool(enabled), id);
}

export function deleteSkill(id: string): void {
  getDb().prepare('DELETE FROM skills WHERE id = ? AND builtin = 0').run(id);
  getDb().prepare('DELETE FROM skill_runs WHERE skillId = ?').run(id);
}

export function recordSkillRun(skillId: string, status: string, durationMs: number, inputText: string | null, outputText: string | null, error: string | null): void {
  getDb().prepare('INSERT INTO skill_runs (skillId, ts, status, durationMs, inputText, outputText, error) VALUES (?, ?, ?, ?, ?, ?, ?)').run(skillId, Date.now(), status, durationMs, text(inputText), text(outputText?.slice(0, 8000)), text(error));
  getDb().prepare('UPDATE skills SET lastRunAt = ?, lastStatus = ?, lastError = ? WHERE id = ?').run(Date.now(), status, text(error), skillId);
}

export function listSkillRuns(skillId: string, limit = 20): Array<{ id: number; skillId: string; ts: number; status: string; durationMs: number; inputText: string | null; outputText: string | null; error: string | null }> {
  return rows(getDb().prepare('SELECT * FROM skill_runs WHERE skillId = ? ORDER BY ts DESC LIMIT ?').all(skillId, Math.min(limit, 100)));
}

/* ------------------------------ mcp servers ------------------------------ */

export function listMcpServers(): McpServerRecord[] {
  return rows<{ id: string; name: string; transport: 'stdio'; command: string; args: string; enabled: number; createdAt: number; lastStatus: string | null; lastError: string | null; tools: string }>(
    getDb().prepare('SELECT * FROM mcp_servers ORDER BY createdAt ASC').all(),
  ).map((r) => ({
    ...r,
    enabled: !!r.enabled,
    args: JSON.parse(r.args) as string[],
    tools: JSON.parse(r.tools) as McpServerRecord['tools'],
  }));
}

export function upsertMcpServer(rec: Omit<McpServerRecord, 'tools' | 'lastStatus' | 'lastError'>): void {
  getDb()
    .prepare(
      `INSERT INTO mcp_servers (id, name, transport, command, args, enabled, createdAt, lastStatus, lastError, tools)
       VALUES (?, ?, 'stdio', ?, ?, ?, ?, NULL, NULL, '[]')
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, command = excluded.command, args = excluded.args, enabled = excluded.enabled`,
    )
    .run(rec.id, rec.name, rec.command, json(rec.args), bool(rec.enabled), rec.createdAt);
}

export function updateMcpStatus(id: string, status: string, error: string | null, tools: McpServerRecord['tools'] = []): void {
  getDb().prepare('UPDATE mcp_servers SET lastStatus = ?, lastError = ?, tools = ? WHERE id = ?').run(status, text(error), json(tools), id);
}

export function deleteMcpServer(id: string): void {
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}
