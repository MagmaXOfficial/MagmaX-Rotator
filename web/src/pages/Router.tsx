import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowRightLeft, CircleDollarSign, Clock, Gauge, Info, ListOrdered, Route, ShieldAlert, SlidersHorizontal, Snowflake, Sparkles, Timer, Wand2, Zap } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { cx, formatDuration, formatLatency, formatPrice, shortModel } from '../lib/format';
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Select, Spinner, Switch, useToast } from '../components/ui';
import { RouteTestModal } from './Overview';
import type { ChainEntry, Model, RouterResponse, RouterSettings } from '../lib/types';

const MODES: Array<{ id: RouterSettings['routingMode']; label: string; description: string; icon: typeof ListOrdered }> = [
  { id: 'priority', label: 'Priority', description: 'Always walk your configured model order first.', icon: ListOrdered },
  { id: 'fastest', label: 'Fastest', description: 'Prefer the lowest measured latency; unsampled models go last.', icon: Gauge },
  { id: 'cheapest', label: 'Cheapest', description: 'Prefer the lowest verified price. Unknown pricing sorts last.', icon: CircleDollarSign },
  { id: 'smart', label: 'Smart', description: 'Blend capability match, reliability, latency and price.', icon: Sparkles },
  { id: 'manual', label: 'Manual', description: 'Only the pinned model. Failover still applies across its keys.', icon: Route },
];

const PROFILES: Array<{ id: RouterSettings['profile']; label: string; hint: string }> = [
  { id: 'general', label: 'General', hint: 'Balanced routing for everyday chat.' },
  { id: 'coding', label: 'Coding', hint: 'Prefers models with verified tool calling.' },
  { id: 'reasoning', label: 'Reasoning', hint: 'Prefers reasoning-capable models.' },
  { id: 'fast', label: 'Fast responses', hint: 'Prefers models with the lowest measured latency.' },
  { id: 'long_context', label: 'Long context', hint: 'Prefers large, documented context windows.' },
  { id: 'vision', label: 'Vision', hint: 'Restricts to models that accept images.' },
  { id: 'free_local', label: 'Free / local only', hint: 'Only free-tier or local models are eligible.' },
];

const FALLBACK_LABELS: Array<{ key: keyof RouterSettings['fallbackOn']; label: string; hint: string }> = [
  { key: 'rateLimit', label: 'Rate limit (429)', hint: 'Cooldown and try the next model.' },
  { key: 'serverError', label: 'Provider error (5xx)', hint: 'Retry on the next candidate.' },
  { key: 'timeout', label: 'Timeout', hint: 'Abort the attempt and move on.' },
  { key: 'auth', label: 'Auth / quota failure', hint: 'Rotate keys, then other models.' },
  { key: 'network', label: 'Connection failure', hint: 'DNS, refused, reset connections.' },
  { key: 'modelUnavailable', label: 'Model unavailable (404)', hint: 'Try a different model.' },
  { key: 'invalidRequest', label: 'Invalid request (400)', hint: 'Keep off: the request is wrong for every provider.' },
  { key: 'contextLength', label: 'Context length exceeded', hint: 'Keep off: another model may not help.' },
  { key: 'contentFilter', label: 'Content filter', hint: 'Keep off: filters usually apply everywhere.' },
];

export function RouterPage() {
  const { data, loading, refresh } = useApi<RouterResponse>('/api/router', { refreshMs: 20_000 });
  const models = useApi<{ models: Model[] }>('/api/models?enabled=1', { refreshMs: 60_000 });
  const [form, setForm] = useState<RouterSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [excludedText, setExcludedText] = useState('');
  const [simModel, setSimModel] = useState('');
  const [simResult, setSimResult] = useState<{ explanation: string; candidates: Array<{ provider: string; model: string; reason: string; score: number; tier: string }> } | null>(null);
  const [simulating, setSimulating] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (data?.settings && !form) {
      setForm(data.settings);
      setExcludedText(data.settings.excludedModels.join('\n'));
    }
  }, [data, form]);

  const chain = data?.chain ?? [];
  const cooldowns = data?.cooldowns ?? [];
  const providerSequence = useMemo(() => {
    const sequence: string[] = [];
    for (const entry of chain) if (sequence[sequence.length - 1] !== entry.provider) sequence.push(entry.provider);
    return sequence;
  }, [chain]);

  const update = <K extends keyof RouterSettings>(key: K, value: RouterSettings[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setDirty(true);
  };

  const patchMode = async (mode: RouterSettings['routingMode']) => {
    setForm((current) => (current ? { ...current, routingMode: mode } : current));
    try {
      await api.patch('/api/router', { routingMode: mode });
      refresh();
    } catch (err) {
      toast.push({ title: 'Could not change routing mode', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    }
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await api.patch('/api/router', {
        profile: form.profile,
        maxAttempts: form.maxAttempts,
        requestTimeoutMs: form.requestTimeoutMs,
        cooldownMs: form.cooldownMs,
        cooldownMaxMs: form.cooldownMaxMs,
        autoRecovery: form.autoRecovery,
        continuationEnabled: form.continuationEnabled,
        maxContinuations: form.maxContinuations,
        fallbackOn: form.fallbackOn,
        excludedModels: excludedText.split(/[\n,]/).map((v) => v.trim()).filter(Boolean),
        manualModelId: form.manualModelId,
        healthCheckIntervalMs: form.healthCheckIntervalMs,
      });
      setDirty(false);
      toast.push({ title: 'Routing configuration saved', description: 'New requests use these rules immediately.', tone: 'success' });
      refresh();
    } catch (err) {
      toast.push({ title: 'Save failed', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const simulate = async () => {
    setSimulating(true);
    try {
      const result = await api.post<{ explanation: string; candidates: Array<{ provider: string; model: string; reason: string; score: number; tier: string }> }>('/api/router/simulate', {
        requestedModel: simModel.trim() || undefined,
      });
      setSimResult(result);
    } catch (err) {
      toast.push({ title: 'Simulation failed', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setSimulating(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex h-60 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Router"
        description="Deterministic failover with cooldowns, key rotation and stream-safe switching. Every decision is explainable."
        actions={
          <>
            <Button variant="secondary" icon={<Zap size={14} />} onClick={() => setTestOpen(true)}>
              Test routing
            </Button>
            <Button variant="primary" icon={<SlidersHorizontal size={14} />} onClick={save} loading={saving} disabled={!dirty}>
              {dirty ? 'Save configuration' : 'Saved'}
            </Button>
          </>
        }
      />

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-5">
        {MODES.map((mode) => {
          const Icon = mode.icon;
          const active = (form?.routingMode ?? data?.settings.routingMode) === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => patchMode(mode.id)}
              className={cx(
                'mx-focus group rounded-xl border p-3.5 text-left transition',
                active ? 'border-magma-line bg-magma-soft/60 shadow-[0_0_0_1px_var(--magma-line)]' : 'border-line bg-panel hover:border-line-strong',
              )}
            >
              <div className="flex items-center justify-between">
                <Icon size={15} className={active ? 'text-magma' : 'text-faint'} />
                {active ? <span className="size-1.5 rounded-full bg-magma" /> : null}
              </div>
              <p className="mt-2 text-[12.5px] font-semibold text-fg">{mode.label}</p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-muted">{mode.description}</p>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_1fr]">
        <Card>
          <CardHeader title="Failover chain" description="Ordered candidates after filters, cooldowns and constraints. Head of the chain is tried first." icon={<Route size={15} />} actions={<Badge tone="magma">{chain.length} candidate{chain.length === 1 ? '' : 's'}</Badge>} />
          {providerSequence.length ? (
            <div className="mb-4 flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-bg-elevated px-3 py-2.5">
              {providerSequence.slice(0, 9).map((provider, index) => (
                <span key={`${provider}-${index}`} className="flex items-center gap-1.5">
                  <span className="rounded-md border border-magma-line/50 bg-magma-soft px-1.5 py-0.5 text-[10.5px] font-medium text-fg">{provider}</span>
                  {index < Math.min(providerSequence.length, 9) - 1 ? <ArrowRight size={11} className="text-faint" /> : null}
                </span>
              ))}
              {providerSequence.length > 9 ? <span className="text-[10px] text-faint">+{providerSequence.length - 9} more</span> : null}
            </div>
          ) : null}
          {chain.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center">
              <p className="text-xs text-muted">No eligible model. Connect a provider and enable models.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {(showAll ? chain : chain.slice(0, 12)).map((entry, index) => (
                <ChainRow key={entry.id} entry={entry} index={index} />
              ))}
              {chain.length > 12 ? (
                <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-1 w-full rounded-md py-1 text-[11px] text-muted transition hover:bg-panel-2 hover:text-fg">
                  {showAll ? 'Show first 12' : `Show all ${chain.length} candidates`}
                </button>
              ) : null}
            </div>
          )}
          {cooldowns.length > 0 ? (
            <div className="mt-3 rounded-lg border border-warn/30 bg-warn-soft/40 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-warn">
                  <Snowflake size={12} /> {cooldowns.length} cooling down
                </p>
                <Button size="sm" variant="ghost" onClick={async () => { await api.post('/api/router/clear-cooldowns'); refresh(); toast.push({ title: 'Cooldowns cleared', tone: 'info' }); }}>
                  Clear
                </Button>
              </div>
              {cooldowns.slice(0, 4).map((cooldown) => (
                <p key={`${cooldown.modelId}-${cooldown.until}`} className="mt-1 truncate font-mono text-[10px] text-muted">
                  {shortModel(cooldown.modelId)} · {cooldown.reason} · {Math.max(0, Math.ceil((cooldown.until - Date.now()) / 1000))}s left
                </p>
              ))}
            </div>
          ) : null}
        </Card>

        <Card>
          <CardHeader title="Engine configuration" description="Applies to every OpenAI and Anthropic compatible request." icon={<SlidersHorizontal size={15} />} />
          {form ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Profile" hint={PROFILES.find((p) => p.id === form.profile)?.hint}>
                  <Select value={form.profile} onChange={(event) => update('profile', event.target.value as RouterSettings['profile'])}>
                    {PROFILES.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Max attempts" hint="per request">
                  <Input type="number" min={1} max={20} value={form.maxAttempts} onChange={(event) => update('maxAttempts', Number(event.target.value))} />
                </Field>
                <Field label="Request timeout" hint="ms per attempt">
                  <Input type="number" min={1000} step={1000} value={form.requestTimeoutMs} onChange={(event) => update('requestTimeoutMs', Number(event.target.value))} />
                </Field>
                <Field label="Cooldown" hint="base ms">
                  <Input type="number" min={1000} step={1000} value={form.cooldownMs} onChange={(event) => update('cooldownMs', Number(event.target.value))} />
                </Field>
                <Field label="Max cooldown" hint="cap, ms">
                  <Input type="number" min={1000} step={1000} value={form.cooldownMaxMs} onChange={(event) => update('cooldownMaxMs', Number(event.target.value))} />
                </Field>
                <Field label="Health check interval" hint="ms">
                  <Input type="number" min={30000} step={30000} value={form.healthCheckIntervalMs} onChange={(event) => update('healthCheckIntervalMs', Number(event.target.value))} />
                </Field>
              </div>

              <div className="space-y-2 rounded-lg border border-line bg-bg-elevated p-3">
                <ToggleRow label="Automatic recovery" hint="Periodic background checks re-validate providers and restore models." checked={form.autoRecovery} onChange={(v) => update('autoRecovery', v)} />
                <ToggleRow label="Continue truncated answers" hint="Non-streaming only: append a continuation when the model hits its output limit." checked={form.continuationEnabled} onChange={(v) => update('continuationEnabled', v)} />
                {form.continuationEnabled ? (
                  <div className="flex items-center gap-2 pl-1 text-[11px] text-muted">
                    Max continuations
                    <Input type="number" min={0} max={5} value={form.maxContinuations} onChange={(event) => update('maxContinuations', Number(event.target.value))} className="h-7 w-16" />
                  </div>
                ) : null}
              </div>

              {form.routingMode === 'manual' ? (
                <Field label="Pinned model" hint="manual mode only routes this model">
                  <Select value={form.manualModelId ?? ''} onChange={(event) => update('manualModelId', event.target.value || null)}>
                    <option value="">Select a model…</option>
                    {(models.data?.models ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.provider.label} · {model.modelId}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}

              <div>
                <p className="mb-1.5 text-xs font-medium text-fg">Fallback rules</p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {FALLBACK_LABELS.map((rule) => (
                    <label key={rule.key} className="flex items-start justify-between gap-2 rounded-lg border border-line bg-bg-elevated px-2.5 py-1.5">
                      <span className="min-w-0">
                        <span className="block text-[11px] text-fg">{rule.label}</span>
                        <span className="block text-[9.5px] leading-relaxed text-faint">{rule.hint}</span>
                      </span>
                      <Switch checked={form.fallbackOn[rule.key]} label={rule.label} onChange={(value) => update('fallbackOn', { ...form.fallbackOn, [rule.key]: value })} />
                    </label>
                  ))}
                </div>
              </div>

              <Field label="Excluded models" hint="one id or row id per line">
                <textarea
                  value={excludedText}
                  onChange={(event) => {
                    setExcludedText(event.target.value);
                    setDirty(true);
                  }}
                  rows={2}
                  className="w-full rounded-lg border border-line bg-bg-elevated px-3 py-2 font-mono text-[11px] text-fg placeholder:text-faint focus:border-magma-line focus:outline-none"
                  placeholder="model-id-to-never-route"
                />
              </Field>
            </div>
          ) : null}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Simulate routing" description="Runs the real selection logic without contacting any provider." icon={<Wand2 size={15} />} />
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Requested model" hint="optional" className="min-w-[220px] flex-1">
              <Input value={simModel} onChange={(event) => setSimModel(event.target.value)} placeholder="alias, model id or empty for auto" mono />
            </Field>
            <Button variant="secondary" onClick={simulate} loading={simulating} icon={<Wand2 size={13} />}>
              Simulate
            </Button>
          </div>
          {simResult ? (
            <div className="mt-3">
              <p className="text-[11px] leading-relaxed text-muted">{simResult.explanation}</p>
              <div className="mt-2 space-y-1">
                {simResult.candidates.slice(0, 8).map((candidate, index) => (
                  <div key={`${candidate.provider}-${candidate.model}-${index}`} className="flex items-center gap-2 rounded-md border border-line bg-bg-elevated px-2 py-1 text-[10.5px]">
                    <span className="font-mono text-faint">{index + 1}</span>
                    <span className="text-fg">{candidate.provider}</span>
                    <span className="font-mono text-muted">{shortModel(candidate.model)}</span>
                    <span className="ml-auto truncate text-faint">{candidate.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-3 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-faint">
              <Info size={12} className="mt-0.5 shrink-0" /> The simulator shows why a model would be selected: priority, measured latency, verified price, capabilities and cooldown state.
            </p>
          )}
        </Card>

        <Card>
          <CardHeader title="How switching is kept safe" description="Guarantees enforced by the engine." icon={<ShieldAlert size={15} />} />
          <ul className="space-y-2 text-[11px] leading-relaxed text-muted">
            <li className="flex gap-2"><ArrowRightLeft size={12} className="mt-0.5 shrink-0 text-magma" /> Fallback only happens before the first byte reaches the client. After that, a broken stream returns an explicit error instead of duplicated output.</li>
            <li className="flex gap-2"><Clock size={12} className="mt-0.5 shrink-0 text-magma" /> Cooldowns use exponential backoff, honour provider Retry-After hints and are capped by your max cooldown.</li>
            <li className="flex gap-2"><Timer size={12} className="mt-0.5 shrink-0 text-magma" /> A model hitting its output limit is a successful request with <span className="font-mono">finish_reason=length</span> — never treated as a provider failure.</li>
            <li className="flex gap-2"><ShieldAlert size={12} className="mt-0.5 shrink-0 text-magma" /> Invalid requests (400) stop immediately by default, so a bad payload is not replayed across every provider.</li>
            <li className="flex gap-2"><Sparkles size={12} className="mt-0.5 shrink-0 text-magma" /> Tool calls are never replayed: switching is forbidden after streamed tool deltas start.</li>
          </ul>
        </Card>
      </div>

      <RouteTestModal open={testOpen} onClose={() => setTestOpen(false)} />
    </div>
  );
}

function ChainRow({ entry, index }: { entry: ChainEntry; index: number }) {
  const cooling = entry.cooldownUntil !== null;
  return (
    <div className={cx('flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 transition', cooling ? 'border-warn/30 bg-warn-soft/20' : 'border-line bg-bg-elevated')}>
      <span className="w-5 shrink-0 font-mono text-[10px] text-faint">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] font-medium text-fg">{entry.provider}</span>
          <span className="text-faint">/</span>
          <span className="truncate font-mono text-[11px] text-muted">{entry.model}</span>
          {cooling ? <Badge tone="warn">cooling</Badge> : null}
          <Badge tone={entry.capabilities.tools ? 'magma' : 'neutral'}>{entry.capabilities.tools ? 'tools' : 'no tools'}</Badge>
        </div>
        <p className="mt-0.5 truncate text-[10px] text-faint">{entry.reason}</p>
      </div>
      <div className="shrink-0 text-right font-mono text-[10px] text-faint">
        <p>{entry.contextWindow ? `${Math.round(entry.contextWindow / 1000)}k ctx` : 'ctx unknown'}</p>
        <p>{entry.price.input === null && entry.price.output === null ? 'price unknown' : `${formatPrice(entry.price.input)} in`}</p>
      </div>
      <div className="shrink-0 text-right font-mono text-[10px] text-faint">
        <p>{formatLatency(entry.latencyMs)}</p>
        <p>p{entry.priority}</p>
      </div>
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11.5px] font-medium text-fg">{label}</p>
        <p className="text-[10px] leading-relaxed text-faint">{hint}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export default RouterPage;
