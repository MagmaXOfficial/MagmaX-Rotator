import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { cx, formatLatency, formatRelative } from '../lib/format';
import { Badge, Button, Card, CardHeader, ConfirmButton, CopyChip, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, StatusDot, Switch, useToast } from '../components/ui';
import type { Provider, ProviderDefinition, ProviderKey } from '../lib/types';

interface ProvidersResponse {
  providers: Provider[];
  registry: ProviderDefinition[];
}

type Tier = 'priority' | 'additional' | 'local';

const TIER_LABEL: Record<string, string> = {
  free: 'free',
  paid: 'paid',
  local: 'local',
  limited: 'limited / free tier',
  unknown: 'access unknown',
};

export function Providers() {
  const { data, loading, refresh } = useApi<ProvidersResponse>('/api/providers', { refreshMs: 20_000 });
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [keyTarget, setKeyTarget] = useState<Provider | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const providers = data?.providers ?? [];
  const registry = data?.registry ?? [];

  const act = async (id: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(`${id}:${label}`);
    try {
      await fn();
      refresh();
    } catch (err) {
      toast.push({ title: `${label} failed`, description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Providers"
        description="Keys are encrypted with AES-256-GCM on disk and never returned by the API. Validating a key performs a real request to the provider."
        actions={
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAddOpen(true)}>
            Add provider
          </Button>
        }
      />

      {providers.length === 0 && !loading ? (
        <EmptyState
          icon={<KeyRound size={18} />}
          title="No providers connected"
          description="Pick a provider, paste a key, and MagmaX validates it and imports the real model catalogue. Keyless local runtimes work at their default ports."
          action={
            <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={() => setAddOpen(true)}>
              Connect your first provider
            </Button>
          }
        />
      ) : null}

      <div className="grid gap-3 xl:grid-cols-2">
        {providers.map((provider) => {
          const definition = provider.definition;
          const isBusy = busy?.startsWith(`${provider.id}:`);
          return (
            <Card key={provider.id} className={cx(!provider.active && 'opacity-70')}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-bg-elevated text-[11px] font-semibold text-magma">
                    {provider.label.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="truncate text-[13px] font-semibold text-fg">{provider.label}</h3>
                      <StatusDot status={provider.status} />
                      <Badge tone={provider.active ? 'ok' : 'neutral'}>{provider.active ? 'active' : 'disabled'}</Badge>
                      {definition ? <Badge tone={definition.tier === 'local' ? 'info' : definition.tier === 'free' ? 'ok' : 'neutral'}>{TIER_LABEL[definition.tier]}</Badge> : null}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-faint">{provider.baseUrl || 'base URL required'}</p>
                  </div>
                </div>
                <Switch
                  checked={provider.active}
                  label={`Enable ${provider.label}`}
                  disabled={isBusy}
                  onChange={(value) =>
                    act(provider.id, value ? 'Enable' : 'Disable', () => api.patch(`/api/providers/${provider.id}`, { active: value })).then(() =>
                      toast.push({ title: value ? 'Provider enabled' : 'Provider disabled', tone: 'info' }),
                    )
                  }
                />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MiniInfo label="Models" value={`${provider.modelCount}`} hint={`${provider.enabledCount} enabled`} />
                <MiniInfo label="Latency" value={formatLatency(provider.latencyMs)} hint="last check" />
                <MiniInfo label="Keys" value={`${provider.keys.length}`} hint={provider.keys[0]?.keyHint ?? '—'} />
                <MiniInfo label="Checked" value={formatRelative(provider.lastCheckAt)} hint={provider.statusMessage?.slice(0, 26) ?? 'not yet'} />
              </div>

              {provider.status === 'error' && provider.statusMessage ? (
                <div className="mt-2.5 flex gap-2 rounded-lg border border-err/30 bg-err-soft/40 px-2.5 py-2 text-[11px] text-muted">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-err" />
                  <span className="break-words">{provider.statusMessage}</span>
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={isBusy ? <Spinner size={12} /> : <Zap size={12} />}
                  disabled={isBusy}
                  onClick={() =>
                    act(provider.id, 'Test', async () => {
                      const result = await api.post<{ test: { ok: boolean; message: string; latencyMs: number | null } }>(`/api/providers/${provider.id}/test`);
                      toast.push({
                        title: result.test.ok ? `${provider.label} connected` : `${provider.label} test failed`,
                        description: `${result.test.message}${result.test.latencyMs ? ` · ${formatLatency(result.test.latencyMs)}` : ''}`,
                        tone: result.test.ok ? 'success' : 'error',
                      });
                    })
                  }
                >
                  Test
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<RefreshCw size={12} />}
                  disabled={isBusy}
                  onClick={() =>
                    act(provider.id, 'Sync', async () => {
                      const result = await api.post<{ total: number; added: number; updated: number }>(`/api/providers/${provider.id}/sync`);
                      toast.push({ title: 'Model catalogue synced', description: `${result.total} models · ${result.added} new · ${result.updated} updated`, tone: 'success' });
                    })
                  }
                >
                  Sync models
                </Button>
                <Button size="sm" variant="ghost" icon={<KeyRound size={12} />} onClick={() => setKeyTarget(provider)}>
                  Add key
                </Button>
                <IconButton label="Edit provider" onClick={() => setEditing(provider)}>
                  <Pencil size={13} />
                </IconButton>
                {definition?.keyHelpUrl ? (
                  <a href={definition.keyHelpUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted transition hover:text-fg">
                    Get a key <ExternalLink size={11} />
                  </a>
                ) : null}
                <ConfirmButton
                  icon={<Trash2 size={12} />}
                  onConfirm={() =>
                    act(provider.id, 'Remove', async () => {
                      await api.del(`/api/providers/${provider.id}`);
                      toast.push({ title: `${provider.label} removed`, tone: 'info' });
                    })
                  }
                >
                  Remove
                </ConfirmButton>
              </div>

              {provider.keys.length > 0 ? (
                <div className="mt-3 space-y-1.5 border-t border-line pt-3">
                  <p className="text-[10px] uppercase tracking-[0.08em] text-faint">Keys · rotated automatically on auth failures</p>
                  {provider.keys.map((key) => (
                    <KeyRow key={key.id} provider={provider} item={key} onChange={refresh} />
                  ))}
                </div>
              ) : null}

              {definition?.notes ? (
                <p className="mt-3 rounded-lg border border-line bg-bg-elevated px-2.5 py-2 text-[10.5px] leading-relaxed text-muted">{definition.notes}</p>
              ) : null}
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader
          title="Provider catalogue"
          description="Real, documented endpoints. Tiers reflect each provider's published access model — verify current pricing on the provider site."
          icon={<ShieldCheck size={15} />}
        />
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {(['priority', 'additional', 'local'] as Tier[]).map((tier) => (
            <div key={tier} className="space-y-2">
              <p className="text-[10px] uppercase tracking-[0.1em] text-faint">{tier === 'priority' ? 'Priority providers' : tier === 'additional' ? 'Additional providers' : 'Local / keyless'}</p>
              {registry
                .filter((item) => item.category === tier)
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setAddOpen(true)}
                    className="mx-focus flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg-elevated px-2.5 py-2 text-left transition hover:border-magma-line"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[11.5px] font-medium text-fg">{item.name}</span>
                        {item.connected ? <CheckCircle2 size={11} className="shrink-0 text-ok" /> : null}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-faint">{TIER_LABEL[item.tier]}{item.keyless ? ' · no key' : ''}</span>
                    </span>
                    <Plus size={12} className="shrink-0 text-faint" />
                  </button>
                ))}
            </div>
          ))}
        </div>
      </Card>

      <AddProviderModal open={addOpen} onClose={() => setAddOpen(false)} registry={registry} onDone={refresh} />
      {editing ? <EditProviderModal provider={editing} onClose={() => setEditing(null)} onDone={refresh} /> : null}
      {keyTarget ? <AddKeyModal provider={keyTarget} onClose={() => setKeyTarget(null)} onDone={refresh} /> : null}
    </div>
  );
}

function MiniInfo({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg-elevated px-2.5 py-1.5">
      <p className="text-[9.5px] uppercase tracking-[0.08em] text-faint">{label}</p>
      <p className="mt-0.5 text-[12px] font-medium text-fg">{value}</p>
      {hint ? <p className="truncate text-[9.5px] text-faint">{hint}</p> : null}
    </div>
  );
}

function KeyRow({ provider, item, onChange }: { provider: Provider; item: ProviderKey; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-elevated px-2.5 py-1.5">
      <span className="text-[11px] text-fg">{item.label}</span>
      <span className="font-mono text-[10px] text-muted">{item.keyHint}</span>
      {item.failures > 0 ? <Badge tone="err">{item.failures} failure{item.failures === 1 ? '' : 's'}</Badge> : null}
      {item.lastError ? <span className="min-w-0 flex-1 truncate text-[10px] text-faint" title={item.lastError}>{item.lastError}</span> : <span className="flex-1" />}
      <Switch
        checked={item.active}
        label="Key active"
        disabled={busy}
        onChange={async (value) => {
          setBusy(true);
          try {
            await api.patch(`/api/providers/${provider.id}/keys/${item.id}`, { active: value });
            onChange();
          } catch (err) {
            toast.push({ title: 'Could not update key', description: String(err), tone: 'error' });
          } finally {
            setBusy(false);
          }
        }}
      />
      <IconButton
        label="Delete key"
        onClick={async () => {
          try {
            await api.del(`/api/providers/${provider.id}/keys/${item.id}`);
            toast.push({ title: 'Key deleted', tone: 'info' });
            onChange();
          } catch (err) {
            toast.push({ title: 'Could not delete key', description: String(err), tone: 'error' });
          }
        }}
      >
        <Trash2 size={12} />
      </IconButton>
    </div>
  );
}

function AddProviderModal({ open, onClose, registry, onDone }: { open: boolean; onClose: () => void; registry: ProviderDefinition[]; onDone: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [accountId, setAccountId] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; modelCount?: number } | null>(null);
  const toast = useToast();
  const selected = registry.find((item) => item.id === selectedId) ?? null;

  const grouped = useMemo(() => {
    return {
      priority: registry.filter((p) => p.category === 'priority'),
      additional: registry.filter((p) => p.category === 'additional'),
      local: registry.filter((p) => p.category === 'local'),
    };
  }, [registry]);

  const reset = () => {
    setSelectedId(null);
    setApiKey('');
    setLabel('');
    setBaseUrl('');
    setAccountId('');
    setResult(null);
    setConnecting(false);
  };

  const connect = async () => {
    if (!selected) return;
    setConnecting(true);
    setResult(null);
    try {
      const response = await api.post<{ ok: boolean; test: { ok: boolean; message: string; modelCount: number } }>('/api/providers', {
        providerId: selected.id,
        apiKey: apiKey.trim() || undefined,
        label: label.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        accountId: accountId.trim() || undefined,
      });
      setResult({ ok: response.test.ok, message: response.test.message, modelCount: response.test.modelCount });
      if (response.test.ok) {
        toast.push({ title: `${selected.name} connected`, description: response.test.message, tone: 'success' });
      } else {
        toast.push({ title: `${selected.name} saved, test failed`, description: response.test.message, tone: 'error' });
      }
      onDone();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setResult({ ok: false, message });
      toast.push({ title: 'Connection failed', description: message, tone: 'error' });
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add provider"
      description="The key is validated with a real model-list request before it is activated."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
            Cancel
          </Button>
          <Button variant="primary" onClick={connect} loading={connecting} disabled={!selected || (!selected.keyless && !apiKey.trim())} icon={<Zap size={14} />}>
            Connect & validate
          </Button>
        </>
      }
    >
      {!selected ? (
        <div className="space-y-4">
          {(['priority', 'additional', 'local'] as const).map((category) => (
            <div key={category}>
              <p className="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-faint">{category === 'priority' ? 'Priority providers' : category === 'additional' ? 'Additional providers' : 'Local runtimes (no key)'}</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {grouped[category].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(item.id);
                      setLabel(item.name);
                      setBaseUrl(item.id.includes('compatible') ? '' : item.baseUrl);
                    }}
                    className="mx-focus rounded-lg border border-line bg-bg-elevated p-2.5 text-left transition hover:border-magma-line"
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span className="text-[12px] font-medium text-fg">{item.name}</span>
                      {item.connected ? <CheckCircle2 size={12} className="text-ok" /> : null}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[10.5px] leading-relaxed text-faint">{item.description}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      <Badge tone={item.tier === 'local' ? 'info' : item.tier === 'free' ? 'ok' : 'neutral'}>{TIER_LABEL[item.tier]}</Badge>
                      <Badge>{item.keyless ? 'no API key' : 'API key'}</Badge>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3.5">
          <div className="rounded-lg border border-line bg-bg-elevated p-3">
            <p className="text-[12px] font-medium text-fg">{selected.name}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">{selected.description}</p>
            {selected.notes ? <p className="mt-1.5 text-[10.5px] leading-relaxed text-faint">{selected.notes}</p> : null}
          </div>
          {selected.keyless ? (
            <div className="rounded-lg border border-info/30 bg-info-soft/30 px-3 py-2 text-[11px] text-muted">
              This provider does not require an API key. Make sure the runtime is running locally before connecting.
            </div>
          ) : (
            <Field label="API key" hint={selected.keyHelpUrl ? 'stored encrypted, never returned' : undefined}>
              <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" mono autoFocus autoComplete="off" />
            </Field>
          )}
          {selected.requiresAccountId ? (
            <Field label="Account ID" hint="Cloudflare dashboard → Workers & Pages">
              <Input value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="023e105f4ecef8ad9ca31a8372d0c353" mono />
            </Field>
          ) : null}
          <Field label="Display label" hint="optional">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={selected.name} />
          </Field>
          <Field label="Base URL" hint={selected.id.includes('compatible') ? 'required for custom endpoints' : 'override only if you use a proxy'}>
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={selected.baseUrl || 'https://your-gateway.example.com/v1'} mono />
          </Field>
          {selected.keyHelpUrl ? (
            <a href={selected.keyHelpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-magma hover:underline">
              Get your {selected.name} key <ExternalLink size={11} />
            </a>
          ) : null}
          {result ? (
            <div className={cx('rounded-lg border px-3 py-2 text-[11px] leading-relaxed', result.ok ? 'border-ok/30 bg-ok-soft/40 text-muted' : 'border-err/30 bg-err-soft/40 text-muted')}>
              <span className="font-medium text-fg">{result.ok ? 'Validated' : 'Validation failed'}: </span>
              {result.message}
              {result.modelCount ? ` · ${result.modelCount} models found` : ''}
            </div>
          ) : null}
          <button type="button" onClick={() => setSelectedId(null)} className="text-[11px] text-muted underline decoration-line underline-offset-2 hover:text-fg">
            Choose a different provider
          </button>
        </div>
      )}
    </Modal>
  );
}

function EditProviderModal({ provider, onClose, onDone }: { provider: Provider; onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = useState(provider.label);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [accountId, setAccountId] = useState(provider.accountId ?? '');
  const [priority, setPriority] = useState(provider.priority);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${provider.label}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await api.patch(`/api/providers/${provider.id}`, {
                  label: label.trim() || provider.label,
                  baseUrl: baseUrl.trim() || provider.baseUrl,
                  accountId: accountId.trim() || null,
                  priority,
                });
                toast.push({ title: 'Provider updated', tone: 'success' });
                onDone();
                onClose();
              } catch (err) {
                toast.push({ title: 'Update failed', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
              } finally {
                setSaving(false);
              }
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Label">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label="Base URL">
          <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} mono />
        </Field>
        {provider.definition?.requiresAccountId ? (
          <Field label="Account ID">
            <Input value={accountId} onChange={(event) => setAccountId(event.target.value)} mono />
          </Field>
        ) : null}
        <Field label="Provider priority" hint="lower is tried first">
          <Input type="number" value={priority} onChange={(event) => setPriority(Number(event.target.value))} />
        </Field>
        <p className="text-[10px] leading-relaxed text-faint">
          Changing the base URL does not remove stored keys. Re-run “Test” after editing to verify the new endpoint.
        </p>
        <CopyChip value={provider.baseUrl} />
      </div>
    </Modal>
  );
}

function AddKeyModal({ provider, onClose, onDone }: { provider: Provider; onClose: () => void; onDone: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState(`key ${provider.keys.length + 1}`);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  return (
    <Modal
      open
      onClose={onClose}
      title={`Add key to ${provider.label}`}
      description="Multiple keys are rotated automatically when one hits an auth or quota error."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={apiKey.trim().length < 4}
            onClick={async () => {
              setSaving(true);
              try {
                const result = await api.post<{ ok: boolean; test: { message: string } }>(`/api/providers/${provider.id}/keys`, { apiKey: apiKey.trim(), label: label.trim() });
                toast.push({
                  title: result.ok ? 'Key added and validated' : 'Key added, validation failed',
                  description: result.test.message,
                  tone: result.ok ? 'success' : 'error',
                });
                onDone();
                onClose();
              } catch (err) {
                toast.push({ title: 'Could not add key', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
              } finally {
                setSaving(false);
              }
            }}
          >
            Add key
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="API key">
          <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} mono autoFocus autoComplete="off" />
        </Field>
        <Field label="Label">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export default Providers;
