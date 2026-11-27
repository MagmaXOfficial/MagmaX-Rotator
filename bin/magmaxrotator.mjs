#!/usr/bin/env node
/**
 * MagmaX Rotator service control.
 *
 *   magmaxrotator start     build if needed, then run in the background
 *   magmaxrotator stop      stop the background server (graceful, then forced)
 *   magmaxrotator restart   stop + start
 *   magmaxrotator status    show PID, URL, uptime and counts
 *
 * Install the command once with `npm link` (or `npm install -g .`).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(root, 'dist', 'server', 'index.js');
const webIndex = path.join(root, 'web', 'dist', 'index.html');
const dataDir = process.env.MAGMAX_DATA_DIR ? path.resolve(process.env.MAGMAX_DATA_DIR) : path.join(root, 'data');
const pidFile = path.join(dataDir, 'magmax.pid');
const logDir = path.join(root, 'logs');
const logFile = path.join(logDir, 'server.log');

const argv = process.argv.slice(2);
const command = (argv[0] ?? 'help').toLowerCase();
const flags = new Set(argv.slice(1));

let port = Number(process.env.MAGMAX_PORT || process.env.PORT || 3000);
let host = process.env.MAGMAX_HOST || '127.0.0.1';
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--port' && argv[i + 1]) port = Number(argv[++i]);
  if (argv[i] === '--host' && argv[i + 1]) host = argv[++i];
}

const baseUrl = `http://localhost:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readPid() {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pidFile, `${pid}\n`);
}

function clearPid() {
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {
    /* ignore */
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function probePort() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function readStatus() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Best-effort ownership check before signalling a PID taken from disk. */
function looksLikeOurServer(pid) {
  if (process.platform !== 'linux') return true;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('dist/server/index.js') || cmdline.includes('server/index.ts') || cmdline.includes('scripts/start.mjs');
  } catch {
    return false;
  }
}

function tailLog(lines = 12) {
  try {
    const content = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
    return content.slice(-lines).join('\n');
  } catch {
    return '(no log output yet)';
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

function newestMtime(targets) {
  let max = 0;
  const walk = (target) => {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
    } else {
      max = Math.max(max, stat.mtimeMs);
    }
  };
  for (const target of targets) walk(path.resolve(root, target));
  return max;
}

function buildIfNeeded() {
  const builtAt = Math.max(
    fs.existsSync(serverEntry) ? fs.statSync(serverEntry).mtimeMs : 0,
    fs.existsSync(webIndex) ? fs.statSync(webIndex).mtimeMs : 0,
  );
  const sourceAt = newestMtime(['server', 'web/src', 'bin', 'package.json', 'vite.config.ts', 'tsconfig.server.json', 'tsconfig.web.json']);
  if (fs.existsSync(serverEntry) && fs.existsSync(webIndex) && sourceAt <= builtAt) return;
  console.log('Building MagmaX Rotator…');
  if (!fs.existsSync(path.join(root, 'node_modules'))) run('npm', ['install', '--no-audit', '--no-fund']);
  run('npm', ['run', 'build']);
}

function printRunning(detail = true) {
  console.log('MagmaX Rotator is running');
  console.log(`  Dashboard  ${baseUrl}`);
  console.log(`  Gateway    ${baseUrl}/v1`);
  if (detail) console.log(`  Logs       ${path.relative(root, logFile) || logFile}`);
}

async function start() {
  const recorded = readPid();
  if (recorded && isAlive(recorded)) {
    printRunning();
    console.log(`  PID        ${recorded}`);
    return 0;
  }
  if (recorded) clearPid();

  // A server started in the foreground has no PID file; recognise it before calling the port busy.
  const discovered = await readStatus();
  if (discovered?.app?.pid && isAlive(discovered.app.pid)) {
    writePid(discovered.app.pid);
    console.log('MagmaX Rotator is already running');
    console.log(`  Dashboard  ${baseUrl}`);
    console.log(`  Gateway    ${baseUrl}/v1`);
    console.log(`  PID        ${discovered.app.pid}`);
    console.log(`  Logs       ${path.relative(root, logFile) || logFile}`);
    return 0;
  }

  if (await probePort()) {
    console.error(`Port ${port} is already in use by another process. Stop it, or run with --port <other>.`);
    return 1;
  }

  buildIfNeeded();
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, MAGMAX_PORT: String(port), MAGMAX_HOST: host },
  });
  child.unref();
  if (!child.pid) {
    console.error('Could not start the server process.');
    return 1;
  }
  writePid(child.pid);

  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(500);
    if (child.exitCode !== null) {
      clearPid();
      console.error(`Server exited during startup (code ${child.exitCode}). Last log lines:\n`);
      console.error(tailLog());
      return 1;
    }
    if (await probePort()) {
      printRunning();
      console.log(`  PID        ${child.pid}`);
      console.log(`  Bound to   ${host}:${port}`);
      return 0;
    }
  }

  console.error(`Server did not answer on port ${port} within 30s. It may still be starting; check:\n${tailLog()}`);
  return 1;
}

async function stop() {
  const fromFile = readPid();
  const status = await readStatus();
  const pid = fromFile ?? status?.app?.pid ?? null;

  if (!pid) {
    clearPid();
    console.log('MagmaX Rotator is not running.');
    return 0;
  }
  if (!isAlive(pid)) {
    clearPid();
    console.log('MagmaX Rotator is not running (removed stale PID file).');
    return 0;
  }

  const owned = status?.app?.pid === pid || !fromFile || looksLikeOurServer(pid);
  if (!owned && !flags.has('--force')) {
    console.error(`PID ${pid} does not look like the MagmaX server. Re-run with --force to stop it anyway.`);
    return 1;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`Could not signal PID ${pid}: ${err.message}`);
    return 1;
  }

  for (let attempt = 0; attempt < 16 && isAlive(pid); attempt++) await sleep(500);
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    for (let attempt = 0; attempt < 8 && isAlive(pid); attempt++) await sleep(250);
  }
  clearPid();

  if (isAlive(pid)) {
    console.error(`PID ${pid} is still alive after a forced stop.`);
    return 1;
  }
  console.log(`MagmaX Rotator stopped (PID ${pid}).`);
  return 0;
}

async function status() {
  const pid = readPid() ?? (await readStatus())?.app?.pid ?? null;
  if (!pid || !isAlive(pid)) {
    console.log('MagmaX Rotator is stopped.');
    return 0;
  }
  const data = await readStatus();
  console.log('MagmaX Rotator is running');
  console.log(`  Dashboard  ${baseUrl}`);
  console.log(`  Gateway    ${baseUrl}/v1`);
  console.log(`  PID        ${pid}`);
  if (data?.app) {
    console.log(`  Version    ${data.app.version} · Node ${data.app.node}`);
    console.log(`  Uptime     ${Math.round(data.app.uptimeSeconds)}s`);
    console.log(`  Data       ${data.app.dataDir}`);
  }
  if (data?.counts) {
    console.log(`  Providers  ${data.counts.activeProviders}/${data.counts.providers} active · ${data.counts.enabledModels} enabled models`);
  }
  return 0;
}

function help() {
  console.log(`MagmaX Rotator control

  magmaxrotator start      Start in the background (builds on first run)
  magmaxrotator stop       Stop the background server
  magmaxrotator restart    Stop, then start
  magmaxrotator status     Show PID, URL, uptime and counts

Options
  --port <n>               Port (default 3000, or MAGMAX_PORT)
  --host <addr>            Bind address (default 127.0.0.1, or MAGMAX_HOST)

Logs: ${path.relative(process.cwd(), logFile) || logFile}`);
  return 0;
}

let exitCode = 0;
switch (command) {
  case 'start':
    exitCode = await start();
    break;
  case 'stop':
    exitCode = await stop();
    break;
  case 'restart': {
    const stopped = await stop();
    if (stopped !== 0) {
      exitCode = stopped;
      break;
    }
    exitCode = await start();
    break;
  }
  case 'status':
    exitCode = await status();
    break;
  case 'help':
  case '--help':
  case '-h':
    exitCode = help();
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    exitCode = help();
    exitCode = 1;
}
process.exit(exitCode);
