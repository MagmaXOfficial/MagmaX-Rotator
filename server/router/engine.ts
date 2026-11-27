import { randomToken } from '../crypto.js';
import { getSettings, listKeyCiphers, listModels, listProviders, recordKeyResult, recordModelUsage, resolveAlias, setProviderStatus } from '../db.js';
import { log } from '../logger.js';
import { publish } from '../realtime.js';
import { anthropicChat, anthropicChatStream } from '../providers/anthropic.js';
import { ERROR_LABELS } from '../providers/errors.js';
import { openaiChat, openaiChatStream } from '../providers/openai.js';
import { getProviderDefinition } from '../providers/registry.js';
import { buildTarget } from '../providers/runtime.js';
import { UpstreamError } from '../providers/types.js';
import type { ChatParams, CompletionResult, ProviderTarget, StreamSink } from '../providers/types.js';
import type {
  AttemptRecord,
  ChatMessage,
  ErrorClass,
  ModelRecord,
  ProviderDefinition,
  ProviderRecord,
  RouterSettings,
  ToolCall,
} from '../types.js';
import { getCooldown, isCoolingDown, recordFailure, recordSuccess } from './state.js';

export class RouteError extends Error {
  statusCode: number;
  errorClass: ErrorClass;
  attempts: AttemptRecord[];
  candidates: number;

  constructor(message: string, opts: { statusCode?: number; errorClass?: ErrorClass; attempts?: AttemptRecord[]; candidates?: number } = {}) {
    super(message);
    this.name = 'RouteError';
    this.statusCode = opts.statusCode ?? 502;
    this.errorClass = opts.errorClass ?? 'unknown';
    this.attempts = opts.attempts ?? [];
    this.candidates = opts.candidates ?? 0;
  }
}

export interface Candidate {
  model: ModelRecord;
  provider: ProviderRecord;
  definition: ProviderDefinition;
  score: number;
  reason: string;
}

export interface BuildCandidatesOptions {
  requestedModel?: string | null;
  pinnedModelRowId?: string | null;
  required?: { tools?: boolean; vision?: boolean };
  settings?: RouterSettings;
}

const normalizeModelName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[\s:./@]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

function matchesRequested(modelId: string, requested: string): boolean {
  const a = normalizeModelName(modelId);
  const b = normalizeModelName(requested);
  if (!b) return false;
  return a === b || a.endsWith(`-${b}`) || b.endsWith(`-${a}`);
}

/** Builds the ordered candidate list for the current settings — pure, no network calls. */
export function buildCandidates(opts: BuildCandidatesOptions = {}): Candidate[] {
  const settings = opts.settings ?? getSettings();
  const providers = listProviders().filter((p) => p.active);
  const defs = new Map<string, ProviderDefinition>();
  const providerById = new Map<string, ProviderRecord>();
  const ready = new Set<string>();

  for (const provider of providers) {
    const definition = getProviderDefinition(provider.providerId);
    if (!definition) continue;
    defs.set(provider.id, definition);
    providerById.set(provider.id, provider);
    if (definition.keyless || listKeyCiphers(provider.id).length > 0) ready.add(provider.id);
  }

  const excluded = new Set(settings.excludedModels.map((m) => m.trim().toLowerCase()).filter(Boolean));
  let candidates: Candidate[] = [];

  for (const model of listModels({ enabledOnly: true })) {
    const provider = providerById.get(model.providerRowId);
    const definition = defs.get(model.providerRowId);
    if (!provider || !definition) continue;
    if (!ready.has(provider.id)) continue;
    if (excluded.has(model.modelId.toLowerCase()) || excluded.has(model.id.toLowerCase())) continue;
    if (isCoolingDown(model.providerRowId, model.id)) continue;
    if (opts.required?.tools && model.capabilities.tools === false) continue;
    if (opts.required?.vision && model.capabilities.vision === false) continue;

    const isLocalOrFree = model.tier === 'free' || model.tier === 'local' || definition.tier === 'local' || definition.tier === 'free';
    if (settings.profile === 'free_local' && !isLocalOrFree) continue;
    if (settings.profile === 'vision' && model.capabilities.vision === false) continue;

    candidates.push({ model, provider, definition, score: 0, reason: '' });
  }

  // Requested-model preference: an exact model id or a configured alias pins the head of the chain.
  const requested = opts.requestedModel?.trim() || null;
  let preferred: Candidate[] = [];
  let preferredReason = '';
  if (opts.pinnedModelRowId) {
    preferred = candidates.filter((c) => c.model.id === opts.pinnedModelRowId);
    preferredReason = 'manually selected model';
  } else if (requested) {
    const alias = resolveAlias(requested);
    if (alias?.modelId) {
      preferred = candidates.filter(
        (c) => (!alias.providerRowId || c.provider.id === alias.providerRowId) && matchesRequested(c.model.modelId, alias.modelId!),
      );
      preferredReason = `alias "${requested}"`;
    }
    if (!preferred.length) {
      preferred = candidates.filter((c) => matchesRequested(c.model.modelId, requested));
      preferredReason = `requested model "${requested}"`;
    }
  }

  if (settings.routingMode === 'manual') {
    const pinned = preferred.length ? preferred : candidates.filter((c) => c.model.id === (settings.manualModelId ?? '') || matchesRequested(c.model.modelId, settings.manualModelId ?? ''));
    candidates = pinned.length ? pinned : [];
  }

  const latencyOf = (c: Candidate): number | null => c.model.latencyMs ?? c.provider.latencyMs ?? null;
  const costOf = (c: Candidate): number | null => {
    const input = c.model.inputPrice;
    const output = c.model.outputPrice;
    if (input === null && output === null) return null;
    return (input ?? 0) + (output ?? 0);
  };

  for (const candidate of candidates) {
    const priority = candidate.model.priority + candidate.provider.priority * 0.5;
    const latency = latencyOf(candidate);
    const cost = costOf(candidate);
    let score = priority;
    let reason = `priority ${candidate.model.priority}`;

    if (preferred.includes(candidate)) {
      score -= 100_000;
      reason = preferredReason;
    } else if (settings.routingMode === 'fastest') {
      score = latency === null ? 50_000 + priority : latency + priority * 0.01;
      reason = latency === null ? 'no latency sample yet' : `${Math.round(latency)}ms measured latency`;
    } else if (settings.routingMode === 'cheapest') {
      score = cost === null ? 1_000_000 + priority : cost * 1000 + priority * 0.01;
      reason = cost === null ? 'price unknown' : `$${cost.toFixed(2)} per 1M tokens (in+out)`;
    } else if (settings.routingMode === 'smart') {
      let smart = priority;
      if (candidate.model.capabilities.tools) smart -= 8;
      if (candidate.model.capabilities.reasoning) smart -= 4;
      if (latency !== null) smart += Math.min(latency, 30_000) / 1000;
      if (cost !== null) smart += Math.min(cost, 100) * 0.15;
      if (candidate.model.favorite) smart -= 6;
      score = smart;
      reason = 'smart score (capabilities, latency, price, priority)';
    } else {
      score = priority;
    }

    if (settings.profile === 'coding' && candidate.model.capabilities.tools) {
      score -= 3;
      reason += ' · coding profile (tool calling)';
    }
    if (settings.profile === 'reasoning' && candidate.model.capabilities.reasoning) {
      score -= 3;
      reason += ' · reasoning model';
    }
    if (settings.profile === 'fast' && latency !== null) {
      score += latency / 1000;
      reason += ` · ${Math.round(latency)}ms`;
    }
    if (settings.profile === 'long_context') {
      const ctx = candidate.model.contextWindow;
      score += ctx === null ? 12 : Math.max(0, 200_000 - ctx) / 20_000;
      reason += ctx === null ? ' · context unknown' : ` · ${ctx.toLocaleString()} ctx`;
    }
    if (settings.profile === 'vision' && candidate.model.capabilities.vision) score -= 5;

    candidate.score = score;
    candidate.reason = reason;
  }

  candidates.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.provider.priority !== b.provider.priority) return a.provider.priority - b.provider.priority;
    if (a.model.priority !== b.model.priority) return a.model.priority - b.model.priority;
    return a.model.modelId.localeCompare(b.model.modelId);
  });

  return candidates;
}

export function explainSelection(candidates: Candidate[], settings: RouterSettings): string {
  const top = candidates[0];
  if (!top) return 'No eligible model — add a provider key or enable models.';
  return `${settings.routingMode} mode · ${settings.profile} profile · chose ${top.model.modelId} via ${top.provider.label} (${top.reason})`;
}

function shouldFallback(error: UpstreamError, settings: RouterSettings): boolean {
  const f = settings.fallbackOn;
  switch (error.errorClass) {
    case 'cancelled':
      return false;
    case 'rate_limit':
      return f.rateLimit;
    case 'auth':
    case 'quota':
      return f.auth;
    case 'timeout':
      return f.timeout;
    case 'network':
      return f.network;
    case 'server':
      return f.serverError;
    case 'model_unavailable':
      return f.modelUnavailable;
    case 'invalid_request':
      return f.invalidRequest;
    case 'context_length':
      return f.contextLength;
    case 'content_filter':
      return f.contentFilter;
    default:
      return true;
  }
}

function normalizeError(err: unknown, externalSignal?: AbortSignal): UpstreamError {
  if (err instanceof UpstreamError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    if (externalSignal?.aborted) return new UpstreamError('cancelled', 'Client cancelled the request', { retryable: false });
    return new UpstreamError('timeout', 'Request exceeded the configured timeout', { retryable: true });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new UpstreamError('network', message, { retryable: true });
}

export function estimateCost(model: ModelRecord, usage: { prompt_tokens?: number; completion_tokens?: number }): number | null {
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (input === undefined && output === undefined) return null;
  if (model.inputPrice === null && model.outputPrice === null) return null;
  const cost =
    ((input ?? 0) / 1_000_000) * (model.inputPrice ?? 0) + ((output ?? 0) / 1_000_000) * (model.outputPrice ?? 0);
  return Math.round(cost * 1e6) / 1e6;
}

export interface ExecuteOptions {
  messages: ChatMessage[];
  requestedModel?: string | null;
  pinnedModelRowId?: string | null;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  response_format?: unknown;
  extra?: Record<string, unknown>;
  stream: boolean;
  sink?: StreamSink;
  signal?: AbortSignal;
  endpoint: string;
  client?: string | null;
  required?: { tools?: boolean; vision?: boolean };
  settings?: RouterSettings;
  candidates?: Candidate[];
  requestId?: string;
  /** Injection point used by diagnostics/tests to supply local targets. */
  resolveTarget?: (providerRowId: string) => ProviderTarget | null;
}

export interface ExecuteResult {
  requestId: string;
  model: ModelRecord;
  provider: ProviderRecord;
  definition: ProviderDefinition;
  result: CompletionResult;
  attempts: AttemptRecord[];
  latencyMs: number;
  ttfbMs: number;
  fallbackCount: number;
  candidates: Candidate[];
  routingMode: string;
  profile: string;
  explain: string;
  keyHint: string | null;
  continuations: number;
}

export async function executeRoute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const settings = opts.settings ?? getSettings();
  const candidates = opts.candidates ?? buildCandidates({ requestedModel: opts.requestedModel, pinnedModelRowId: opts.pinnedModelRowId, required: opts.required, settings });
  const requestId = opts.requestId ?? `req_${randomToken(9)}`;
  const attempts: AttemptRecord[] = [];
  const triedKeyIds = new Set<string>();
  const startedAt = Date.now();
  let emitted = 0;
  let ttfbMs = 0;

  if (!candidates.length) {
    throw new RouteError(
      'No eligible model. Connect a provider, sync its models and enable at least one model (Router → priority chain).',
      { statusCode: 503, errorClass: 'model_unavailable', attempts: [], candidates: 0 },
    );
  }

  const sink: StreamSink = {
    onText: (delta) => {
      if (!emitted) ttfbMs = Date.now() - startedAt;
      emitted++;
      opts.sink?.onText?.(delta);
    },
    onReasoning: (delta) => {
      if (!emitted) ttfbMs = Date.now() - startedAt;
      emitted++;
      opts.sink?.onReasoning?.(delta);
    },
    onToolStart: (index, id, name) => {
      if (!emitted) ttfbMs = Date.now() - startedAt;
      emitted++;
      opts.sink?.onToolStart?.(index, id, name);
    },
    onToolArgs: (index, args) => {
      if (!emitted) ttfbMs = Date.now() - startedAt;
      emitted++;
      opts.sink?.onToolArgs?.(index, args);
    },
    onUsage: (usage) => opts.sink?.onUsage?.(usage),
  };

  publish('route_started', { requestId, endpoint: opts.endpoint, candidates: candidates.length, mode: settings.routingMode, profile: settings.profile });

  const callProvider = async (
    target: ProviderTarget,
    candidate: Candidate,
    messages: ChatMessage[],
    activeSink: StreamSink,
  ): Promise<CompletionResult> => {
    const params: ChatParams = {
      model: candidate.model.modelId,
      messages,
      temperature: opts.temperature,
      top_p: opts.top_p,
      max_tokens: opts.max_tokens,
      stop: opts.stop,
      tools: opts.tools,
      tool_choice: opts.tool_choice,
      response_format: opts.response_format,
      extra: opts.extra,
    };
    const isAnthropic = candidate.definition.protocol === 'anthropic';
    if (opts.stream) {
      return isAnthropic
        ? anthropicChatStream(target, params, settings.requestTimeoutMs, activeSink, opts.signal)
        : openaiChatStream(target, params, settings.requestTimeoutMs, activeSink, opts.signal);
    }
    return isAnthropic ? anthropicChat(target, params, settings.requestTimeoutMs, opts.signal) : openaiChat(target, params, settings.requestTimeoutMs, opts.signal);
  };

  const runAttempt = (target: ProviderTarget, candidate: Candidate): Promise<CompletionResult> =>
    callProvider(target, candidate, opts.messages, sink);

  let lastError: UpstreamError | null = null;

  for (const candidate of candidates) {
    if (attempts.length >= Math.max(1, settings.maxAttempts)) break;
    let keyRotations = 0;

    while (keyRotations < 2) {
      if (attempts.length >= Math.max(1, settings.maxAttempts)) break;
      const target = opts.resolveTarget ? opts.resolveTarget(candidate.provider.id) : buildTarget(candidate.provider.id, { excludeKeyIds: triedKeyIds });
      if (!target) {
        if (keyRotations === 0) {
          attempts.push({
            providerRowId: candidate.provider.id,
            providerName: candidate.provider.label,
            modelId: candidate.model.modelId,
            startedAt: Date.now(),
            latencyMs: 0,
            outcome: 'error',
            errorClass: 'auth',
            message: 'No usable API key for this provider',
          });
        }
        break;
      }
      opts.sink?.onStart?.({ modelId: candidate.model.modelId, provider: candidate.provider.label, providerRowId: candidate.provider.id });
      const attemptStart = Date.now();
      try {
        const result = await runAttempt(target, candidate);
        const latencyMs = Date.now() - attemptStart;
        attempts.push({
          providerRowId: candidate.provider.id,
          providerName: candidate.provider.label,
          modelId: candidate.model.modelId,
          keyHint: target.keyHint ?? undefined,
          startedAt: attemptStart,
          latencyMs,
          outcome: 'success',
        });
        recordSuccess(candidate.provider.id, candidate.model.id);
        recordModelUsage(candidate.provider.id, candidate.model.modelId, latencyMs);
        if (target.keyId) recordKeyResult(target.keyId, true);
        if (candidate.provider.status !== 'connected') setProviderStatus(candidate.provider.id, 'connected', null, latencyMs);

        let combined = result;
        let continuations = 0;
        if (
          !opts.stream &&
          combined.finishReason === 'length' &&
          settings.continuationEnabled &&
          combined.content.trim() &&
          !combined.toolCalls.length
        ) {
          while (continuations < Math.max(0, settings.maxContinuations)) {
            continuations++;
            const followUpMessages: ChatMessage[] = [
              ...opts.messages,
              { role: 'assistant', content: combined.content },
              { role: 'user', content: 'Continue exactly where you stopped. Do not repeat any text you already wrote.' },
            ];
            try {
              const more = await callProvider(target, candidate, followUpMessages, {});
              if (!more.content.trim()) break;
              combined = {
                content: combined.content + more.content,
                reasoning: combined.reasoning,
                toolCalls: more.toolCalls.length ? more.toolCalls : combined.toolCalls,
                finishReason: more.finishReason,
                usage: {
                  prompt_tokens: (combined.usage.prompt_tokens ?? 0) + (more.usage.prompt_tokens ?? 0) || undefined,
                  completion_tokens: (combined.usage.completion_tokens ?? 0) + (more.usage.completion_tokens ?? 0) || undefined,
                  total_tokens: (combined.usage.total_tokens ?? 0) + (more.usage.total_tokens ?? 0) || undefined,
                },
              };
              publish('route_continued', { requestId, model: candidate.model.modelId, continuation: continuations });
              if (more.finishReason !== 'length' || more.toolCalls.length) break;
            } catch {
              break;
            }
          }
        }

        const totalLatency = Date.now() - attemptStart;
        const fallbackCount = attempts.filter((a) => a.outcome === 'error').length;
        publish('route_success', {
          requestId,
          provider: candidate.provider.label,
          model: candidate.model.modelId,
          latencyMs: totalLatency,
          attempts: attempts.length,
          fallbacks: fallbackCount,
        });
        log.info('route.success', { requestId, provider: candidate.provider.label, model: candidate.model.modelId, attempts: attempts.length, latencyMs: totalLatency });
        return {
          requestId,
          model: candidate.model,
          provider: candidate.provider,
          definition: candidate.definition,
          result: combined,
          attempts,
          latencyMs: totalLatency,
          ttfbMs: ttfbMs || totalLatency,
          fallbackCount,
          candidates,
          routingMode: settings.routingMode,
          profile: settings.profile,
          explain: explainSelection(candidates, settings),
          keyHint: target.keyHint,
          continuations,
        };
      } catch (err) {
        const error = normalizeError(err, opts.signal);
        lastError = error;
        const latencyMs = Date.now() - attemptStart;
        attempts.push({
          providerRowId: candidate.provider.id,
          providerName: candidate.provider.label,
          modelId: candidate.model.modelId,
          keyHint: target.keyHint ?? undefined,
          startedAt: attemptStart,
          latencyMs,
          outcome: 'error',
          errorClass: error.errorClass,
          statusCode: error.statusCode,
          message: error.message.slice(0, 400),
        });
        if (target.keyId) {
          recordKeyResult(target.keyId, false, `${ERROR_LABELS[error.errorClass]}: ${error.message.slice(0, 200)}`);
          triedKeyIds.add(target.keyId);
        }
        const cooldown = recordFailure(
          candidate.provider.id,
          candidate.model.id,
          candidate.model.modelId,
          error.errorClass,
          error.message.slice(0, 300),
          settings,
          error.retryAfterMs,
        );
        if (error.errorClass === 'auth' || error.errorClass === 'quota') {
          setProviderStatus(candidate.provider.id, 'error', `${ERROR_LABELS[error.errorClass]}: ${error.message.slice(0, 180)}`);
        }
        publish('route_attempt_failed', {
          requestId,
          provider: candidate.provider.label,
          model: candidate.model.modelId,
          errorClass: error.errorClass,
          status: error.statusCode ?? null,
          message: error.message.slice(0, 300),
          cooldownUntil: cooldown.until,
        });
        log.warn('route.attempt_failed', { requestId, provider: candidate.provider.label, model: candidate.model.modelId, errorClass: error.errorClass, status: error.statusCode, message: error.message.slice(0, 200) });

        if (error.errorClass === 'cancelled') {
          throw new RouteError('Request cancelled by the client.', { statusCode: 499, errorClass: 'cancelled', attempts, candidates: candidates.length });
        }
        if (emitted > 0) {
          throw new RouteError(
            `The response stream failed after output started (${ERROR_LABELS[error.errorClass]}). MagmaX does not switch models mid-stream to avoid duplicated or truncated output.`,
            { statusCode: 502, errorClass: error.errorClass, attempts, candidates: candidates.length },
          );
        }
        if (!shouldFallback(error, settings)) {
          const status = error.errorClass === 'invalid_request' || error.errorClass === 'context_length' || error.errorClass === 'content_filter' ? 400 : 502;
          throw new RouteError(`${ERROR_LABELS[error.errorClass]}: ${error.message}`, { statusCode: status, errorClass: error.errorClass, attempts, candidates: candidates.length });
        }
        if (error.credentialProblem && keyRotations === 0) {
          keyRotations++;
          continue;
        }
        break;
      }
    }
  }

  const summary = attempts
    .slice(-4)
    .map((a) => `${a.providerName}/${a.modelId}: ${ERROR_LABELS[(a.errorClass ?? 'unknown') as ErrorClass]}`)
    .join('; ');
  const cooldownsActive = candidates.length - buildCandidates({ requestedModel: opts.requestedModel, required: opts.required, settings }).length;
  throw new RouteError(
    `All ${attempts.length} attempt(s) failed${summary ? ` — ${summary}` : ''}.${cooldownsActive > 0 ? ` ${cooldownsActive} model(s) are cooling down.` : ''} Check Providers → test, and Router → cooldowns.`,
    {
      statusCode: lastError?.errorClass === 'rate_limit' ? 429 : 502,
      errorClass: lastError?.errorClass ?? 'unknown',
      attempts,
      candidates: candidates.length,
    },
  );
}

/** Summary used by the dashboard/router tab to show the current chain without secrets. */
export function describeChain(settings?: RouterSettings): Array<Record<string, unknown>> {
  const s = settings ?? getSettings();
  const candidates = buildCandidates({ settings: s });
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const c of candidates) {
    const key = `${c.provider.id}`;
    const cooldown = getCooldown(c.provider.id, c.model.id);
    out.push({
      id: c.model.id,
      providerId: c.provider.id,
      provider: c.provider.label,
      providerKind: c.provider.providerId,
      model: c.model.modelId,
      priority: c.model.priority,
      providerPriority: c.provider.priority,
      price: { input: c.model.inputPrice, output: c.model.outputPrice },
      contextWindow: c.model.contextWindow,
      latencyMs: c.model.latencyMs,
      capabilities: c.model.capabilities,
      reason: c.reason,
      cooldownUntil: cooldown?.until ?? null,
      sameProviderAsPrevious: seen.has(key) ? true : (seen.add(key), false),
    });
  }
  return out;
}
