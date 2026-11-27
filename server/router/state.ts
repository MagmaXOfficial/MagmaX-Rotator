import type { ErrorClass, RouterSettings } from '../types.js';

export interface CooldownInfo {
  key: string;
  modelId: string;
  until: number;
  since: number;
  failures: number;
  reason: ErrorClass;
  message: string;
}

const cooldowns = new Map<string, CooldownInfo>();

export function cooldownKey(providerRowId: string, modelRowId: string): string {
  return `${providerRowId}::${modelRowId}`;
}

export function isCoolingDown(providerRowId: string, modelRowId: string): boolean {
  const entry = cooldowns.get(cooldownKey(providerRowId, modelRowId));
  if (!entry) return false;
  if (entry.until <= Date.now()) {
    cooldowns.delete(entry.key);
    return false;
  }
  return true;
}

export function getCooldown(providerRowId: string, modelRowId: string): CooldownInfo | null {
  const entry = cooldowns.get(cooldownKey(providerRowId, modelRowId));
  if (!entry) return null;
  if (entry.until <= Date.now()) {
    cooldowns.delete(entry.key);
    return null;
  }
  return entry;
}

export function listCooldowns(): CooldownInfo[] {
  const now = Date.now();
  for (const [k, v] of cooldowns) if (v.until <= now) cooldowns.delete(k);
  return [...cooldowns.values()].sort((a, b) => a.until - b.until);
}

export function clearCooldown(providerRowId: string, modelRowId: string): void {
  cooldowns.delete(cooldownKey(providerRowId, modelRowId));
}

export function clearAllCooldowns(): void {
  cooldowns.clear();
}

/** Exponential backoff, capped by cooldownMaxMs. Rate-limit hints win when larger. */
export function recordFailure(
  providerRowId: string,
  modelRowId: string,
  modelId: string,
  errorClass: ErrorClass,
  message: string,
  settings: RouterSettings,
  retryAfterMs?: number,
): CooldownInfo {
  const key = cooldownKey(providerRowId, modelRowId);
  const prev = cooldowns.get(key);
  const failures = (prev?.failures ?? 0) + 1;
  const base = Math.max(1000, settings.cooldownMs);
  const backoff = Math.min(base * 2 ** (failures - 1), Math.max(base, settings.cooldownMaxMs));
  const hint = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 0;
  const duration = Math.min(Math.max(backoff, hint), Math.max(settings.cooldownMaxMs, base));
  const entry: CooldownInfo = {
    key,
    modelId,
    until: Date.now() + duration,
    since: Date.now(),
    failures,
    reason: errorClass,
    message,
  };
  cooldowns.set(key, entry);
  return entry;
}

export function recordSuccess(providerRowId: string, modelRowId: string): void {
  cooldowns.delete(cooldownKey(providerRowId, modelRowId));
}

export function persistStateForTests(): void {
  cooldowns.clear();
}
