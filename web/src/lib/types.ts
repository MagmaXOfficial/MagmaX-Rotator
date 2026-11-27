export type ProviderTier = 'free' | 'paid' | 'local' | 'limited' | 'unknown';

export interface ProviderCapabilities {
  tools: boolean | null;
  vision: boolean | null;
  reasoning: boolean | null;
  streaming: boolean | null;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  protocol: 'openai' | 'anthropic' | 'gemini' | 'cloudflare';
  baseUrl: string;
  docsUrl: string;
  keyHelpUrl?: string;
  description: string;
  category: 'priority' | 'additional' | 'local';
  tier: ProviderTier;
  keyless: boolean;
  authStyle: string;
  requiresAccountId?: boolean;
  listStyle: string;
  notes?: string;
  chatCompletions: boolean;
  anthropicMessages?: boolean;
  connected: boolean;
}

export interface ProviderKey {
  id: string;
  label: string;
  keyHint: string;
  active: boolean;
  failures: number;
  lastUsedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface Provider {
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
  definition?: ProviderDefinition;
  keys: ProviderKey[];
  hasCredential: boolean;
  modelCount: number;
  enabledCount: number;
}

export interface Model {
  id: string;
  providerRowId: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutput: number | null;
  inputPrice: number | null;
  outputPrice: number | null;
  tier: ProviderTier;
  capabilities: ProviderCapabilities;
  enabled: boolean;
  favorite: boolean;
  priority: number;
  latencyMs: number | null;
  requestCount: number;
  source: 'api' | 'catalog' | 'manual';
  addedAt: number;
  lastSeenAt: number | null;
  provider: { id: string; label: string; kind: string; status: string; tier: ProviderTier };
}

export interface Alias {
  alias: string;
  providerRowId: string | null;
  modelId: string | null;
  builtin: boolean;
  createdAt: number;
}

export interface Attempt {
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
  attempts: Attempt[];
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

export interface StatsBucket {
  ts: number;
  total: number;
  success: number;
  error: number;
  tokens: number;
  latencyMs: number | null;
}

export interface Stats {
  window: string;
  since: number;
  bucketMs: number;
  totals: {
    total: number;
    success: number;
    error: number;
    cancelled: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    costKnownRequests: number;
    avgLatency: number | null;
    avgTtfb: number | null;
    fallbackRequests: number;
  };
  requestsPerMinute: number;
  requestsLastHour: number;
  successRate: number | null;
  series: StatsBucket[];
  byProvider: Array<{
    providerRowId: string;
    providerName: string;
    total: number;
    success: number;
    error: number;
    tokens: number;
    cost: number;
    avgLatency: number | null;
    lastAt: number;
  }>;
  byModel: Array<{ modelId: string; providerName: string; total: number; success: number; error: number; tokens: number; cost: number; avgLatency: number | null }>;
  errors: Array<{ code: string; count: number; lastMessage: string | null }>;
  fallbackEvents: number;
  rateLimitEvents: number;
  cooldowns: Array<{ modelId: string; until: number; reason: string; failures: number; message: string }>;
  storage: { payloadLogging: boolean };
}

export interface StatusResponse {
  app: {
    name: string;
    version: string;
    startedAt: number;
    uptimeSeconds: number;
    node: string;
    pid: number;
    host: string;
    port: number;
    localOnly: boolean;
    dataDir: string;
    dbPath: string;
    dashboardBuilt: boolean;
    gatewayBase: string;
  };
  counts: { providers: number; activeProviders: number; models: number; enabledModels: number; skills: number; mcpServers: number; liveClients: number };
  providers: Array<{
    id: string;
    kind: string;
    label: string;
    status: string;
    active: boolean;
    latencyMs: number | null;
    lastCheckAt: number | null;
    statusMessage: string | null;
    models: number;
    enabled: number;
  }>;
  routing: { mode: string; profile: string; chainLength: number; cooldowns: number; requireApiKey: boolean };
  usage: { total: number; success: number; error: number; requestsPerMinute: number; tokens: number; cost: number; avgLatency: number | null; successRate: number | null };
  events: Array<{ id: number; ts: number; type: string; data: Record<string, unknown> }>;
}

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
  fallbackOn: Record<'rateLimit' | 'serverError' | 'timeout' | 'auth' | 'network' | 'modelUnavailable' | 'invalidRequest' | 'contextLength' | 'contentFilter', boolean>;
  excludedModels: string[];
  manualModelId: string | null;
  healthCheckIntervalMs: number;
}

export interface RouterResponse {
  settings: RouterSettings;
  chain: ChainEntry[];
  cooldowns: Array<{ modelId: string; until: number; reason: string; failures: number; message: string }>;
  candidateCount: number;
}

export interface ChainEntry {
  id: string;
  providerId: string;
  provider: string;
  providerKind: string;
  model: string;
  priority: number;
  providerPriority: number;
  price: { input: number | null; output: number | null };
  contextWindow: number | null;
  latencyMs: number | null;
  capabilities: ProviderCapabilities;
  reason: string;
  cooldownUntil: number | null;
  sameProviderAsPrevious: boolean;
}

export interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;
  source: 'builtin' | 'local' | 'git' | 'imported';
  path: string;
  enabled: boolean;
  permissions: { network?: string[]; filesystem?: string; env?: string[] };
  manifest: { id: string; name: string; version: string; description: string; entry?: string; exampleInput?: Record<string, unknown>; tags?: string[]; timeoutMs?: number };
  installedAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  builtin: boolean;
}

export interface SkillRun {
  id: number;
  skillId: string;
  ts: number;
  status: string;
  durationMs: number;
  inputText: string | null;
  outputText: string | null;
  error: string | null;
}

export interface McpServer {
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

export interface IntegrationStatus {
  id: 'claude-code' | 'opencode';
  name: string;
  endpoint: string;
  configPath: string;
  configExists: boolean;
  configured: boolean;
  detail: string;
  envVars?: Array<{ key: string; value: string }>;
}

export interface CheckResult {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail: string;
  durationMs: number;
  data?: unknown;
}

export interface DiagnosticsReport {
  ranAt: number;
  durationMs: number;
  checks: CheckResult[];
  summary: { pass: number; warn: number; fail: number; skip: number };
}

export interface EventRow {
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
