#!/usr/bin/env node
/**
 * Single-command launcher: builds the server + dashboard on first run, then boots the gateway.
 * Usage: npm start   (options: --port 3000 --host 127.0.0.1)
 */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(root, 'dist', 'server', 'index.js');
const webIndex = path.join(root, 'web', 'dist', 'index.html');

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) process.env.MAGMAX_PORT = args[++i];
  if (args[i] === '--host' && args[i + 1]) process.env.MAGMAX_HOST = args[++i];
}

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`\n${cmd} ${cmdArgs.join(' ')} failed (exit ${result.status}).`);
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

const builtAt = Math.max(
  fs.existsSync(serverEntry) ? fs.statSync(serverEntry).mtimeMs : 0,
  fs.existsSync(webIndex) ? fs.statSync(webIndex).mtimeMs : 0,
);
const sourceAt = newestMtime(['server', 'web/src', 'package.json', 'vite.config.ts', 'tsconfig.server.json', 'tsconfig.web.json']);
const needsBuild = !fs.existsSync(serverEntry) || !fs.existsSync(webIndex) || sourceAt > builtAt;

if (needsBuild) {
  console.log('Building MagmaX Rotator…');
  if (!fs.existsSync(path.join(root, 'node_modules'))) run('npm', ['install', '--no-audit', '--no-fund']);
  run('npm', ['run', 'build']);
}

console.log(`Starting MagmaX Rotator on http://localhost:${process.env.MAGMAX_PORT || process.env.PORT || 3000}`);
const child = spawn(process.execPath, [serverEntry, ...args], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
