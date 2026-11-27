import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DATA_DIR } from '../config.js';
import { deleteSkill, getSkill, listSkills, recordSkillRun, upsertSkill } from '../db.js';
import { log } from '../logger.js';
import { publish } from '../realtime.js';
import type { SkillManifest, SkillRecord } from '../types.js';
import { BUILTIN_SKILLS } from './builtins.js';

export const SKILLS_DIR = path.join(DATA_DIR, 'skills');

const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Skill id must be lowercase letters, numbers and dashes'),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  entry: z.string().default('index.mjs'),
  runtime: z.enum(['node', 'process']).default('node'),
  permissions: z
    .object({
      network: z.array(z.string()).default([]),
      filesystem: z.enum(['none', 'skill', 'read-data']).default('none'),
      env: z.array(z.string()).default([]),
    })
    .default({ network: [], filesystem: 'none', env: [] }),
  inputSchema: z.record(z.unknown()).optional(),
  author: z.string().optional(),
  homepage: z.string().optional(),
  tags: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(120000).default(15000),
  exampleInput: z.record(z.unknown()).optional(),
});

const RUNNER_SOURCE = `import { readFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
const entry = process.env.MAGMAX_SKILL_ENTRY;
if (!entry) throw new Error('MAGMAX_SKILL_ENTRY is not set');
const mod = await import(new URL(entry, import.meta.url).href);
const run = mod.run ?? mod.default;
if (typeof run !== 'function') throw new Error('Skill does not export run(input)');
const result = await run(input, { log: (...args) => console.error('[skill]', ...args) });
process.stdout.write(JSON.stringify(result ?? null));
`;

function safeJoin(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
    throw new Error('Skill entry escapes the skill directory');
  }
  return target;
}

export function ensureBuiltinSkills(): void {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  for (const skill of BUILTIN_SKILLS) {
    const dir = path.join(SKILLS_DIR, skill.manifest.id);
    const entry = path.join(dir, 'index.mjs');
    const manifestFile = path.join(dir, 'skill.json');
    const runner = path.join(dir, '_runner.mjs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(entry)) fs.writeFileSync(entry, skill.entrySource, 'utf8');
      if (!fs.existsSync(manifestFile)) fs.writeFileSync(manifestFile, JSON.stringify(skill.manifest, null, 2), 'utf8');
      if (!fs.existsSync(runner)) fs.writeFileSync(runner, RUNNER_SOURCE, 'utf8');
      upsertSkill({
        id: skill.manifest.id,
        name: skill.manifest.name,
        version: skill.manifest.version,
        description: skill.manifest.description,
        source: 'builtin',
        path: dir,
        enabled: getSkill(skill.manifest.id)?.enabled ?? true,
        permissions: skill.manifest.permissions,
        manifest: skill.manifest,
        installedAt: getSkill(skill.manifest.id)?.installedAt ?? Date.now(),
        lastRunAt: getSkill(skill.manifest.id)?.lastRunAt ?? null,
        lastStatus: getSkill(skill.manifest.id)?.lastStatus ?? null,
        lastError: getSkill(skill.manifest.id)?.lastError ?? null,
        builtin: true,
      });
    } catch (err) {
      log.error('skill.builtin_failed', { id: skill.manifest.id, error: String(err) });
    }
  }
}

export function builtinRegistry(): SkillManifest[] {
  const installed = new Set(listSkills().map((s) => s.id));
  return BUILTIN_SKILLS.filter((s) => !installed.has(s.manifest.id)).map((s) => s.manifest);
}

function readManifest(dir: string): SkillManifest {
  const file = path.join(dir, 'skill.json');
  if (!fs.existsSync(file)) throw new Error('skill.json not found in the skill directory');
  const parsed = manifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return parsed as SkillManifest;
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile() && fs.statSync(from).size <= 2 * 1024 * 1024) fs.copyFileSync(from, to);
  }
}

export interface InstallResult {
  skill: SkillRecord;
  warnings: string[];
}

export function installFromDirectory(sourceDir: string, opts: { enabled?: boolean } = {}): InstallResult {
  const resolved = path.resolve(sourceDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Directory not found: ${resolved}`);
  const manifest = readManifest(resolved);
  const dest = path.join(SKILLS_DIR, manifest.id);
  if (fs.existsSync(dest)) {
    const existing = getSkill(manifest.id);
    if (existing && !existing.builtin) fs.rmSync(dest, { recursive: true, force: true });
    else throw new Error(`A skill with id "${manifest.id}" already exists`);
  }
  copyDir(resolved, dest);
  const entryPath = safeJoin(dest, manifest.entry ?? 'index.mjs');
  if (!fs.existsSync(entryPath)) throw new Error(`Entry point not found: ${manifest.entry ?? 'index.mjs'}`);
  fs.writeFileSync(path.join(dest, '_runner.mjs'), RUNNER_SOURCE, 'utf8');
  upsertSkill({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    source: 'local',
    path: dest,
    enabled: opts.enabled ?? true,
    permissions: manifest.permissions,
    manifest,
    installedAt: Date.now(),
    lastRunAt: null,
    lastStatus: 'installed',
    lastError: null,
    builtin: false,
  });
  publish('skill_installed', { id: manifest.id, name: manifest.name });
  return {
    skill: getSkill(manifest.id)!,
    warnings: [
      'Skills run in a Node permission sandbox, but that is not a full security boundary. Review the code before installing third-party skills.',
    ],
  };
}

export async function installFromGit(url: string): Promise<InstallResult> {
  if (!/^https:\/\/[\w.-]+\.\w+\/[\w./-]+(\.git)?$/.test(url)) {
    throw new Error('Only https git URLs are accepted (no ssh, no local file paths)');
  }
  const tmp = path.join(DATA_DIR, 'tmp', `skill-${Date.now().toString(36)}`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', url, tmp], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => reject(new Error(`git is not available: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git clone failed: ${stderr.slice(0, 300)}`))));
  });
  try {
    const result = installFromDirectory(tmp);
    return result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface SkillRunResult {
  status: 'success' | 'error' | 'disabled' | 'timeout';
  output: unknown;
  logs: string;
  durationMs: number;
  error?: string;
}

export async function runSkill(id: string, input: Record<string, unknown>): Promise<SkillRunResult> {
  const skill = getSkill(id);
  if (!skill) throw new Error('Skill not found');
  if (!skill.enabled) {
    recordSkillRun(id, 'disabled', 0, JSON.stringify(input).slice(0, 500), null, 'Skill is disabled');
    return { status: 'disabled', output: null, logs: '', durationMs: 0, error: 'Skill is disabled' };
  }
  const dir = skill.path;
  const manifest = skill.manifest;
  const entry = manifest.entry ?? 'index.mjs';
  const entryPath = safeJoin(dir, entry);
  if (!fs.existsSync(entryPath)) {
    const error = `Entry point missing: ${entry}`;
    recordSkillRun(id, 'error', 0, null, null, error);
    return { status: 'error', output: null, logs: '', durationMs: 0, error };
  }
  const runner = path.join(dir, '_runner.mjs');
  if (!fs.existsSync(runner)) fs.writeFileSync(runner, RUNNER_SOURCE, 'utf8');

  const args = ['--permission', `--allow-fs-read=${dir}`, runner];
  if (manifest.permissions?.network?.length) args.splice(2, 0, '--allow-net');
  const timeoutMs = Math.min(manifest.timeoutMs ?? 15000, 60_000);
  const started = Date.now();
  const result = await new Promise<SkillRunResult>((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', MAGMAX_SKILL_ENTRY: `./${entry}` },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += String(d);
      if (stdout.length > 1_000_000) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 100_000) stderr = stderr.slice(0, 100_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'error', output: null, logs: stderr, durationMs: Date.now() - started, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (timedOut) {
        const error = `Skill exceeded its ${timeoutMs}ms timeout`;
        recordSkillRun(id, 'timeout', durationMs, JSON.stringify(input).slice(0, 500), null, error);
        resolve({ status: 'timeout', output: null, logs: stderr, durationMs, error });
        return;
      }
      if (code !== 0) {
        const error = stderr.trim().slice(0, 2000) || `Skill exited with code ${code}`;
        recordSkillRun(id, 'error', durationMs, JSON.stringify(input).slice(0, 500), null, error);
        resolve({ status: 'error', output: null, logs: stderr.slice(0, 4000), durationMs, error });
        return;
      }
      try {
        const output = JSON.parse(stdout || 'null');
        recordSkillRun(id, 'success', durationMs, JSON.stringify(input).slice(0, 500), JSON.stringify(output), null);
        resolve({ status: 'success', output, logs: stderr.slice(0, 4000), durationMs });
      } catch {
        const error = `Skill returned invalid JSON: ${stdout.slice(0, 300)}`;
        recordSkillRun(id, 'error', durationMs, JSON.stringify(input).slice(0, 500), stdout.slice(0, 500), error);
        resolve({ status: 'error', output: null, logs: stderr, durationMs, error });
      }
    });
    child.stdin.write(JSON.stringify(input ?? {}));
    child.stdin.end();
  });
  publish('skill_run', { id, status: result.status, durationMs: result.durationMs });
  log.info('skill.run', { id, status: result.status, durationMs: result.durationMs });
  return result;
}

export function removeSkill(id: string): void {
  const skill = getSkill(id);
  if (!skill) throw new Error('Skill not found');
  if (skill.builtin) throw new Error('Built-in skills cannot be removed — disable them instead');
  const resolved = path.resolve(skill.path);
  if (resolved.startsWith(path.resolve(SKILLS_DIR) + path.sep) && fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  deleteSkill(id);
  publish('skill_removed', { id });
}
