import { useState } from 'react';
import { Cable, CheckCircle2, CircleSlash, ClipboardCheck, FileJson, RefreshCw, Terminal, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { cx } from '../lib/format';
import { Badge, Button, Card, CardHeader, CodeBlock, CopyChip, Modal, PageHeader, Spinner, StatusDot, useToast } from '../components/ui';
import type { IntegrationStatus } from '../lib/types';

interface IntegrationsResponse {
  integrations: IntegrationStatus[];
  claudeCode: { settings: Record<string, unknown>; shell: string; env: Array<{ key: string; value: string }> };
  openCode: { config: Record<string, unknown> };
  endpoints: { openai: string; anthropic: string };
}

interface ApplyResult {
  ok: boolean;
  path: string;
  wrote: boolean;
  message: string;
  preview: string;
}

interface VerifyResult {
  target: string;
  ok: boolean;
  status: number | null;
  detail: string;
  modelCount?: number;
}

export function Integrations() {
  const { data, loading, refresh } = useApi<IntegrationsResponse>('/api/integrations', { refreshMs: 20_000 });
  const [preview, setPreview] = useState<{ title: string; result: ApplyResult; target: 'claude' | 'opencode' } | null>(null);
  const [applying, setApplying] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResults, setVerifyResults] = useState<VerifyResult[] | null>(null);
  const toast = useToast();

  const claude = data?.integrations.find((item) => item.id === 'claude-code');
  const opencode = data?.integrations.find((item) => item.id === 'opencode');

  const runPreview = async (target: 'claude' | 'opencode') => {
    try {
      const result = await api.post<ApplyResult>(`/api/integrations/${target === 'claude' ? 'claude-code' : 'opencode'}/apply`, { dryRun: true });
      setPreview({ title: target === 'claude' ? 'Claude Code settings preview' : 'OpenCode config preview', result, target });
    } catch (err) {
      toast.push({ title: 'Could not build preview', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    }
  };

  const apply = async () => {
    if (!preview) return;
    setApplying(true);
    try {
      const result = await api.post<ApplyResult>(`/api/integrations/${preview.target === 'claude' ? 'claude-code' : 'opencode'}/apply`, { dryRun: false });
      if (result.ok) {
        toast.push({ title: result.message, description: `Written to ${result.path}. A .magmax-backup copy was kept.`, tone: 'success' });
        setPreview(null);
        refresh();
      } else {
        toast.push({ title: 'Could not write config', description: result.message, tone: 'error' });
      }
    } catch (err) {
      toast.push({ title: 'Could not write config', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setApplying(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    try {
      const result = await api.post<{ results: VerifyResult[] }>('/api/integrations/verify');
      setVerifyResults(result.results);
      const failures = result.results.filter((item) => !item.ok).length;
      toast.push({
        title: failures ? `${failures} endpoint check(s) failed` : 'Both gateways reachable',
        description: result.results.map((item) => `${item.target}: ${item.ok ? 'ok' : item.detail}`).join(' · '),
        tone: failures ? 'error' : 'success',
      });
      refresh();
    } catch (err) {
      toast.push({ title: 'Verification failed', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setVerifying(false);
    }
  };

  if (loading && !data) {
    return <div className="flex h-60 items-center justify-center"><Spinner /></div>;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Integrations"
        description="Point coding agents at this router. Auto-config writes the standard client config file with a backup; nothing is applied without a preview."
        actions={
          <>
            <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={refresh}>
              Refresh
            </Button>
            <Button variant="primary" icon={<ClipboardCheck size={14} />} onClick={verify} loading={verifying}>
              Test connection
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                Claude Code <StatusDot status={claude?.configured ? 'connected' : 'unconfigured'} />
              </span>
            }
            description={claude?.detail ?? 'Anthropic Messages API compatible endpoint.'}
            icon={<Terminal size={15} />}
            actions={<Badge tone={claude?.configured ? 'ok' : 'warn'}>{claude?.configured ? 'configured' : 'not configured'}</Badge>}
          />
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted">Base URL</span>
              <CopyChip value={data?.endpoints.anthropic ?? 'http://localhost:3000/v1'} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted">Config file</span>
              <span className="truncate font-mono text-[10px] text-faint">{claude?.configPath}</span>
            </div>
            <div className="overflow-hidden rounded-lg border border-line">
              <div className="flex items-center justify-between border-b border-line bg-bg-elevated px-3 py-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">environment variables</span>
                <Badge>{data?.claudeCode.env.length ?? 0}</Badge>
              </div>
              <div className="divide-y divide-line">
                {(data?.claudeCode.env ?? []).map((item) => (
                  <div key={item.key} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="truncate font-mono text-[10.5px] text-muted">{item.key}</span>
                    <CopyChip value={item.value} label={`${item.value.slice(0, 26)}${item.value.length > 26 ? '…' : ''}`} />
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-line bg-bg-elevated p-2.5 text-[10.5px] leading-relaxed text-muted">
              Claude Code appends <span className="font-mono text-fg">/v1/messages</span> itself, so <span className="font-mono text-fg">ANTHROPIC_BASE_URL</span> must not include it. Model aliases in the Models tab let you keep Claude model names while routing to NVIDIA, Groq or Gemini.
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => runPreview('claude')}>
                Preview config
              </Button>
              <Button variant="primary" size="sm" onClick={() => runPreview('claude')} icon={<ClipboardCheck size={12} />}>
                Apply to settings.json
              </Button>
            </div>
            <CodeBlock title="shell (manual setup)" code={data?.claudeCode.shell ?? ''} maxHeight={140} />
          </div>
        </Card>

        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                OpenCode <StatusDot status={opencode?.configured ? 'connected' : 'unconfigured'} />
              </span>
            }
            description={opencode?.detail ?? 'OpenAI-compatible custom provider.'}
            icon={<Cable size={15} />}
            actions={<Badge tone={opencode?.configured ? 'ok' : 'warn'}>{opencode?.configured ? 'configured' : 'not configured'}</Badge>}
          />
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted">Base URL</span>
              <CopyChip value={`${data?.endpoints.openai ?? 'http://localhost:3000/v1'}`} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted">Config file</span>
              <span className="truncate font-mono text-[10px] text-faint">{opencode?.configPath}</span>
            </div>
            <CodeBlock title="~/.config/opencode/opencode.json" code={JSON.stringify(data?.openCode.config ?? {}, null, 2)} maxHeight={240} />
            <div className="rounded-lg border border-line bg-bg-elevated p-2.5 text-[10.5px] leading-relaxed text-muted">
              Registers a custom provider named <span className="font-mono text-fg">magmax</span> using the OpenAI-compatible SDK. The default model <span className="font-mono text-fg">magmax-auto</span> lets the router choose; individual model ids are also registered.
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => runPreview('opencode')}>
                Preview config
              </Button>
              <Button variant="primary" size="sm" icon={<FileJson size={12} />} onClick={() => runPreview('opencode')}>
                Apply to opencode.json
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {verifyResults ? (
        <Card>
          <CardHeader title="Connection verification" description="Loopback requests to the running gateway — no inference cost." icon={<ClipboardCheck size={15} />} />
          <div className="space-y-1.5">
            {verifyResults.map((result) => (
              <div key={result.target} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-elevated px-3 py-2 text-[11px]">
                {result.ok ? <CheckCircle2 size={13} className="text-ok" /> : <CircleSlash size={13} className="text-err" />}
                <span className="font-medium text-fg">{result.target}</span>
                <Badge tone={result.ok ? 'ok' : 'err'}>{result.status ?? 'network error'}</Badge>
                <span className="min-w-0 flex-1 truncate text-muted">{result.detail}</span>
                {result.modelCount !== undefined ? <span className="font-mono text-faint">{result.modelCount} models</span> : null}
              </div>
            ))}
          </div>
          <p className="mt-2 flex gap-1.5 text-[10px] leading-relaxed text-faint">
            <TriangleAlert size={11} className="mt-0.5 shrink-0" /> A 400 from <span className="font-mono">/v1/messages</span> still proves the endpoint is reachable and validating; this check sends an intentionally empty message list.
          </p>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="What is actually supported" description="No invented compatibility claims." icon={<FileJson size={15} />} />
        <div className="grid gap-2 md:grid-cols-2">
          {[
            ['Anthropic Messages API', 'implemented', 'POST /v1/messages with system prompts, tool use, streaming and stop sequences'],
            ['Anthropic streaming events', 'implemented', 'message_start → content_block_delta → message_delta → message_stop, including input_json_delta for tools'],
            ['OpenAI Chat Completions', 'implemented', 'POST /v1/chat/completions with tools, streaming, stop, response_format, seed and extra passthrough fields'],
            ['Model listing', 'implemented', 'GET /v1/models with real metadata; unknown fields stay null'],
            ['Token counting', 'estimated', 'POST /v1/messages/count_tokens returns an estimate (≈4 chars/token), labelled _magmax_estimated'],
            ['OpenAI Responses API', 'not implemented', '/v1/responses returns 501 with a clear message'],
            ['Embeddings', 'not implemented', '/v1/embeddings returns 501 — this router routes chat models only'],
            ['Claude Code “1M context” flags', 'provider dependent', 'Forwarded as ordinary requests; no special handling is claimed'],
          ].map(([feature, state, detail]) => (
            <div key={feature} className="rounded-lg border border-line bg-bg-elevated p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-fg">{feature}</span>
                <Badge tone={state === 'implemented' ? 'ok' : state === 'not implemented' ? 'err' : 'warn'}>{state}</Badge>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-muted">{detail}</p>
            </div>
          ))}
        </div>
      </Card>

      <Modal
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview?.title ?? 'Preview'}
        description={preview?.result.path}
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
            <Button variant="primary" onClick={apply} loading={applying} icon={<ClipboardCheck size={13} />}>
              Write file
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <p className={cx('rounded-lg border px-3 py-2 text-[11px]', preview?.result.ok ? 'border-line text-muted' : 'border-err/30 text-err')}>{preview?.result.message}</p>
          <pre className="mx-code max-h-80 overflow-auto rounded-lg border border-line bg-bg-elevated p-3 text-muted">{preview?.result.preview}</pre>
        </div>
      </Modal>
    </div>
  );
}

export default Integrations;
