import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { APP_NAME, DATA_DIR, HOST, PORT, STARTED_AT, VERSION, WEB_DIST } from '../config.js';
import {
  addProviderKey,
  DEFAULT_SETTINGS,
  deleteAlias,
  deleteMcpServer,
  deleteModel,
  deleteProvider,
  deleteProviderKey,
  getDb,
  getDbPath,
  getModelRow,
  getProvider,
  getRequest,
  getSettings,
  getSkill,
  listAliases,
  listEvents,
  listMcpServers,
  listModels,
  listProviderKeys,
  listProviders,
  listRequests,
  listSkillRuns,
  listSkills,
  pruneRequests,
  resetApiKey,
  setAlias,
  setKeyActive,
  setSkillEnabled,
  updateModel,
  updateProvider,
  updateSettings,
  upsertMcpServer,
  upsertModels,
} from '../db.js';
import { encryptSecret, keyHint } from '../crypto.js';
import { HttpError, adminGuard, readJsonBody } from '../http-utils.js';
import { log, log as logger } from '../logger.js';
import { getDashboardStats, WINDOWS } from '../analytics.js';
import { getProviderDefinition, listProviderDefinitions } from '../providers/registry.js';
import { connectProvider, providerDefinitionsForUi, runHealthChecks, syncProviderModels, testProvider } from '../providers/ops.js';
import { providerHasCredentials } from '../providers/runtime.js';
import { buildCandidates, describeChain, executeRoute, RouteError } from '../router/engine.js';
import { clearAllCooldowns, listCooldowns } from '../router/state.js';
import { createRecord, finishRecord } from '../router/recording.js';
import { publish, recentEvents, subscriberCount } from '../realtime.js';
import { builtinRegistry, ensureBuiltinSkills, installFromDirectory, installFromGit, removeSkill, runSkill } from '../skills/manager.js';
import { callMcpTool, probeAndStore } from '../mcp.js';
import {
  applyClaudeCode,
  applyOpenCode,
  claudeCodeSettingsJson,
  detectIntegrations,
  localBaseUrl,
  openCodeConfig,
  shellSnippet,
  verifyIntegrations,
} from '../integrations.js';
import { getLastReport, runDiagnostics } from '../diagnostics.js';
import type { RouterSettings } from '../types.js';

export const adminApi = new Hono();
adminApi.use('*', adminGuard);

/* --------------------------------- status -------------------------------- */

adminApi.get('/status', (c) => {
  const providers = listProviders();
  const models = listModels();
  const stats = getDashboardStats('1h');
  const settings = getSettings();
  return c.json({
    app: {
      name: APP_NAME,
      version: VERSION,
      startedAt: STARTED_AT,
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      node: process.version,
      pid: process.pid,
      host: HOST,
      port: PORT,
      localOnly: HOST === '127.0.0.1' || HOST === 'localhost',
      dataDir: DATA_DIR,
      dbPath: getDbPath(),
      dashboardBuilt: fs.existsSync(path.join(WEB_DIST, 'index.html')),
      gatewayBase: `${localBaseUrl()}/v1`,
    },
    counts: {
      providers: providers.length,
      activeProviders: providers.filter((p) => p.active && providerHasCredentials(p.id)).length,
      models: models.length,
      enabledModels: models.filter((m) => m.enabled).length,
      skills: listSkills().length,
      mcpServers: listMcpServers().length,
      liveClients: subscriberCount(),
    },
    providers: providers.map((p) => ({
      id: p.id,
      kind: p.providerId,
      label: p.label,
      status: p.status,
      active: p.active,
      latencyMs: p.latencyMs,
      lastCheckAt: p.lastCheckAt,
      statusMessage: p.statusMessage,
      models: models.filter((m) => m.providerRowId === p.id).length,
      enabled: models.filter((m) => m.providerRowId === p.id && m.enabled).length,
    })),
    routing: {
      mode: settings.routingMode,
      profile: settings.profile,
      chainLength: describeChain(settings).length,
      cooldowns: listCooldowns().length,
      requireApiKey: settings.requireApiKey,
    },
    usage: {
      total: stats.totals.total,
      success: stats.totals.success,
      error: stats.totals.error,
      requestsPerMinute: stats.requestsPerMinute,
      tokens: stats.totals.inputTokens + stats.totals.outputTokens,
      cost: stats.totals.cost,
      avgLatency: stats.totals.avgLatency,
      successRate: stats.successRate,
    },
    events: recentEvents(20),
  });
});

/* -------------------------------- settings ------------------------------- */

const fallbackSchema = z.object({
  rateLimit: z.boolean(),
  serverError: z.boolean(),
  timeout: z.boolean(),
  auth: z.boolean(),
  network: z.boolean(),
  modelUnavailable: z.boolean(),
  invalidRequest: z.boolean(),
  contextLength: z.boolean(),
  contentFilter: z.boolean(),
});

const settingsPatchSchema = z
  .object({
    routingMode: z.enum(['priority', 'fastest', 'cheapest', 'smart', 'manual']).optional(),
    profile: z.enum(['general', 'coding', 'reasoning', 'fast', 'long_context', 'vision', 'free_local']).optional(),
    maxAttempts: z.number().int().min(1).max(20).optional(),
    requestTimeoutMs: z.number().int().min(1000).max(600000).optional(),
    cooldownMs: z.number().int().min(1000).max(3600000).optional(),
    cooldownMaxMs: z.number().int().min(1000).max(86400000).optional(),
    autoRecovery: z.boolean().optional(),
    continuationEnabled: z.boolean().optional(),
    maxContinuations: z.number().int().min(0).max(5).optional(),
    fallbackOn: fallbackSchema.partial().optional(),
    excludedModels: z.array(z.string().max(200)).max(500).optional(),
    manualModelId: z.string().nullable().optional(),
    requireApiKey: z.boolean().optional(),
    adminToken: z.string().max(200).optional(),
    storePayloads: z.boolean().optional(),
    rateLimitPerMinute: z.number().int().min(10).max(100000).optional(),
    maxBodyKb: z.number().int().min(16).max(51200).optional(),
    healthCheckIntervalMs: z.number().int().min(30000).max(3600000).optional(),
    allowExternalBind: z.boolean().optional(),
    logLevel: z.string().max(10).optional(),
  })
  .strict();

adminApi.get('/settings', (c) => {
  const settings = getSettings();
  return c.json({
    settings: { ...settings, adminToken: settings.adminToken ? 'set' : '' },
    hasAdminToken: !!settings.adminToken,
    defaults: { ...DEFAULT_SETTINGS, apiKey: 'generated', adminToken: '' },
    endpoints: {
      gateway: `${localBaseUrl()}/v1`,
      chatCompletions: `${localBaseUrl()}/v1/chat/completions`,
      models: `${localBaseUrl()}/v1/models`,
      anthropicMessages: `${localBaseUrl()}/v1/messages`,
      health: `${localBaseUrl()}/api/status`,
    },
    paths: { dataDir: DATA_DIR, dbPath: getDbPath(), webDist: WEB_DIST },
  });
});

adminApi.patch('/settings', async (c) => {
  const body = settingsPatchSchema.parse(await readJsonBody(c));
  const updated = updateSettings(body as Partial<RouterSettings>);
  publish('settings_updated', { keys: Object.keys(body) });
  if (body.adminToken !== undefined && body.adminToken === '') {
    log.info('settings.admin_token_cleared');
  }
  if (body.maxBodyKb) c.header('X-MagMax-Max-Body-Kb', String(updated.maxBodyKb));
  return c.json({ ok: true, settings: { ...updated, adminToken: updated.adminToken ? 'set' : '' } });
});

adminApi.post('/settings/rotate-api-key', (c) => {
  const apiKey = resetApiKey();
  publish('api_key_rotated', {});
  return c.json({ ok: true, apiKey });
});

adminApi.post('/settings/reset', (c) => {
  const current = getSettings();
  const updated = updateSettings({
    ...DEFAULT_SETTINGS,
    apiKey: current.apiKey,
    adminToken: current.adminToken,
  });
  publish('settings_reset', {});
  return c.json({ ok: true, settings: { ...updated, adminToken: updated.adminToken ? 'set' : '' } });
});

adminApi.get('/settings/export', (c) => {
  const settings = getSettings();
  const providers = listProviders().map((p) => ({
    providerId: p.providerId,
    label: p.label,
    baseUrl: p.baseUrl,
    accountId: p.accountId,
    priority: p.priority,
    active: p.active,
    models: listModels({ providerRowId: p.id }).map((m) => ({
      modelId: m.modelId,
      displayName: m.displayName,
      enabled: m.enabled,
      favorite: m.favorite,
      priority: m.priority,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
      tier: m.tier,
      capabilities: m.capabilities,
    })),
  }));
  return c.json(
    {
      format: 'magmax-rotator-export',
      version: 1,
      exportedAt: Date.now(),
      note: 'API keys are intentionally excluded. Re-add them under Providers after importing.',
      settings: { ...settings, apiKey: undefined, adminToken: undefined },
      providers,
      aliases: listAliases().map((a) => ({ alias: a.alias, modelId: a.modelId, providerRowId: a.providerRowId })),
    },
    200,
    { 'Content-Disposition': 'attachment; filename="magmax-config.json"' } as Record<string, string>,
  );
});

adminApi.post('/settings/import', async (c) => {
  const body = await readJsonBody<{
    format?: string;
    settings?: Partial<RouterSettings>;
    aliases?: Array<{ alias: string; modelId: string | null; providerRowId: string | null }>;
  }>(c);
  if (body.format !== 'magmax-rotator-export') throw new HttpError(400, 'Unrecognised export format');
  const allowed: Partial<RouterSettings> = {};
  const keys: Array<keyof RouterSettings> = ['routingMode', 'profile', 'maxAttempts', 'requestTimeoutMs', 'cooldownMs', 'cooldownMaxMs', 'autoRecovery', 'continuationEnabled', 'maxContinuations', 'fallbackOn', 'excludedModels', 'manualModelId', 'rateLimitPerMinute', 'maxBodyKb', 'healthCheckIntervalMs', 'storePayloads'];
  for (const key of keys) {
    if (body.settings && key in body.settings) (allowed as Record<string, unknown>)[key] = body.settings[key];
  }
  updateSettings(allowed);
  let aliases = 0;
  for (const alias of body.aliases ?? []) {
    if (!alias.alias) continue;
    setAlias(alias.alias, alias.providerRowId ?? null, alias.modelId ?? null);
    aliases++;
  }
  return c.json({ ok: true, imported: { settings: Object.keys(allowed).length, aliases } });
});

/* -------------------------------- providers ------------------------------ */

adminApi.get('/providers/registry', (c) => c.json({ providers: providerDefinitionsForUi() }));

adminApi.get('/providers', (c) => {
  const models = listModels();
  const providers = listProviders().map((p) => {
    const definition = getProviderDefinition(p.providerId);
    return {
      ...p,
      definition,
      keys: listProviderKeys(p.id),
      hasCredential: providerHasCredentials(p.id),
      modelCount: models.filter((m) => m.providerRowId === p.id).length,
      enabledCount: models.filter((m) => m.providerRowId === p.id && m.enabled).length,
    };
  });
  return c.json({ providers, registry: listProviderDefinitions() });
});

adminApi.post('/providers', async (c) => {
  const body = z
    .object({
      providerId: z.string().min(1),
      apiKey: z.string().min(1).max(4096).optional(),
      keyLabel: z.string().max(80).optional(),
      label: z.string().max(120).optional(),
      baseUrl: z.string().url().optional(),
      accountId: z.string().max(120).optional(),
      skipTest: z.boolean().optional(),
    })
    .parse(await readJsonBody(c));
  if (!getProviderDefinition(body.providerId)) throw new HttpError(400, `Unknown provider: ${body.providerId}`);
  const { provider, test } = await connectProvider(body);
  return c.json({
    ok: test.ok,
    provider: { ...provider, keys: listProviderKeys(provider.id), definition: getProviderDefinition(provider.providerId) },
    test,
  });
});

adminApi.post('/providers/:id/test', async (c) => {
  const id = c.req.param('id');
  if (!getProvider(id)) throw new HttpError(404, 'Provider not found');
  const test = await testProvider(id);
  return c.json({ test, provider: getProvider(id), keys: listProviderKeys(id), models: listModels({ providerRowId: id }).length });
});

adminApi.post('/providers/:id/sync', async (c) => {
  const id = c.req.param('id');
  if (!getProvider(id)) throw new HttpError(404, 'Provider not found');
  const result = await syncProviderModels(id);
  return c.json({ ok: true, ...result, total: listModels({ providerRowId: id }).length });
});

adminApi.patch('/providers/:id', async (c) => {
  const id = c.req.param('id');
  if (!getProvider(id)) throw new HttpError(404, 'Provider not found');
  const body = z
    .object({
      label: z.string().min(1).max(120).optional(),
      baseUrl: z.string().url().optional(),
      accountId: z.string().max(120).nullable().optional(),
      active: z.boolean().optional(),
      priority: z.number().int().min(0).max(10000).optional(),
    })
    .parse(await readJsonBody(c));
  updateProvider(id, body);
  return c.json({ ok: true, provider: getProvider(id) });
});

adminApi.delete('/providers/:id', (c) => {
  const id = c.req.param('id');
  if (!getProvider(id)) throw new HttpError(404, 'Provider not found');
  deleteProvider(id);
  publish('provider_removed', { providerId: id });
  return c.json({ ok: true });
});

adminApi.post('/providers/:id/keys', async (c) => {
  const id = c.req.param('id');
  if (!getProvider(id)) throw new HttpError(404, 'Provider not found');
  const body = z.object({ apiKey: z.string().min(4).max(4096), label: z.string().max(80).optional() }).parse(await readJsonBody(c));
  addProviderKey(id, encryptSecret(body.apiKey.trim()), keyHint(body.apiKey.trim()), body.label || `key ${listProviderKeys(id).length + 1}`);
  const test = await testProvider(id);
  return c.json({ ok: test.ok, test, keys: listProviderKeys(id) });
});

adminApi.delete('/providers/:id/keys/:keyId', (c) => {
  deleteProviderKey(c.req.param('keyId'));
  return c.json({ ok: true, keys: listProviderKeys(c.req.param('id')) });
});

adminApi.patch('/providers/:id/keys/:keyId', async (c) => {
  const body = z.object({ active: z.boolean() }).parse(await readJsonBody(c));
  setKeyActive(c.req.param('keyId'), body.active);
  return c.json({ ok: true, keys: listProviderKeys(c.req.param('id')) });
});

adminApi.post('/health/run', async (c) => {
  await runHealthChecks(false);
  return c.json({ ok: true, providers: listProviders() });
});

/* --------------------------------- models -------------------------------- */

adminApi.get('/models', (c) => {
  const providers = new Map(listProviders().map((p) => [p.id, p]));
  const search = (c.req.query('search') ?? '').toLowerCase();
  const providerFilter = c.req.query('provider');
  const models = listModels()
    .filter((m) => providers.has(m.providerRowId))
    .filter((m) => (providerFilter ? m.providerRowId === providerFilter : true))
    .filter((m) => (c.req.query('enabled') === '1' ? m.enabled : true))
    .filter((m) => (c.req.query('favorite') === '1' ? m.favorite : true))
    .filter((m) => (search ? `${m.modelId} ${m.displayName}`.toLowerCase().includes(search) : true))
    .map((m) => ({
      ...m,
      provider: {
        id: m.providerRowId,
        label: providers.get(m.providerRowId)?.label ?? 'unknown',
        kind: providers.get(m.providerRowId)?.providerId ?? 'unknown',
        status: providers.get(m.providerRowId)?.status ?? 'unknown',
        tier: getProviderDefinition(providers.get(m.providerRowId)?.providerId ?? '')?.tier ?? 'unknown',
      },
    }));
  return c.json({ models, total: models.length, aliases: listAliases() });
});

adminApi.patch('/models/:id', async (c) => {
  const id = c.req.param('id');
  if (!getModelRow(id)) throw new HttpError(404, 'Model not found');
  const body = z
    .object({
      enabled: z.boolean().optional(),
      favorite: z.boolean().optional(),
      priority: z.number().int().min(0).max(10000).optional(),
      displayName: z.string().min(1).max(200).optional(),
      contextWindow: z.number().int().positive().nullable().optional(),
      maxOutput: z.number().int().positive().nullable().optional(),
      inputPrice: z.number().min(0).nullable().optional(),
      outputPrice: z.number().min(0).nullable().optional(),
      tier: z.enum(['free', 'paid', 'local', 'limited', 'unknown']).optional(),
    })
    .parse(await readJsonBody(c));
  updateModel(id, body);
  return c.json({ ok: true, model: getModelRow(id) });
});

adminApi.post('/models', async (c) => {
  const body = z
    .object({
      providerRowId: z.string().min(1),
      modelId: z.string().min(1).max(200),
      displayName: z.string().max(200).optional(),
      contextWindow: z.number().int().positive().nullable().optional(),
      maxOutput: z.number().int().positive().nullable().optional(),
      inputPrice: z.number().min(0).nullable().optional(),
      outputPrice: z.number().min(0).nullable().optional(),
      tier: z.enum(['free', 'paid', 'local', 'limited', 'unknown']).optional(),
    })
    .parse(await readJsonBody(c));
  if (!getProvider(body.providerRowId)) throw new HttpError(404, 'Provider not found');
  upsertModels(body.providerRowId, [{ ...body, source: 'manual' }], 'manual');
  const model = listModels({ providerRowId: body.providerRowId }).find((m) => m.modelId === body.modelId);
  return c.json({ ok: true, model });
});

adminApi.delete('/models/:id', (c) => {
  deleteModel(c.req.param('id'));
  return c.json({ ok: true });
});

adminApi.post('/aliases', async (c) => {
  const body = z.object({ alias: z.string().min(1).max(120), providerRowId: z.string().nullable().optional(), modelId: z.string().nullable().optional() }).parse(await readJsonBody(c));
  setAlias(body.alias, body.providerRowId ?? null, body.modelId ?? null);
  return c.json({ ok: true, aliases: listAliases() });
});

adminApi.delete('/aliases/:alias', (c) => {
  deleteAlias(c.req.param('alias'));
  return c.json({ ok: true, aliases: listAliases() });
});

/* --------------------------------- router -------------------------------- */

adminApi.get('/router', (c) => {
  const settings = getSettings();
  return c.json({
    settings: {
      routingMode: settings.routingMode,
      profile: settings.profile,
      maxAttempts: settings.maxAttempts,
      requestTimeoutMs: settings.requestTimeoutMs,
      cooldownMs: settings.cooldownMs,
      cooldownMaxMs: settings.cooldownMaxMs,
      autoRecovery: settings.autoRecovery,
      continuationEnabled: settings.continuationEnabled,
      maxContinuations: settings.maxContinuations,
      fallbackOn: settings.fallbackOn,
      excludedModels: settings.excludedModels,
      manualModelId: settings.manualModelId,
      healthCheckIntervalMs: settings.healthCheckIntervalMs,
    },
    chain: describeChain(settings),
    cooldowns: listCooldowns(),
    candidateCount: buildCandidates({ settings }).length,
  });
});

adminApi.patch('/router', async (c) => {
  const body = settingsPatchSchema.partial().parse(await readJsonBody(c));
  updateSettings(body as Partial<RouterSettings>);
  return c.json({ ok: true, chain: describeChain(), settings: getSettings() });
});

adminApi.post('/router/simulate', async (c) => {
  const body = z
    .object({
      requestedModel: z.string().max(200).optional(),
      routingMode: z.enum(['priority', 'fastest', 'cheapest', 'smart', 'manual']).optional(),
      profile: z.enum(['general', 'coding', 'reasoning', 'fast', 'long_context', 'vision', 'free_local']).optional(),
      requiredTools: z.boolean().optional(),
      requiredVision: z.boolean().optional(),
    })
    .parse(await readJsonBody(c).catch(() => ({})));
  const base = getSettings();
  const simulated: RouterSettings = { ...base, routingMode: body.routingMode ?? base.routingMode, profile: body.profile ?? base.profile };
  const candidates = buildCandidates({
    requestedModel: body.requestedModel,
    required: { tools: body.requiredTools, vision: body.requiredVision },
    settings: simulated,
  });
  return c.json({
    explanation:
      candidates.length === 0
        ? 'No eligible model for these constraints.'
        : `${candidates.length} eligible models; first: ${candidates[0]!.provider.label} / ${candidates[0]!.model.modelId} — ${candidates[0]!.reason}`,
    candidates: candidates.slice(0, 25).map((c) => ({
      provider: c.provider.label,
      providerId: c.provider.id,
      model: c.model.modelId,
      reason: c.reason,
      score: Math.round(c.score * 100) / 100,
      cooldown: listCooldowns().some((x) => x.modelId === c.model.modelId),
      tier: c.model.tier,
    })),
  });
});

adminApi.post('/router/clear-cooldowns', (c) => {
  clearAllCooldowns();
  publish('cooldowns_cleared', {});
  return c.json({ ok: true });
});

adminApi.post('/router/test', async (c) => {
  const body = z.object({ prompt: z.string().min(1).max(4000).optional(), model: z.string().max(200).optional() }).parse(await readJsonBody(c).catch(() => ({})));
  const settings = getSettings();
  const record = createRecord({ endpoint: '/api/router/test', requestedModel: body.model ?? null, stream: false, client: 'dashboard', settings });
  const started = Date.now();
  try {
    const outcome = await executeRoute({
      messages: [{ role: 'user', content: body.prompt ?? 'Reply with the single word: ready' }],
      requestedModel: body.model ?? null,
      max_tokens: 32,
      temperature: 0,
      stream: false,
      settings,
      endpoint: '/api/router/test',
      client: 'dashboard',
      requestId: record.id,
    });
    finishRecord(record, {
      status: 'success',
      statusCode: 200,
      providerRowId: outcome.provider.id,
      providerName: outcome.provider.label,
      modelId: outcome.model.modelId,
      model: outcome.model,
      attempts: outcome.attempts,
      latencyMs: outcome.latencyMs,
      ttfbMs: outcome.ttfbMs,
      usage: outcome.result.usage,
      content: outcome.result.content,
    });
    return c.json({
      ok: true,
      response: outcome.result.content.slice(0, 2000),
      provider: outcome.provider.label,
      model: outcome.model.modelId,
      attempts: outcome.attempts,
      latencyMs: outcome.latencyMs,
      usage: outcome.result.usage,
      costUsd: null,
    });
  } catch (err) {
    const routeErr = err instanceof RouteError ? err : null;
    finishRecord(record, {
      status: 'error',
      statusCode: routeErr?.statusCode ?? 500,
      attempts: routeErr?.attempts ?? [],
      latencyMs: Date.now() - started,
      errorCode: routeErr?.errorClass ?? 'internal',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), attempts: routeErr?.attempts ?? [] }, 502);
  }
});

/* ------------------------------- monitoring ------------------------------ */

adminApi.get('/monitoring/stats', (c) => {
  const windowKey = (c.req.query('window') ?? '24h') as keyof typeof WINDOWS;
  return c.json(getDashboardStats(WINDOWS[windowKey] ? windowKey : '24h'));
});

adminApi.get('/monitoring/requests', (c) => {
  const windowParam = c.req.query('window');
  const since = windowParam ? Date.now() - (WINDOWS[windowParam as keyof typeof WINDOWS]?.ms ?? WINDOWS['24h'].ms) : undefined;
  const result = listRequests({
    limit: Number(c.req.query('limit') ?? 50),
    offset: Number(c.req.query('offset') ?? 0),
    since,
    status: c.req.query('status') || undefined,
    providerRowId: c.req.query('provider') || undefined,
    modelId: c.req.query('model') || undefined,
    search: c.req.query('search') || undefined,
  });
  return c.json(result);
});

adminApi.get('/monitoring/requests/:id', (c) => {
  const record = getRequest(c.req.param('id'));
  if (!record) throw new HttpError(404, 'Request not found');
  return c.json({ request: record });
});

adminApi.delete('/monitoring/requests', (c) => {
  pruneRequests(0);
  return c.json({ ok: true });
});

adminApi.get('/monitoring/events', (c) => {
  const events = listEvents({
    limit: Number(c.req.query('limit') ?? 100),
    type: c.req.query('type') || undefined,
    level: c.req.query('level') || undefined,
    since: c.req.query('window') ? Date.now() - (WINDOWS[c.req.query('window') as keyof typeof WINDOWS]?.ms ?? 86_400_000) : undefined,
  });
  return c.json({ events, live: recentEvents(50) });
});

adminApi.get('/monitoring/logs', (c) => c.json({ logs: logger.recent(Number(c.req.query('limit') ?? 200)) }));

adminApi.get('/monitoring/stream', async (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'hello', data: JSON.stringify({ ts: Date.now(), live: subscriberCount() }) });
    let closed = false;
    const unsubscribe = (await import('../realtime.js')).subscribe((event) => {
      if (closed) return;
      void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {
        closed = true;
      });
    });
    c.req.raw.signal.addEventListener('abort', () => {
      closed = true;
    });
    while (!closed) {
      await new Promise((resolve) => setTimeout(resolve, 15000));
      if (closed) break;
      try {
        await stream.writeSSE({ event: 'ping', data: JSON.stringify({ ts: Date.now() }) });
      } catch {
        break;
      }
    }
    unsubscribe();
  }),
);

/* ---------------------------------- skills ------------------------------- */

adminApi.get('/skills', (c) => {
  ensureBuiltinSkills();
  const skills = listSkills();
  return c.json({ skills, available: builtinRegistry(), mcp: listMcpServers() });
});

adminApi.get('/skills/:id/runs', (c) => c.json({ runs: listSkillRuns(c.req.param('id'), 30) }));

adminApi.post('/skills/install', async (c) => {
  const body = z
    .object({
      mode: z.enum(['builtin', 'path', 'git']),
      id: z.string().max(80).optional(),
      path: z.string().max(2000).optional(),
      url: z.string().max(2000).optional(),
    })
    .parse(await readJsonBody(c));
  if (body.mode === 'builtin') {
    ensureBuiltinSkills();
    const skill = body.id ? getSkill(body.id) : null;
    if (!skill) throw new HttpError(404, 'Built-in skill not found');
    setSkillEnabled(skill.id, true);
    return c.json({ ok: true, skill: getSkill(skill.id), warnings: [] });
  }
  if (body.mode === 'path') {
    if (!body.path) throw new HttpError(400, 'path is required');
    if (!path.isAbsolute(body.path)) throw new HttpError(400, 'Use an absolute path to the skill directory');
    return c.json({ ok: true, ...installFromDirectory(body.path) });
  }
  if (!body.url) throw new HttpError(400, 'url is required');
  return c.json({ ok: true, ...(await installFromGit(body.url)) });
});

adminApi.patch('/skills/:id', async (c) => {
  const id = c.req.param('id');
  const body = z.object({ enabled: z.boolean() }).parse(await readJsonBody(c));
  if (!getSkill(id)) throw new HttpError(404, 'Skill not found');
  setSkillEnabled(id, body.enabled);
  return c.json({ ok: true, skill: getSkill(id) });
});

adminApi.delete('/skills/:id', (c) => {
  removeSkill(c.req.param('id'));
  return c.json({ ok: true });
});

adminApi.post('/skills/:id/run', async (c) => {
  const id = c.req.param('id');
  const skill = getSkill(id);
  if (!skill) throw new HttpError(404, 'Skill not found');
  const body = await readJsonBody<{ input?: Record<string, unknown> }>(c).catch(() => ({ input: undefined }));
  const input = body.input ?? skill.manifest.exampleInput ?? {};
  const result = await runSkill(id, input);
  return c.json({ ...result, skill: { id, name: skill.name, permissions: skill.permissions } });
});

/* ----------------------------------- MCP --------------------------------- */

adminApi.get('/mcp', (c) => c.json({ servers: listMcpServers() }));

adminApi.post('/mcp', async (c) => {
  const body = z
    .object({
      name: z.string().min(1).max(80),
      command: z.string().min(1).max(500),
      args: z.array(z.string().max(500)).max(30).default([]),
      enabled: z.boolean().default(true),
    })
    .parse(await readJsonBody(c));
  const id = `mcp_${Math.random().toString(36).slice(2, 10)}`;
  upsertMcpServer({ id, name: body.name, transport: 'stdio', command: body.command, args: body.args, enabled: body.enabled, createdAt: Date.now() });
  return c.json({ ok: true, servers: listMcpServers() });
});

adminApi.delete('/mcp/:id', (c) => {
  deleteMcpServer(c.req.param('id'));
  return c.json({ ok: true, servers: listMcpServers() });
});

adminApi.post('/mcp/:id/probe', async (c) => {
  const server = listMcpServers().find((s) => s.id === c.req.param('id'));
  if (!server) throw new HttpError(404, 'MCP server not found');
  const result = await probeAndStore(server.id, server);
  return c.json({ ...result, servers: listMcpServers() });
});

adminApi.post('/mcp/:id/call', async (c) => {
  const server = listMcpServers().find((s) => s.id === c.req.param('id'));
  if (!server) throw new HttpError(404, 'MCP server not found');
  const body = z.object({ tool: z.string().min(1), arguments: z.record(z.unknown()).default({}) }).parse(await readJsonBody(c));
  const result = await callMcpTool(server, body.tool, body.arguments);
  return c.json({ ok: true, result });
});

/* ------------------------------- integrations ---------------------------- */

adminApi.get('/integrations', (c) =>
  c.json({
    integrations: detectIntegrations(),
    claudeCode: { settings: claudeCodeSettingsJson(), shell: shellSnippet(), env: detectIntegrations()[0]?.envVars ?? [] },
    openCode: { config: openCodeConfig() },
    endpoints: { openai: `${localBaseUrl()}/v1`, anthropic: `${localBaseUrl()}/v1` },
  }),
);

adminApi.post('/integrations/claude-code/apply', async (c) => {
  const body = await readJsonBody<{ dryRun?: boolean }>(c).catch(() => ({ dryRun: false }));
  return c.json(applyClaudeCode({ dryRun: body.dryRun }));
});

adminApi.post('/integrations/opencode/apply', async (c) => {
  const body = await readJsonBody<{ dryRun?: boolean }>(c).catch(() => ({ dryRun: false }));
  return c.json(applyOpenCode({ dryRun: body.dryRun }));
});

adminApi.post('/integrations/verify', async (c) => c.json({ results: await verifyIntegrations(), integrations: detectIntegrations() }));

/* ------------------------------- diagnostics ----------------------------- */

adminApi.post('/diagnostics/run', async (c) => {
  const body = await readJsonBody<{ includeProviders?: boolean }>(c).catch(() => ({ includeProviders: true }));
  const report = await runDiagnostics({ includeProviders: body.includeProviders !== false });
  return c.json(report);
});

adminApi.get('/diagnostics/last', (c) => c.json({ report: getLastReport() }));

/* --------------------------------- misc ---------------------------------- */

adminApi.get('/backup/download', (c) => {
  const file = getDbPath();
  if (!fs.existsSync(file)) throw new HttpError(404, 'Database file not found');
  const data = fs.readFileSync(file);
  return c.body(data, 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="magmax-${new Date().toISOString().slice(0, 10)}.db"`,
  });
});

adminApi.get('/backup/size', (c) => {
  const file = getDbPath();
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = getDb().prepare(`SELECT COUNT(*) AS c FROM "${table.name}"`).get() as { c: number };
    counts[table.name] = Number(row.c);
  }
  return c.json({ size, counts });
});
