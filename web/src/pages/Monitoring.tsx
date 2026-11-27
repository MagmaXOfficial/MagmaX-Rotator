import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, ArrowRightLeft, Clock, Filter, Radio, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useApi, useEventStream } from '../lib/hooks';
import { cx, formatCurrency, formatDateTime, formatLatency, formatNumber, formatRelative, formatTokens, shortModel } from '../lib/format';
import { Badge, Button, Card, CardHeader, ConfirmButton, EmptyState, Field, Input, PageHeader, Segmented, Select, Spinner, Stat, useToast } from '../components/ui';
import { Donut, MeterRow, RequestBars } from '../components/charts';
import { RequestDetailModal } from '../components/RequestDetail';
import type { EventRow, Model, RequestRecord, Stats } from '../lib/types';

type Tab = 'requests' | 'events' | 'logs' | 'breakdown';
type WindowKey = '1h' | '6h' | '24h' | '7d';
interface LogLine {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}

export function Monitoring() {
  const [tab, setTab] = useState<Tab>('requests');
  const [window, setWindow] = useState<WindowKey>('24h');
  const [statusFilter, setStatusFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const limit = 50;
  const [selected, setSelected] = useState<RequestRecord | null>(null);
  const [liveEvents, setLiveEvents] = useState<EventRow[]>([]);
  const [liveConnected, setLiveConnected] = useState(false);
  const toast = useToast();

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(page * limit), window });
    if (statusFilter) params.set('status', statusFilter);
    if (providerFilter) params.set('provider', providerFilter);
    if (search.trim()) params.set('search', search.trim());
    return params.toString();
  }, [page, window, statusFilter, providerFilter, search]);

  const stats = useApi<Stats>(`/api/monitoring/stats?window=${window}`, { refreshMs: 15_000 });
  const requests = useApi<{ items: RequestRecord[]; total: number }>(`/api/monitoring/requests?${query}`, { refreshMs: 10_000 });
  const events = useApi<{ events: EventRow[] }>('/api/monitoring/events?limit=80', { refreshMs: 20_000 });
  const logs = useApi<{ logs: LogLine[] }>(tab === 'logs' ? '/api/monitoring/logs?limit=250' : null, { refreshMs: 6000 });
  const models = useApi<{ models: Model[] }>('/api/models');
  const stream = useEventStream((event) => {
    setLiveConnected(true);
    setLiveEvents((current) =>
      [
        {
          id: event.id,
          ts: event.ts,
          type: event.type,
          level: event.type.includes('failed') || event.type.includes('error') ? 'warn' : 'info',
          provider: (event.data.provider as string) ?? null,
          model: (event.data.model as string) ?? null,
          requestId: (event.data.requestId as string) ?? null,
          message: describeEvent(event.type, event.data),
          meta: event.data,
        } satisfies EventRow,
        ...current,
      ].slice(0, 100),
    );
  });

  useEffect(() => {
    setPage(0);
  }, [window, statusFilter, providerFilter, search]);

  const providers = useMemo(() => {
    const map = new Map<string, string>();
    for (const model of models.data?.models ?? []) map.set(model.providerRowId, model.provider.label);
    for (const provider of stats.data?.byProvider ?? []) if (provider.providerRowId) map.set(provider.providerRowId, provider.providerName);
    return [...map.entries()];
  }, [models.data, stats.data]);

  const totals = stats.data?.totals;
  const combinedEvents = [...liveEvents.slice(0, 50), ...(events.data?.events ?? [])].filter((event, index, list) => list.findIndex((e) => e.id === event.id && e.type === event.type) === index).slice(0, 100);
  const totalPages = Math.max(1, Math.ceil((requests.data?.total ?? 0) / limit));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Monitoring"
        description="Every routed request, fallback, cooldown and error. Prompt logging stays off unless you explicitly enable it."
        actions={
          <>
            <Segmented value={window} onChange={setWindow} options={[{ value: '1h', label: '1h' }, { value: '6h', label: '6h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }]} />
            <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={() => { stats.refresh(); requests.refresh(); events.refresh(); }}>
              Refresh
            </Button>
            <ConfirmButton
              variant="danger"
              size="md"
              icon={<Trash2 size={13} />}
              confirmLabel="Delete all history?"
              onConfirm={async () => {
                try {
                  await api.del('/api/monitoring/requests');
                  toast.push({ title: 'Request history cleared', tone: 'info' });
                  stats.refresh();
                  requests.refresh();
                } catch (err) {
                  toast.push({ title: 'Could not clear history', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
                }
              }}
                          >
                Clear history
              </ConfirmButton>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Stat label="Requests" value={formatNumber(totals?.total ?? 0)} hint={`${window} · ${stats.data?.requestsPerMinute.toFixed(1) ?? '0'} / min`} icon={<Activity size={14} />} />
        <Stat label="Success" value={formatNumber(totals?.success ?? 0)} hint={`${stats.data?.successRate === null || stats.data?.successRate === undefined ? '—' : stats.data.successRate.toFixed(1)}% success rate`} icon={<Radio size={14} />} tone="ok" />
        <Stat label="Fallbacks" value={formatNumber(totals?.fallbackRequests ?? 0)} hint={`${formatNumber(stats.data?.rateLimitEvents ?? 0)} rate-limit events`} icon={<ArrowRightLeft size={14} />} />
        <Stat label="Tokens / cost" value={formatTokens((totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0))} hint={formatCurrency(totals?.cost ?? 0)} icon={<Clock size={14} />} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <Card>
          <CardHeader title="Traffic" description="Successful requests in magma, failures in red." icon={<Activity size={15} />} />
          <RequestBars data={stats.data?.series ?? []} bucketMs={stats.data?.bucketMs ?? 60_000} height={170} />
        </Card>
        <Card>
          <CardHeader title="Reliability" description="Share of requests that completed successfully." icon={<Radio size={15} />} />
          <Donut percent={stats.data?.successRate ?? null} sublabel="success" label={`Average latency ${formatLatency(totals?.avgLatency)} · first token ${formatLatency(totals?.avgTtfb)}. Cooldowns active: ${stats.data?.cooldowns.length ?? 0}.`} />
          <div className="mt-3 space-y-2 border-t border-line pt-3">
            {(stats.data?.byProvider ?? []).slice(0, 4).map((provider) => (
              <MeterRow
                key={provider.providerRowId ?? provider.providerName}
                label={provider.providerName ?? 'unknown'}
                value={provider.total}
                max={Math.max(1, ...(stats.data?.byProvider ?? []).map((item) => item.total))}
                hint={`${formatNumber(provider.total)} req · ${provider.error} err`}
                tone={provider.error > provider.success ? 'err' : 'ok'}
              />
            ))}
            {(stats.data?.byProvider.length ?? 0) === 0 ? <p className="text-[11px] text-faint">No provider traffic in this window.</p> : null}
          </div>
        </Card>
      </div>

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 pt-3">
          {(
            [
              { id: 'requests', label: 'Requests', icon: Activity },
              { id: 'events', label: 'Live events', icon: Radio },
              { id: 'logs', label: 'Logs', icon: ScrollText },
              { id: 'breakdown', label: 'Breakdown', icon: Filter },
            ] as Array<{ id: Tab; label: string; icon: typeof Activity }>
          ).map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cx(
                  'mx-focus relative -mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12px] font-medium transition',
                  tab === item.id ? 'border-magma text-fg' : 'border-transparent text-muted hover:text-fg',
                )}
              >
                <Icon size={12} /> {item.label}
                {item.id === 'events' ? <span className={cx('ml-1 size-1.5 rounded-full', stream.connected ? 'bg-ok' : 'bg-faint')} /> : null}
              </button>
            );
          })}
          <span className="ml-auto flex items-center gap-2 pb-2 text-[10px] text-faint">
            <span className={cx('size-1.5 rounded-full', stream.connected ? 'bg-ok mx-pulse' : 'bg-faint')} />
            {stream.connected ? 'live stream connected' : 'live stream offline'}
          </span>
        </div>

        {tab === 'requests' ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
              <div className="relative min-w-[200px] flex-1">
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search request id, model or error…"
                  className="h-8"
                />
              </div>
              <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-8 w-auto">
                <option value="">Any status</option>
                <option value="success">Success</option>
                <option value="error">Error</option>
                <option value="cancelled">Cancelled</option>
                <option value="streaming">Streaming</option>
              </Select>
              <Select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} className="h-8 w-auto">
                <option value="">Any provider</option>
                {providers.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
              <span className="font-mono text-[10px] text-faint">{formatNumber(requests.data?.total ?? 0)} total</span>
            </div>
            {requests.loading && !requests.data ? (
              <div className="flex h-40 items-center justify-center"><Spinner /></div>
            ) : requests.data?.items.length === 0 ? (
              <div className="p-5">
                <EmptyState icon={<Activity size={18} />} title="No requests match" description="Adjust the filters or send a request through /v1/chat/completions." />
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1000px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-line bg-bg-elevated/50 text-[10px] uppercase tracking-[0.08em] text-faint">
                        <th className="px-4 py-2 font-medium">Timestamp</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium">Requested</th>
                        <th className="px-2 py-2 font-medium">Routed model</th>
                        <th className="px-2 py-2 font-medium">Provider</th>
                        <th className="px-2 py-2 text-right font-medium">Latency</th>
                        <th className="px-2 py-2 text-right font-medium">Tokens</th>
                        <th className="px-2 py-2 text-right font-medium">Cost</th>
                        <th className="px-4 py-2 text-right font-medium">Fallback</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requests.data.items.map((request) => (
                        <tr key={request.id} onClick={() => setSelected(request)} className="cursor-pointer border-b border-line/60 text-[11.5px] transition hover:bg-panel-2/60">
                          <td className="whitespace-nowrap px-4 py-2 font-mono text-[10px] text-faint">{formatDateTime(request.ts)}</td>
                          <td className="px-2 py-2">
                            <Badge tone={request.status === 'success' ? 'ok' : request.status === 'error' ? 'err' : 'warn'} dot>
                              {request.status}
                            </Badge>
                            {request.stream ? <Badge tone="info" className="ml-1">SSE</Badge> : null}
                          </td>
                          <td className="max-w-[140px] truncate px-2 py-2 font-mono text-[10px] text-faint">{request.requestedModel ?? 'auto'}</td>
                          <td className="max-w-[180px] truncate px-2 py-2 font-mono text-[10.5px] text-fg">{shortModel(request.modelId) || '—'}</td>
                          <td className="px-2 py-2 text-muted">{request.providerName ?? '—'}</td>
                          <td className="px-2 py-2 text-right font-mono text-[10.5px] text-muted">{formatLatency(request.latencyMs)}</td>
                          <td className="px-2 py-2 text-right font-mono text-[10.5px] text-muted">{formatTokens((request.inputTokens ?? 0) + (request.outputTokens ?? 0))}</td>
                          <td className="px-2 py-2 text-right font-mono text-[10.5px] text-muted">{request.costUsd === null ? '—' : formatCurrency(request.costUsd)}</td>
                          <td className="px-4 py-2 text-right font-mono text-[10.5px]">
                            {request.fallbackCount ? <span className="text-warn">{request.fallbackCount}</span> : <span className="text-faint">0</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[10.5px] text-faint">
                  <span>
                    Page {page + 1} of {totalPages}
                  </span>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                      Previous
                    </Button>
                    <Button size="sm" variant="ghost" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        ) : null}

        {tab === 'events' ? (
          <div className="p-4">
            <div className="space-y-1.5">
              {combinedEvents.length === 0 ? <EmptyState icon={<Radio size={18} />} title="No events yet" description="Routing, fallback, provider health and skill events appear here in real time." /> : null}
              {combinedEvents.map((event) => (
                <div key={`${event.type}-${event.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-elevated px-2.5 py-1.5 text-[10.5px]">
                  <span className={cx('size-1.5 shrink-0 rounded-full', event.type.includes('failed') ? 'bg-warn' : event.type.includes('success') || event.type.includes('installed') ? 'bg-ok' : 'bg-info')} />
                  <span className="w-[150px] shrink-0 truncate font-mono text-faint">{event.type}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{event.message}</span>
                  {event.provider ? <Badge>{event.provider}</Badge> : null}
                  <span className="shrink-0 font-mono text-[9.5px] text-faint">{formatRelative(event.ts)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {tab === 'logs' ? (
          <div className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] text-muted">Structured server logs (credentials are redacted).</p>
              <Button size="sm" variant="ghost" onClick={logs.refresh}>Refresh</Button>
            </div>
            {logs.loading && !logs.data ? <Spinner /> : null}
            <div className="space-y-0.5 font-mono text-[10.5px]">
              {(logs.data?.logs ?? []).slice().reverse().map((line, index) => (
                <div key={`${line.ts}-${index}`} className="flex gap-2 rounded px-1.5 py-1 hover:bg-panel-2/50">
                  <span className="w-[70px] shrink-0 text-faint">{new Date(line.ts).toLocaleTimeString()}</span>
                  <span className={cx('w-[42px] shrink-0 uppercase', line.level === 'error' ? 'text-err' : line.level === 'warn' ? 'text-warn' : 'text-faint')}>{line.level}</span>
                  <span className="w-[170px] shrink-0 truncate text-muted">{line.msg}</span>
                  <span className="min-w-0 flex-1 truncate text-faint">{line.meta ? JSON.stringify(line.meta) : ''}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {tab === 'breakdown' ? (
          <div className="grid gap-4 p-4 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-faint">By provider</p>
              <div className="space-y-1.5">
                {(stats.data?.byProvider ?? []).map((provider) => (
                  <div key={provider.providerRowId ?? provider.providerName} className="rounded-lg border border-line bg-bg-elevated px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate text-fg">{provider.providerName}</span>
                      <span className="font-mono text-faint">{formatNumber(provider.total)} req</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
                      <span>{formatLatency(provider.avgLatency)} avg · {formatTokens(provider.tokens)} tokens</span>
                      <span className={provider.error > 0 ? 'text-err' : 'text-ok'}>{provider.error} errors</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-faint">Top models</p>
              <div className="space-y-1">
                {(stats.data?.byModel ?? []).slice(0, 10).map((model) => (
                  <div key={`${model.modelId}-${model.providerName}`} className="flex items-center gap-2 rounded border border-line bg-bg-elevated px-2 py-1.5 text-[10.5px]">
                    <span className="min-w-0 flex-1 truncate font-mono text-fg">{shortModel(model.modelId)}</span>
                    <span className="shrink-0 text-faint">{model.providerName}</span>
                    <span className="shrink-0 font-mono text-muted">{formatNumber(model.total)}</span>
                    <span className={cx('shrink-0 font-mono', model.error ? 'text-err' : 'text-faint')}>{model.error}</span>
                  </div>
                ))}
              </div>
              <p className="mb-2 mt-4 text-[11px] font-medium uppercase tracking-[0.1em] text-faint">Errors</p>
              <div className="space-y-1">
                {(stats.data?.errors ?? []).length === 0 ? <p className="text-[11px] text-faint">No errors in this window.</p> : null}
                {(stats.data?.errors ?? []).map((error) => (
                  <div key={error.code} className="rounded border border-line bg-bg-elevated px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2 text-[10.5px]">
                      <span className="flex items-center gap-1 font-mono text-err"><AlertTriangle size={10} /> {error.code}</span>
                      <span className="font-mono text-faint">{error.count}</span>
                    </div>
                    {error.lastMessage ? <p className="mt-0.5 truncate text-[9.5px] text-faint">{error.lastMessage}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </Card>

      <RequestDetailModal record={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function describeEvent(type: string, data: Record<string, unknown>): string {
  const provider = typeof data.provider === 'string' ? data.provider : '';
  const model = typeof data.model === 'string' ? data.model : '';
  if (type === 'route_attempt_failed') return `${provider} / ${model} failed: ${data.errorClass ?? 'error'} ${data.status ?? ''}${data.message ? ` — ${String(data.message).slice(0, 120)}` : ''}`;
  if (type === 'route_success') return `${provider} / ${model} succeeded in ${data.latencyMs ?? '?'}ms after ${data.attempts ?? 1} attempt(s)`;
  if (type === 'route_started') return `Routing started (${data.mode} · ${data.profile}) across ${data.candidates} candidates`;
  if (type === 'provider_status') return `${provider} → ${data.status}${data.message ? `: ${String(data.message).slice(0, 120)}` : ''}`;
  if (type === 'skill_run') return `Skill ${data.id} ${data.status} in ${data.durationMs}ms`;
  if (type === 'route_continued') return `Continued ${model} after hitting its output limit`;
  return `${type}${provider ? ` · ${provider}` : ''}`;
}

export default Monitoring;
