#!/usr/bin/env node
// Change CREDENTIALS_KEY without losing any stored mailbox credential.
//
//   OLD_CREDENTIALS_KEY=<current> NEW_CREDENTIALS_KEY=<new> node scripts/rotate-key.js [--dry-run]
//
// 1. STOP THE SERVER.   2. node scripts/backup.js   3. run this (use --dry-run first)   4. set CREDENTIALS_KEY=<new>, start the server.
// Safe to re-run if interrupted. Nothing is written if any value cannot be opened with the old key.
import { createStore } from '../lib/store.js';
import { rotateKeys } from '../lib/rotate.js';

const { OLD_CREDENTIALS_KEY: oldKeyB64, NEW_CREDENTIALS_KEY: newKeyB64 } = process.env;
if (!oldKeyB64 || !newKeyB64) { console.error('Set OLD_CREDENTIALS_KEY and NEW_CREDENTIALS_KEY (base64, 32 bytes each).'); process.exit(2); }
const store = await createStore(process.env);
try {
  const r = rotateKeys({ store, oldKeyB64, newKeyB64, dryRun: process.argv.includes('--dry-run') });
  console.log(process.argv.includes('--dry-run')
    ? `dry run: ${r.wouldRotate} value(s) would be re-encrypted, ${r.alreadyRotated} already on the new key. Nothing was changed.`
    : `rotated ${r.rotated} value(s) (${r.alreadyRotated} were already on the new key). Now set CREDENTIALS_KEY to the new key and start the server.`);
} catch (e) { console.error(`rotation FAILED: ${e.message}`); process.exit(1); } finally { store.close(); }
