import { log } from '../logger.js';
import type { ModelCapabilities } from '../types.js';
import { assertOk, joinUrl, readJson, requestUpstream } from './http.js';
import { authHeadersFor } from './http.js';
import { UpstreamError } from './types.js';
import type { DiscoveredModel, DiscoveryResult, ProviderTarget } from './types.js';

/** Model id patterns that are not chat-completion models. */
const NON_CHAT = /(embed|embedding|whisper|tts|dall-e|moderation|rerank|bge-|clip-|stable-diffusion|flux|guard|stt|audio|transcribe|image-generation|vision-encoder|detector)/i;

export function looksLikeChatModel(id: string): boolean {
  return !NON_CHAT.test(id);
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function perMillion(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // OpenAI-compatible catalogs report USD per token; some report per million.
  return n > 0 && n < 0.01 ? n * 1_000_000 : n;
}

function tierFor(target: ProviderTarget, id: string): DiscoveredModel['tier'] {
  if (target.definition.tier === 'local') return 'local';
  if (id.endsWith(':free')) return 'free';
  if (target.definition.tier === 'limited') return 'limited';
  return target.definition.tier === 'unknown' ? 'unknown' : 'paid';
}

interface OpenAiListResponse {
  data?: Array<Record<string, unknown>>;
  models?: Array<Record<string, unknown>>;
  result?: Array<Record<string, unknown>>;
}

/** Reads real model metadata from the provider. Unknown fields stay null — never invented. */
export async function discoverModels(target: ProviderTarget, timeoutMs = 25_000): Promise<DiscoveryResult> {
  const started = Date.now();
  const def = target.definition;

  if (def.listStyle === 'anthropic') {
    const models = await listAnthropicModels(target, timeoutMs);
    return { models, latencyMs: Date.now() - started };
  }
  if (def.listStyle === 'gemini') {
    const models = await listGeminiModels(target, timeoutMs);
    return { models, latencyMs: Date.now() - started };
  }
  if (def.listStyle === 'cloudflare') {
    const models = await listCloudflareModels(target, timeoutMs);
    return { models, latencyMs: Date.now() - started };
  }
  if (!def.modelsUrl && !target.baseUrl) {
    throw new UpstreamError('invalid_request', 'No base URL configured for this provider', { retryable: false });
  }
  const listUrl = def.modelsUrl ? joinUrl(target.baseUrl, def.modelsUrl) : joinUrl(target.baseUrl, '/models');
  const res = await requestUpstream(listUrl, { method: 'GET', headers: authHeadersFor(target) }, timeoutMs);
  await assertOk(res);
  const data = await readJson<OpenAiListResponse>(res);
  const list = data.data ?? data.models ?? data.result ?? [];
  const models: DiscoveredModel[] = [];
  for (const raw of list) {
    const id = String(raw.id ?? raw.name ?? raw.model ?? '');
    if (!id) continue;
    if (def.tier !== 'unknown' && !looksLikeChatModel(id)) continue;
    if (def.tier === 'unknown' && !looksLikeChatModel(id)) continue;
    const caps: Partial<ModelCapabilities> = {};
    const supported = raw.supported_parameters;
    if (Array.isArray(supported)) {
      caps.tools = supported.includes('tools') || supported.includes('tool_choice');
      caps.streaming = supported.includes('stream');
      caps.reasoning = supported.includes('reasoning') || supported.includes('include_reasoning');
    }
    const architecture = raw.architecture as { input_modalities?: string[]; modality?: string } | undefined;
    if (architecture) {
      const modalities = architecture.input_modalities ?? (architecture.modality ? architecture.modality.split('->')[0]!.split('+') : []);
      caps.vision = modalities.includes('image') || modalities.includes('vision');
    }
    const pricing = raw.pricing as Record<string, unknown> | undefined;
    models.push({
      modelId: id,
      displayName: String(raw.name ?? raw.display_name ?? id),
      contextWindow: num(raw.context_length ?? raw.context_window ?? raw.max_context_length ?? raw.max_model_len ?? raw.max_input_tokens),
      maxOutput: num(raw.max_output_tokens ?? raw.max_completion_tokens ?? raw.max_tokens),
      inputPrice: pricing ? perMillion(pricing.prompt ?? pricing.input) : num(raw.input_price_per_million ?? raw.prompt_price),
      outputPrice: pricing ? perMillion(pricing.completion ?? pricing.output) : num(raw.output_price_per_million ?? raw.completion_price),
      tier: tierFor(target, id),
      capabilities: caps,
    });
  }
  if (!models.length) {
    log.warn('discovery.empty', { provider: target.provider.label, url: listUrl });
  }
  return { models, latencyMs: Date.now() - started };
}

async function listAnthropicModels(target: ProviderTarget, timeoutMs: number): Promise<DiscoveredModel[]> {
  const out: DiscoveredModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < 6; page++) {
    const url = `${joinUrl(target.baseUrl, '/models')}?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const res = await requestUpstream(url, { method: 'GET', headers: authHeadersFor(target) }, timeoutMs);
    await assertOk(res);
    const data = await readJson<{ data?: Array<{ id?: string; display_name?: string; created_at?: string }>; has_more?: boolean; last_id?: string }>(res);
    for (const m of data.data ?? []) {
      if (!m.id) continue;
      out.push({
        modelId: m.id,
        displayName: m.display_name || m.id,
        contextWindow: null,
        maxOutput: null,
        inputPrice: null,
        outputPrice: null,
        tier: tierFor(target, m.id),
        capabilities: { tools: true, streaming: true },
      });
    }
    if (!data.has_more || !data.last_id) break;
    after = data.last_id;
  }
  return out;
}

async function listGeminiModels(target: ProviderTarget, timeoutMs: number): Promise<DiscoveredModel[]> {
  const out: DiscoveredModel[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await requestUpstream(url, { method: 'GET', headers: authHeadersFor(target) }, timeoutMs);
    await assertOk(res);
    const data = await readJson<{
      models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }>;
      nextPageToken?: string;
    }>(res);
    for (const m of data.models ?? []) {
      const methods = m.supportedGenerationMethods ?? [];
      if (!methods.includes('generateContent')) continue;
      const id = (m.name ?? '').replace(/^models\//, '');
      if (!id) continue;
      out.push({
        modelId: id,
        displayName: m.displayName || id,
        contextWindow: m.inputTokenLimit ?? null,
        maxOutput: m.outputTokenLimit ?? null,
        inputPrice: null,
        outputPrice: null,
        tier: tierFor(target, id),
        capabilities: { streaming: methods.includes('streamGenerateContent') },
      });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

async function listCloudflareModels(target: ProviderTarget, timeoutMs: number): Promise<DiscoveredModel[]> {
  const accountId = target.accountId;
  if (!accountId) throw new UpstreamError('invalid_request', 'Cloudflare requires an Account ID', { retryable: false });
  const out: DiscoveredModel[] = [];
  for (let page = 1; page <= 5; page++) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?per_page=100&page=${page}`;
    const res = await requestUpstream(url, { method: 'GET', headers: authHeadersFor(target) }, timeoutMs);
    await assertOk(res);
    const data = await readJson<{ result?: Array<{ name?: string; description?: string }>; result_info?: { total_pages?: number } }>(res);
    for (const m of data.result ?? []) {
      if (!m.name) continue;
      if (!looksLikeChatModel(m.name)) continue;
      out.push({
        modelId: m.name,
        displayName: m.name,
        contextWindow: null,
        maxOutput: null,
        inputPrice: null,
        outputPrice: null,
        tier: tierFor(target, m.name),
        capabilities: {},
      });
    }
    if (!data.result_info?.total_pages || page >= data.result_info.total_pages) break;
  }
  return out;
}
