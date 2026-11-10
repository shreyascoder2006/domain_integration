#!/usr/bin/env node
// node scripts/restore.js <backup-file> [--force]
// STOP THE SERVER FIRST. The backup is validated, the current data is kept as .pre-restore-<time>, then it is replaced.
import { restoreBackup } from '../lib/backup.js';
const a = process.argv.slice(2);
const file = a.find((x) => !x.startsWith('--'));
if (!file) { console.error('Usage: node scripts/restore.js <backup-file> [--force]'); process.exit(2); }
restoreBackup({ file, force: a.includes('--force') })
  .then((r) => console.log(`restored ${file} -> ${r.restoredTo}  (${r.orders} orders, ${r.mailboxes} mailboxes)${r.savedAs ? `\nprevious data kept at ${r.savedAs}` : ''}\nnow start the server.`))
  .catch((e) => { console.error(`restore FAILED: ${e.message}`); process.exit(1); });
