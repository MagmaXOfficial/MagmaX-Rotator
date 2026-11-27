import { serve, type ServerType } from '@hono/node-server';
import { APP_NAME, DATA_DIR, HOST, PORT, VERSION } from './config.js';
import { closeDb, getSettings, initDb, listModels, listProviders, pruneRequests } from './db.js';
import { log } from './logger.js';
import { createApp } from './app.js';
import { ensureBuiltinSkills } from './skills/manager.js';
import { startHealthLoop, stopHealthLoop } from './providers/ops.js';

initDb();
ensureBuiltinSkills();

const app = createApp();
const settings = getSettings();
const pruned = pruneRequests(30 * 24 * 3600_000);
if (pruned) log.info('requests.pruned', { count: pruned });
startHealthLoop();

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  const providers = listProviders();
  const models = listModels({ enabledOnly: true });
  const lines = [
    '',
    `  ${APP_NAME} v${VERSION}`,
    `  ─────────────────────────────────────────────`,
    `  Dashboard   http://localhost:${info.port}`,
    `  Gateway     http://localhost:${info.port}/v1`,
    `  Bound to    ${HOST}:${info.port}${HOST === '127.0.0.1' || HOST === 'localhost' ? ' + [::1] (localhost only)' : ' (network exposed)'}`,
    `  Data        ${DATA_DIR}`,
    `  Providers   ${providers.filter((p) => p.active).length} active · ${models.length} enabled models`,
    `  API key     ${settings.requireApiKey ? 'required for /v1' : 'not required for /v1 (localhost)'}`,
    `  ─────────────────────────────────────────────`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
  log.info('server.started', { port: info.port, host: HOST, version: VERSION });
});

const servers: ServerType[] = [server];

// Clients such as Claude Code may resolve `localhost` to ::1 first. Listen on the IPv6
// loopback too so both address families work without exposing anything externally.
if (PORT !== 0 && HOST !== '::' && HOST !== '::1') {
  try {
    const ipv6 = serve({ fetch: app.fetch, hostname: '::1', port: PORT }, () => log.debug('server.ipv6_listening', { port: PORT }));
    ipv6.on('error', (err: NodeJS.ErrnoException) => log.debug('server.ipv6_unavailable', { code: err.code ?? 'unknown' }));
    servers.push(ipv6);
  } catch (err) {
    log.debug('server.ipv6_unavailable', { reason: err instanceof Error ? err.message : String(err) });
  }
}

const pruneTimer = setInterval(
  () => {
    const count = pruneRequests(30 * 24 * 3600_000);
    if (count) log.info('requests.pruned', { count });
  },
  6 * 60 * 60_000,
);
pruneTimer.unref?.();

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server.shutdown', { signal });
  clearInterval(pruneTimer);
  stopHealthLoop();
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref?.();
  await Promise.all(servers.map((item) => new Promise<void>((resolve) => item.close(() => resolve()))));
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('unhandled_rejection', { reason: String(reason) }));
