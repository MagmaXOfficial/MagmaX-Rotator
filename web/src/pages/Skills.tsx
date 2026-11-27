import { useEffect, useState } from 'react';
import { Boxes, Code2, Download, FolderGit2, History, Play, Plus, Server, ShieldAlert, Sparkles, Terminal, Trash2, Wrench } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { cx, formatDateTime, formatDuration, formatRelative } from '../lib/format';
import { Badge, Button, Card, CardHeader, ConfirmButton, EmptyState, Field, IconButton, Input, Modal, PageHeader, Spinner, Switch, Tabs, Textarea, useToast } from '../components/ui';
import type { McpServer, Skill, SkillRun } from '../lib/types';

interface SkillsResponse {
  skills: Skill[];
  available: Array<Skill['manifest']>;
  mcp: McpServer[];
}

type Tab = 'installed' | 'install' | 'mcp';

export function Skills() {
  const { data, loading, refresh } = useApi<SkillsResponse>('/api/skills', { refreshMs: 30_000 });
  const [tab, setTab] = useState<Tab>('installed');
  const [running, setRunning] = useState<Skill | null>(null);
  const [logsFor, setLogsFor] = useState<Skill | null>(null);
  const [callFor, setCallFor] = useState<{ server: McpServer; tool: string } | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [gitInput, setGitInput] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const [mcpName, setMcpName] = useState('');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const [probing, setProbing] = useState<string | null>(null);
  const toast = useToast();

  const skills = data?.skills ?? [];
  const available = data?.available ?? [];
  const servers = data?.mcp ?? [];

  const install = async (mode: 'builtin' | 'path' | 'git', payload: { id?: string; path?: string; url?: string }) => {
    setInstalling(mode + (payload.id ?? payload.path ?? payload.url ?? ''));
    try {
      const result = await api.post<{ skill: Skill; warnings: string[] }>('/api/skills/install', { mode, ...payload });
      toast.push({
        title: `${result.skill?.name ?? 'Skill'} installed`,
        description: result.warnings?.[0] ?? 'Enable it and run a test to confirm it works.',
        tone: 'success',
      });
      setPathInput('');
      setGitInput('');
      refresh();
    } catch (err) {
      toast.push({ title: 'Install failed', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Skills"
        description="Real executables, sandboxed in a Node permission process with an explicit timeout. Permissions are shown before you run anything."
        actions={
          <Button variant="ghost" icon={<History size={14} />} onClick={refresh} loading={loading}>
            Refresh
          </Button>
        }
      />

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'installed', label: 'Installed', count: skills.length },
          { id: 'install', label: 'Install', count: available.length },
          { id: 'mcp', label: 'MCP servers', count: servers.length },
        ]}
      />

      {tab === 'installed' ? (
        loading && !data ? (
          <div className="flex h-40 items-center justify-center"><Spinner /></div>
        ) : skills.length === 0 ? (
          <EmptyState icon={<Sparkles size={18} />} title="No skills installed" description="Install a built-in skill or import one from a directory or Git repository." action={<Button size="sm" variant="primary" onClick={() => setTab('install')}>Browse skills</Button>} />
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {skills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onRun={() => setRunning(skill)}
                onLogs={() => setLogsFor(skill)}
                onChange={refresh}
              />
            ))}
          </div>
        )
      ) : null}

      {tab === 'install' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="Built-in skills" description="Shipped with MagmaX. Implementations live on disk and can be inspected or edited." icon={<Sparkles size={15} />} />
            {available.length === 0 ? (
              <p className="text-xs text-muted">All built-in skills are installed.</p>
            ) : (
              <div className="space-y-2">
                {available.map((manifest) => (
                  <div key={manifest.id} className="rounded-lg border border-line bg-bg-elevated p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[12px] font-medium text-fg">{manifest.name}</p>
                      <Button size="sm" variant="secondary" loading={installing === `builtin${manifest.id}`} icon={<Download size={12} />} onClick={() => install('builtin', { id: manifest.id })}>
                        Install
                      </Button>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted">{manifest.description}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader title="Install from a directory" description="The folder must contain skill.json and the declared entry file." icon={<FolderGit2 size={15} />} />
              <div className="space-y-2.5">
                <Field label="Absolute path">
                  <Input value={pathInput} onChange={(event) => setPathInput(event.target.value)} placeholder="/Users/you/skills/my-skill" mono />
                </Field>
                <Button variant="secondary" icon={<Plus size={13} />} loading={installing === `path${pathInput}`} disabled={!pathInput.trim()} onClick={() => install('path', { path: pathInput.trim() })}>
                  Install directory
                </Button>
              </div>
            </Card>
            <Card>
              <CardHeader title="Install from Git" description="Clones over https with --depth 1, then verifies skill.json before registering." icon={<Code2 size={15} />} />
              <div className="space-y-2.5">
                <Field label="https repository URL">
                  <Input value={gitInput} onChange={(event) => setGitInput(event.target.value)} placeholder="https://github.com/you/my-skill" mono />
                </Field>
                <Button variant="secondary" icon={<Download size={13} />} loading={installing === `git${gitInput}`} disabled={!gitInput.trim()} onClick={() => install('git', { url: gitInput.trim() })}>
                  Clone and install
                </Button>
              </div>
            </Card>
            <div className="flex gap-2 rounded-xl border border-warn/30 bg-warn-soft/30 p-3 text-[11px] leading-relaxed text-muted">
              <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warn" />
              <span>
                Skills run with <span className="font-mono">--permission</span>, read access limited to their own folder, network only when declared, and a hard timeout. That is a strong guard, not a perfect sandbox — review third-party code before installing.
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'mcp' ? (
        <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
          <Card>
            <CardHeader title="Add MCP server" description="Stdio transport. MagmaX performs the real JSON-RPC handshake and lists tools on probe." icon={<Server size={15} />} />
            <div className="space-y-3">
              <Field label="Name">
                <Input value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="filesystem" />
              </Field>
              <Field label="Command" hint="executable on PATH">
                <Input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="npx" mono />
              </Field>
              <Field label="Arguments" hint="comma separated">
                <Input value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} placeholder="-y,@modelcontextprotocol/server-filesystem,/Users/you" mono />
              </Field>
              <Button
                variant="primary"
                icon={<Plus size={13} />}
                disabled={!mcpName.trim() || !mcpCommand.trim()}
                onClick={async () => {
                  try {
                    await api.post('/api/mcp', {
                      name: mcpName.trim(),
                      command: mcpCommand.trim(),
                      args: mcpArgs.split(',').map((value) => value.trim()).filter(Boolean),
                    });
                    setMcpName('');
                    setMcpCommand('');
                    setMcpArgs('');
                    toast.push({ title: 'MCP server saved', description: 'Probe it to start the handshake and list its tools.', tone: 'success' });
                    refresh();
                  } catch (err) {
                    toast.push({ title: 'Could not save server', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
                  }
                }}
              >
                Add server
              </Button>
              <p className="flex gap-1.5 text-[10px] leading-relaxed text-faint">
                <ShieldAlert size={11} className="mt-0.5 shrink-0" /> Adding a command does not execute it. Probing and calling tools do — only add servers you trust.
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Configured servers" description="Tools are listed from the server's own tools/list response." icon={<Server size={15} />} />
            {servers.length === 0 ? (
              <p className="text-xs text-muted">No MCP servers configured.</p>
            ) : (
              <div className="space-y-2">
                {servers.map((server) => (
                  <div key={server.id} className="rounded-lg border border-line bg-bg-elevated p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] font-medium text-fg">{server.name}</span>
                      <Badge tone={server.lastStatus === 'connected' ? 'ok' : server.lastStatus === 'error' ? 'err' : 'neutral'}>{server.lastStatus ?? 'not probed'}</Badge>
                      <span className="ml-auto flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={probing === server.id}
                          onClick={async () => {
                            setProbing(server.id);
                            try {
                              const result = await api.post<{ ok: boolean; tools: Array<{ name: string }>; error: string | null }>(`/api/mcp/${server.id}/probe`);
                              toast.push({
                                title: result.ok ? `${result.tools.length} MCP tool(s) discovered` : 'MCP probe failed',
                                description: result.error ?? result.tools.map((t) => t.name).join(', '),
                                tone: result.ok ? 'success' : 'error',
                              });
                              refresh();
                            } catch (err) {
                              toast.push({ title: 'Probe failed', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
                            } finally {
                              setProbing(null);
                            }
                          }}
                        >
                          Probe
                        </Button>
                        <ConfirmButton onConfirm={() => api.del(`/api/mcp/${server.id}`).then(refresh)}>
                          Remove
                        </ConfirmButton>
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-faint">
                      {server.command} {server.args.join(' ')}
                    </p>
                    {server.lastError ? <p className="mt-1 text-[10px] text-err">{server.lastError}</p> : null}
                    {server.tools.length > 0 ? (
                      <div className="mt-2 space-y-1">
                        {server.tools.map((tool) => (
                          <div key={tool.name} className="flex items-center gap-2 rounded border border-line bg-panel px-2 py-1">
                            <Wrench size={10} className="shrink-0 text-magma" />
                            <span className="truncate font-mono text-[10.5px] text-fg">{tool.name}</span>
                            <span className="min-w-0 flex-1 truncate text-[9.5px] text-faint">{tool.description}</span>
                            <button type="button" onClick={() => setCallFor({ server, tool: tool.name })} className="shrink-0 text-[10px] text-muted underline decoration-line underline-offset-2 hover:text-fg">
                              Call
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {running ? <SkillRunModal skill={running} onClose={() => setRunning(null)} onDone={refresh} /> : null}
      {logsFor ? <SkillLogsModal skill={logsFor} onClose={() => setLogsFor(null)} /> : null}
      {callFor ? <McpCallModal server={callFor.server} tool={callFor.tool} onClose={() => setCallFor(null)} /> : null}
    </div>
  );
}

function SkillCard({ skill, onRun, onLogs, onChange }: { skill: Skill; onRun: () => void; onLogs: () => void; onChange: () => void }) {
  const toast = useToast();
  return (
    <Card className={cx(!skill.enabled && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[13px] font-semibold text-fg">{skill.name}</h3>
            <Badge tone={skill.source === 'builtin' ? 'magma' : 'info'}>{skill.source}</Badge>
            <span className="font-mono text-[10px] text-faint">v{skill.version}</span>
            <Badge tone={skill.enabled ? 'ok' : 'neutral'}>{skill.enabled ? 'enabled' : 'disabled'}</Badge>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{skill.description}</p>
        </div>
        <Switch checked={skill.enabled} label={`Enable ${skill.name}`} onChange={async (value) => {
          try {
            await api.patch(`/api/skills/${skill.id}`, { enabled: value });
            onChange();
          } catch (err) {
            toast.push({ title: 'Could not update skill', description: String(err), tone: 'error' });
          }
        }} />
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1">
        <Badge tone="neutral">fs: {skill.permissions.filesystem ?? 'none'}</Badge>
        <Badge tone={skill.permissions.network?.length ? 'warn' : 'neutral'}>net: {skill.permissions.network?.length ? skill.permissions.network.join(', ') : 'none'}</Badge>
        <Badge tone="neutral">timeout {formatDuration(skill.manifest.timeoutMs ?? 15000)}</Badge>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <div className="min-w-0">
          {skill.lastRunAt ? (
            <p className="truncate text-[10px] text-faint">
              Last run {formatRelative(skill.lastRunAt)} · <span className={skill.lastStatus === 'success' ? 'text-ok' : 'text-err'}>{skill.lastStatus}</span>
              {skill.lastError ? ` · ${skill.lastError.slice(0, 60)}` : ''}
            </p>
          ) : (
            <p className="text-[10px] text-faint">Never run · {skill.path}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" icon={<Play size={12} />} onClick={onRun} disabled={!skill.enabled}>
            Run test
          </Button>
          <Button size="sm" variant="ghost" icon={<Terminal size={12} />} onClick={onLogs}>
            Logs
          </Button>
          {!skill.builtin ? (
            <ConfirmButton icon={<Trash2 size={12} />} onConfirm={async () => {
              await api.del(`/api/skills/${skill.id}`);
              onChange();
            }}>
              Remove
            </ConfirmButton>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function SkillRunModal({ skill, onClose, onDone }: { skill: Skill; onClose: () => void; onDone: () => void }) {
  const [input, setInput] = useState(JSON.stringify(skill.manifest.exampleInput ?? {}, null, 2));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ status: string; output: unknown; logs: string; durationMs: number; error?: string } | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const toast = useToast();

  const run = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(input || '{}') as Record<string, unknown>;
      setJsonError(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Invalid JSON');
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const response = await api.post<{ status: string; output: unknown; logs: string; durationMs: number; error?: string }>(`/api/skills/${skill.id}/run`, { input: parsed });
      setResult(response);
      toast.push({ title: response.status === 'success' ? 'Skill ran successfully' : 'Skill failed', description: response.error ?? `${response.durationMs}ms`, tone: response.status === 'success' ? 'success' : 'error' });
      onDone();
    } catch (err) {
      toast.push({ title: 'Skill execution failed', description: err instanceof ApiError ? err.message : String(err), tone: 'error' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Run ${skill.name}`}
      description={`Sandboxed Node process · ${skill.permissions.filesystem === 'none' ? 'no filesystem' : `fs ${skill.permissions.filesystem}`} · ${skill.permissions.network?.length ? 'network allowed' : 'no network'}`}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={run} loading={running} icon={<Play size={13} />}>Run skill</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Input (JSON)" hint="passed to run(input)">
          <Textarea value={input} onChange={(event) => setInput(event.target.value)} rows={6} mono />
        </Field>
        {jsonError ? <p className="text-[11px] text-err">Invalid JSON: {jsonError}</p> : null}
        {result ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <Badge tone={result.status === 'success' ? 'ok' : 'err'}>{result.status}</Badge>
              <span className="font-mono text-faint">{result.durationMs}ms</span>
            </div>
            {result.error ? <p className="rounded-lg border border-err/30 bg-err-soft/40 p-2 text-[11px] text-muted">{result.error}</p> : null}
            <pre className="mx-code max-h-60 overflow-auto rounded-lg border border-line bg-bg-elevated p-2.5 text-fg">{JSON.stringify(result.output, null, 2)}</pre>
            {result.logs ? <pre className="mx-code max-h-32 overflow-auto rounded-lg border border-line bg-bg-elevated p-2.5 text-faint">{result.logs}</pre> : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function SkillLogsModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const { data, loading } = useApi<{ runs: SkillRun[] }>(`/api/skills/${skill.id}/runs`);
  return (
    <Modal open onClose={onClose} title={`${skill.name} · execution log`} width="max-w-2xl">
      {loading && !data ? <Spinner /> : null}
      {data?.runs.length === 0 ? <p className="text-xs text-muted">No executions yet.</p> : null}
      <div className="space-y-1.5">
        {data?.runs.map((run) => (
          <div key={run.id} className="rounded-lg border border-line bg-bg-elevated p-2.5">
            <div className="flex flex-wrap items-center gap-2 text-[10.5px]">
              <Badge tone={run.status === 'success' ? 'ok' : run.status === 'timeout' ? 'warn' : 'err'}>{run.status}</Badge>
              <span className="text-muted">{formatDateTime(run.ts)}</span>
              <span className="font-mono text-faint">{run.durationMs}ms</span>
            </div>
            {run.error ? <p className="mt-1 break-words text-[10px] text-err">{run.error}</p> : null}
            {run.outputText ? <pre className="mx-code mt-1 max-h-28 overflow-auto text-faint">{run.outputText}</pre> : null}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function McpCallModal({ server, tool, onClose }: { server: McpServer; tool: string; onClose: () => void }) {
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const toast = useToast();
  return (
    <Modal
      open
      onClose={onClose}
      title={`Call ${tool}`}
      description={`${server.name} · real MCP tools/call over stdio`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            loading={running}
            onClick={async () => {
              try {
                const parsed = JSON.parse(args || '{}') as Record<string, unknown>;
                setRunning(true);
                const response = await api.post<{ ok: boolean; result: unknown }>(`/api/mcp/${server.id}/call`, { tool, arguments: parsed });
                setResult(JSON.stringify(response.result, null, 2));
              } catch (err) {
                const message = err instanceof ApiError ? err.message : err instanceof SyntaxError ? 'Arguments are not valid JSON' : String(err);
                toast.push({ title: 'MCP call failed', description: message, tone: 'error' });
              } finally {
                setRunning(false);
              }
            }}
          >
            Call tool
          </Button>
        </>
      }
    >
      <Field label="Arguments (JSON)">
        <Textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={5} mono />
      </Field>
      {result ? <pre className="mx-code mt-3 max-h-64 overflow-auto rounded-lg border border-line bg-bg-elevated p-2.5 text-fg">{result}</pre> : null}
    </Modal>
  );
}

export default Skills;
