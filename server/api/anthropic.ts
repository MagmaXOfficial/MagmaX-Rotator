import { Hono } from 'hono';
import { z } from 'zod';
import { getSettings } from '../db.js';
import { anthropicError, clientLabel, HttpError, readJsonBody } from '../http-utils.js';
import { RouteError, executeRoute } from '../router/engine.js';
import { createRecord, finishRecord } from '../router/recording.js';
import type { ChatMessage, ToolCall } from '../types.js';

export const anthropicApi = new Hono();

const blockSchema = z.record(z.unknown());

const bodySchema = z
  .object({
    model: z.string().optional(),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(blockSchema)]) }))
      .min(1),
    system: z.union([z.string(), z.array(blockSchema)]).optional(),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().optional(),
    tools: z.array(blockSchema).optional(),
    tool_choice: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

type AnthropicBlock = {
  type?: string;
  text?: string;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

function textFromBlocks(blocks: AnthropicBlock[] | string | undefined): string {
  if (!blocks) return '';
  if (typeof blocks === 'string') return blocks;
  return blocks
    .map((b) => (b.type === 'text' ? (b.text ?? '') : typeof b.content === 'string' ? b.content : ''))
    .filter(Boolean)
    .join('\n');
}

/** Converts an Anthropic Messages request into the router's internal OpenAI-style messages. */
export function toChatMessages(body: z.infer<typeof bodySchema>): ChatMessage[] {
  const out: ChatMessage[] = [];
  const systemText = textFromBlocks(body.system as string | AnthropicBlock[] | undefined);
  if (systemText) out.push({ role: 'system', content: systemText });

  for (const msg of body.messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = msg.content as AnthropicBlock[];
    const parts: Array<Record<string, unknown>> = [];
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text) parts.push({ type: 'text', text: block.text });
      else if (block.type === 'image' && block.source) {
        if (block.source.type === 'base64') {
          parts.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type ?? 'image/png'};base64,${block.source.data ?? ''}` } });
        } else if (block.source.url) {
          parts.push({ type: 'image_url', image_url: { url: block.source.url } });
        }
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? `call_${toolCalls.length}`,
          type: 'function',
          function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id ?? '',
          content: typeof block.content === 'string' ? block.content : textFromBlocks(block.content as AnthropicBlock[] | undefined),
        });
      }
    }
    if (msg.role === 'assistant') {
      const text = textFromBlocks(blocks);
      out.push({ role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else if (parts.length) {
      const onlyText = parts.every((p) => p.type === 'text');
      out.push({ role: 'user', content: onlyText ? parts.map((p) => String(p.text)).join('\n') : parts });
    }
  }
  return out;
}

function toOpenAiTools(tools: z.infer<typeof bodySchema>['tools']): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools as Array<{ name?: string; description?: string; input_schema?: unknown }>) {
    if (!tool.name) continue;
    out.push({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema ?? { type: 'object', properties: {} } } });
  }
  return out.length ? out : undefined;
}

function toOpenAiToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== 'object') return undefined;
  const c = choice as { type?: string; name?: string; disable_parallel_tool_use?: boolean };
  if (c.type === 'tool' && c.name) return { type: 'function', function: { name: c.name } };
  if (c.type === 'any') return 'required';
  if (c.type === 'auto') return 'auto';
  return undefined;
}

function mapStop(reason: string | null): string {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

/** Honest token estimate — the dashboard labels it as estimated. */
export function estimatePromptTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if ((p as { type?: string }).type === 'image_url') images++;
        else if (typeof (p as { text?: string }).text === 'string') chars += (p as { text: string }).text.length;
      }
    }
    for (const call of m.tool_calls ?? []) chars += call.function.arguments.length;
  }
  return Math.max(1, Math.ceil(chars / 4) + images * 1000);
}

function anthropicUsage(promptTokens: number | undefined, completionTokens: number | undefined, estimated: boolean, fallbackContent: string) {
  return {
    input_tokens: promptTokens ?? Math.max(1, Math.ceil(fallbackContent.length / 4)),
    output_tokens: completionTokens ?? 0,
    ...(estimated ? { _magmax_estimated: true } : {}),
  };
}

anthropicApi.post('/v1/messages', async (c) => {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await readJsonBody(c));
  } catch (err) {
    if (err instanceof HttpError) return anthropicError(c, err.status, err.message, err.status === 413 ? 'request_too_large' : 'invalid_request_error');
    if (err instanceof z.ZodError) return anthropicError(c, 400, err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'invalid_request_error');
    throw err;
  }

  const settings = getSettings();
  const messages = toChatMessages(parsed);
  const stream = parsed.stream === true;
  const requestedModel = parsed.model && parsed.model !== 'auto' ? parsed.model : null;
  const declaredModel = parsed.model ?? 'claude-magmax';
  const record = createRecord({ endpoint: '/v1/messages', requestedModel, stream, client: clientLabel(c), settings, body: parsed });
  const extra: Record<string, unknown> = {};
  if (parsed.top_k !== undefined) extra.top_k = parsed.top_k;
  const systemPresent = messages.some((m) => m.role === 'system');
  const common = {
    messages,
    requestedModel,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    max_tokens: parsed.max_tokens ?? 4096,
    stop: parsed.stop_sequences,
    tools: toOpenAiTools(parsed.tools),
    tool_choice: toOpenAiToolChoice(parsed.tool_choice),
    extra,
    required: { tools: !!parsed.tools?.length, vision: messages.some((m) => Array.isArray(m.content)) },
    settings,
    endpoint: '/v1/messages',
    client: clientLabel(c),
    requestId: record.id,
    signal: c.req.raw.signal,
  } as const;
  void systemPresent;

  if (!stream) {
    try {
      const outcome = await executeRoute({ ...common, stream: false });
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
      const usage = outcome.result.usage;
      const estimated = usage.prompt_tokens === undefined || usage.completion_tokens === undefined;
      for (const [k, v] of Object.entries({
        'X-MagMax-Request-Id': outcome.requestId,
        'X-MagMax-Model': encodeURIComponent(outcome.model.modelId),
        'X-MagMax-Provider': encodeURIComponent(outcome.provider.label),
        'X-MagMax-Attempts': String(outcome.attempts.length),
        'X-MagMax-Fallbacks': String(outcome.fallbackCount),
      }))
        c.header(k, v);
      return c.json({
        id: `msg_${outcome.requestId}`,
        type: 'message',
        role: 'assistant',
        model: declaredModel,
        content: [
          ...(outcome.result.content ? [{ type: 'text', text: outcome.result.content }] : []),
          ...outcome.result.toolCalls.map((call) => {
            let input: unknown = {};
            try {
              input = JSON.parse(call.function.arguments || '{}');
            } catch {
              input = { raw: call.function.arguments };
            }
            return { type: 'tool_use', id: call.id, name: call.function.name, input };
          }),
        ],
        stop_reason: mapStop(outcome.result.finishReason),
        stop_sequence: null,
        usage: {
          input_tokens: usage.prompt_tokens ?? estimatePromptTokens(messages),
          output_tokens: usage.completion_tokens ?? Math.max(1, Math.ceil(outcome.result.content.length / 4)),
          ...(estimated ? { _magmax_estimated: true } : {}),
        },
        magmax: {
          requestId: outcome.requestId,
          routedModel: outcome.model.modelId,
          provider: outcome.provider.label,
          providerId: outcome.provider.providerId,
          routingMode: outcome.routingMode,
          profile: outcome.profile,
          explain: outcome.explain,
          fallbackCount: outcome.fallbackCount,
          attempts: outcome.attempts.map((a) => ({ provider: a.providerName, model: a.modelId, outcome: a.outcome, latencyMs: a.latencyMs, errorClass: a.errorClass ?? null })),
          continuations: outcome.continuations,
        },
      });
    } catch (err) {
      return handleAnthropicFailure(c, record, err);
    }
  }

  const encoder = new TextEncoder();
  let closed = false;
  const startedAt = Date.now();
  const messageId = `msg_${record.id}`;
  let blockIndex = -1;
  let blockType: 'text' | 'tool' | null = null;
  let nextIndex = 0;
  let started = false;
  const toolBlocks = new Map<number, number>();
  let accumulated = '';
  let outputTokens: number | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const ensureStart = () => {
        if (started) return;
        started = true;
        emit('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: declaredModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: estimatePromptTokens(messages), output_tokens: 1, _magmax_estimated: true },
          },
        });
      };
      const closeBlock = () => {
        if (blockType === null) return;
        emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        blockType = null;
      };
      const openText = () => {
        ensureStart();
        if (blockType === 'text') return;
        closeBlock();
        blockIndex = nextIndex++;
        blockType = 'text';
        emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
      };

      void (async () => {
        try {
          const outcome = await executeRoute({
            ...common,
            stream: true,
            sink: {
              onText: (delta) => {
                openText();
                accumulated += delta;
                emit('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta } });
              },
              onToolStart: (toolIndex, id, name) => {
                ensureStart();
                closeBlock();
                blockIndex = nextIndex++;
                blockType = 'tool';
                toolBlocks.set(toolIndex, blockIndex);
                emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id, name, input: {} } });
              },
              onToolArgs: (toolIndex, args) => {
                const idx = toolBlocks.get(toolIndex) ?? blockIndex;
                emit('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: args } });
              },
              onUsage: (usage) => {
                if (typeof usage.completion_tokens === 'number') outputTokens = usage.completion_tokens;
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
          ensureStart();
          closeBlock();
          emit('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: mapStop(outcome.result.finishReason), stop_sequence: null },
            usage: {
              output_tokens: outputTokens ?? Math.max(1, Math.ceil(accumulated.length / 4)),
              ...(outputTokens === undefined ? { _magmax_estimated: true } : {}),
            },
          });
          emit('message_stop', { type: 'message_stop' });
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
          emit('error', {
            type: 'error',
            error: { type: routeErr?.statusCode === 429 ? 'rate_limit_error' : 'api_error', message: routeErr?.message ?? String(err) },
          });
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

anthropicApi.post('/v1/messages/count_tokens', async (c) => {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await readJsonBody(c));
  } catch (err) {
    if (err instanceof HttpError) return anthropicError(c, err.status, err.message, 'invalid_request_error');
    if (err instanceof z.ZodError) return anthropicError(c, 400, 'Invalid request body', 'invalid_request_error');
    throw err;
  }
  c.header('X-MagMax-Estimate', 'true');
  return c.json({
    input_tokens: estimatePromptTokens(toChatMessages(parsed)),
    _magmax_estimated: true,
    note: 'MagmaX estimates tokens (≈4 characters/token). It does not run the provider tokenizer for unauthenticated counting.',
  });
});

function handleAnthropicFailure(c: Parameters<typeof anthropicError>[0], record: ReturnType<typeof createRecord>, err: unknown) {
  if (err instanceof RouteError) {
    finishRecord(record, {
      status: err.errorClass === 'cancelled' ? 'cancelled' : 'error',
      statusCode: err.statusCode,
      attempts: err.attempts,
      latencyMs: err.attempts.reduce((sum, a) => sum + a.latencyMs, 0),
      errorCode: err.errorClass,
      errorMessage: err.message,
    });
    const type =
      err.statusCode === 429 ? 'rate_limit_error' : err.statusCode === 400 ? 'invalid_request_error' : err.statusCode === 401 ? 'authentication_error' : 'api_error';
    return anthropicError(c, err.statusCode, err.message, type);
  }
  const message = err instanceof Error ? err.message : String(err);
  finishRecord(record, { status: 'error', statusCode: 500, attempts: [], latencyMs: 0, errorCode: 'internal', errorMessage: message });
  return anthropicError(c, 500, message, 'api_error');
}
