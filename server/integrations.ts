import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_DIR, PORT } from './config.js';
import { getSettings, listModels, listProviders } from './db.js';

export function localBaseUrl(): string {
  // 127.0.0.1 avoids clients that resolve localhost to ::1 before IPv4.
  return `http://127.0.0.1:${PORT}`;
}

function home(): string {
  return HOME_DIR || os.homedir();
}

export function claudeSettingsPath(): string {
  return path.join(home(), '.claude', 'settings.json');
}

export function openCodeConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg || path.join(home(), '.config'), 'opencode', 'opencode.json');
}

function authToken(): string {
  const settings = getSettings();
  return settings.apiKey;
}

/** The exact env Claude Code needs. Base URL must not include /v1 — the client appends it. */
export function claudeCodeEnv(): Record<string, string> {
  const settings = getSettings();
  const models = listModels({ enabledOnly: true });
  const preferred = models.find((m) => m.favorite) ?? models[0];
  const modelName = preferred?.modelId ?? 'magmax-auto';
  return {
    ANTHROPIC_BASE_URL: localBaseUrl(),
    ANTHROPIC_AUTH_TOKEN: authToken(),
    ANTHROPIC_MODEL: modelName,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelName,
    ANTHROPIC_SMALL_FAST_MODEL: modelName,
  };
}

export function claudeCodeSettingsJson(): Record<string, unknown> {
  return {
    env: claudeCodeEnv(),
    _magmaxNote: 'Created by MagmaX Rotator. Remove these env entries to disconnect Claude Code.',
  };
}

export function openCodeConfig(): Record<string, unknown> {
  const settings = getSettings();
  const models = listModels({ enabledOnly: true });
  const modelMap: Record<string, unknown> = {
    'magmax-auto': { name: 'MagmaX Auto (automatic failover)' },
  };
  for (const model of models.slice(0, 40)) {
    modelMap[`${model.modelId}`] = { name: `${model.modelId} · ${model.providerRowId}` };
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      magmax: {
        npm: '@ai-sdk/openai-compatible',
        name: 'MagmaX Rotator',
        options: {
          baseURL: `${localBaseUrl()}/v1`,
          apiKey: settings.apiKey,
          headers: { 'X-MagMax-Client': 'opencode' },
        },
        models: modelMap,
      },
    },
    model: 'magmax/magmax-auto',
  };
}

export function shellSnippet(): string {
  const env = claudeCodeEnv();
  return Object.entries(env)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join('\n');
}

export interface IntegrationStatus {
  id: 'claude-code' | 'opencode';
  name: string;
  endpoint: string;
  configPath: string;
  configExists: boolean;
  configured: boolean;
  detail: string;
  envVars?: Array<{ key: string; value: string }>;
}

export function detectIntegrations(): IntegrationStatus[] {
  const routerBase = localBaseUrl();
  const modelName = listModels({ enabledOnly: true })[0]?.modelId ?? 'magmax-auto';

  const claudePath = claudeSettingsPath();
  let claudeConfigured = false;
  let claudeDetail = 'No ~/.claude/settings.json found';
  if (fs.existsSync(claudePath)) {
    try {
      const json = JSON.parse(fs.readFileSync(claudePath, 'utf8')) as { env?: Record<string, string> };
      const base = json.env?.ANTHROPIC_BASE_URL ?? '';
      claudeConfigured = base.includes(`localhost:${PORT}`) || base.includes(`127.0.0.1:${PORT}`);
      claudeDetail = claudeConfigured ? 'ANTHROPIC_BASE_URL points at this router' : 'Claude Code config exists but uses a different base URL';
    } catch {
      claudeDetail = 'Claude Code settings exist but are not valid JSON';
    }
  }

  const openPath = openCodeConfigPath();
  let openConfigured = false;
  let openDetail = 'No OpenCode config found';
  if (fs.existsSync(openPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(openPath, 'utf8')) as { provider?: Record<string, { options?: { baseURL?: string } }> };
      openConfigured = Boolean(json.provider?.magmax?.options?.baseURL?.includes('/v1'));
      openDetail = openConfigured ? 'Custom provider "magmax" is configured' : 'OpenCode config exists without a magmax provider';
    } catch {
      openDetail = 'OpenCode config exists but is not valid JSON';
    }
  }

  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      endpoint: `${routerBase}/v1/messages`,
      configPath: claudePath,
      configExists: fs.existsSync(claudePath),
      configured: claudeConfigured,
      detail: claudeDetail,
      envVars: Object.entries(claudeCodeEnv()).map(([key, value]) => ({ key, value })),
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      endpoint: `${routerBase}/v1/chat/completions`,
      configPath: openPath,
      configExists: fs.existsSync(openPath),
      configured: openConfigured,
      detail: openDetail,
      envVars: [{ key: 'model', value: `magmax/magmax-auto` }],
    },
  ];
}

export interface ApplyResult {
  ok: boolean;
  path: string;
  wrote: boolean;
  message: string;
  preview: string;
}

export function applyClaudeCode(opts: { dryRun?: boolean } = {}): ApplyResult {
  const file = claudeSettingsPath();
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
  const merged = { ...(existing as Record<string, unknown>), env: { ...((existing as { env?: Record<string, string> }).env ?? {}), ...claudeCodeEnv() } };
  const preview = JSON.stringify(merged, null, 2);
  if (opts.dryRun) return { ok: true, path: file, wrote: false, message: 'Preview only', preview };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.magmax-backup`);
    fs.writeFileSync(file, preview + '\n', { mode: 0o600 });
    return { ok: true, path: file, wrote: true, message: 'Claude Code settings updated', preview };
  } catch (err) {
    return { ok: false, path: file, wrote: false, message: err instanceof Error ? err.message : String(err), preview };
  }
}

export function applyOpenCode(opts: { dryRun?: boolean } = {}): ApplyResult {
  const file = openCodeConfigPath();
  const existing = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8') || '{}') as Record<string, unknown>) : {};
  const existingProvider = (existing.provider ?? {}) as Record<string, unknown>;
  const merged = { ...existing, provider: { ...existingProvider, magmax: (openCodeConfig() as { provider: Record<string, unknown> }).provider.magmax }, model: 'magmax/magmax-auto' };
  const preview = JSON.stringify(merged, null, 2);
  if (opts.dryRun) return { ok: true, path: file, wrote: false, message: 'Preview only', preview };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.magmax-backup`);
    fs.writeFileSync(file, preview + '\n', { mode: 0o600 });
    return { ok: true, path: file, wrote: true, message: 'OpenCode config updated', preview };
  } catch (err) {
    return { ok: false, path: file, wrote: false, message: err instanceof Error ? err.message : String(err), preview };
  }
}

export interface VerifyResult {
  target: string;
  ok: boolean;
  status: number | null;
  detail: string;
  modelCount?: number;
}

/** Real loopback checks against the running server (no inference cost). */
export async function verifyIntegrations(): Promise<VerifyResult[]> {
  const settings = getSettings();
  const headers: Record<string, string> = { Authorization: `Bearer ${settings.apiKey}` };
  const results: VerifyResult[] = [];
  const check = async (target: string, url: string, init?: RequestInit) => {
    try {
      const response = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
      const text = await response.text();
      let modelCount: number | undefined;
      try {
        const json = JSON.parse(text) as { data?: unknown[] };
        if (Array.isArray(json.data)) modelCount = json.data.length;
      } catch {
        /* not JSON */
      }
      results.push({
        target,
        ok: response.ok,
        status: response.status,
        detail: response.ok ? 'Endpoint reachable' : text.slice(0, 200),
        modelCount,
      });
    } catch (err) {
      results.push({ target, ok: false, status: null, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  await check('OpenAI /v1/models', `${localBaseUrl()}/v1/models`);
  // count_tokens validates the Anthropic route, headers and auth without running inference.
  await check('Anthropic /v1/messages', `${localBaseUrl()}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'magmax-auto', messages: [{ role: 'user', content: 'connection check' }] }),
  });
  return results;
}

export function providerSummary() {
  return listProviders().map((p) => ({ id: p.id, label: p.label, kind: p.providerId }));
}
