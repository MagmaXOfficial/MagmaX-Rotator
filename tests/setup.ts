import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate every test run from the real data directory (skills, master key, SQLite).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magmax-test-'));
process.env.MAGMAX_DATA_DIR = dir;
process.env.MAGMAX_LOG_LEVEL = 'error';

process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
