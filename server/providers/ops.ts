import { addProviderKey, createProvider, getProvider, getSettings, listKeyCiphers, listProviders, findProviderByKind, recordKeyResult, setProviderStatus, updateProvider, upsertModels } from '../db.js';
import { encryptSecret, keyHint } from '../crypto.js';
import { log } from '../logger.js';
import { publish } from '../realtime.js';
import type { ProviderDefinition, ProviderRecord } from '../types.js';
import { discoverModels } from './discovery.js';
import { getProviderDefinition, listProviderDefinitions, resolveBaseUrl } from './registry.js';
import { buildTarget } from './runtime.js';
import { UpstreamError } from './types.js';

export interface ConnectInput {
  providerId: string;
  apiKey?: string | null;
  label?: string;
  baseUrl?: string;
  accountId?: string | null;
  keyLabel?: string;
  skipTest?: boolean;
}

export interface TestResult {
  ok: boolean;
  status: 'connected' | 'error' | 'unconfigured';
  message: string;
  latencyMs: number | null;
  modelCount: number;
  errorClass?: string;
}

/** Runs a real request against the provider's model catalog to validate credentials. */
export async function testProvider(providerRowId: string): Promise<TestResult> {
  const provider = getProvider(providerRowId);
  if (!provider) return { ok: false, status: 'error', message: 'Provider not found', latencyMs: null, modelCount: 0 };
  const definition = getProviderDefinition(provider.providerId);
  if (!definition) return { ok: false, status: 'error', message: 'Unknown provider type', latencyMs: null, modelCount: 0 };

  if (!definition.keyless && listKeyCiphers(providerRowId).length === 0) {
    setProviderStatus(providerRowId, 'unconfigured', 'No API key added');
    return { ok: false, status: 'unconfigured', message: 'No API key added', latencyMs: null, modelCount: 0 };
  }
  if (definition.requiresAccountId && !provider.accountId) {
    setProviderStatus(providerRowId, 'error', 'Account ID required (Cloudflare)');
    return { ok: false, status: 'error', message: 'Account ID required', latencyMs: null, modelCount: 0, errorClass: 'invalid_request' };
  }

  const target = buildTarget(providerRowId);
  if (!target) {
    setProviderStatus(providerRowId, 'error', 'No usable credential');
    return { ok: false, status: 'error', message: 'No usable credential', latencyMs: null, modelCount: 0, errorClass: 'auth' };
  }

  try {
    const discovery = await discoverModels(target);
    if (discovery.models.length) upsertModels(providerRowId, discovery.models, 'api');
    const message = discovery.models.length
      ? `${discovery.models.length} models available`
      : 'Connected, but the provider returned no chat models';
    setProviderStatus(providerRowId, 'connected', message, discovery.latencyMs);
    if (target.keyId) recordKeyResult(target.keyId, true);
    publish('provider_status', { providerId: providerRowId, label: provider.label, status: 'connected', message, latencyMs: discovery.latencyMs });
    log.info('provider.connected', { provider: provider.label, models: discovery.models.length, latencyMs: discovery.latencyMs });
    return { ok: true, status: 'connected', message, latencyMs: discovery.latencyMs, modelCount: discovery.models.length };
  } catch (err) {
    const error = err instanceof UpstreamError ? err : new UpstreamError('network', err instanceof Error ? err.message : String(err));
    if (target.keyId) recordKeyResult(target.keyId, false, error.message.slice(0, 200));
    setProviderStatus(providerRowId, 'error', `${error.errorClass}: ${error.message.slice(0, 200)}`);
    publish('provider_status', { providerId: providerRowId, label: provider.label, status: 'error', message: error.message.slice(0, 200) });
    log.warn('provider.test_failed', { provider: provider.label, errorClass: error.errorClass, status: error.statusCode });
    return {
      ok: false,
      status: 'error',
      message: error.message.slice(0, 400),
      latencyMs: null,
      modelCount: 0,
      errorClass: error.errorClass,
    };
  }
}

export async function connectProvider(input: ConnectInput): Promise<{ provider: ProviderRecord; test: TestResult }> {
  const definition = getProviderDefinition(input.providerId);
  if (!definition) throw new Error(`Unknown provider: ${input.providerId}`);
  if (definition.requiresAccountId && !input.accountId) throw new Error('This provider requires an account ID');
  if (!definition.keyless && !input.apiKey?.trim()) throw new Error('An API key is required for this provider');
  if (!definition.baseUrl && !input.baseUrl?.trim()) throw new Error('A base URL is required for this provider');

  let provider = findProviderByKind(input.providerId);
  if (provider && input.providerId !== 'openai-compatible' && input.providerId !== 'anthropic-compatible') {
    // Reuse the existing row so users can attach multiple keys to the same provider.
    updateProvider(provider.id, {
      label: input.label || provider.label,
      baseUrl: input.baseUrl || provider.baseUrl,
      accountId: input.accountId ?? provider.accountId,
      active: true,
    });
  } else {
    provider = createProvider(definition, { label: input.label, baseUrl: input.baseUrl, accountId: input.accountId ?? null });
  }

  if (input.apiKey?.trim()) {
    addProviderKey(provider.id, encryptSecret(input.apiKey.trim()), keyHint(input.apiKey.trim()), input.keyLabel || 'default');
  }

  const test = input.skipTest
    ? {
        ok: true,
        status: 'connected' as const,
        message: 'Saved without testing',
        latencyMs: null,
        modelCount: 0,
      }
    : await testProvider(provider.id);
  return { provider: getProvider(provider.id)!, test };
}

export async function syncProviderModels(providerRowId: string): Promise<{ added: number; updated: number; total: number; latencyMs: number }> {
  const target = buildTarget(providerRowId);
  if (!target) throw new UpstreamError('auth', 'No usable credential for this provider', { retryable: false });
  const discovery = await discoverModels(target);
  const { added, updated } = upsertModels(providerRowId, discovery.models, 'api');
  setProviderStatus(providerRowId, 'connected', `${discovery.models.length} models available`, discovery.latencyMs);
  return { added, updated, total: discovery.models.length, latencyMs: discovery.latencyMs };
}

let healthTimer: NodeJS.Timeout | null = null;
let healthRunning = false;

export async function runHealthChecks(onlyErrored = false): Promise<void> {
  if (healthRunning) return;
  healthRunning = true;
  try {
    const providers = listProviders().filter((p) => p.active && (!onlyErrored || p.status === 'error'));
    for (const provider of providers) {
      await testProvider(provider.id);
    }
  } catch (err) {
    log.error('health.loop_failed', { error: String(err) });
  } finally {
    healthRunning = false;
  }
}

export function startHealthLoop(): void {
  stopHealthLoop();
  const settings = getSettings();
  const interval = Math.max(30_000, settings.healthCheckIntervalMs);
  healthTimer = setInterval(() => {
    const current = getSettings();
    if (!current.autoRecovery) return;
    void runHealthChecks(false);
  }, interval);
  healthTimer.unref?.();
  log.info('health.loop_started', { intervalMs: interval });
}

export function stopHealthLoop(): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

export function providerDefinitionsForUi(): Array<ProviderDefinition & { connected: boolean }> {
  const connectedKinds = new Set(listProviders().map((p) => p.providerId));
  return listProviderDefinitions().map((def) => ({ ...def, connected: connectedKinds.has(def.id) }));
}

export { resolveBaseUrl };
