import { ArrowRight, Clock, Coins, Hash, Timer } from 'lucide-react';
import { Badge, Modal } from './ui';
import { cx, formatDateTime, formatDuration, formatLatency, formatTokens, formatCurrency, shortModel } from '../lib/format';
import type { RequestRecord } from '../lib/types';

export function RequestDetailModal({ record, onClose }: { record: RequestRecord | null; onClose: () => void }) {
  if (!record) return null;
  return (
    <Modal open onClose={onClose} title="Request inspector" description={`${record.endpoint} · ${formatDateTime(record.ts)}`} width="max-w-2xl">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={record.status === 'success' ? 'ok' : record.status === 'error' ? 'err' : 'warn'}>{record.status}</Badge>
          <Badge tone="neutral">HTTP {record.statusCode}</Badge>
          {record.stream ? <Badge tone="info">streaming</Badge> : null}
          {record.fallbackCount > 0 ? <Badge tone="warn">{record.fallbackCount} fallback{record.fallbackCount === 1 ? '' : 's'}</Badge> : null}
          <span className="font-mono text-[10px] text-faint">{record.id}</span>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Metric icon={<Timer size={13} />} label="Latency" value={formatLatency(record.latencyMs)} />
          <Metric icon={<Clock size={13} />} label="First token" value={formatLatency(record.ttfbMs)} />
          <Metric icon={<Hash size={13} />} label="Tokens" value={`${formatTokens(record.inputTokens)} / ${formatTokens(record.outputTokens)}`} hint="in / out" />
          <Metric icon={<Coins size={13} />} label="Cost" value={record.costUsd === null ? 'unknown' : formatCurrency(record.costUsd)} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Info label="Requested model" value={record.requestedModel ?? 'auto'} mono />
          <Info label="Routed model" value={record.modelId ?? '—'} mono />
          <Info label="Provider" value={record.providerName ?? '—'} />
          <Info label="Routing" value={`${record.routingMode} · ${record.profile}`} />
          <Info label="Client" value={record.client ?? 'unknown'} />
          <Info label="Endpoint" value={record.endpoint} mono />
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-faint">Attempts</p>
          <div className="space-y-1.5">
            {record.attempts.length === 0 ? <p className="text-xs text-muted">No attempts recorded.</p> : null}
            {record.attempts.map((attempt, index) => (
              <div key={`${attempt.startedAt}-${index}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-elevated px-2.5 py-2 text-[11px]">
                <span className="font-mono text-faint">#{index + 1}</span>
                <span className="font-medium text-fg">{attempt.providerName}</span>
                <ArrowRight size={11} className="text-faint" />
                <span className="font-mono text-muted">{shortModel(attempt.modelId)}</span>
                <span className="ml-auto flex items-center gap-2">
                  <span className="font-mono text-faint">{formatDuration(attempt.latencyMs)}</span>
                  <Badge tone={attempt.outcome === 'success' ? 'ok' : 'err'}>{attempt.outcome === 'success' ? 'ok' : attempt.errorClass ?? 'error'}</Badge>
                </span>
                {attempt.message ? <p className="w-full break-words text-[10px] text-muted">{attempt.message}</p> : null}
              </div>
            ))}
          </div>
        </div>

        {record.errorMessage ? (
          <div className="rounded-lg border border-err/30 bg-err-soft/40 p-3">
            <p className="text-[11px] font-medium text-err">{record.errorCode ?? 'error'}</p>
            <p className="mt-1 break-words text-[11px] leading-relaxed text-muted">{record.errorMessage}</p>
          </div>
        ) : null}

        {record.promptSample || record.responseSample ? (
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-faint">Captured payload (payload logging enabled)</p>
            {record.promptSample ? <pre className="mx-code max-h-40 overflow-auto rounded-lg border border-line bg-bg-elevated p-2.5 text-muted">{record.promptSample}</pre> : null}
            {record.responseSample ? <pre className="mx-code max-h-40 overflow-auto rounded-lg border border-line bg-bg-elevated p-2.5 text-muted">{record.responseSample}</pre> : null}
          </div>
        ) : (
          <p className="text-[10px] leading-relaxed text-faint">
            Prompts and responses are not stored. Enable “Store prompt/response samples” in Settings if you need them in the inspector.
          </p>
        )}
      </div>
    </Modal>
  );
}

function Metric({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg-elevated p-2.5">
      <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-faint">
        {icon}
        {label}
      </p>
      <p className="mt-1 truncate font-mono text-xs text-fg">{value}</p>
      {hint ? <p className="text-[9px] text-faint">{hint}</p> : null}
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={cx('rounded-lg border border-line bg-bg-elevated px-2.5 py-2')}>
      <p className="text-[10px] uppercase tracking-[0.08em] text-faint">{label}</p>
      <p className={cx('mt-0.5 truncate text-[11px] text-fg', mono && 'font-mono')}>{value}</p>
    </div>
  );
}

export function requestStatusTone(status: string): 'ok' | 'err' | 'warn' {
  return status === 'success' ? 'ok' : status === 'error' ? 'err' : 'warn';
}

