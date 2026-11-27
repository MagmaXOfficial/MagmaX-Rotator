import { decryptSecret } from '../crypto.js';
import { listKeyCiphers, listProviders } from '../db.js';
import { log } from '../logger.js';
import { getProviderDefinition, resolveBaseUrl } from './registry.js';
import type { ProviderTarget } from './types.js';

export interface TargetBuildOptions {
  /** Key ids already tried for this request (credential rotation). */
  excludeKeyIds?: Set<string>;
}

/**
 * Builds a callable target for a provider, selecting the healthiest credential.
 * Keys are decrypted in memory only, never logged or returned.
 */
export function buildTarget(providerRowId: string, opts: TargetBuildOptions = {}): ProviderTarget | null {
  const provider = listProviders().find((p) => p.id === providerRowId);
  if (!provider) return null;
  const definition = getProviderDefinition(provider.providerId);
  if (!definition) return null;
  const keys = listKeyCiphers(providerRowId).filter((k) => !opts.excludeKeyIds?.has(k.id));
  let apiKey: string | null = null;
  let keyId: string | null = null;
  let keyHint: string | null = null;
  for (const k of keys) {
    try {
      apiKey = decryptSecret(k.cipher);
      keyId = k.id;
      keyHint = k.keyHint;
      break;
    } catch (err) {
      log.error('key.decrypt_failed', { provider: provider.label, keyId: k.id, error: String(err) });
    }
  }
  if (!apiKey && !definition.keyless) return null;
  return {
    provider,
    definition,
    baseUrl: resolveBaseUrl(definition, provider.baseUrl, provider.accountId),
    apiKey,
    keyId,
    keyHint,
    accountId: provider.accountId,
  };
}

export function providerHasCredentials(providerRowId: string): boolean {
  const provider = listProviders().find((p) => p.id === providerRowId);
  if (!provider) return false;
  const definition = getProviderDefinition(provider.providerId);
  if (!definition) return false;
  if (definition.keyless) return true;
  return listKeyCiphers(providerRowId).length > 0;
}
