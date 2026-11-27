export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini' | 'cloudflare';
export type ProviderTier = 'free' | 'paid' | 'local' | 'limited' | 'unknown';
export type ModelTier = ProviderTier;
export type ListStyle = 'openai' | 'gemini' | 'cloudflare' | 'anthropic' | 'none';
export type AuthStyle = 'bearer' | 'x-api-key' | 'query' | 'none';

export interface ModelCapabilities {
  tools: boolean | null;
  vision: boolean | null;
  reasoning: boolean | null;
  streaming: boolean | null;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  /** May contain {accountId} for account-scoped providers (Cloudflare). */
  baseUrl: string;
  docsUrl: string;
  description: string;
  category: 'priority' | 'additional' | 'local';
  tier: ProviderTier;
  keyless: boolean;
  authStyle: AuthStyle;
  requiresAccountId?: boolean;
  /** How GET model lists are shaped. */
  listStyle: ListStyle;
  /** Endpoint (relative to baseUrl, or absolute) used to list models. */
  modelsUrl?: string;
  keyHelpUrl?: string;
  /** Header required by some gateways, e.g. GitHub Models / OpenRouter attribution. */
  extraHeaders?: Record<string, string>;
  notes?: string;
  /** True when /chat/completions is supported on the OpenAI-compatible base URL. */
  chatCompletions: boolean;
  /** True when the provider exposes an Anthropic Messages endpoint. */
  anthropicMessages?: boolean;
  /** Default context-less model offered when listing is unavailable (never assumed metadata). */
  suggestedModels?: string[];
}

export interface ProviderRecord {
  id: string;
  providerId: string;
  label: string;
  baseUrl: string;
  accountId: string | null;
  active: boolean;
  status: 'unconfigured' | 'connected' | 'error' | 'disabled';
  statusMessage: string | null;
  latencyMs: number | null;
  priority: number;
  createdAt: number;
  lastCheckAt: number | null;
}

export interface ProviderKeyRecord {
  id: string;
  providerRowId: string;
  label: string;
  keyHint: string;
  active: boolean;
  failures: number;
  lastUsedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface ModelRecord {
  id: string;
  providerRowId: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutput: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  tier: ModelTier;
  capabilities: ModelCapabilities;
  enabled: boolean;
  favorite: boolean;
  priority: number;
  latencyMs: number | null;
  requestCount: number;
  source: 'api' | 'catalog' | 'manual';
  addedAt: number;
  lastSeenAt: number | null;
}

export interface AliasRecord {
  alias: string;
  providerRowId: string | null;
  modelId: string | null;
  builtin: boolean;
  createdAt: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>> | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: Record<string, unknown>;
  completion_tokens_details?: Record<string, unknown>;
}

export interface RoutedResponse {
  providerRowId: string;
  providerName: string;
  modelId: string;
  upstreamModel: string;
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
  latencyMs: number;
  ttfbMs: number;
  attempts: AttemptRecord[];
  raw?: unknown;
}

export interface AttemptRecord {
  providerRowId: string;
  providerName: string;
  modelId: string;
  keyHint?: string;
  startedAt: number;
  latencyMs: number;
  outcome: 'success' | 'error';
  errorClass?: string;
  statusCode?: number;
  message?: string;
}

export type ErrorClass =
  | 'rate_limit'
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'server'
  | 'model_unavailable'
  | 'invalid_request'
  | 'context_length'
  | 'content_filter'
  | 'cancelled'
  | 'unknown';

export interface RouterSettings {
  routingMode: 'priority' | 'fastest' | 'cheapest' | 'smart' | 'manual';
  profile: 'general' | 'coding' | 'reasoning' | 'fast' | 'long_context' | 'vision' | 'free_local';
  maxAttempts: number;
  requestTimeoutMs: number;
  cooldownMs: number;
  cooldownMaxMs: number;
  autoRecovery: boolean;
  continuationEnabled: boolean;
  maxContinuations: number;
  fallbackOn: {
    rateLimit: boolean;
    serverError: boolean;
    timeout: boolean;
    auth: boolean;
    network: boolean;
    modelUnavailable: boolean;
    invalidRequest: boolean;
    contextLength: boolean;
    contentFilter: boolean;
  };
  excludedModels: string[];
  manualModelId: string | null;
  requireApiKey: boolean;
  apiKey: string;
  adminToken: string;
  storePayloads: boolean;
  rateLimitPerMinute: number;
  maxBodyKb: number;
  healthCheckIntervalMs: number;
  logLevel: string;
  allowExternalBind: boolean;
  telemetry: boolean;
}

export interface RequestRecord {
  id: string;
  ts: number;
  endpoint: string;
  requestedModel: string | null;
  routingMode: string;
  profile: string;
  status: 'success' | 'error' | 'cancelled' | 'streaming';
  statusCode: number;
  providerRowId: string | null;
  providerName: string | null;
  modelId: string | null;
  attempts: AttemptRecord[];
  latencyMs: number;
  ttfbMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  fallbackCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  stream: boolean;
  client: string | null;
  promptSample: string | null;
  responseSample: string | null;
}

export interface EventRecord {
  id: number;
  ts: number;
  type: string;
  level: 'info' | 'warn' | 'error';
  provider: string | null;
  model: string | null;
  requestId: string | null;
  message: string;
  meta: Record<string, unknown> | null;
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  entry?: string;
  runtime?: 'node' | 'process';
  permissions?: {
    network?: string[];
    filesystem?: 'none' | 'skill' | 'read-data';
    env?: string[];
  };
  inputSchema?: Record<string, unknown>;
  author?: string;
  homepage?: string;
  tags?: string[];
  timeoutMs?: number;
  /** Real input used by the dashboard "Run test" button. */
  exampleInput?: Record<string, unknown>;
}

export interface SkillRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  source: 'builtin' | 'local' | 'git' | 'imported';
  path: string;
  enabled: boolean;
  permissions: SkillManifest['permissions'];
  manifest: SkillManifest;
  installedAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  builtin: boolean;
}

export interface McpServerRecord {
  id: string;
  name: string;
  transport: 'stdio';
  command: string;
  args: string[];
  enabled: boolean;
  createdAt: number;
  lastStatus: string | null;
  lastError: string | null;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}
