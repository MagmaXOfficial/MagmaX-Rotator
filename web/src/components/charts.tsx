import { useState } from 'react';
import { useElementWidth } from '../lib/hooks';
import { cx, formatNumber, formatTokens } from '../lib/format';
import type { StatsBucket } from '../lib/types';

export function RequestBars({ data, bucketMs, height = 190 }: { data: StatsBucket[]; bucketMs: number; height?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padding = { top: 12, right: 8, bottom: 22, left: 8 };
  const chartWidth = Math.max(100, width - padding.left - padding.right);
  const chartHeight = height - padding.top - padding.bottom;
  const max = Math.max(1, ...data.map((d) => d.total));
  const slot = chartWidth / Math.max(1, data.length);
  const barWidth = Math.max(2, Math.min(18, slot * 0.62));

  const labelFor = (ts: number) => {
    const date = new Date(ts);
    if (bucketMs >= 86_400_000) return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    if (bucketMs >= 3_600_000) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const hovered = hover !== null ? data[hover] : null;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      <svg width={width} height={height} className="block overflow-visible" role="img" aria-label="Request volume over time">
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <line
            key={ratio}
            x1={padding.left}
            x2={width - padding.right}
            y1={padding.top + chartHeight * (1 - ratio)}
            y2={padding.top + chartHeight * (1 - ratio)}
            stroke="var(--line)"
            strokeDasharray="2 4"
            strokeWidth={1}
          />
        ))}
        {data.map((bucket, index) => {
          const x = padding.left + index * slot + (slot - barWidth) / 2;
          const totalHeight = (bucket.total / max) * chartHeight;
          const errorHeight = (bucket.error / max) * chartHeight;
          const successHeight = Math.max(0, totalHeight - errorHeight);
          const y = padding.top + chartHeight - totalHeight;
          return (
            <g key={bucket.ts} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={padding.top} width={barWidth} height={chartHeight} fill="transparent" />
              <rect x={x} y={y} width={barWidth} height={Math.max(0, successHeight)} rx={1.5} fill="var(--magma)" opacity={hover === null || hover === index ? 0.92 : 0.4} />
              <rect x={x} y={y + successHeight} width={barWidth} height={Math.max(0, errorHeight)} rx={1.5} fill="var(--err)" opacity={hover === null || hover === index ? 0.9 : 0.35} />
            </g>
          );
        })}
        {data.length > 0
          ? [0, Math.floor(data.length / 2), data.length - 1].map((index) => {
              const bucket = data[index];
              if (!bucket) return null;
              const x = padding.left + index * slot + slot / 2;
              return (
                <text key={`label-${index}`} x={x} y={height - 6} textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'} fontSize={9.5} fill="var(--faint)" fontFamily="var(--font-mono)">
                  {labelFor(bucket.ts)}
                </text>
              );
            })
          : null}
      </svg>
      {hovered ? (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[150px] rounded-lg border border-line bg-panel px-2.5 py-2 text-[11px] shadow-xl"
          style={{ left: Math.min(Math.max(0, padding.left + (hover ?? 0) * slot - 60), Math.max(0, width - 160)) }}
        >
          <p className="mb-1 font-mono text-[10px] text-faint">{labelFor(hovered.ts)}</p>
          <div className="flex justify-between gap-4">
            <span className="text-muted">Requests</span>
            <span className="font-medium text-fg">{formatNumber(hovered.total)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted">Success</span>
            <span className="font-medium text-ok">{formatNumber(hovered.success)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted">Errors</span>
            <span className="font-medium text-err">{formatNumber(hovered.error)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted">Tokens</span>
            <span className="font-medium text-fg">{formatTokens(hovered.tokens)}</span>
          </div>
        </div>
      ) : null}
      {data.length === 0 ? <div className="absolute inset-0 flex items-center justify-center text-xs text-faint">No requests in this window</div> : null}
    </div>
  );
}

export function Sparkline({ values, tone = 'magma', height = 36, className }: { values: number[]; tone?: 'magma' | 'ok' | 'err' | 'info'; height?: number; className?: string }) {
  const width = 120;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 3 - (value / max) * (height - 6)).toFixed(1)}`);
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'err' ? 'var(--err)' : tone === 'info' ? 'var(--info)' : 'var(--magma)';
  if (!values.length) return <div className={cx('text-[10px] text-faint', className)}>no data</div>;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cx('w-full', className)} style={{ height }} aria-hidden="true">
      <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Donut({ percent, label, sublabel, size = 112 }: { percent: number | null; label?: string; sublabel?: string; size?: number }) {
  const safe = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div className="flex items-center gap-4">
      <div
        className="relative shrink-0 rounded-full"
        style={{
          width: size,
          height: size,
          background: `conic-gradient(var(--magma) ${safe * 3.6}deg, var(--panel-3) 0deg)`,
        }}
        role="img"
        aria-label={`${label ?? 'Value'}: ${safe.toFixed(1)} percent`}
      >
        <div className="absolute inset-[9px] flex flex-col items-center justify-center rounded-full bg-panel">
          <span className="text-lg font-semibold tracking-[-0.02em] text-fg">{percent === null ? '—' : `${safe.toFixed(1)}%`}</span>
          {sublabel ? <span className="text-[9px] uppercase tracking-[0.1em] text-faint">{sublabel}</span> : null}
        </div>
      </div>
      {label ? <p className="text-xs leading-relaxed text-muted">{label}</p> : null}
    </div>
  );
}

export function MeterRow({ label, value, max, hint, tone = 'magma' }: { label: string; value: number; max: number; hint?: string; tone?: 'magma' | 'ok' | 'err' }) {
  const width = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[11px]">
        <span className="truncate text-fg">{label}</span>
        <span className="shrink-0 font-mono text-faint">{hint ?? formatNumber(value)}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-panel-3">
        <div className={cx('h-full rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'err' ? 'bg-err' : 'bg-magma')} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
