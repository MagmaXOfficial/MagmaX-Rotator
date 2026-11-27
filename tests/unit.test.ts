import { beforeAll, describe, expect, it } from 'vitest';
import { classifyHttpError } from '../server/providers/errors.js';
import { decryptSecret, encryptSecret } from '../server/crypto.js';
import {
  DEFAULT_SETTINGS,
  addProviderKey,
  createProvider,
  getSettings,
  initDb,
  listKeyCiphers,
  listModels,
  setAlias,
  updateModel,
  updateSettings,
  upsertModels,
} from '../server/db.js';
import { getProviderDefinition } from '../server/providers/registry.js';
import { buildCandidates } from '../server/router/engine.js';
import { clearCooldown, clearAllCooldowns, recordFailure, isCoolingDown } from '../server/router/state.js';
import { buildAnthropicRequest, toAnthropicMessages } from '../server/providers/anthropic.js';
import { ensureBuiltinSkills } from '../server/skills/manager.js';
import { runSkill } from '../server/skills/manager.js';

let providerId = '';
let alphaId = '';
let betaId = '';

beforeAll(() => {
  initDb({ path: ':memory:' });
  const def = getProviderDefinition('openai-compatible')!;
  const provider = createProvider(def, { baseUrl: 'http://127.0.0.1:9/v1', label: 'Test provider' });
  providerId = provider.id;
  upsertModels(providerId, [{ modelId: 'alpha', contextWindow: 8000, inputPrice: 1, outputPrice: 3, tier: 'paid' }, { modelId: 'beta', contextWindow: 200_000, inputPrice: 0, outputPrice: 0, tier: 'free' }]);
  const models = listModels({ providerRowId: providerId });
  alphaId = models.find((m) => m.modelId === 'alpha')!.id;
  betaId = models.find((m) => m.modelId === 'beta')!.id;
  updateModel(alphaId, { priority: 1, latencyMs: 800 });
  updateModel(betaId, { priority: 50, latencyMs: 40 });
});

describe('error classification', () => {
  it('classifies rate limits and reads Retry-After', () => {
    const error = classifyHttpError(429, JSON.stringify({ error: { message: 'slow down' } }), new Headers({ 'retry-after': '2' }));
    expect(error.errorClass).toBe('rate_limit');
    expect(error.retryAfterMs).toBe(2000);
    expect(error.retryable).toBe(true);
  });

  it('treats auth failures as credential problems', () => {
    const error = classifyHttpError(401, 'unauthorized');
    expect(error.errorClass).toBe('auth');
    expect(error.credentialProblem).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it('detects context length and invalid requests separately', () => {
    expect(classifyHttpError(400, JSON.stringify({ error: { message: 'maximum context length exceeded' } })).errorClass).toBe('context_length');
    expect(classifyHttpError(400, JSON.stringify({ error: { message: 'messages[0].role is invalid' } })).errorClass).toBe('invalid_request');
    expect(classifyHttpError(500, 'upstream exploded').errorClass).toBe('server');
    expect(classifyHttpError(404, 'model does not exist').errorClass).toBe('model_unavailable');
  });
});

describe('secret storage', () => {
  it('round trips encrypted values and rejects tampering', () => {
    const secret = 'sk-test-1234567890';
    const sealed = encryptSecret(secret);
    expect(sealed).not.toContain(secret);
    expect(decryptSecret(sealed)).toBe(secret);
    expect(() => decryptSecret(sealed.slice(0, -4) + 'AAAA')).toThrow();
  });

  it('never stores provider keys in plaintext', () => {
    const raw = 'sk-live-abcdef123456';
    addProviderKey(providerId, encryptSecret(raw), '••••3456', 'primary');
    const stored = listKeyCiphers(providerId);
    expect(stored.length).toBe(1);
    expect(stored[0]!.cipher).not.toContain(raw);
    expect(decryptSecret(stored[0]!.cipher)).toBe(raw);
  });
});

describe('routing candidate selection', () => {
  it('orders by priority in priority mode', () => {
    const candidates = buildCandidates({ settings: { ...DEFAULT_SETTINGS, routingMode: 'priority' } });
    expect(candidates.map((c) => c.model.modelId)).toEqual(['alpha', 'beta']);
  });

  it('prefers measured latency in fastest mode', () => {
    const candidates = buildCandidates({ settings: { ...DEFAULT_SETTINGS, routingMode: 'fastest' } });
    expect(candidates[0]!.model.modelId).toBe('beta');
  });

  it('prefers verified cheap models in cheapest mode', () => {
    const candidates = buildCandidates({ settings: { ...DEFAULT_SETTINGS, routingMode: 'cheapest' } });
    expect(candidates[0]!.model.modelId).toBe('beta');
  });

  it('honours the free/local profile', () => {
    const candidates = buildCandidates({ settings: { ...DEFAULT_SETTINGS, profile: 'free_local' } });
    expect(candidates.map((c) => c.model.modelId)).toEqual(['beta']);
  });

  it('excludes cooling-down models and recovers after clearing', () => {
    recordFailure(providerId, alphaId, 'alpha', 'rate_limit', '429', { ...DEFAULT_SETTINGS, cooldownMs: 60_000 });
    expect(isCoolingDown(providerId, alphaId)).toBe(true);
    expect(buildCandidates({ settings: DEFAULT_SETTINGS }).map((c) => c.model.modelId)).not.toContain('alpha');
    clearCooldown(providerId, alphaId);
    expect(buildCandidates({ settings: DEFAULT_SETTINGS }).map((c) => c.model.modelId)).toContain('alpha');
  });

  it('prefers a requested model and a configured alias', () => {
    const requested = buildCandidates({ requestedModel: 'beta', settings: DEFAULT_SETTINGS });
    expect(requested[0]!.model.modelId).toBe('beta');
    setAlias('claude-sonnet-4-5', providerId, 'beta');
    const aliased = buildCandidates({ requestedModel: 'claude-sonnet-4-5', settings: DEFAULT_SETTINGS });
    expect(aliased[0]!.model.modelId).toBe('beta');
  });

  it('respects exclusions', () => {
    const candidates = buildCandidates({ settings: { ...DEFAULT_SETTINGS, excludedModels: ['alpha'] } });
    expect(candidates.map((c) => c.model.modelId)).toEqual(['beta']);
  });

  it('applies tool capability requirements', () => {
    const candidates = buildCandidates({ required: { tools: true }, settings: DEFAULT_SETTINGS });
    // Capabilities are unknown (null) for discovered models, so unknown is allowed.
    expect(candidates.length).toBe(2);
    updateModel(alphaId, { enabled: false });
    expect(buildCandidates({ settings: DEFAULT_SETTINGS }).length).toBe(1);
    updateModel(alphaId, { enabled: true });
    clearAllCooldowns();
  });
});

describe('settings persistence', () => {
  it('merges patches without losing defaults', () => {
    const updated = updateSettings({ maxAttempts: 3, fallbackOn: { ...DEFAULT_SETTINGS.fallbackOn, invalidRequest: true } });
    expect(updated.maxAttempts).toBe(3);
    expect(updated.fallbackOn.invalidRequest).toBe(true);
    expect(getSettings().requestTimeoutMs).toBe(DEFAULT_SETTINGS.requestTimeoutMs);
  });
});

describe('anthropic translation', () => {
  it('converts system prompts, tool results and tool calls', () => {
    const converted = toAnthropicMessages([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'read a file' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'hello' },
    ]);
    expect(converted.system).toBe('You are terse.');
    expect(converted.messages[1]!.content).toEqual([expect.objectContaining({ type: 'tool_use', name: 'read_file', input: { path: 'a.txt' } })]);
    expect(converted.messages[2]!.content).toEqual([expect.objectContaining({ type: 'tool_result', tool_use_id: 'call_1' })]);
  });

  it('builds a valid anthropic request with tools and stop sequences', () => {
    const body = buildAnthropicRequest(
      {
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 64,
        stop: '###',
        tools: [{ type: 'function', function: { name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } } }],
        tool_choice: { type: 'function', function: { name: 'ping' } },
      },
      true,
    );
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(64);
    expect(body.stop_sequences).toEqual(['###']);
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'ping' });
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'ping' });
  });
});

describe('skills runtime', () => {
  it('installs built-ins and runs them in a sandbox', async () => {
    ensureBuiltinSkills();
    const summarizer = await runSkill('text-summarizer', {
      text: 'MagmaX routes requests. MagmaX fails over automatically. MagmaX stores keys encrypted. MagmaX shows live monitoring. Summaries keep key sentences.',
      sentences: 2,
    });
    expect(summarizer.status).toBe('success');
    expect((summarizer.output as { summary: string }).summary.length).toBeGreaterThan(10);

    const repaired = await runSkill('json-toolkit', { action: 'repair', json: '{"a":1,}' });
    expect(repaired.status).toBe('success');
    expect(JSON.parse((repaired.output as { result: string }).result)).toEqual({ a: 1 });
  });

  it('surfaces real errors instead of faking success', async () => {
    const result = await runSkill('json-toolkit', { action: 'format', json: 'not json at all' });
    expect(result.status).toBe('error');
    expect(result.error).toBeTruthy();
  });
});
