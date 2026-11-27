import type {
  ChatMessage,
  ErrorClass,
  ModelCapabilities,
  ProviderDefinition,
  ProviderRecord,
  ToolCall,
  Usage,
} from '../types.js';

export interface ProviderTarget {
  provider: ProviderRecord;
  definition: ProviderDefinition;
  baseUrl: string;
  apiKey: string | null;
  keyId: string | null;
  keyHint: string | null;
  accountId: string | null;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  response_format?: unknown;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  /** Extra body fields forwarded verbatim to OpenAI-compatible providers. */
  extra?: Record<string, unknown>;
}

export interface StreamSink {
  /** Fired once a candidate is selected, before any payload is emitted. */
  onStart?: (info: { modelId: string; provider: string; providerRowId: string }) => void;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolStart?: (index: number, id: string, name: string) => void;
  onToolArgs?: (index: number, args: string) => void;
  onUsage?: (usage: Usage) => void;
}

export interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
}

export class UpstreamError extends Error {
  errorClass: ErrorClass;
  statusCode?: number;
  retryAfterMs?: number;
  retryable: boolean;
  /** True when the credential itself is the problem (rotate key / stop using it). */
  credentialProblem: boolean;

  constructor(
    errorClass: ErrorClass,
    message: string,
    opts: { statusCode?: number; retryAfterMs?: number; retryable?: boolean; credentialProblem?: boolean } = {},
  ) {
    super(message);
    this.name = 'UpstreamError';
    this.errorClass = errorClass;
    this.statusCode = opts.statusCode;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable = opts.retryable ?? true;
    this.credentialProblem = opts.credentialProblem ?? (errorClass === 'auth' || errorClass === 'quota');
  }
}

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutput: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  tier: 'free' | 'paid' | 'local' | 'limited' | 'unknown';
  capabilities: Partial<ModelCapabilities>;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  latencyMs: number;
}

/** Builds auth headers without ever leaking the key into logs or responses. */
export function buildHeaders(target: ProviderTarget, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  const def = target.definition;
  if (target.apiKey) {
    if (def.protocol === 'anthropic') {
      headers['x-api-key'] = target.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers.Authorization = `Bearer ${target.apiKey}`;
    } else if (def.id === 'google-gemini') {
      headers.Authorization = `Bearer ${target.apiKey}`;
      headers['x-goog-api-key'] = target.apiKey;
    } else {
      headers.Authorization = `Bearer ${target.apiKey}`;
    }
  }
  return headers;
}
