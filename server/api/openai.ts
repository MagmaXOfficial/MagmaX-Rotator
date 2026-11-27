import { Hono } from 'hono';
import { z } from 'zod';
import { getSettings, listAliases, listModels, listProviders } from '../db.js';
import { clientLabel, HttpError, openAiError, readJsonBody } from '../http-utils.js';
import type { Context } from 'hono';
import type { ChatMessage, ToolCall } from '../types.js';
import { RouteError, executeRoute } from '../router/engine.js';
import { createRecord, finishRecord } from '../router/recording.js';
import type { CompletionResult } from '../providers/types.js';

export const openaiApi = new Hono();

const contentSchema = z.union([z.string(), z.array(z.record(z.unknown())), z.null()]);

const messageSchema = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: contentSchema.optional(),
    name: z.string().optional(),
    tool_calls: z.array(z.record(z.unknown())).optional(),
    tool_call_id: z.string().optional(),
  })
  .passthrough();

const chatSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(messageSchema).min(1, 'messages must contain at least one message'),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    tools: z.array(z.record(z.unknown())).optional(),
    tool_choice: z.unknown().optional(),
    response_format: z.unknown().optional(),
    seed: z.number().optional(),
  })
  .passthrough();

const KNOWN_KEYS = new Set([
  'model',
  'messages',
  'stream',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'tools',
  'tool_choice',
  'response_format',
  'seed',
  'stream_options',
  'user',
]);

function toMessages(raw: z.infer<typeof messageSchema>[]): ChatMessage[] {
  return raw.map((m) => ({
    role: (m.role === 'developer' ? 'system' : m.role) as ChatMessage['role'],
    content: (m.content ?? null) as ChatMessage['content'],
    name: m.name,
    tool_calls: m.tool_calls as ToolCall[] | undefined,
    tool_call_id: m.tool_call_id,
  }));
}

function hasImage(messages: ChatMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => (p as { type?: string }).type === 'image_url'));
}

function normalizeFinish(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'tool_calls') return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

function routeHeaders(outcome: { requestId: string; provider: { label: string }; model: { modelId: string }; attempts: unknown[]; fallbackCount: number; routingMode: string }): Record<string, string> {
  return {
    'X-MagMax-Request-Id': outcome.requestId,
    'X-MagMax-Provider': encodeURIComponent(outcome.provider.label),
    'X-MagMax-Model': encodeURIComponent(outcome.model.modelId),
    'X-MagMax-Attempts': String(outcome.attempts.length),
    'X-MagMax-Fallbacks': String(outcome.fallbackCount),
    'X-MagMax-Mode': outcome.routingMode,
  };
}

function magmaxMeta(outcome: {
  requestId: string;
  provider: { label: string; providerId: string };
  model: { modelId: string };
  routingMode: string;
  profile: string;
  explain: string;
  attempts: Array<{ providerName: string; modelId: string; outcome: string; latencyMs: number; errorClass?: string }>;
  latencyMs: number;
  fallbackCount: number;
}) {
  return {
    requestId: outcome.requestId,
    provider: outcome.provider.label,
    providerId: outcome.provider.providerId,
    model: outcome.model.modelId,
    routingMode: outcome.routingMode,
    profile: outcome.profile,
    fallbackCount: outcome.fallbackCount,
    latencyMs: outcome.latencyMs,
    explain: outcome.explain,
    attempts: outcome.attempts.map((a) => ({
      provider: a.providerName,
      model: a.modelId,
      outcome: a.outcome,
      latencyMs: a.latencyMs,
      errorClass: a.errorClass ?? null,
    })),
  };
}

/** Client-safe model catalogue. Never includes credentials. */
openaiApi.get('/v1/models', (c) => {
  const all = c.req.query('all') === '1';
  const providers = new Map(listProviders().map((p) => [p.id, p]));
  const data = listModels()
    .filter((m) => all || m.enabled)
    .filter((m) => providers.has(m.providerRowId))
    .map((m) => ({
      id: m.modelId,
      object: 'model',
      created: Math.floor(m.addedAt / 1000),
      owned_by: providers.get(m.providerRowId)?.label ?? 'unknown',
      context_length: m.contextWindow,
      max_output_tokens: m.maxOutput,
      pricing: m.inputPrice === null && m.outputPrice === null ? null : { input_per_million: m.inputPrice, output_per_million: m.outputPrice },
      capabilities: m.capabilities,
      tier: m.tier,
      enabled: m.enabled,
      magmax: { providerRowId: m.providerRowId, providerKind: providers.get(m.providerRowId)?.providerId ?? null, favorite: m.favorite, priority: m.priority },
    }));
  const aliases = listAliases()
    .filter((a) => a.modelId)
    .map((a) => ({ id: a.alias, object: 'model', created: Math.floor(a.createdAt / 1000), owned_by: 'magmax-alias', magmax: { aliasFor: a.modelId } }));
  return c.json({ object: 'list', data: [...data, ...aliases] });
});

openaiApi.post('/v1/chat/completions', async (c) => {
  let parsed: z.infer<typeof chatSchema>;
  try {
    parsed = chatSchema.parse(await readJsonBody(c));
  } catch (err) {
    if (err instanceof HttpError) return openAiError(c, err.status, err.message, err.code);
    if (err instanceof z.ZodError) return openAiError(c, 400, err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'invalid_request');
    throw err;
  }

  const settings = getSettings();
  const messages = toMessages(parsed.messages);
  const stream = parsed.stream === true;
  const requestedModel = parsed.model && parsed.model !== 'auto' ? parsed.model : null;
  const record = createRecord({
    endpoint: '/v1/chat/completions',
    requestedModel,
    stream,
    client: clientLabel(c),
    settings,
    messages,
    body: parsed,
  });
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!KNOWN_KEYS.has(key) && value !== undefined) extra[key] = value;
  }
  const common = {
    messages,
    requestedModel,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    max_tokens: parsed.max_completion_tokens ?? parsed.max_tokens,
    stop: parsed.stop,
    tools: parsed.tools,
    tool_choice: parsed.tool_choice,
    response_format: parsed.response_format,
    extra,
    required: { tools: !!parsed.tools?.length, vision: hasImage(messages) },
    settings,
    endpoint: '/v1/chat/completions',
    client: clientLabel(c),
    requestId: record.id,
    signal: c.req.raw.signal,
  } as const;

  if (!stream) {
    try {
      const outcome = await executeRoute({ ...common, stream: false });
      const finishRecorded = finishRecord(record, {
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
      void finishRecorded;
      const usage = outcome.result.usage;
      const hasUsage = usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined;
      for (const [k, v] of Object.entries(routeHeaders(outcome))) c.header(k, v);
      return c.json({
        id: `chatcmpl-${outcome.requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: outcome.model.modelId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: outcome.result.content || null,
              ...(outcome.result.toolCalls.length ? { tool_calls: outcome.result.toolCalls } : {}),
            },
            finish_reason: normalizeFinish(outcome.result.finishReason),
            logprobs: null,
          },
        ],
        ...(hasUsage
          ? {
              usage: {
                prompt_tokens: usage.prompt_tokens ?? 0,
                completion_tokens: usage.completion_tokens ?? 0,
                total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
              },
            }
          : {}),
        magmax: magmaxMeta(outcome),
      });
    } catch (err) {
      return handleRouteFailure(c, record, err);
    }
  }

  // Streaming: never switch models after the first byte reaches the client.
  const encoder = new TextEncoder();
  const completionId = `chatcmpl-${record.id}`;
  const created = Math.floor(Date.now() / 1000);
  let closed = false;
  let sentRole = false;
  const startedAt = Date.now();
  let streamModel = requestedModel ?? 'magmax-router';

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const emitRaw = (line: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        } catch {
          closed = true;
        }
      };
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: streamModel,
        choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      });
      const ensureRole = () => {
        if (sentRole) return;
        sentRole = true;
        emit({ id: completionId, object: 'chat.completion.chunk', created, model: streamModel, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      };

      void (async () => {
        try {
          const outcome = await executeRoute({
            ...common,
            stream: true,
            sink: {
              onStart: (info) => {
                streamModel = info.modelId;
              },
              onText: (delta) => {
                ensureRole();
                emit(chunk({ content: delta }));
              },
              onToolStart: (index, id, name) => {
                ensureRole();
                emit(chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] }));
              },
              onToolArgs: (index, args) => {
                emit(chunk({ tool_calls: [{ index, function: { arguments: args } }] }));
              },
              onUsage: (usage) => {
                emit({ id: completionId, object: 'chat.completion.chunk', created, model: streamModel, choices: [], usage });
              },
            },
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
          emit({ id: completionId, object: 'chat.completion.chunk', created, model: streamModel, choices: [{ index: 0, delta: {}, finish_reason: normalizeFinish(outcome.result.finishReason) }] });
          emitRaw('[DONE]');
        } catch (err) {
          const routeErr = err instanceof RouteError ? err : null;
          finishRecord(record, {
            status: routeErr?.errorClass === 'cancelled' ? 'cancelled' : 'error',
            statusCode: routeErr?.statusCode ?? 502,
            attempts: routeErr?.attempts ?? [],
            latencyMs: Date.now() - startedAt,
            errorCode: routeErr?.errorClass ?? 'unknown',
            errorMessage: routeErr?.message ?? (err instanceof Error ? err.message : String(err)),
          });
          emit({ error: { message: routeErr?.message ?? String(err), type: 'upstream_error', code: routeErr?.errorClass ?? 'unknown' } });
          emitRaw('[DONE]');
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      })();
    },
    cancel() {
      closed = true;
    },
  });

  return c.newResponse(body, 200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-MagMax-Request-Id': record.id,
  });
});

/** Legacy completions stay available for older SDKs by mapping prompts onto chat. */
openaiApi.post('/v1/completions', async (c) => {
  const raw = await readJsonBody<Record<string, unknown>>(c).catch((err) => {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid JSON body');
  });
  const prompt = raw.prompt;
  const promptText = Array.isArray(prompt) ? prompt.join('\n') : typeof prompt === 'string' ? prompt : '';
  if (!promptText) return openAiError(c, 400, 'A non-empty prompt is required', 'invalid_request');
  const settings = getSettings();
  const requestedModel = typeof raw.model === 'string' && raw.model !== 'auto' ? raw.model : null;
  const record = createRecord({ endpoint: '/v1/completions', requestedModel, stream: false, client: clientLabel(c), settings, body: raw });
  try {
    const outcome = await executeRoute({
      messages: [{ role: 'user', content: promptText }],
      requestedModel,
      temperature: typeof raw.temperature === 'number' ? raw.temperature : undefined,
      max_tokens: typeof raw.max_tokens === 'number' ? raw.max_tokens : undefined,
      stop: raw.stop as string | string[] | undefined,
      stream: false,
      settings,
      endpoint: '/v1/completions',
      client: clientLabel(c),
      requestId: record.id,
      signal: c.req.raw.signal,
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
      id: `cmpl-${outcome.requestId}`,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model: outcome.model.modelId,
      choices: [{ text: outcome.result.content, index: 0, finish_reason: normalizeFinish(outcome.result.finishReason), logprobs: null }],
      magmax: magmaxMeta(outcome),
    });
  } catch (err) {
    return handleRouteFailure(c, record, err);
  }
});

openaiApi.post('/v1/embeddings', (c) =>
  openAiError(
    c,
    501,
    'Embeddings are not implemented by MagmaX Rotator. Route chat completions only, or call your embedding provider directly.',
    'not_implemented',
  ),
);

openaiApi.all('/v1/responses', (c) =>
  openAiError(
    c,
    501,
    'The OpenAI Responses API is not implemented. Use /v1/chat/completions, which OpenCode and most OpenAI-compatible clients use.',
    'not_implemented',
  ),
);

function handleRouteFailure(c: Context, record: ReturnType<typeof createRecord>, err: unknown) {
  if (err instanceof RouteError) {
    const cancelled = err.errorClass === 'cancelled';
    if (!cancelled) {
      finishRecord(record, {
        status: cancelled ? 'cancelled' : 'error',
        statusCode: err.statusCode,
        attempts: err.attempts,
        latencyMs: err.attempts.reduce((sum, a) => sum + a.latencyMs, 0),
        errorCode: err.errorClass,
        errorMessage: err.message,
      });
    }
    return openAiError(c, err.statusCode, err.message, err.errorClass);
  }
  const message = err instanceof Error ? err.message : String(err);
  finishRecord(record, { status: 'error', statusCode: 500, attempts: [], latencyMs: 0, errorCode: 'internal', errorMessage: message });
  return openAiError(c, 500, message, 'internal_error');
}
