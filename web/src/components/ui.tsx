import { createContext, useCallback, useContext, useEffect, useId, useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { AlertTriangle, Check, Copy, Info, Loader2, X } from 'lucide-react';
import { copyText } from '../lib/api';
import { cx } from '../lib/format';

/* --------------------------------- toasts -------------------------------- */

export type ToastTone = 'success' | 'error' | 'info' | 'warning';
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

const ToastContext = createContext<{ push: (toast: Omit<ToastItem, 'id'>) => void }>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-3), { ...toast, id }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 5200);
  }, []);
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[min(380px,calc(100vw-2.5rem))] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(
              'mx-toast pointer-events-auto flex gap-3 rounded-xl border bg-panel p-3.5 shadow-[var(--shadow)]',
              toast.tone === 'error' && 'border-err/40',
              toast.tone === 'success' && 'border-ok/40',
              toast.tone === 'warning' && 'border-warn/40',
              toast.tone === 'info' && 'border-line-strong',
            )}
          >
            <span
              className={cx(
                'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                toast.tone === 'error' && 'bg-err-soft text-err',
                toast.tone === 'success' && 'bg-ok-soft text-ok',
                toast.tone === 'warning' && 'bg-warn-soft text-warn',
                toast.tone === 'info' && 'bg-info-soft text-info',
              )}
            >
              {toast.tone === 'error' || toast.tone === 'warning' ? <AlertTriangle size={12} /> : toast.tone === 'success' ? <Check size={12} /> : <Info size={12} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-snug text-fg">{toast.title}</p>
              {toast.description ? <p className="mt-0.5 break-words text-xs leading-relaxed text-muted">{toast.description}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
              className="h-5 w-5 shrink-0 rounded text-faint transition hover:bg-panel-2 hover:text-fg"
              aria-label="Dismiss"
            >
              <X size={13} className="mx-auto" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* --------------------------------- button -------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
};

export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'mx-focus inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-8 px-2.5 text-xs',
        size === 'md' && 'h-9 px-3.5 text-[13px]',
        size === 'lg' && 'h-10 px-5 text-sm',
        variant === 'primary' && 'bg-magma text-on-magma shadow-[0_1px_0_rgba(255,255,255,0.18)_inset] hover:bg-magma-hover',
        variant === 'secondary' && 'border border-line bg-panel-2 text-fg hover:border-line-strong hover:bg-panel-3',
        variant === 'outline' && 'border border-line text-fg hover:border-magma-line hover:bg-magma-soft',
        variant === 'ghost' && 'text-muted hover:bg-panel-2 hover:text-fg',
        variant === 'danger' && 'border border-err/40 bg-transparent text-err hover:bg-err-soft',
        className,
      )}
    >
      {loading ? <Loader2 size={14} className="mx-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx('mx-focus inline-flex size-8 items-center justify-center rounded-lg text-muted transition hover:bg-panel-2 hover:text-fg', className)}
    >
      {children}
    </button>
  );
}

/* ---------------------------------- card --------------------------------- */

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <section className={cx('rounded-xl border border-line bg-panel shadow-[var(--shadow)]', padded && 'p-5', className)}>{children}</section>;
}

export function CardHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? <span className="mt-0.5 text-magma">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-fg">{title}</h2>
          {description ? <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: string; actions?: ReactNode; eyebrow?: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow ? <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-magma">{eyebrow}</p> : null}
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-fg">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* --------------------------------- badges -------------------------------- */

export type Tone = 'neutral' | 'magma' | 'ok' | 'warn' | 'err' | 'info';

const TONE_STYLES: Record<Tone, string> = {
  neutral: 'border-line bg-panel-2 text-muted',
  magma: 'border-magma-line bg-magma-soft text-magma',
  ok: 'border-ok/30 bg-ok-soft text-ok',
  warn: 'border-warn/30 bg-warn-soft text-warn',
  err: 'border-err/30 bg-err-soft text-err',
  info: 'border-info/30 bg-info-soft text-info',
};

export function Badge({ children, tone = 'neutral', className, dot }: { children: ReactNode; tone?: Tone; className?: string; dot?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4', TONE_STYLES[tone], className)}>
      {dot ? <span className={cx('size-1.5 rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'err' ? 'bg-err' : tone === 'warn' ? 'bg-warn' : tone === 'magma' ? 'bg-magma' : 'bg-faint')} /> : null}
      {children}
    </span>
  );
}

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const tone = status === 'connected' || status === 'success' || status === 'ok' || status === 'online' ? 'ok' : status === 'error' || status === 'fail' ? 'err' : status === 'unconfigured' || status === 'warn' || status === 'skip' ? 'warn' : 'neutral';
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs', className)}>
      <span
        className={cx(
          'size-1.5 rounded-full',
          tone === 'ok' && 'bg-ok shadow-[0_0_0_3px_var(--ok-soft)]',
          tone === 'err' && 'bg-err shadow-[0_0_0_3px_var(--err-soft)]',
          tone === 'warn' && 'bg-warn shadow-[0_0_0_3px_var(--warn-soft)]',
          tone === 'neutral' && 'bg-faint',
        )}
      />
    </span>
  );
}

/* --------------------------------- inputs -------------------------------- */

export function Field({ label, hint, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <label className={cx('block', className)} htmlFor={htmlFor}>
      <span className="mb-1.5 flex items-baseline justify-between gap-2 text-xs font-medium text-fg">
        {label}
        {hint ? <span className="text-[11px] font-normal text-faint">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const inputBase =
  'w-full rounded-lg border border-line bg-bg-elevated px-3 text-[13px] text-fg placeholder:text-faint transition focus:border-magma-line focus:outline-none focus:ring-2 focus:ring-magma/10 disabled:opacity-60';

export function Input({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input {...rest} className={cx(inputBase, 'h-9', mono && 'font-mono text-xs', className)} />;
}

export function Textarea({ className, mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea {...rest} className={cx(inputBase, 'min-h-[88px] py-2 leading-relaxed', mono && 'font-mono text-xs', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(inputBase, 'h-9 appearance-none bg-[length:14px] bg-[right_10px_center] bg-no-repeat pr-8', className)} style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}>
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? 'Toggle'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'mx-focus relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-magma bg-magma' : 'border-line-strong bg-panel-3',
      )}
    >
      <span className={cx('block size-3.5 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-[18px] bg-[var(--on-magma)]' : 'translate-x-[3px]')} />
    </button>
  );
}

export function Segmented<T extends string>({ options, value, onChange, className }: { options: Array<{ value: T; label: string }>; value: T; onChange: (value: T) => void; className?: string }) {
  return (
    <div className={cx('inline-flex rounded-lg border border-line bg-panel-2 p-0.5', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cx(
            'mx-focus rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition',
            value === option.value ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------- tabs --------------------------------- */

export function Tabs<T extends string>({ items, value, onChange, className }: { items: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (id: T) => void; className?: string }) {
  return (
    <div className={cx('flex flex-wrap gap-1 border-b border-line', className)}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onChange(item.id)}
          className={cx(
            'mx-focus relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition',
            value === item.id ? 'border-magma text-fg' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {item.label}
          {item.count !== undefined ? <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-faint">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------- modal --------------------------------- */

export function Modal({ open, onClose, title, description, children, footer, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-[2px] sm:p-8" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('mx-enter mt-4 w-full rounded-xl border border-line bg-panel shadow-2xl', width)} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-fg">{title}</h3>
            {description ? <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p> : null}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------- utilities ------------------------------- */

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cx('mx-spin text-muted', className)} />;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-12 text-center">
      {icon ? <span className="mb-3 flex size-10 items-center justify-center rounded-xl border border-line bg-panel-2 text-muted">{icon}</span> : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-md text-xs leading-relaxed text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Stat({ label, value, hint, icon, tone }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-faint">{label}</span>
        {icon ? <span className={cx(tone === 'err' ? 'text-err' : tone === 'ok' ? 'text-ok' : tone === 'magma' ? 'text-magma' : 'text-faint')}>{icon}</span> : null}
      </div>
      <p className="mt-2 text-[22px] font-semibold leading-none tracking-[-0.02em] text-fg">{value}</p>
      {hint ? <p className="mt-2 text-[11px] leading-relaxed text-muted">{hint}</p> : null}
    </div>
  );
}

export function CodeBlock({ code, title, maxHeight = 260, className }: { code: string; title?: string; maxHeight?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cx('overflow-hidden rounded-lg border border-line bg-bg-elevated', className)}>
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">{title ?? 'config'}</span>
        <button
          type="button"
          onClick={async () => {
            const ok = await copyText(code);
            setCopied(ok);
            setTimeout(() => setCopied(false), 1600);
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition hover:bg-panel-2 hover:text-fg"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="mx-code overflow-auto p-3 text-muted" style={{ maxHeight }}>
        {code}
      </pre>
    </div>
  );
}

export function CopyChip({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyText(value);
        setCopied(ok);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-bg-elevated px-2 py-1 font-mono text-[11px] text-muted transition hover:border-line-strong hover:text-fg"
      title="Copy to clipboard"
    >
      <span className="truncate">{label ?? value}</span>
      {copied ? <Check size={11} className="shrink-0 text-ok" /> : <Copy size={11} className="shrink-0" />}
    </button>
  );
}

export function ConfirmButton({ children, onConfirm, confirmLabel = 'Click again to confirm', variant = 'danger', size = 'sm', icon }: { children: ReactNode; onConfirm: () => void; confirmLabel?: string; variant?: ButtonProps['variant']; size?: ButtonProps['size']; icon?: ReactNode }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      type="button"
      variant={armed ? 'danger' : variant}
      size={size}
      icon={icon}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-xs text-muted">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 rounded border-line bg-bg-elevated accent-[var(--magma)]" />
      {label}
    </label>
  );
}
