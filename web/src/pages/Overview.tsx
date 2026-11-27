import { useState } from 'react';
import {
  Activity,
  ArrowRight,
  Boxes,
  Cable,
  CircleDollarSign,
  Cpu,
  Gauge,
  Plug,
  Route,
  Sparkles,
  Stethoscope,
  Timer,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { cx, formatCurrency, formatLatency, formatNumber, formatRelative, formatTokens, shortModel } from '../lib/format';
import { Badge, Button, Card, CardHeader, CopyChip, EmptyState, Field, Input, Modal, PageHeader, Segmented, Spinner, Stat, StatusDot, useToast } from '../components/ui';
import { RequestBars } from '../components/charts';
import { DiagnosticsRunner } from '../components/Diagnostics';
import { RequestDetailModal } from '../components/RequestDetail';
import type { Attempt, RequestRecord, Stats, StatusResponse } from '../lib/types';
import type { PageId } from '../components/Shell';

type TestResult = { ok: boolean; response?: string; provider?: string; model?: string; latencyMs?: number; attempts?: Attempt[]; error?: string };

export function Overview({ navigate }: { navigate: (page: PageId) => void }) {
  const [window, setWindow] = useState<'1h' | '24h' | '7d'>('24h');
  const [selected, setSelected] = useState<RequestRecord | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const status = useApi<StatusResponse>('/api/status', { refreshMs: 8000 });
  const stats = useApi<Stats>(`/api/monitoring/stats?window=${window}`, { refreshMs: 12_000 });
  const requests = useApi<{ items: RequestRecord[]; total: number }>('/api/monitoring/requests?limit=8', { refreshMs: 10_000 });
  const providers = status?.data?.providers ?? [];
  const totals = stats.data?.totals;
  const hasProviders = (status?.data?.counts.activeProviders ?? 0) > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Gateway"
        title="Overview"
        description="One local endpoint in front of every provider. Requests are routed, retried and measured automatically."
        actions={
          <>
            <Button variant="secondary" size="md" icon={<Zap size={14} />} onClick={() => setTestOpen(true)}>
              Test routing
            </Button>
            <Button variant="outline" size="md" icon={<Stethoscope size={14} />} onClick={() => setDiagnosticsOpen(true)}>
              Diagnostics
            </Button>
            <Button variant="primary" size="md" icon={<Plug size={14} />} onClick={() => navigate('providers')}>
              Connect provider
            </Button>
          </>
        }
      />

      {!hasProviders ? (
        <Card className="border-magma-line/60 bg-gradient-to-br from-magma-soft/50 to-transparent">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-magma-line bg-magma-soft px-2 py-0.5 text-[11px] font-medium text-magma">
                <Sparkles size={11} /> Setup
              </span>
              <h2 className="mt-2.5 text-lg font-semibold tracking-[-0.02em]">Add your first provider key</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">
                Paste a key once — MagmaX validates it, pulls the real model catalogue and starts routing. Local runtimes such as Ollama and LM Studio need no key.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {['NVIDIA NIM', 'Google Gemini', 'OpenRouter', 'Groq', 'Kilo Gateway', 'Cline API', 'Ollama'].map((name) => (
                  <span key={name} className="rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-muted">
                    {name}
                  </span>
                ))}
              </div>
            </div>
            <Button variant="primary" icon={<ArrowRight size={14} />} onClick={() => navigate('providers')}>
              Open Providers
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Requests"
          value={formatNumber(totals?.total ?? 0)}
          hint={`${window} window · ${formatNumber(stats.data?.requestsLastHour ?? 0)} last hour`}
          icon={<Activity size={14} />}
        />
        <Stat
          label="Success rate"
          value={stats.data?.successRate === null || stats.data?.successRate === undefined ? '—' : `${stats.data.successRate.toFixed(1)}%`}
          hint={`${formatNumber(totals?.error ?? 0)} failed · ${formatNumber(totals?.fallbackRequests ?? 0)} with fallback`}
          icon={<Gauge size={14} />}
          tone={stats.data?.successRate !== null && stats.data?.successRate !== undefined && stats.data.successRate < 95 ? 'err' : 'ok'}
        />
        <Stat label="Avg latency" value={formatLatency(totals?.avgLatency)} hint={`First token ${formatLatency(totals?.avgTtfb)}`} icon={<Timer size={14} />} />
        <Stat
          label="Tokens"
          value={formatTokens((totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0))}
          hint={`${formatTokens(totals?.inputTokens ?? 0)} in · ${formatTokens(totals?.outputTokens ?? 0)} out`}
          icon={<Cpu size={14} />}
        />
        <Stat
          label="Est. cost"
          value={formatCurrency(totals?.cost ?? 0)}
          hint={totals && totals.costKnownRequests < totals.success ? 'Only priced models included' : 'From provider pricing'}
          icon={<CircleDollarSign size={14} />}
        />
        <Stat label="Throughput" value={`${(stats.data?.requestsPerMinute ?? 0).toFixed(1)}`} hint="requests per minute" icon={<Zap size={14} />} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <Card>
          <CardHeader
            title="Request volume"
            description="Successful vs failed requests per time bucket."
            icon={<Activity size={15} />}
            actions={<Segmented value={window} onChange={setWindow} options={[{ value: '1h', label: '1h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }]} />}
          />
          {stats.loading && !stats.data ? (
            <div className="flex h-[190px] items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <RequestBars data={stats.data?.series ?? []} bucketMs={stats.data?.bucketMs ?? 60_000} />
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[11px]">
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-muted"><span className="size-1.5 rounded-sm bg-magma" /> success</span>
              <span className="flex items-center gap-1.5 text-muted"><span className="size-1.5 rounded-sm bg-err" /> failed</span>
            </span>
            <span className="flex items-center gap-3 font-mono text-faint">
              <span>{formatNumber(stats.data?.fallbackEvents ?? 0)} fallback events</span>
              <span>{formatNumber(stats.data?.rateLimitEvents ?? 0)} rate limits</span>
            </span>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Gateway" description="Point any OpenAI or Anthropic compatible client here." icon={<Cable size={15} />} />
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">OpenAI compatible</span>
                <CopyChip value={status?.data?.app.gatewayBase ?? 'http://localhost:3000/v1'} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">Anthropic / Claude Code</span>
                <CopyChip value={`${status?.data?.app.gatewayBase ?? 'http://localhost:3000/v1'}/messages`} label="/v1/messages" />
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <Badge tone="magma">{status?.data?.routing.mode ?? 'priority'} routing</Badge>
                <Badge>{status?.data?.routing.profile ?? 'general'} profile</Badge>
                <Badge tone={status?.data?.routing.requireApiKey ? 'warn' : 'ok'}>{status?.data?.routing.requireApiKey ? 'API key required' : 'Localhost open'}</Badge>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3">
              <button type="button" onClick={() => navigate('router')} className="mx-focus flex items-center gap-2 rounded-lg border border-line bg-bg-elevated px-2.5 py-2 text-left text-[11px] text-muted transition hover:border-magma-line hover:text-fg">
                <Route size={13} className="text-magma" /> Failover chain
                <span className="ml-auto font-mono text-faint">{status?.data?.routing.chainLength ?? 0}</span>
              </button>
              <button type="button" onClick={() => navigate('models')} className="mx-focus flex items-center gap-2 rounded-lg border border-line bg-bg-elevated px-2.5 py-2 text-left text-[11px] text-muted transition hover:border-magma-line hover:text-fg">
                <Boxes size={13} className="text-magma" /> Enabled models
                <span className="ml-auto font-mono text-faint">{status?.data?.counts.enabledModels ?? 0}</span>
              </button>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Provider health"
              description="Live status from the last check."
              icon={<Plug size={15} />}
              actions={
                <Button variant="ghost" size="sm" onClick={() => navigate('providers')}>
                  Manage
                </Button>
              }
            />
            {providers.length === 0 ? (
              <p className="text-xs text-muted">No providers yet.</p>
            ) : (
              <div className="space-y-1.5">
                {providers.slice(0, 5).map((provider) => (
                  <div key={provider.id} className="flex items-center gap-2 rounded-lg border border-line bg-bg-elevated px-2.5 py-2">
                    <StatusDot status={provider.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11.5px] font-medium text-fg">{provider.label}</p>
                      <p className="truncate text-[10px] text-faint">{provider.models} models · {provider.enabled} enabled</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-[10px] text-muted">{formatLatency(provider.latencyMs)}</p>
                      <p className="text-[9px] text-faint">{formatRelative(provider.lastCheckAt)}</p>
                    </div>
                  </div>
                ))}
                {(status?.data?.routing.cooldowns ?? 0) > 0 ? (
                  <p className="flex items-center gap-1.5 pt-1 text-[10px] text-warn">
                    <TriangleAlert size={11} /> {status?.data?.routing.cooldowns} model(s) cooling down
                  </p>
                ) : null}
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
          <CardHeader title="Recent requests" description="Click a row for the full routing trace." icon={<Activity size={15} />} />
          <Button variant="ghost" size="sm" onClick={() => navigate('monitoring')} icon={<ArrowRight size={13} />}>
            Open monitoring
          </Button>
        </div>
        {requests.data?.items.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-y border-line bg-bg-elevated/50 text-[10px] uppercase tracking-[0.08em] text-faint">
                  <th className="px-5 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 text-right font-medium">Latency</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens</th>
                  <th className="px-5 py-2 text-right font-medium">Fallbacks</th>
                </tr>
              </thead>
              <tbody>
                {requests.data.items.map((request) => (
                  <tr key={request.id} onClick={() => setSelected(request)} className="cursor-pointer border-b border-line/70 text-[11.5px] transition hover:bg-panel-2/60">
                    <td className="px-5 py-2 font-mono text-[10px] text-faint">{formatRelative(request.ts)}</td>
                    <td className="px-3 py-2">
                      <Badge tone={request.status === 'success' ? 'ok' : request.status === 'error' ? 'err' : 'warn'} dot>
                        {request.status}
                      </Badge>
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2 font-mono text-[11px] text-fg">{shortModel(request.modelId ?? request.requestedModel)}</td>
                    <td className="px-3 py-2 text-muted">{request.providerName ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-mono text-[11px] text-muted">{formatLatency(request.latencyMs)}</td>
                    <td className="px-3 py-2 text-right font-mono text-[11px] text-muted">{formatTokens((request.inputTokens ?? 0) + (request.outputTokens ?? 0))}</td>
                    <td className="px-5 py-2 text-right font-mono text-[11px]">
                      {request.fallbackCount > 0 ? <span className="text-warn">{request.fallbackCount}</span> : <span className="text-faint">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 pb-5">
            <EmptyState
              icon={<Activity size={18} />}
              title="No requests yet"
              description="Send your first completion to /v1/chat/completions or connect Claude Code — every request appears here with its routing trace."
              action={
                <Button variant="secondary" size="sm" onClick={() => navigate('integrations')} icon={<Cable size={13} />}>
                  Connect a client
                </Button>
              }
            />
          </div>
        )}
      </Card>

      <RequestDetailModal record={selected} onClose={() => setSelected(null)} />
      <RouteTestModal open={testOpen} onClose={() => setTestOpen(false)} />
      <Modal open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} title="System diagnostics" description="Real checks against your database, encryption, failover engine, streaming, endpoints, providers and skills." width="max-w-2xl">
        <DiagnosticsRunner />
      </Modal>
    </div>
  );
}

export function RouteTestModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [prompt, setPrompt] = useState('Reply with the single word: ready');
  const [model, setModel] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const toast = useToast();

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const response = await api.post<TestResult>('/api/router/test', { prompt, model: model.trim() || undefined });
      setResult(response);
      if (response.ok) toast.push({ title: 'Routing works', description: `${response.provider} · ${response.model} · ${formatLatency(response.latencyMs)}`, tone: 'success' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setResult({ ok: false, error: message });
      toast.push({ title: 'Routing test failed', description: message, tone: 'error' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Test routing"
      description="Sends a real, tiny completion through the failover chain. Costs a few tokens on the selected provider."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={run} loading={running} icon={<Zap size={14} />}>
            Send test request
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Prompt" hint="max 4000 chars">
          <Input value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        </Field>
        <Field label="Requested model" hint="optional — leave empty for automatic routing">
          <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="e.g. llama-3.3-70b-versatile or a model alias" mono />
        </Field>
        {running ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={13} /> Routing through the live chain…
          </p>
        ) : null}
        {result ? (
          <div className={cx('rounded-lg border p-3', result.ok ? 'border-ok/30 bg-ok-soft/30' : 'border-err/30 bg-err-soft/30')}>
            {result.ok ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <Badge tone="ok">success</Badge>
                  <span className="font-medium text-fg">{result.provider}</span>
                  <span className="font-mono text-muted">{result.model}</span>
                  <span className="ml-auto font-mono text-faint">{formatLatency(result.latencyMs)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-bg-elevated p-2 font-mono text-[11px] text-fg">{result.response || '(empty response)'}</p>
                {result.attempts && result.attempts.length > 1 ? (
                  <div className="mt-2 space-y-1">
                    {result.attempts.map((attempt, index) => (
                      <p key={index} className="text-[10px] text-muted">
                        #{index + 1} {attempt.providerName} / {attempt.modelId} — {attempt.outcome}
                        {attempt.errorClass ? ` (${attempt.errorClass})` : ''}
                      </p>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <Badge tone="err">routing failed</Badge>
                <p className="mt-2 break-words text-[11px] leading-relaxed text-muted">{result.error}</p>
                {result.attempts?.length ? (
                  <div className="mt-2 space-y-1">
                    {result.attempts.map((attempt, index) => (
                      <p key={index} className="text-[10px] text-muted">
                        #{index + 1} {attempt.providerName} / {attempt.modelId} — {attempt.errorClass ?? attempt.outcome}
                        {attempt.message ? `: ${attempt.message.slice(0, 140)}` : ''}
                      </p>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
