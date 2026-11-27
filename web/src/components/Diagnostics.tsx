import { useState } from 'react';
import { CheckCircle2, CircleSlash, TriangleAlert, XCircle, Stethoscope } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { cx, formatDuration } from '../lib/format';
import { useToast } from './ui';
import type { DiagnosticsReport } from '../lib/types';
import { Badge, Button, Checkbox, Spinner } from './ui';

export function DiagnosticsRunner({ compact = false }: { compact?: boolean }) {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [running, setRunning] = useState(false);
  const [includeProviders, setIncludeProviders] = useState(true);
  const toast = useToast();

  const run = async () => {
    setRunning(true);
    try {
      const result = await api.post<DiagnosticsReport>('/api/diagnostics/run', { includeProviders });
      setReport(result);
      const { fail, warn } = result.summary;
      toast.push({
        title: fail > 0 ? `${fail} diagnostic check(s) failed` : warn > 0 ? 'Diagnostics finished with warnings' : 'All diagnostics passed',
        description: `${result.summary.pass} passed · ${result.summary.warn} warnings · ${result.summary.fail} failed · ${result.summary.skip} skipped`,
        tone: fail > 0 ? 'error' : warn > 0 ? 'warning' : 'success',
      });
    } catch (err) {
      toast.push({ title: 'Diagnostics could not run', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className={cx('flex flex-wrap items-center gap-3', compact && 'gap-2')}>
        <Button variant="primary" onClick={run} loading={running} icon={<Stethoscope size={14} />}>
          Run System Diagnostics
        </Button>
        <Checkbox checked={includeProviders} onChange={setIncludeProviders} label="Include live provider checks (network)" />
      </div>
      {running && !report ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-elevated px-3 py-3 text-xs text-muted">
          <Spinner size={14} /> Running real checks: database, encryption, failover engine, streaming, endpoints, skills…
        </div>
      ) : null}
      {report ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <Badge tone={report.summary.fail > 0 ? 'err' : report.summary.warn > 0 ? 'warn' : 'ok'}>
              {report.summary.fail > 0 ? 'Attention needed' : report.summary.warn > 0 ? 'Operational with warnings' : 'All systems operational'}
            </Badge>
            <span>
              {report.summary.pass} passed · {report.summary.warn} warnings · {report.summary.fail} failed · {report.summary.skip} skipped
            </span>
            <span className="font-mono text-faint">in {formatDuration(report.durationMs)}</span>
          </div>
          <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {report.checks.map((check) => (
              <div key={check.id} className="flex gap-3 bg-panel px-3 py-2.5">
                <span
                  className={cx(
                    'mt-0.5 shrink-0',
                    check.status === 'pass' ? 'text-ok' : check.status === 'warn' ? 'text-warn' : check.status === 'fail' ? 'text-err' : 'text-faint',
                  )}
                >
                  {check.status === 'pass' ? <CheckCircle2 size={15} /> : check.status === 'warn' ? <TriangleAlert size={15} /> : check.status === 'fail' ? <XCircle size={15} /> : <CircleSlash size={15} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-xs font-medium text-fg">{check.label}</p>
                    <span className="font-mono text-[10px] text-faint">{formatDuration(check.durationMs)}</span>
                  </div>
                  <p className="mt-0.5 break-words text-[11px] leading-relaxed text-muted">{check.detail}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] leading-relaxed text-faint">
            Provider checks call the real provider APIs with your keys. Engine and streaming checks use a temporary local upstream on 127.0.0.1 — no tokens are spent.
          </p>
        </div>
      ) : null}
    </div>
  );
}
