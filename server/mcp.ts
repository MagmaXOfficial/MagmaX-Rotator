import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { updateMcpStatus } from './db.js';
import type { McpServerRecord } from './types.js';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0).
 * Only servers the user explicitly added are ever spawned.
 */
class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private stderr = '';

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-4000);
    });
    this.child.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`MCP server exited (code ${code}). ${this.stderr.slice(0, 300)}`));
      this.pending.clear();
    });
    this.child.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(new Error(`Failed to start MCP server: ${err.message}`));
      this.pending.clear();
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleMessage(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  private handleMessage(line: string) {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (msg.id === undefined) return; // notification
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
    else pending.resolve(msg.result);
  }

  request(method: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close(): void {
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

export interface ProbeResult {
  ok: boolean;
  tools: McpTool[];
  status: string;
  error: string | null;
  serverInfo?: unknown;
}

export async function probeMcpServer(server: Pick<McpServerRecord, 'command' | 'args'>): Promise<ProbeResult> {
  if (!server.command.trim()) return { ok: false, tools: [], status: 'error', error: 'Command is empty' };
  const client = new StdioMcpClient(server.command, server.args);
  try {
    const init = (await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'magmax-rotator', version: '1.0.0' },
    })) as { serverInfo?: unknown; capabilities?: unknown };
    client.notify('notifications/initialized', {});
    const toolsResult = (await client.request('tools/list', {})) as { tools?: McpTool[] };
    const tools = toolsResult.tools ?? [];
    return { ok: true, tools, status: 'connected', error: null, serverInfo: init?.serverInfo };
  } catch (err) {
    return { ok: false, tools: [], status: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

export async function probeAndStore(id: string, server: Pick<McpServerRecord, 'command' | 'args'>): Promise<ProbeResult> {
  const result = await probeMcpServer(server);
  updateMcpStatus(id, result.status, result.error, result.tools);
  return result;
}

export async function callMcpTool(
  server: Pick<McpServerRecord, 'command' | 'args'>,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = new StdioMcpClient(server.command, server.args);
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'magmax-rotator', version: '1.0.0' },
    });
    client.notify('notifications/initialized', {});
    return await client.request('tools/call', { name: tool, arguments: args }, 60000);
  } finally {
    client.close();
  }
}
