import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  Boxes,
  Cable,
  ChevronRight,
  Flame,
  LayoutDashboard,
  Menu,
  Moon,
  Plug,
  Route,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import { useApi } from '../lib/hooks';
import { cx } from '../lib/format';
import { CopyChip, StatusDot } from './ui';
import type { StatusResponse } from '../lib/types';

export type PageId = 'overview' | 'providers' | 'models' | 'router' | 'skills' | 'integrations' | 'monitoring' | 'settings';

export const PAGES: Array<{ id: PageId; label: string; icon: typeof LayoutDashboard; description: string }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, description: 'Gateway health, usage and quick actions' },
  { id: 'providers', label: 'Providers', icon: Plug, description: 'API keys, connections and endpoints' },
  { id: 'models', label: 'Models', icon: Boxes, description: 'Catalogue, priorities, aliases and pricing' },
  { id: 'router', label: 'Router', icon: Route, description: 'Routing modes, failover chain and retries' },
  { id: 'skills', label: 'Skills', icon: Sparkles, description: 'Sandboxed skills and MCP servers' },
  { id: 'integrations', label: 'Integrations', icon: Cable, description: 'Claude Code, OpenCode and clients' },
  { id: 'monitoring', label: 'Monitoring', icon: Activity, description: 'Live requests, analytics and errors' },
  { id: 'settings', label: 'Settings', icon: SettingsIcon, description: 'Server, security, backup and diagnostics' },
];

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return (localStorage.getItem('magmax.theme') as 'dark' | 'light') || 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');
    try {
      localStorage.setItem('magmax.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex size-8 items-center justify-center rounded-[9px] bg-gradient-to-br from-[#ff7a3d] to-[#e2410a] text-[#1a0b04] shadow-[0_0_0_1px_rgba(255,122,61,0.25),0_6px_18px_-8px_rgba(255,90,31,0.8)]">
        <Flame size={17} strokeWidth={2.4} />
      </span>
      <div className="leading-tight">
        <p className="text-[13.5px] font-semibold tracking-[-0.01em] text-fg">
          MagmaX <span className="font-normal text-muted">Rotator</span>
        </p>
        <p className="text-[10px] uppercase tracking-[0.16em] text-faint">Local AI gateway</p>
      </div>
    </div>
  );
}

export function Shell({ page, onNavigate, children }: { page: PageId; onNavigate: (page: PageId) => void; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { theme, toggle } = useTheme();
  const { data: status } = useApi<StatusResponse>('/api/status', { refreshMs: 10_000 });
  const activeMeta = PAGES.find((p) => p.id === page);
  const online = Boolean(status);
  const localOnly = status?.app.localOnly ?? true;

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 px-2.5">
      {PAGES.map((item) => {
        const Icon = item.icon;
        const active = item.id === page;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              onNavigate(item.id);
              setMobileOpen(false);
            }}
            className={cx(
              'mx-focus group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] transition-colors',
              active ? 'bg-panel-2 text-fg' : 'text-muted hover:bg-panel-2/60 hover:text-fg',
            )}
          >
            {active ? <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r bg-magma" /> : null}
            <Icon size={15} className={cx('shrink-0 transition-colors', active ? 'text-magma' : 'text-faint group-hover:text-muted')} strokeWidth={1.9} />
            <span className="flex-1 truncate">{item.label}</span>
            {item.id === 'providers' && status ? <span className="text-[10px] font-mono text-faint">{status.counts.activeProviders}</span> : null}
            {item.id === 'models' && status ? <span className="text-[10px] font-mono text-faint">{status.counts.enabledModels}</span> : null}
          </button>
        );
      })}
    </nav>
  );

  const sidebarFooter = (
    <div className="mx-2.5 mb-3 rounded-lg border border-line bg-bg-elevated/60 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-fg">
          <StatusDot status={online ? 'connected' : 'error'} />
          {online ? 'Gateway online' : 'Connecting…'}
        </span>
        <span className="font-mono text-[10px] text-faint">v{status?.app.version ?? '1.0.0'}</span>
      </div>
      <p className="mt-1.5 truncate font-mono text-[10px] text-faint">
        {status?.app.host ?? '127.0.0.1'}:{status?.app.port ?? 3000}
      </p>
      <p className={cx('mt-1 inline-flex items-center gap-1 text-[10px]', localOnly ? 'text-faint' : 'text-warn')}>
        {localOnly ? 'Localhost only' : 'Network exposed'}
      </p>
    </div>
  );

  return (
    <div className="mx-glow min-h-screen">
      <div className="lg:grid lg:min-h-screen lg:grid-cols-[236px_1fr]">
        {/* desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-bg/80 backdrop-blur-xl lg:flex">
          <div className="px-4 pb-4 pt-5">
            <Logo />
          </div>
          {nav}
          {sidebarFooter}
        </aside>

        {/* mobile drawer */}
        {mobileOpen ? (
          <div className="fixed inset-0 z-[80] lg:hidden">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
            <aside className="mx-enter absolute inset-y-0 left-0 flex w-[268px] flex-col border-r border-line bg-bg">
              <div className="flex items-center justify-between px-4 pb-4 pt-5">
                <Logo />
                <button type="button" onClick={() => setMobileOpen(false)} className="rounded-lg p-1.5 text-muted hover:bg-panel-2" aria-label="Close navigation">
                  <X size={16} />
                </button>
              </div>
              {nav}
              {sidebarFooter}
            </aside>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-40 flex h-[52px] items-center justify-between gap-3 border-b border-line bg-bg/75 px-4 backdrop-blur-xl sm:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <button type="button" onClick={() => setMobileOpen(true)} className="rounded-lg p-1.5 text-muted hover:bg-panel-2 lg:hidden" aria-label="Open navigation">
                <Menu size={17} />
              </button>
              <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
                <span className="hidden text-faint sm:inline">MagmaX</span>
                <ChevronRight size={12} className="hidden text-faint sm:inline" />
                <span className="truncate font-medium text-fg">{activeMeta?.label ?? 'Overview'}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {status ? (
                <span className="hidden items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] md:inline-flex">
                  <span className={cx('size-1.5 rounded-full', online ? 'bg-ok' : 'bg-err', online && 'mx-pulse')} />
                  <span className="text-muted">{status.usage.requestsPerMinute.toFixed(1)} req/min</span>
                </span>
              ) : null}
              <div className="hidden sm:block">
                <CopyChip value={status?.app.gatewayBase ?? 'http://localhost:3000/v1'} />
              </div>
              <button
                type="button"
                onClick={toggle}
                className="mx-focus rounded-lg p-1.5 text-muted transition hover:bg-panel-2 hover:text-fg"
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
              >
                {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
              </button>
            </div>
          </header>

          <main className="mx-auto w-full max-w-[1380px] flex-1 px-4 py-6 sm:px-6 sm:py-7">{children}</main>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-[11px] text-faint sm:px-6">
            <span>
              MagmaX Rotator v{status?.app.version ?? '1.0.0'} · data at <span className="font-mono">{status?.app.dataDir ?? './data'}</span>
            </span>
            <span className="font-mono">
              {status?.counts.liveClients ?? 0} live client{status?.counts.liveClients === 1 ? '' : 's'}
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}
