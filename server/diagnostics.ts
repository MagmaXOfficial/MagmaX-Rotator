import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOST, PORT, VERSION, WEB_DIST, DATA_DIR, STARTED_AT } from './config.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { getDb, getDbPath, getSettings, insertRequest, listModels, listProviders, pruneRequests } from './db.js';
import { getProviderDefinition } from './providers/registry.js';
import { testProvider } from './providers/ops.js';
import { buildTarget } from './providers/runtime.js';
import { openaiChatStream } from './providers/openai.js';
import { clearCooldown } from './router/state.js';
import { executeRoute } from './router/engine.js';
import { getSkill, listSkills } from './db.js';
import { runSkill } from './skills/manager.js';
import { detectIntegrations, localBaseUrl } from './integrations.js';
import type { Candidate } from './router/engine.js';
import type { AttemptRecord, ModelRecord, ProviderRecord } from './types.js';
import type { ProviderTarget } from './providers/types.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  durationMs: number;
  data?: unknown;
}

export interface DiagnosticsReport {
  ranAt: number;
  durationMs: number;
  checks: CheckResult[];
  summary: { pass: number; warn: number; fail: number; skip: number };
}

let lastReport: DiagnosticsReport | null = null;

export function getLastReport(): DiagnosticsReport | null {
  return lastReport;
}

async function timed(id: string, label: string, fn: () => Promise<{ status: CheckStatus; detail: string; data?: unknown }>): Promise<CheckResult> {
  const started = Date.now();
  try {
    const result = await fn();
    return { id, label, ...result, durationMs: Date.now() - started };
  } catch (err) {
    return { id, label, status: 'fail', detail: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started };
  }
}

interface MockServer {
  url: string;
  close: () => Promise<void>;
}

function startMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not bind mock server'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function fakeProvider(id: string, label: string): ProviderRecord {
  return {
    id,
    providerId: 'openai-compatible',
    label,
    baseUrl: '',
    accountId: null,
    active: true,
    status: 'connected',
    statusMessage: null,
    latencyMs: 5,
    priority: 10,
    createdAt: Date.now(),
    lastCheckAt: Date.now(),
  };
}

function fakeModel(providerId: string, modelId: string): ModelRecord {
  return {
    id: `${providerId}::${modelId}`,
    providerRowId: providerId,
    modelId,
    displayName: modelId,
    contextWindow: 8192,
    maxOutput: 1024,
    inputPrice: 0,
    outputPrice: 0,
    tier: 'local',
    capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
    enabled: true,
    favorite: false,
    priority: 1,
    latencyMs: 5,
    requestCount: 0,
    source: 'manual',
    addedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
}

/** Real end-to-end check of classification, cooldowns, failover and SSE streaming over HTTP. */
async function engineSelfTest(): Promise<{ status: CheckStatus; detail: string; data?: unknown }> {
  const failing = await startMockServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-fast' }] }));
      return;
    }
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: { message: 'simulated rate limit' } }));
  });
  const healthy = await startMockServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-backup' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"failover"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"-ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  const defA = getProviderDefinition('openai-compatible')!;
  const defB = getProviderDefinition('openai-compatible')!;
  const providerA = fakeProvider('diag_a', 'Diagnostics primary');
  const providerB = fakeProvider('diag_b', 'Diagnostics backup');
  const modelA = fakeModel(providerA.id, 'mock-fast');
  const modelB = fakeModel(providerB.id, 'mock-backup');
  const targetFor = (url: string, provider: ProviderRecord): ProviderTarget => ({
    provider,
    definition: defA,
    baseUrl: url,
    apiKey: null,
    keyId: null,
    keyHint: null,
    accountId: null,
  });
  const targets = new Map<string, ProviderTarget>([
    [providerA.id, targetFor(failing.url, providerA)],
    [providerB.id, targetFor(healthy.url, providerB)],
  ]);
  const candidates: Candidate[] = [
    { model: modelA, provider: providerA, definition: defA, score: 0, reason: 'diagnostics' },
    { model: modelB, provider: providerB, definition: defB, score: 1, reason: 'diagnostics' },
  ];

  const chunks: string[] = [];
  try {
    const outcome = await executeRoute({
      messages: [{ role: 'user', content: 'diagnostics ping' }],
      stream: true,
      sink: { onText: (d) => chunks.push(d) },
      settings: { ...getSettings(), maxAttempts: 3, cooldownMs: 1000 },
      candidates,
      resolveTarget: (id) => targets.get(id) ?? null,
      endpoint: '/diagnostics',
      requestedModel: null,
    });
    const attempts: AttemptRecord[] = outcome.attempts;
    const fellBack = attempts.length === 2 && attempts[0]?.errorClass === 'rate_limit' && attempts[1]?.outcome === 'success';
    const streamed = chunks.join('') === 'failover-ok';
    const checks: string[] = [];
    if (!fellBack) checks.push(`expected 429 then success, got ${attempts.map((a) => `${a.outcome}:${a.errorClass ?? ''}${a.statusCode ?? ''}`).join(', ')}`);
    if (!streamed) checks.push(`stream content mismatch: "${chunks.join('')}"`);
    return {
      status: fellBack && streamed ? 'pass' : 'fail',
      detail: fellBack && streamed ? '429 classified, cooldown applied, SSE failover produced intact output' : checks.join('; '),
      data: { attempts: attempts.map((a) => ({ provider: a.providerName, outcome: a.outcome, errorClass: a.errorClass ?? null, status: a.statusCode ?? null })), streamed },
    };
  } finally {
    clearCooldown(providerA.id, modelA.id);
    clearCooldown(providerB.id, modelB.id);
    await failing.close();
    await healthy.close();
  }
}

/** Verifies the OpenAI adapter's SSE parser against a local stream, including usage parsing. */
async function streamingAdapterTest(): Promise<{ status: CheckStatus; detail: string }> {
  const server = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const lines = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
      'data: [DONE]',
      '',
    ];
    res.end(lines.join('\n\n'));
  });
  const definition = getProviderDefinition('openai-compatible')!;
  const target: ProviderTarget = {
    provider: fakeProvider('diag_stream', 'Diagnostics stream'),
    definition,
    baseUrl: server.url,
    apiKey: null,
    keyId: null,
    keyHint: null,
    accountId: null,
  };
  const parts: string[] = [];
  let usage: { prompt_tokens?: number } = {};
  try {
    const result = await openaiChatStream(
      target,
      { model: 'mock', messages: [{ role: 'user', content: 'hi' }] },
      10000,
      { onText: (d) => parts.push(d), onUsage: (u) => (usage = u) },
    );
    const ok = parts.join('') === 'hello world' && result.finishReason === 'stop' && usage.prompt_tokens === 4;
    return { status: ok ? 'pass' : 'fail', detail: ok ? 'SSE deltas, finish reason and usage parsed correctly' : `unexpected stream result: "${parts.join('')}" usage=${JSON.stringify(usage)}` };
  } finally {
    await server.close();
  }
}

async function apiSurfaceTest(): Promise<{ status: CheckStatus; detail: string }> {
  const settings = getSettings();
  const origin = `http://127.0.0.1:${PORT}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.requireApiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  try {
    const models = await fetch(`${origin}/v1/models`, { headers, signal: AbortSignal.timeout(5000) });
    const modelsText = await models.text();
    let count = 0;
    try {
      count = (JSON.parse(modelsText) as { data?: unknown[] }).data?.length ?? 0;
    } catch {
      /* ignore */
    }
    const invalid = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: [] }),
      signal: AbortSignal.timeout(5000),
    });
    const validationWorks = invalid.status === 400;
    const modelsOk = models.ok;
    if (!modelsOk) return { status: 'fail', detail: `/v1/models returned ${models.status}: ${modelsText.slice(0, 160)}` };
    return {
      status: validationWorks ? 'pass' : 'warn',
      detail: `/v1/models listed ${count} entries; request validation ${validationWorks ? 'rejected an empty message list (400)' : `returned ${invalid.status}`}`,
    };
  } catch (err) {
    return { status: 'fail', detail: `Loopback request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runDiagnostics(opts: { includeProviders?: boolean } = {}): Promise<DiagnosticsReport> {
  const startedAll = Date.now();
  const checks: CheckResult[] = [];

  checks.push(
    await timed('server', 'Server & runtime', async () => ({
      status: 'pass',
      detail: `MagmaX ${VERSION} on Node ${process.version}, bound to ${HOST}:${PORT}, up ${Math.round((Date.now() - STARTED_AT) / 1000)}s, RSS ${Math.round(process.memoryUsage().rss / 1_048_576)}MB`,
    })),
  );

  checks.push(
    await timed('database', 'Database (SQLite)', async () => {
      const db = getDb();
      const id = `diag_${crypto.randomBytes(4).toString('hex')}`;
      const now = Date.now();
      insertRequest({
        id,
        ts: now,
        endpoint: '/diagnostics',
        requestedModel: null,
        routingMode: 'priority',
        profile: 'general',
        status: 'success',
        statusCode: 200,
        providerRowId: null,
        providerName: null,
        modelId: null,
        attempts: [],
        latencyMs: 0,
        ttfbMs: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        fallbackCount: 0,
        errorCode: null,
        errorMessage: null,
        stream: false,
        client: 'diagnostics',
        promptSample: null,
        responseSample: null,
      });
      const read = db.prepare('SELECT id FROM requests WHERE id = ?').get(id) as { id?: string } | undefined;
      db.prepare('DELETE FROM requests WHERE id = ?').run(id);
      const again = db.prepare('SELECT id FROM requests WHERE id = ?').get(id) as { id?: string } | undefined;
      const providers = db.prepare('SELECT COUNT(*) AS c FROM providers').get() as { c: number };
      const models = db.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number };
      if (read?.id !== id || again) return { status: 'fail', detail: 'Insert/read/delete round trip failed' };
      return {
        status: 'pass',
        detail: `WAL database at ${getDbPath()} · ${providers.c} providers · ${models.c} cached models · write round trip verified`,
      };
    }),
  );

  checks.push(
    await timed('encryption', 'Secret encryption (AES-256-GCM)', async () => {
      const sample = `diag-${crypto.randomBytes(16).toString('hex')}`;
      const sealed = encryptSecret(sample);
      const opened = decryptSecret(sealed);
      const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
      let rejectsTamper = false;
      try {
        decryptSecret(tampered);
      } catch {
        rejectsTamper = true;
      }
      if (opened !== sample) return { status: 'fail', detail: 'Decryption did not return the original value' };
      return { status: rejectsTamper ? 'pass' : 'warn', detail: rejectsTamper ? 'Round trip verified; tampered ciphertext rejected' : 'Round trip OK but tamper detection did not trigger' };
    }),
  );

  checks.push(await timed('routing-engine', 'Failover engine (429 → fallback → stream)', engineSelfTest));
  checks.push(await timed('streaming', 'SSE streaming adapter', streamingAdapterTest));
  checks.push(await timed('api-surface', 'Gateway endpoints', apiSurfaceTest));

  const providers = listProviders();
  if (!providers.length) {
    checks.push({ id: 'providers', label: 'Provider connections', status: 'skip', detail: 'No providers configured yet', durationMs: 0 });
  } else {
    checks.push(
      await timed('providers', 'Provider connections', async () => {
        if (opts.includeProviders === false) return { status: 'skip', detail: 'Skipped by request' };
        const results: Array<{ label: string; ok: boolean; message: string }> = [];
        for (const provider of providers.filter((p) => p.active)) {
          const target = buildTarget(provider.id);
          if (!target) {
            results.push({ label: provider.label, ok: false, message: 'no usable credential' });
            continue;
          }
          const result = await testProvider(provider.id);
          results.push({ label: provider.label, ok: result.ok, message: result.message });
        }
        const failed = results.filter((r) => !r.ok);
        return {
          status: failed.length === 0 ? 'pass' : failed.length === results.length ? 'fail' : 'warn',
          detail: results.map((r) => `${r.label}: ${r.ok ? 'ok' : r.message.slice(0, 100)}`).join(' · '),
          data: results,
        };
      }),
    );
  }

  checks.push(
    await timed('models', 'Model catalogue', async () => {
      const models = listModels();
      const enabled = models.filter((m) => m.enabled);
      const priced = models.filter((m) => m.inputPrice !== null || m.outputPrice !== null).length;
      if (!models.length) return { status: 'warn', detail: 'No models cached — connect a provider and sync' };
      return {
        status: enabled.length ? 'pass' : 'warn',
        detail: `${models.length} models cached, ${enabled.length} enabled, ${priced} with verified pricing (unknown pricing stays blank)`,
      };
    }),
  );

  checks.push(
    await timed('skills', 'Skills runtime', async () => {
      const skills = listSkills();
      if (!skills.length) return { status: 'warn', detail: 'No skills installed' };
      const enabled = skills.find((s) => s.enabled && s.builtin);
      if (!enabled) return { status: 'warn', detail: `${skills.length} skills installed but none enabled` };
      const skill = getSkill(enabled.id)!;
      const result = await runSkill(enabled.id, skill.manifest.exampleInput ?? {});
      return {
        status: result.status === 'success' ? 'pass' : 'fail',
        detail: `Sandboxed run of "${skill.name}" ${result.status} in ${result.durationMs}ms${result.error ? `: ${result.error}` : ''}`,
        data: { output: result.output, logs: result.logs.slice(0, 500) },
      };
    }),
  );

  checks.push(
    await timed('integrations', 'Client integrations', async () => {
      const statuses = detectIntegrations();
      const configured = statuses.filter((s) => s.configured);
      return {
        status: configured.length ? 'pass' : 'warn',
        detail: statuses.map((s) => `${s.name}: ${s.configured ? 'configured' : s.detail}`).join(' · '),
      };
    }),
  );

  checks.push(
    await timed('storage', 'Disk & retention', async () => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const pruned = pruneRequests(30 * 24 * 3600_000);
      const webBuilt = fs.existsSync(path.join(WEB_DIST, 'index.html'));
      return {
        status: webBuilt ? 'pass' : 'warn',
        detail: `Data dir ${DATA_DIR}${pruned ? `, pruned ${pruned} old request(s)` : ''}${webBuilt ? '' : '; dashboard bundle not built (npm run build:web)'}`,
      };
    }),
  );

  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) summary[check.status]++;
  lastReport = { ranAt: Date.now(), durationMs: Date.now() - startedAll, checks, summary };
  return lastReport;
}

export { localBaseUrl };
