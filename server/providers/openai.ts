import type { ToolCall, Usage } from '../types.js';
import { authHeadersFor, assertOk, joinUrl, readJson, readSse, requestUpstream, startStream } from './http.js';
import { UpstreamError } from './types.js';
import type { ChatParams, CompletionResult, ProviderTarget, StreamSink } from './types.js';

function bodyFor(target: ProviderTarget, params: ChatParams, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    stream,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.top_p !== undefined) body.top_p = params.top_p;
  if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens;
  if (params.stop !== undefined) body.stop = params.stop;
  if (params.tools?.length) {
    body.tools = params.tools;
    body.tool_choice = params.tool_choice ?? 'auto';
  }
  if (params.response_format !== undefined) body.response_format = params.response_format;
  if (params.presence_penalty !== undefined) body.presence_penalty = params.presence_penalty;
  if (params.frequency_penalty !== undefined) body.frequency_penalty = params.frequency_penalty;
  if (params.seed !== undefined) body.seed = params.seed;
  if (params.extra) Object.assign(body, params.extra);
  if (stream) body.stream_options = { include_usage: true };
  // OpenRouter optionally exposes reasoning tokens; ignored by other providers.
  if (target.definition.id === 'openrouter' && params.extra?.reasoning === undefined) {
    // no-op: only forward what the client asked for
  }
  return body;
}

interface OpenAiResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning_content?: string; reasoning?: string };
    delta?: { content?: string | null; reasoning_content?: string; reasoning?: string; tool_calls?: OpenAiToolDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: Usage;
  error?: { message?: string };
}

interface OpenAiToolDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export async function openaiChat(
  target: ProviderTarget,
  params: ChatParams,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const res = await requestUpstream(
    joinUrl(target.baseUrl, '/chat/completions'),
    { method: 'POST', headers: authHeadersFor(target), body: JSON.stringify(bodyFor(target, params, false)) },
    timeoutMs,
    signal,
  );
  await assertOk(res);
  const data = await readJson<OpenAiResponse>(res);
  const choice = data.choices?.[0];
  if (!choice) throw new UpstreamError('server', 'Provider returned no choices', { retryable: true });
  return {
    content: choice.message?.content ?? '',
    reasoning: choice.message?.reasoning_content ?? choice.message?.reasoning ?? '',
    toolCalls: normalizeToolCalls(choice.message?.tool_calls),
    finishReason: choice.finish_reason ?? null,
    usage: data.usage ?? {},
  };
}

export async function openaiChatStream(
  target: ProviderTarget,
  params: ChatParams,
  timeoutMs: number,
  sink: StreamSink,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const { response: res } = await startStream(
    joinUrl(target.baseUrl, '/chat/completions'),
    {
      method: 'POST',
      headers: authHeadersFor(target, { Accept: 'text/event-stream' }),
      body: JSON.stringify(bodyFor(target, params, true)),
    },
    timeoutMs,
    signal,
  );
  if (!res.body) throw new UpstreamError('server', 'Provider returned an empty stream body', { retryable: true });

  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: Usage = {};
  const toolCalls = new Map<number, ToolCall>();
  const announced = new Set<number>();

  for await (const msg of readSse(res.body)) {
    if (msg.data === '[DONE]') break;
    let chunk: OpenAiResponse;
    try {
      chunk = JSON.parse(msg.data) as OpenAiResponse;
    } catch {
      continue;
    }
    if (chunk.error?.message) throw new UpstreamError('server', chunk.error.message, { retryable: true });
    if (chunk.usage) {
      usage = chunk.usage;
      sink.onUsage?.(chunk.usage);
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (delta?.content) {
      content += delta.content;
      sink.onText?.(delta.content);
    }
    const think = delta?.reasoning_content ?? delta?.reasoning;
    if (think) {
      reasoning += think;
      sink.onReasoning?.(think);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? toolCalls.size;
      let acc = toolCalls.get(index);
      if (!acc) {
        acc = { id: tc.id ?? `call_${index}_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: '', arguments: '' } };
        toolCalls.set(index, acc);
      }
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.function.name = tc.function.name;
      if (!announced.has(index) && (tc.id || tc.function?.name)) {
        announced.add(index);
        sink.onToolStart?.(index, acc.id, acc.function.name);
      }
      if (tc.function?.arguments) {
        acc.function.arguments += tc.function.arguments;
        sink.onToolArgs?.(index, tc.function.arguments);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  return {
    content,
    reasoning,
    toolCalls: [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    finishReason,
    usage,
  };
}

function normalizeToolCalls(calls: ToolCall[] | undefined): ToolCall[] {
  if (!calls?.length) return [];
  return calls.map((c, i) => ({
    id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name: c.function?.name ?? '', arguments: c.function?.arguments ?? '{}' },
  }));
}
