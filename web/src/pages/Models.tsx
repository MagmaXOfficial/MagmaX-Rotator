import { useMemo, useState } from 'react';
import { Boxes, Brain, Eye, Plus, Search, Star, Trash2, Wrench, Zap } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { contextLabel, cx, formatLatency, formatNumber, formatPrice, shortModel } from '../lib/format';
import { Badge, Button, Card, CardHeader, ConfirmButton, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Switch, useToast } from '../components/ui';
import type { Alias, Model, ProviderTier } from '../lib/types';

interface ModelsResponse {
  models: Model[];
  total: number;
  aliases: Alias[];
}

type SortKey = 'priority' | 'name' | 'context' | 'price' | 'latency';

export function Models() {
  const { data, loading, refresh } = useApi<ModelsResponse>('/api/models', { refreshMs: 25_000 });
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [sort, setSort] = useState<SortKey>('priority');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [toolsOnly, setToolsOnly] = useState(false);
  const [visionOnly, setVisionOnly] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const toast = useToast();

  const providerList = useApi<{ providers: Array<{ id: string; label: string }> }>('/api/providers', { refreshMs: 60_000 });
  const models = data?.models ?? [];
  const aliases = data?.aliases ?? [];
  const providers = useMemo(() => {
    const map = new Map<string, string>();
    for (const provider of providerList.data?.providers ?? []) map.set(provider.id, provider.label);
    for (const model of models) map.set(model.providerRowId, model.provider.label);
    return [...map.entries()];
  }, [models, providerList.data]);

  const visible = useMemo(() => {
    const filtered = models
      .filter((model) => (providerFilter === 'all' ? true : model.providerRowId === providerFilter))
      .filter((model) => (tierFilter === 'all' ? true : model.tier === tierFilter))
      .filter((model) => (favoritesOnly ? model.favorite : true))
      .filter((model) => (enabledOnly ? model.enabled : true))
      .filter((model) => (toolsOnly ? model.capabilities.tools === true : true))
      .filter((model) => (visionOnly ? model.capabilities.vision === true : true))
      .filter((model) => {
        if (!search.trim()) return true;
        const query = search.toLowerCase();
        return `${model.modelId} ${model.displayName} ${model.provider.label}`.toLowerCase().includes(query);
      });
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === 'name') return a.modelId.localeCompare(b.modelId);
      if (sort === 'context') return (b.contextWindow ?? -1) - (a.contextWindow ?? -1);
      if (sort === 'latency') return (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER);
      if (sort === 'price') {
        const priceA = a.inputPrice === null && a.outputPrice === null ? Number.MAX_SAFE_INTEGER : (a.inputPrice ?? 0) + (a.outputPrice ?? 0);
        const priceB = b.inputPrice === null && b.outputPrice === null ? Number.MAX_SAFE_INTEGER : (b.inputPrice ?? 0) + (b.outputPrice ?? 0);
        return priceA - priceB;
      }
      return a.priority - b.priority || a.modelId.localeCompare(b.modelId);
    });
    return sorted;
  }, [models, providerFilter, tierFilter, favoritesOnly, enabledOnly, toolsOnly, visionOnly, search, sort]);

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusyId(id);
    try {
      await api.patch(`/api/models/${id}`, body);
      refresh();
    } catch (err) {
      toast.push({ title: 'Could not update model', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const enabledCount = models.filter((m) => m.enabled).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Models"
        description="Everything discovered from your providers. Specifications are never invented — unknown context or pricing stays blank."
        actions={
          <>
            <Button variant="secondary" icon={<Plus size={14} />} onClick={() => setManualOpen(true)}>
              Add model manually
            </Button>
            <Button variant="ghost" icon={<Zap size={14} />} onClick={refresh} loading={loading}>
              Refresh
            </Button>
          </>
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div className="relative min-w-[200px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models or providers…" className="pl-8" />
          </div>
          <Select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} className="w-auto min-w-[150px]">
            <option value="all">All providers</option>
            {providers.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
          <Select value={tierFilter} onChange={(event) => setTierFilter(event.target.value)} className="w-auto">
            <option value="all">Any access</option>
            <option value="free">Free</option>
            <option value="limited">Limited / trial</option>
            <option value="paid">Paid</option>
            <option value="local">Local</option>
            <option value="unknown">Unknown</option>
          </Select>
          <Select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className="w-auto">
            <option value="priority">Sort: priority</option>
            <option value="name">Sort: name</option>
            <option value="context">Sort: context</option>
            <option value="price">Sort: price</option>
            <option value="latency">Sort: latency</option>
          </Select>
          <div className="flex flex-wrap items-center gap-3 pl-1">
            <label className="flex items-center gap-1.5 text-[11px] text-muted">
              <input type="checkbox" checked={favoritesOnly} onChange={(e) => setFavoritesOnly(e.target.checked)} className="size-3.5 accent-[var(--magma)]" /> favourites
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-muted">
              <input type="checkbox" checked={enabledOnly} onChange={(e) => setEnabledOnly(e.target.checked)} className="size-3.5 accent-[var(--magma)]" /> enabled
            </label>
            <button
              type="button"
              onClick={() => setToolsOnly((v) => !v)}
              className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition', toolsOnly ? 'border-magma-line bg-magma-soft text-magma' : 'border-line text-faint hover:text-fg')}
            >
              <Wrench size={10} /> tools
            </button>
            <button
              type="button"
              onClick={() => setVisionOnly((v) => !v)}
              className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition', visionOnly ? 'border-magma-line bg-magma-soft text-magma' : 'border-line text-faint hover:text-fg')}
            >
              <Eye size={10} /> vision
            </button>
          </div>
        </div>

        {loading && !data ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : visible.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<Boxes size={18} />}
              title={models.length === 0 ? 'No models discovered yet' : 'No models match these filters'}
              description={models.length === 0 ? 'Connect a provider and sync its catalogue. Local runtimes (Ollama, LM Studio, vLLM) expose their models automatically.' : 'Clear filters or search for another model name.'}
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-line bg-bg-elevated/50 text-[10px] uppercase tracking-[0.08em] text-faint">
                    <th className="px-4 py-2 font-medium">Model</th>
                    <th className="px-2 py-2 font-medium">Context</th>
                    <th className="px-2 py-2 font-medium">Price / 1M</th>
                    <th className="px-2 py-2 font-medium">Access</th>
                    <th className="px-2 py-2 font-medium">Capabilities</th>
                    <th className="px-2 py-2 text-right font-medium">Latency</th>
                    <th className="px-2 py-2 text-right font-medium">Priority</th>
                    <th className="px-2 py-2 text-center font-medium">Enabled</th>
                    <th className="px-4 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.slice(0, 250).map((model) => (
                    <tr key={model.id} className="border-b border-line/60 text-[11.5px] transition hover:bg-panel-2/50">
                      <td className="max-w-[300px] px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <button type="button" onClick={() => patch(model.id, { favorite: !model.favorite })} aria-label="Toggle favourite" className={cx('transition', model.favorite ? 'text-magma' : 'text-faint hover:text-muted')}>
                            <Star size={12} fill={model.favorite ? 'currentColor' : 'none'} />
                          </button>
                          <span className="truncate font-mono text-[11px] text-fg" title={model.modelId}>
                            {shortModel(model.modelId)}
                          </span>
                          {model.source === 'manual' ? <Badge tone="info">manual</Badge> : null}
                        </div>
                        <p className="mt-0.5 truncate pl-[18px] text-[10px] text-faint">{model.provider.label}</p>
                      </td>
                      <td className="px-2 py-2 font-mono text-[11px] text-muted">{contextLabel(model.contextWindow)}</td>
                      <td className="px-2 py-2 font-mono text-[10.5px] text-muted">
                        <span>{formatPrice(model.inputPrice)}</span>
                        <span className="text-faint"> / </span>
                        <span>{formatPrice(model.outputPrice)}</span>
                      </td>
                      <td className="px-2 py-2">
                        <Badge tone={model.tier === 'free' ? 'ok' : model.tier === 'local' ? 'info' : model.tier === 'paid' ? 'neutral' : 'warn'}>{model.tier}</Badge>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1 text-faint">
                          <Capability on={model.capabilities.tools} icon={<Wrench size={11} />} label="Tool calling" />
                          <Capability on={model.capabilities.vision} icon={<Eye size={11} />} label="Vision" />
                          <Capability on={model.capabilities.reasoning} icon={<Brain size={11} />} label="Reasoning" />
                          <Capability on={model.capabilities.streaming} icon={<Zap size={11} />} label="Streaming" />
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-[10.5px] text-muted">{formatLatency(model.latencyMs)}</td>
                      <td className="px-2 py-2 text-right font-mono text-[10.5px] text-muted">{model.priority}</td>
                      <td className="px-2 py-2 text-center">
                        <Switch checked={model.enabled} label={`Enable ${model.modelId}`} disabled={busyId === model.id} onChange={(value) => patch(model.id, { enabled: value })} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(model)}>
                            Edit
                          </Button>
                          <ConfirmButton icon={<Trash2 size={11} />} onConfirm={() => api.del(`/api/models/${model.id}`).then(refresh)}>
                            Del
                          </ConfirmButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[10.5px] text-faint">
              <span>
                Showing {Math.min(visible.length, 250)} of {visible.length} matching · {models.length} cached · {enabledCount} enabled
              </span>
              <span className="font-mono">unknown specs are left blank on purpose</span>
            </div>
          </>
        )}
      </Card>

      <AliasCard aliases={aliases} models={models} onChanged={refresh} />

      <ModelEditModal model={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <ManualModelModal open={manualOpen} onClose={() => setManualOpen(false)} providers={providers} onSaved={refresh} />
    </div>
  );
}

function Capability({ on, icon, label }: { on: boolean | null; icon: React.ReactNode; label: string }) {
  return (
    <span
      title={on === null ? `${label}: unknown` : `${label}: ${on ? 'yes' : 'no'}`}
      className={cx(
        'inline-flex size-5 items-center justify-center rounded border',
        on === true ? 'border-magma-line bg-magma-soft text-magma' : on === false ? 'border-line text-faint/50 line-through' : 'border-line/60 text-faint/50',
      )}
    >
      {icon}
    </span>
  );
}

function AliasCard({ aliases, models, onChanged }: { aliases: Alias[]; models: Model[]; onChanged: () => void }) {
  const [alias, setAlias] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const enabledModels = models.filter((m) => m.enabled);

  const save = async (aliasName: string, value: string) => {
    if (!value) return;
    const [providerRowId, ...rest] = value.split('::');
    const modelId = rest.join('::');
    setSaving(true);
    try {
      await api.post('/api/aliases', { alias: aliasName, providerRowId, modelId });
      toast.push({ title: `Alias "${aliasName}" saved`, tone: 'success' });
      onChanged();
    } catch (err) {
      toast.push({ title: 'Could not save alias', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Model aliases"
        description="Claude Code sends its own model names. Map them to any routed model, or let MagmaX auto-route when unmapped."
        icon={<Boxes size={15} />}
      />
      <div className="space-y-1.5">
        {aliases.map((item) => {
          const current = item.providerRowId && item.modelId ? `${item.providerRowId}::${item.modelId}` : '';
          return (
            <div key={item.alias} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-elevated px-2.5 py-1.5">
              <span className="min-w-[190px] font-mono text-[11px] text-fg">{item.alias}</span>
              <Select
                value={current}
                onChange={(event) => save(item.alias, event.target.value)}
                className="h-7 max-w-[300px] flex-1 text-[11px]"
                disabled={saving}
              >
                <option value="">Auto-route (no mapping)</option>
                {enabledModels.map((model) => (
                  <option key={model.id} value={`${model.providerRowId}::${model.modelId}`}>
                    {model.provider.label} · {model.modelId}
                  </option>
                ))}
              </Select>
              {item.builtin ? <Badge>built-in</Badge> : null}
              {!item.builtin ? (
                <IconButton
                  label="Delete alias"
                  onClick={async () => {
                    await api.del(`/api/aliases/${encodeURIComponent(item.alias)}`);
                    onChanged();
                  }}
                >
                  <Trash2 size={12} />
                </IconButton>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
        <Field label="New alias" className="min-w-[160px] flex-1">
          <Input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="my-coding-model" mono />
        </Field>
        <Field label="Target model" className="min-w-[220px] flex-[2]">
          <Select value={modelKey} onChange={(event) => setModelKey(event.target.value)}>
            <option value="">Select a model…</option>
            {enabledModels.map((model) => (
              <option key={model.id} value={`${model.providerRowId}::${model.modelId}`}>
                {model.provider.label} · {model.modelId}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="secondary"
          disabled={!alias.trim() || !modelKey || saving}
          loading={saving}
          onClick={async () => {
            await save(alias.trim(), modelKey);
            setAlias('');
            setModelKey('');
          }}
        >
          Add alias
        </Button>
      </div>
    </Card>
  );
}

function ModelEditModal({ model, onClose, onSaved }: { model: Model | null; onClose: () => void; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(model?.displayName ?? '');
  const [priority, setPriority] = useState(model?.priority ?? 100);
  const [contextWindow, setContextWindow] = useState(model?.contextWindow?.toString() ?? '');
  const [maxOutput, setMaxOutput] = useState(model?.maxOutput?.toString() ?? '');
  const [inputPrice, setInputPrice] = useState(model?.inputPrice?.toString() ?? '');
  const [outputPrice, setOutputPrice] = useState(model?.outputPrice?.toString() ?? '');
  const [tier, setTier] = useState<ProviderTier>(model?.tier ?? 'unknown');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  if (!model) return null;

  const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${shortModel(model.modelId)}`}
      description="Only override metadata when you know the real values — the router uses pricing and context for smart routing."
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
                await api.patch(`/api/models/${model.id}`, {
                  displayName: displayName.trim() || model.modelId,
                  priority,
                  contextWindow: numberOrNull(contextWindow),
                  maxOutput: numberOrNull(maxOutput),
                  inputPrice: numberOrNull(inputPrice),
                  outputPrice: numberOrNull(outputPrice),
                  tier,
                });
                toast.push({ title: 'Model updated', tone: 'success' });
                onSaved();
                onClose();
              } catch (err) {
                toast.push({ title: 'Update failed', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
              } finally {
                setSaving(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name" className="sm:col-span-2">
          <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label="Priority" hint="lower runs first">
          <Input type="number" value={priority} onChange={(event) => setPriority(Number(event.target.value))} />
        </Field>
        <Field label="Access tier">
          <Select value={tier} onChange={(event) => setTier(event.target.value as ProviderTier)}>
            <option value="free">free</option>
            <option value="limited">limited</option>
            <option value="paid">paid</option>
            <option value="local">local</option>
            <option value="unknown">unknown</option>
          </Select>
        </Field>
        <Field label="Context window" hint="tokens">
          <Input type="number" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder="unknown" />
        </Field>
        <Field label="Max output" hint="tokens">
          <Input type="number" value={maxOutput} onChange={(event) => setMaxOutput(event.target.value)} placeholder="unknown" />
        </Field>
        <Field label="Input price" hint="USD per 1M tokens">
          <Input type="number" step="0.0001" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} placeholder="unknown" />
        </Field>
        <Field label="Output price" hint="USD per 1M tokens">
          <Input type="number" step="0.0001" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} placeholder="unknown" />
        </Field>
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-faint">
        Model id <span className="font-mono text-muted">{model.modelId}</span> · provider <span className="font-mono text-muted">{model.provider.label}</span> · source {model.source}
        {model.requestCount > 0 ? ` · ${formatNumber(model.requestCount)} routed requests` : ''}
      </p>
    </Modal>
  );
}

function ManualModelModal({ open, onClose, providers, onSaved }: { open: boolean; onClose: () => void; providers: Array<[string, string]>; onSaved: () => void }) {
  const [providerRowId, setProviderRowId] = useState(providers[0]?.[0] ?? '');
  const [modelId, setModelId] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [tier, setTier] = useState<ProviderTier>('unknown');
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add model manually"
      description="For gateways whose model list is not exposed. No metadata is assumed — leave fields blank if unknown."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!providerRowId || !modelId.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                await api.post('/api/models', {
                  providerRowId,
                  modelId: modelId.trim(),
                  contextWindow: contextWindow.trim() ? Number(contextWindow) : null,
                  inputPrice: inputPrice.trim() ? Number(inputPrice) : null,
                  outputPrice: outputPrice.trim() ? Number(outputPrice) : null,
                  tier,
                  displayName: modelId.trim(),
                });
                toast.push({ title: 'Model added', tone: 'success' });
                onSaved();
                onClose();
                setModelId('');
              } catch (err) {
                toast.push({ title: 'Could not add model', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
              } finally {
                setSaving(false);
              }
            }}
          >
            Add model
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Provider">
          <Select value={providerRowId} onChange={(event) => setProviderRowId(event.target.value)}>
            <option value="">Select provider…</option>
            {providers.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model id" hint="exactly as the provider expects">
          <Input value={modelId} onChange={(event) => setModelId(event.target.value)} mono placeholder="e.g. meta-llama/Llama-3.3-70B-Instruct" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Context" hint="tokens">
            <Input type="number" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder="unknown" />
          </Field>
          <Field label="Input $/1M">
            <Input type="number" step="0.0001" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} placeholder="unknown" />
          </Field>
          <Field label="Output $/1M">
            <Input type="number" step="0.0001" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} placeholder="unknown" />
          </Field>
        </div>
        <Field label="Access tier">
          <Select value={tier} onChange={(event) => setTier(event.target.value as ProviderTier)}>
            <option value="unknown">unknown</option>
            <option value="free">free</option>
            <option value="limited">limited</option>
            <option value="paid">paid</option>
            <option value="local">local</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export default Models;
