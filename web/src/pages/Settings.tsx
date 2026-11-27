import { useEffect, useRef, useState } from 'react';
import { Database, Download, HardDrive, Info, KeyRound, Lock, RefreshCw, Server, ShieldCheck, Stethoscope, Upload, Webhook } from 'lucide-react';
import { api, ApiError, getAdminToken, setAdminToken } from '../lib/api';
import { useApi } from '../lib/hooks';
import { cx, formatDateTime } from '../lib/format';
import { Badge, Button, Card, CardHeader, CodeBlock, ConfirmButton, CopyChip, Field, Input, PageHeader, Segmented, Spinner, Switch, useToast } from '../components/ui';
import { DiagnosticsRunner } from '../components/Diagnostics';
import type { RouterSettings, StatusResponse } from '../lib/types';

interface SettingsPayload extends RouterSettings {
  apiKey: string;
  adminToken: string;
  requireApiKey: boolean;
  storePayloads: boolean;
  rateLimitPerMinute: number;
  maxBodyKb: number;
  allowExternalBind: boolean;
  logLevel: string;
}

interface SettingsResponse {
  settings: SettingsPayload;
  hasAdminToken: boolean;
  endpoints: Record<string, string>;
  paths: { dataDir: string; dbPath: string; webDist: string };
}

type Tab = 'general' | 'security' | 'data' | 'diagnostics';

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('general');
  const status = useApi<StatusResponse>('/api/status', { refreshMs: 15_000 });
  const settings = useApi<SettingsResponse>('/api/settings');
  const backup = useApi<{ size: number; counts: Record<string, number> }>('/api/backup/size', { refreshMs: 30_000 });
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [adminTokenInput, setAdminTokenInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [limits, setLimits] = useState({ rateLimitPerMinute: 240, maxBodyKb: 2048 });
  const [limitsDirty, setLimitsDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data && !limitsDirty) {
      setLimits({ rateLimitPerMinute: settings.data.settings.rateLimitPerMinute, maxBodyKb: settings.data.settings.maxBodyKb });
    }
  }, [settings.data, limitsDirty]);

  const patch = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      await api.patch('/api/settings', body);
      toast.push({ title: 'Setting saved', description: label, tone: 'success' });
      settings.refresh();
    } catch (err) {
      toast.push({ title: 'Could not save', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const download = async (path: string, filename: string) => {
    try {
      const token = getAdminToken();
      const response = await fetch(path, { headers: token ? { 'x-admin-token': token } : {} });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.push({ title: 'Download started', description: filename, tone: 'success' });
    } catch (err) {
      toast.push({ title: 'Download failed', description: err instanceof Error ? err.message : String(err), tone: 'error' });
    }
  };

  const s = settings.data?.settings;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Server, security, data and diagnostics. Everything is stored locally in SQLite."
        actions={
          <>
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: 'general', label: 'General' },
                { value: 'security', label: 'Security' },
                { value: 'data', label: 'Data' },
                { value: 'diagnostics', label: 'Diagnostics' },
              ]}
            />
            <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={() => { settings.refresh(); status.refresh(); backup.refresh(); }}>
              Refresh
            </Button>
          </>
        }
      />

      {tab === 'general' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="Server" description="Runtime information for this gateway instance." icon={<Server size={15} />} />
            {settings.loading && !settings.data ? (
              <Spinner />
            ) : (
              <div className="space-y-1.5">
                {[
                  ['Version', status.data?.app.version ?? '—'],
                  ['Uptime', status.data ? `${Math.floor(status.data.app.uptimeSeconds / 60)}m ${status.data.app.uptimeSeconds % 60}s` : '—'],
                  ['Node', status.data?.app.node ?? '—'],
                  ['PID', String(status.data?.app.pid ?? '—')],
                  ['Binding', `${status.data?.app.host ?? '—'}:${status.data?.app.port ?? '—'}`],
                  ['Local only', status.data?.app.localOnly ? 'yes — no external interface' : 'no — network exposed'],
                  ['Dashboard bundle', status.data?.app.dashboardBuilt ? 'built' : 'not built'],
                  ['Live SSE clients', String(status.data?.counts.liveClients ?? 0)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3 border-b border-line/60 py-1 text-[11px] last:border-0">
                    <span className="text-muted">{label}</span>
                    <span className="truncate font-mono text-[10.5px] text-fg">{value}</span>
                  </div>
                ))}
                <div className="pt-2">
                  <p className="mb-1 text-[10px] uppercase tracking-[0.08em] text-faint">Data directory</p>
                  <CopyChip value={settings.data?.paths.dataDir ?? './data'} />
                </div>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="API endpoints" description="The gateway speaks both protocols on the same port." icon={<Webhook size={15} />} />
            <div className="space-y-1.5">
              {Object.entries(settings.data?.endpoints ?? {}).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-bg-elevated px-2.5 py-1.5">
                  <span className="text-[11px] capitalize text-muted">{key.replace(/([A-Z])/g, ' $1')}</span>
                  <CopyChip value={value} label={value.replace(/^https?:\/\/[^/]+/, '')} />
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-lg border border-line bg-bg-elevated p-2.5 text-[10.5px] leading-relaxed text-muted">
              Binding to <span className="font-mono text-fg">127.0.0.1</span> is the default. To expose the gateway on your LAN, restart with{' '}
              <span className="font-mono text-fg">npm start -- --host 0.0.0.0</span> and turn on API key authentication first.
            </div>
          </Card>

          <Card className="xl:col-span-2">
            <CardHeader title="About this build" description="MagmaX Rotator 1.0.0 — local AI gateway." icon={<Info size={15} />} />
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-line bg-bg-elevated p-3">
                <p className="text-[11px] font-medium text-fg">Backend</p>
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted">TypeScript + Hono on Node 22+, SQLite via <span className="font-mono">node:sqlite</span>, AES-256-GCM secret storage, SSE for live events.</p>
              </div>
              <div className="rounded-lg border border-line bg-bg-elevated p-3">
                <p className="text-[11px] font-medium text-fg">Frontend</p>
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted">React 19 + Vite + Tailwind CSS 4, hand-built chart primitives, no telemetry.</p>
              </div>
              <div className="rounded-lg border border-line bg-bg-elevated p-3">
                <p className="text-[11px] font-medium text-fg">Scope</p>
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted">Chat completions and Anthropic Messages, failover, model catalogues, skills and MCP. No embeddings or Responses API.</p>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'security' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="Gateway authentication" description="Protect /v1 when the server is reachable by other machines." icon={<Lock size={15} />} />
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-bg-elevated p-3">
                <div>
                  <p className="text-[11.5px] font-medium text-fg">Require an API key</p>
                  <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted">When enabled, clients must send <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>. Claude Code uses the same value as ANTHROPIC_AUTH_TOKEN.</p>
                </div>
                <Switch checked={s?.requireApiKey ?? false} label="Require API key" onChange={(value) => patch({ requireApiKey: value }, value ? 'API key required' : 'API key not required')} />
              </div>
              <Field label="Router API key" hint="local only — rotate if leaked">
                <div className="flex gap-2">
                  <Input readOnly value={showApiKey ? s?.apiKey ?? '' : mask(s?.apiKey ?? '')} mono className="flex-1" />
                  <Button variant="ghost" size="sm" onClick={() => setShowApiKey((v) => !v)}>
                    {showApiKey ? 'Hide' : 'Reveal'}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => s?.apiKey && navigator.clipboard?.writeText(s.apiKey)} icon={<KeyRound size={12} />}>
                    Copy
                  </Button>
                </div>
              </Field>
              <ConfirmButton
                variant="danger"
                size="sm"
                confirmLabel="Rotate key now?"
                onConfirm={async () => {
                  try {
                    const result = await api.post<{ apiKey: string }>('/api/settings/rotate-api-key');
                    toast.push({ title: 'API key rotated', description: 'Update connected clients with the new key.', tone: 'warning' });
                    setShowApiKey(true);
                    void result;
                    settings.refresh();
                  } catch (err) {
                    toast.push({ title: 'Rotation failed', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
                  }
                }}
              >
                Rotate API key
              </ConfirmButton>
              <p className="flex gap-1.5 text-[10px] leading-relaxed text-faint">
                <ShieldCheck size={11} className="mt-0.5 shrink-0" /> Provider API keys are encrypted with AES-256-GCM using <span className="font-mono">data/master.key</span> (0600). They are never returned by any endpoint.
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Dashboard access" description="Optional admin token for /api. Leave empty for localhost-only use." icon={<ShieldCheck size={15} />} />
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">Status</span>
                <Badge tone={settings.data?.hasAdminToken ? 'ok' : 'neutral'}>{settings.data?.hasAdminToken ? 'token set' : 'open on localhost'}</Badge>
              </div>
              <Field label="Admin token" hint="stored in this browser after saving">
                <Input type="password" value={adminTokenInput} onChange={(event) => setAdminTokenInput(event.target.value)} placeholder={settings.data?.hasAdminToken ? '•••••••• (set)' : 'empty = no dashboard auth'} mono />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  loading={busy === 'Admin token'}
                  disabled={!adminTokenInput.trim()}
                  onClick={async () => {
                    await patch({ adminToken: adminTokenInput }, 'Admin token');
                    setAdminToken(adminTokenInput);
                    setAdminTokenInput('');
                  }}
                >
                  Set token
                </Button>
                <Button
                  variant="ghost"
                  disabled={!settings.data?.hasAdminToken}
                  onClick={async () => {
                    await api.patch('/api/settings', { adminToken: '' });
                    setAdminToken('');
                    toast.push({ title: 'Admin token cleared', description: 'The dashboard is open again on localhost.', tone: 'info' });
                    settings.refresh();
                  }}
                >
                  Clear token
                </Button>
              </div>
              <p className="text-[10px] leading-relaxed text-faint">
                If you lose the token, stop the server and clear the <span className="font-mono">adminToken</span> setting in <span className="font-mono">data/magmax.db</span> (see README troubleshooting).
              </p>
            </div>
          </Card>

          <Card className="xl:col-span-2">
            <CardHeader title="Limits & privacy" description="Applied before any provider call." icon={<Lock size={15} />} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Rate limit" hint="requests per minute">
                <Input type="number" min={10} value={limits.rateLimitPerMinute} onChange={(event) => { setLimits({ ...limits, rateLimitPerMinute: Number(event.target.value) }); setLimitsDirty(true); }} />
              </Field>
              <Field label="Max request body" hint="kilobytes">
                <Input type="number" min={16} value={limits.maxBodyKb} onChange={(event) => { setLimits({ ...limits, maxBodyKb: Number(event.target.value) }); setLimitsDirty(true); }} />
              </Field>
              <div className="flex items-end">
                <Button
                  variant="secondary"
                  disabled={!limitsDirty}
                  loading={busy === 'Limits'}
                  onClick={async () => {
                    await patch(limits, 'Limits');
                    setLimitsDirty(false);
                  }}
                >
                  Save limits
                </Button>
              </div>
            </div>
            <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-line bg-bg-elevated p-3">
              <div>
                <p className="text-[11.5px] font-medium text-fg">Store prompt and response samples</p>
                <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted">Off by default. When enabled, the first 4 KB of each request and response is stored in the local database for the request inspector.</p>
              </div>
              <Switch checked={s?.storePayloads ?? false} label="Store payload samples" onChange={(value) => patch({ storePayloads: value }, value ? 'Payload logging on' : 'Payload logging off')} />
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'data' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="Local storage" description="SQLite in WAL mode under the data directory." icon={<Database size={15} />} />
            <div className="space-y-1.5">
              <Row label="Database size" value={`${((backup.data?.size ?? 0) / 1024).toFixed(1)} KB`} />
              <Row label="Database path" value={settings.data?.paths.dbPath ?? '—'} mono />
              {Object.entries(backup.data?.counts ?? {}).map(([table, count]) => (
                <Row key={table} label={table} value={String(count)} />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" icon={<Download size={12} />} onClick={() => download('/api/backup/download', `magmax-${new Date().toISOString().slice(0, 10)}.db`)}>
                Download database
              </Button>
              <Button variant="ghost" size="sm" icon={<HardDrive size={12} />} onClick={backup.refresh}>
                Refresh size
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="Configuration export" description="Settings, aliases and model preferences. API keys are excluded by design." icon={<Upload size={15} />} />
            <div className="space-y-2">
              <p className="text-[10.5px] leading-relaxed text-muted">Use this to move routing configuration between machines. Re-add provider keys after importing.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" icon={<Download size={12} />} onClick={() => download('/api/settings/export', 'magmax-config.json')}>
                  Export config
                </Button>
                <Button variant="outline" size="sm" icon={<Upload size={12} />} onClick={() => fileRef.current?.click()}>
                  Import config
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      const text = await file.text();
                      const parsed = JSON.parse(text) as Record<string, unknown>;
                      const result = await api.post<{ imported: { settings: number; aliases: number } }>('/api/settings/import', parsed);
                      toast.push({ title: 'Configuration imported', description: `${result.imported.settings} settings · ${result.imported.aliases} aliases`, tone: 'success' });
                      settings.refresh();
                    } catch (err) {
                      toast.push({ title: 'Import failed', description: err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err), tone: 'error' });
                    } finally {
                      event.target.value = '';
                    }
                  }}
                />
              </div>
              <div className="rounded-lg border border-warn/30 bg-warn-soft/30 p-2.5 text-[10px] leading-relaxed text-muted">
                Requests older than 30 days are pruned automatically every six hours. Prompt logging is a separate opt-in.
              </div>
            </div>
          </Card>

          <Card className="xl:col-span-2">
            <CardHeader title="Maintenance" description="These actions affect local data only." icon={<HardDrive size={15} />} />
            <div className="flex flex-wrap items-center gap-2">
              <ConfirmButton
                variant="danger"
                size="md"
                confirmLabel="Delete all request history?"
                onConfirm={async () => {
                  await api.del('/api/monitoring/requests');
                  toast.push({ title: 'Request history cleared', tone: 'info' });
                  backup.refresh();
                }}
              >
                Clear request history
              </ConfirmButton>
              <Button
                variant="secondary"
                size="md"
                icon={<Stethoscope size={13} />}
                onClick={async () => {
                  await api.post('/api/health/run');
                  toast.push({ title: 'Provider health checks triggered', tone: 'info' });
                  status.refresh();
                }}
              >
                Run provider health checks
              </Button>
              <span className="text-[10px] text-faint">Last check {formatDateTime(status.data?.providers[0]?.lastCheckAt ?? null)}</span>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'diagnostics' ? (
        <Card>
          <CardHeader title="System diagnostics" description="Real checks — database writes, AES tamper detection, HTTP failover with a local upstream, SSE parsing, endpoints, providers and a sandboxed skill run." icon={<Stethoscope size={15} />} />
          <DiagnosticsRunner />
        </Card>
      ) : null}

    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/60 py-1 text-[11px] last:border-0">
      <span className="text-muted">{label}</span>
      <span className={cx('max-w-[65%] truncate text-right text-[10.5px] text-fg', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 6)}${'•'.repeat(Math.max(6, value.length - 12))}${value.slice(-4)}`;
}

export default SettingsPage;
