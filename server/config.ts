import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository root — works both for `tsx server/index.ts` and `node dist/server/index.js`.
 * Walks up until the package manifest is found, so compiled output never misplaces data.
 */
function findRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 6; depth++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));

// Optional .env support (Node 20.12+). Missing files are ignored.
try {
  (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(path.join(ROOT, '.env'));
} catch {
  /* no .env present */
}

export const VERSION = '1.0.0';
export const APP_NAME = 'MagmaX Rotator';

export const DATA_DIR = process.env.MAGMAX_DATA_DIR
  ? path.resolve(process.env.MAGMAX_DATA_DIR)
  : path.join(ROOT, 'data');

export const WEB_DIST = path.join(ROOT, 'web', 'dist');

export const HOST = process.env.MAGMAX_HOST || '127.0.0.1';
export const PORT = Number(process.env.MAGMAX_PORT || process.env.PORT || 3000);

/** Path of the Claude Code / OpenCode integration config files this app can write. */
export const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';

export const STARTED_AT = Date.now();

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
}
