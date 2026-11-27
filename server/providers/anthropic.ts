import type { ChatMessage, ToolCall, Usage } from '../types.js';
import { authHeadersFor, assertOk, joinUrl, readJson, readSse, requestUpstream, startStream } from './http.js';
import { UpstreamError } from './types.js';
import type { ChatParams, CompletionResult, ProviderTarget, StreamSink } from './types.js';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  source?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  error?: { message?: string; type?: string };
}

function textOfContent(content: ChatMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Converts OpenAI-style messages (what the router speaks internally) into Anthropic messages. */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string | undefined; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = textOfContent(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === 'tool') {
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id ?? '',
        content: typeof msg.content === 'string' ? msg.content : textOfContent(msg.content),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      const text = textOfContent(msg.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of msg.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || '{}');
        } catch {
          input = { raw: call.function.arguments };
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // user
    if (Array.isArray(msg.content) && msg.content.some((p) => p.type === 'image_url')) {
      const blocks: AnthropicContentBlock[] = [];
      for (const part of msg.content) {
        if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
        if (part.type === 'image_url') {
          const url = (part.image_url as { url?: string } | undefined)?.url ?? '';
          const match = /^data:([^;]+);base64,(.+)$/.exec(url);
          if (match) blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
          else if (url) blocks.push({ type: 'image', source: { type: 'url', url } });
        }
      }
      out.push({ role: 'user', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else {
      out.push({ role: 'user', content: textOfContent(msg.content) });
    }
  }

  // Anthropic rejects consecutive same-role messages; merge them.
  const merged: AnthropicMessage[] = [];
  for (const msg of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      const a = typeof last.content === 'string' ? [{ type: 'text', text: last.content } as AnthropicContentBlock] : last.content;
      const b = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content } as AnthropicContentBlock] : msg.content;
      last.content = [...a, ...b];
    } else merged.push(msg);
  }
  if (!merged.length) merged.push({ role: 'user', content: '' });

  return { system: systemParts.length ? systemParts.join('\n\n') : undefined, messages: merged };
}

function toAnthropicTools(tools: ChatParams['tools']): unknown[] | undefined {
  if (!tools?.length) return undefined;
  const out: unknown[] = [];
  for (const tool of tools) {
    const fn = (tool.function ?? tool) as { name?: string; description?: string; parameters?: unknown; input_schema?: unknown };
    if (!fn.name) continue;
    out.push({ name: fn.name, description: fn.description, input_schema: fn.parameters ?? fn.input_schema ?? { type: 'object', properties: {} } });
  }
  return out.length ? out : undefined;
}

function toAnthropicToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== 'object') return choice === 'required' ? { type: 'any' } : undefined;
  const c = choice as { type?: string; function?: { name?: string } };
  if (c.type === 'function' && c.function?.name) return { type: 'tool', name: c.function.name };
  if (c.type === 'required' || c.type === 'any') return { type: 'any' };
  return undefined;
}

function mapStopReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === 'end_turn') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'stop_sequence') return 'stop';
  return reason;
}

function mapFinishToAnthropic(reason: string | null): string {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'stop') return 'end_turn';
  return reason ?? 'end_turn';
}

export function buildAnthropicRequest(params: ChatParams, stream: boolean): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(params.messages);
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.max_tokens ?? 4096,
    messages,
    stream,
  };
  if (system) body.system = system;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.top_p !== undefined) body.top_p = params.top_p;
  if (params.stop !== undefined) body.stop_sequences = Array.isArray(params.stop) ? params.stop : [params.stop];
  const tools = toAnthropicTools(params.tools);
  if (tools) {
    body.tools = tools;
    const choice = toAnthropicToolChoice(params.tool_choice);
    if (choice) body.tool_choice = choice;
  }
  return body;
}

export async function anthropicChat(
  target: ProviderTarget,
  params: ChatParams,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const res = await requestUpstream(
    joinUrl(target.baseUrl, '/messages'),
    { method: 'POST', headers: authHeadersFor(target), body: JSON.stringify(buildAnthropicRequest(params, false)) },
    timeoutMs,
    signal,
  );
  await assertOk(res);
  const data = await readJson<AnthropicResponse>(res);
  const blocks = data.content ?? [];
  const content = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b, i) => ({
      id: b.id ?? `toolu_${i}`,
      type: 'function',
      function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
    }));
  const usage: Usage = {
    prompt_tokens: data.usage?.input_tokens,
    completion_tokens: data.usage?.output_tokens,
    total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
  };
  return { content, reasoning: '', toolCalls, finishReason: mapStopReason(data.stop_reason), usage };
}

export async function anthropicChatStream(
  target: ProviderTarget,
  params: ChatParams,
  timeoutMs: number,
  sink: StreamSink,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const { response: res } = await startStream(
    joinUrl(target.baseUrl, '/messages'),
    {
      method: 'POST',
      headers: authHeadersFor(target, { Accept: 'text/event-stream' }),
      body: JSON.stringify(buildAnthropicRequest(params, true)),
    },
    timeoutMs,
    signal,
  );
  if (!res.body) throw new UpstreamError('server', 'Provider returned an empty stream body', { retryable: true });

  let content = '';
  let finishReason: string | null = null;
  const usage: Usage = {};
  const toolCalls = new Map<number, ToolCall>();
  const blockIndexToTool = new Map<number, number>();

  for await (const msg of readSse(res.body)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(msg.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(data.type ?? msg.event ?? '');
    if (type === 'error') {
      const err = data.error as { message?: string } | undefined;
      throw new UpstreamError('server', err?.message ?? 'Anthropic stream error', { retryable: true });
    }
    if (type === 'message_start') {
      const m = data.message as AnthropicResponse | undefined;
      if (m?.usage) {
        usage.prompt_tokens = m.usage.input_tokens;
        usage.completion_tokens = m.usage.output_tokens;
      }
      continue;
    }
    if (type === 'content_block_start') {
      const index = Number(data.index ?? 0);
      const block = data.content_block as AnthropicContentBlock | undefined;
      if (block?.type === 'tool_use') {
        const toolIndex = toolCalls.size;
        blockIndexToTool.set(index, toolIndex);
        const call: ToolCall = { id: block.id ?? `toolu_${toolIndex}`, type: 'function', function: { name: block.name ?? '', arguments: '' } };
        toolCalls.set(toolIndex, call);
        sink.onToolStart?.(toolIndex, call.id, call.function.name);
      }
      continue;
    }
    if (type === 'content_block_delta') {
      const delta = data.delta as { type?: string; text?: string; partial_json?: string } | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        content += delta.text;
        sink.onText?.(delta.text);
      } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
        const blockIndex = Number(data.index ?? 0);
        const toolIndex = blockIndexToTool.get(blockIndex) ?? 0;
        const call = toolCalls.get(toolIndex);
        if (call) call.function.arguments += delta.partial_json;
        sink.onToolArgs?.(toolIndex, delta.partial_json);
      }
      continue;
    }
    if (type === 'message_delta') {
      const d = data.delta as { stop_reason?: string | null } | undefined;
      if (d?.stop_reason) finishReason = mapStopReason(d.stop_reason);
      const u = data.usage as { output_tokens?: number } | undefined;
      if (u?.output_tokens !== undefined) usage.completion_tokens = u.output_tokens;
      continue;
    }
    if (type === 'message_stop') break;
  }

  if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) {
    usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    sink.onUsage?.(usage);
  }

  return {
    content,
    reasoning: '',
    toolCalls: [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    finishReason,
    usage,
  };
}

export { mapFinishToAnthropic };
