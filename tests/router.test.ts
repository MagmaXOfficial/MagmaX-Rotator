import http from 'node:http';
import type { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { DEFAULT_SETTINGS, createProvider, initDb, listModels, upsertModels, updateProvider, updateSettings } from '../server/db.js';
import { getProviderDefinition } from '../server/providers/registry.js';
import { RouteError, executeRoute } from '../server/router/engine.js';
import type { Candidate } from '../server/router/engine.js';
import type { ProviderTarget } from '../server/providers/types.js';
import type { ModelRecord, ProviderRecord } from '../server/types.js';

interface Mock {
  url: string;
  close: () => Promise<void>;
}

function startMock(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Mock> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => handler(req, res, body));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('bind failed'));
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

function fakeProvider(id: string, label: string): ProviderRecord {
  return {
    id,
    providerId: 'openai-compatible',
    label,
    baseUrl: '',
    accountId: null,
    active: true,
    status: 'connected',
    statusMessage: null,
    latencyMs: 5,
    priority: 10,
    createdAt: Date.now(),
    lastCheckAt: Date.now(),
  };
}

function fakeModel(providerRowId: string, modelId: string, priority = 1): ModelRecord {
  return {
    id: `${providerRowId}::${modelId}`,
    providerRowId,
    modelId,
    displayName: modelId,
    contextWindow: 8192,
    maxOutput: 512,
    inputPrice: null,
    outputPrice: null,
    tier: 'local',
    capabilities: { tools: null, vision: null, reasoning: null, streaming: true },
    enabled: true,
    favorite: false,
    priority,
    latencyMs: null,
    requestCount: 0,
    source: 'manual',
    addedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
}

const definition = getProviderDefinition('openai-compatible')!;

describe('failover engine over real HTTP', () => {
  it('classifies a 429, cools the model down and streams from the next provider intact', async () => {
    const failing = await startMock((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    });
    const healthy = await startMock((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"fall"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"back"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const primary = fakeProvider('t_primary', 'Primary');
      const backup = fakeProvider('t_backup', 'Backup');
      const targets = new Map<string, ProviderTarget>([
        [primary.id, { provider: primary, definition, baseUrl: failing.url, apiKey: null, keyId: null, keyHint: null, accountId: null }],
        [backup.id, { provider: backup, definition, baseUrl: healthy.url, apiKey: null, keyId: null, keyHint: null, accountId: null }],
      ]);
      const candidates: Candidate[] = [
        { model: fakeModel(primary.id, 'a'), provider: primary, definition, score: 0, reason: 'test' },
        { model: fakeModel(backup.id, 'b'), provider: backup, definition, score: 1, reason: 'test' },
      ];
      const chunks: string[] = [];
      const outcome = await executeRoute({
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        sink: { onText: (delta) => chunks.push(delta) },
        candidates,
        resolveTarget: (id) => targets.get(id) ?? null,
        settings: { ...DEFAULT_SETTINGS, maxAttempts: 3 },
      });
      expect(chunks.join('')).toBe('fallback');
      expect(outcome.attempts).toHaveLength(2);
      expect(outcome.attempts[0]!.errorClass).toBe('rate_limit');
      expect(outcome.attempts[1]!.outcome).toBe('success');
      expect(outcome.fallbackCount).toBe(1);
      expect(outcome.result.usage.prompt_tokens).toBe(7);
    } finally {
      await failing.close();
      await healthy.close();
    }
  });

  it('never switches models after bytes have reached the client', async () => {
    const broken = await startMock((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      setTimeout(() => res.destroy(), 30);
    });
    const backup = await startMock((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"should-not-run"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    try {
      const primary = fakeProvider('t_mid', 'Mid');
      const backupProvider = fakeProvider('t_mid_backup', 'Mid backup');
      const targets = new Map<string, ProviderTarget>([
        [primary.id, { provider: primary, definition, baseUrl: broken.url, apiKey: null, keyId: null, keyHint: null, accountId: null }],
        [backupProvider.id, { provider: backupProvider, definition, baseUrl: backup.url, apiKey: null, keyId: null, keyHint: null, accountId: null }],
      ]);
      const chunks: string[] = [];
      await expect(
        executeRoute({
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
          sink: { onText: (delta) => chunks.push(delta) },
          candidates: [
            { model: fakeModel(primary.id, 'a'), provider: primary, definition, score: 0, reason: 'test' },
            { model: fakeModel(backupProvider.id, 'b'), provider: backupProvider, definition, score: 1, reason: 'test' },
          ],
          resolveTarget: (id) => targets.get(id) ?? null,
          settings: { ...DEFAULT_SETTINGS, maxAttempts: 3 },
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(RouteError);
        const routeError = error as RouteError;
        expect(routeError.message).toContain('after output started');
        expect(routeError.attempts).toHaveLength(1);
        return true;
      });
      expect(chunks.join('')).toBe('partial');
    } finally {
      await broken.close();
      await backup.close();
    }
  });
});

describe('gateway endpoints', () => {
  let app: Hono;
  let mock: Mock;
  let providerRowId = '';

  beforeAll(async () => {
    initDb({ path: ':memory:' });
    updateSettings({ ...DEFAULT_SETTINGS, requireApiKey: false });
    mock = await startMock((req, res, body) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-chat' }] }));
        return;
      }
      const parsed = JSON.parse(body || '{}') as { stream?: boolean; messages?: Array<{ content?: string }>; tools?: unknown[] };
      if (parsed.tools?.length && !parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-tool',
            model: 'mock-chat',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 8, completion_tokens: 3 },
          }),
        );
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            model: 'mock-chat',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello from mock' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          }),
        );
      }
    });
    const def = getProviderDefinition('openai-compatible')!;
    const provider = createProvider(def, { label: 'Gateway mock', baseUrl: mock.url });
    providerRowId = provider.id;
    updateProvider(providerRowId, { baseUrl: mock.url });
    upsertModels(providerRowId, [{ modelId: 'mock-chat', contextWindow: 4096 }]);
    app = createApp();
  });

  it('serves an OpenAI-compatible completion with routing metadata', async () => {
    const response = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'user-agent': 'vitest' },
      body: JSON.stringify({ model: 'mock-chat', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }>; magmax: { provider: string; model: string } };
    expect(json.choices[0]!.message.content).toBe('hello from mock');
    expect(json.magmax.model).toBe('mock-chat');
    expect(response.headers.get('x-magmax-model')).toBe('mock-chat');
  });

  it('streams OpenAI chunks and terminates with [DONE]', async () => {
    const response = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-chat', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('"content":"hi"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('serves the Anthropic Messages API and returns tool-ready content', async () => {
    const response = await app.request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 128, system: 'be brief', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { type: string; role: string; content: Array<{ type: string; text: string }>; stop_reason: string; magmax: { routedModel: string } };
    expect(json.type).toBe('message');
    expect(json.role).toBe('assistant');
    expect(json.content[0]!.text).toBe('hello from mock');
    expect(json.stop_reason).toBe('end_turn');
    expect(json.magmax.routedModel).toBe('mock-chat');
  });

  it('streams Anthropic SSE events', async () => {
    const response = await app.request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('"text":"hi"');
    expect(text).toContain('event: message_stop');
  });

  it('passes OpenAI tool calls through with finish_reason tool_calls', async () => {
    const response = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-chat',
        messages: [{ role: 'user', content: 'read a.txt' }],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      }),
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { choices: Array<{ message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason: string }> };
    expect(json.choices[0]!.finish_reason).toBe('tool_calls');
    expect(json.choices[0]!.message.tool_calls[0]!.function.name).toBe('read_file');
    expect(JSON.parse(json.choices[0]!.message.tool_calls[0]!.function.arguments)).toEqual({ path: 'a.txt' });
  });

  it('maps routed tool calls into Anthropic tool_use blocks', async () => {
    const response = await app.request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'read a.txt' }],
        tools: [{ name: 'read_file', description: 'reads a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      }),
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { stop_reason: string; content: Array<{ type: string; id?: string; name?: string; input?: unknown }> };
    expect(json.stop_reason).toBe('tool_use');
    const block = json.content.find((item) => item.type === 'tool_use');
    expect(block).toBeTruthy();
    expect(block!.name).toBe('read_file');
    expect(block!.input).toEqual({ path: 'a.txt' });
  });

  it('rejects invalid requests with a 400 instead of falling back', async () => {
    const response = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-chat', messages: [] }),
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as { error: { code: string } };
    expect(json.error.code).toBe('invalid_request');
  });

  it('requires an API key when enabled', async () => {
    updateSettings({ requireApiKey: true, apiKey: 'test-key' });
    const unauthorized = await app.request('http://localhost/v1/models');
    expect(unauthorized.status).toBe(401);
    const authorized = await app.request('http://localhost/v1/models', { headers: { Authorization: 'Bearer test-key' } });
    expect(authorized.status).toBe(200);
    updateSettings({ requireApiKey: false });
  });
});
