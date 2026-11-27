import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const KEY_FILE = path.join(DATA_DIR, 'master.key');
const CIPHER_PREFIX = 'v1';
let cachedKey: Buffer | null = null;

/**
 * Master key resolution order:
 *  1. MAGMAX_MASTER_KEY (32 bytes, hex or base64)
 *  2. data/master.key — generated on first run with 0600 permissions
 * Secrets are encrypted with AES-256-GCM and never leave the server in plaintext.
 */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.MAGMAX_MASTER_KEY?.trim();
  if (fromEnv) {
    const buf = /^[0-9a-f]{64}$/i.test(fromEnv)
      ? Buffer.from(fromEnv, 'hex')
      : Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) throw new Error('MAGMAX_MASTER_KEY must decode to exactly 32 bytes');
    cachedKey = buf;
    return buf;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (cachedKey.length !== 32) throw new Error(`Corrupt master key at ${KEY_FILE}`);
    return cachedKey;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('base64') + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  cachedKey = key;
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CIPHER_PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== CIPHER_PREFIX) throw new Error('Unsupported secret format');
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const ct = Buffer.from(parts[3]!, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Last 4 characters only — safe for the dashboard, logs and API responses. */
export function keyHint(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
