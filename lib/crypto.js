// AES-256-GCM sealing for vendor credentials at rest.
// Set CREDENTIALS_KEY to 32 random bytes, base64:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

let key;
function getKey() {
  if (key) return key;
  const raw = process.env.CREDENTIALS_KEY;
  if (raw) {
    key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('CREDENTIALS_KEY must decode to exactly 32 bytes (base64)');
  } else {
    if (process.env.NODE_ENV === 'production') throw new Error('CREDENTIALS_KEY is required in production');
    console.warn('[crypto] CREDENTIALS_KEY not set: using an insecure dev-only key');
    key = scryptSync('cloudlead-dev-only', 'dev-salt', 32);
  }
  return key;
}

export function seal(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function open(sealed) {
  if (typeof sealed !== 'string' || !sealed.startsWith('enc:v1:')) throw new Error('Not a sealed value');
  const buf = Buffer.from(sealed.slice(7), 'base64');
  const d = createDecipheriv('aes-256-gcm', getKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}
