import { finalizeRequest, getSettings, insertRequest } from '../db.js';
import type { AttemptRecord, ChatMessage, ModelRecord, RequestRecord, RouterSettings, Usage } from '../types.js';
import { estimateCost } from './engine.js';

export interface RecordInput {
  endpoint: string;
  requestedModel: string | null;
  stream: boolean;
  client: string | null;
  settings: RouterSettings;
  messages?: ChatMessage[];
  body?: unknown;
}

export function createRecord(input: RecordInput): RequestRecord {
  const settings = input.settings;
  const prompt = settings.storePayloads && input.body ? safeSample(input.body) : null;
  const rec: RequestRecord = {
    id: `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    endpoint: input.endpoint,
    requestedModel: input.requestedModel,
    routingMode: settings.routingMode,
    profile: settings.profile,
    status: input.stream ? 'streaming' : 'success',
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
    stream: input.stream,
    client: input.client,
    promptSample: prompt,
    responseSample: null,
  };
  insertRequest(rec);
  return rec;
}

export interface RecordOutcome {
  status: RequestRecord['status'];
  statusCode: number;
  providerRowId?: string | null;
  providerName?: string | null;
  modelId?: string | null;
  model?: ModelRecord | null;
  attempts: AttemptRecord[];
  latencyMs: number;
  ttfbMs?: number | null;
  usage?: Usage;
  errorCode?: string | null;
  errorMessage?: string | null;
  content?: string;
}

export function finishRecord(rec: RequestRecord, outcome: RecordOutcome): RequestRecord {
  const settings = getSettings();
  const usage = outcome.usage ?? {};
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
  const updated: RequestRecord = {
    ...rec,
    status: outcome.status,
    statusCode: outcome.statusCode,
    providerRowId: outcome.providerRowId ?? null,
    providerName: outcome.providerName ?? null,
    modelId: outcome.modelId ?? null,
    attempts: outcome.attempts,
    latencyMs: outcome.latencyMs,
    ttfbMs: outcome.ttfbMs ?? null,
    inputTokens,
    outputTokens,
    costUsd: outcome.model ? estimateCost(outcome.model, usage) : null,
    fallbackCount: outcome.attempts.filter((a) => a.outcome === 'error').length,
    errorCode: outcome.errorCode ?? null,
    errorMessage: outcome.errorMessage ?? null,
    responseSample: settings.storePayloads && outcome.content ? safeSample(outcome.content) : null,
  };
  finalizeRequest(updated);
  return updated;
}

export function safeSample(value: unknown, limit = 4000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
