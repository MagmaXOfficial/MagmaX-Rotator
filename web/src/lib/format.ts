export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return formatNumber(value);
}

export function formatCurrency(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${value.toFixed(digits > 2 ? 4 : 2)}`;
}

export function formatLatency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'unknown';
  if (value === 0) return 'free';
  return `$${value.toFixed(value < 1 ? 3 : 2)}/1M`;
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatRelative(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const diff = Math.max(0, now - ts);
  if (diff < 5000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function shortModel(value: string | null | undefined): string {
  if (!value) return '—';
  const parts = value.split('/');
  return parts[parts.length - 1] ?? value;
}

export function contextLabel(value: number | null | undefined): string {
  if (!value) return 'unknown';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(1)}%`;
}
