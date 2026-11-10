// AES-256-GCM sealing for vendor credentials at rest.
// Set CREDENTIALS_KEY to 32 random bytes, base64:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// To change the key later, use scripts/rotate-key.js (never just swap the variable: every sealed value would become unreadable).
import { log as defaultLog } from './log.js';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const PREFIX = 'enc:v1:';

/** base64 string -> 32-byte key, or throw. */
export function keyFromBase64(b64) {
  const k = Buffer.from(String(b64 || ''), 'base64');
  if (k.length !== 32) throw new Error('A credentials key must decode to exactly 32 bytes (base64)');
  return k;
}

let key;
function getKey() {
  if (key) return key;
  const raw = process.env.CREDENTIALS_KEY;
  if (raw) {
    key = keyFromBase64(raw);
  } else {
    if (process.env.NODE_ENV === 'production') throw new Error('CREDENTIALS_KEY is required in production');
    defaultLog.warn('CREDENTIALS_KEY not set: using an insecure dev-only key');
    key = scryptSync('cloudlead-dev-only', 'dev-salt', 32);
  }
  return key;
}

export function sealWith(obj, k) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function openWith(sealed, k) {
  if (typeof sealed !== 'string' || !sealed.startsWith(PREFIX)) throw new Error('Not a sealed value');
  const buf = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  const d = createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

export const seal = (obj) => sealWith(obj, getKey());
export const open = (sealed) => openWith(sealed, getKey());
