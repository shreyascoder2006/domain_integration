#!/usr/bin/env node
// node scripts/backup.js [--dir backups] [--keep 14]     (uses STORE / DATA_FILE / SQLITE_FILE like the server)
// Safe to run while the server is up (cron it hourly). Prints the snapshot and proves it can be opened.
import { createBackup } from '../lib/backup.js';
const a = process.argv.slice(2);
const flag = (n, d) => { const i = a.indexOf(n); return i < 0 ? d : a[i + 1]; };
createBackup({ dir: flag('--dir', 'backups'), keep: Number(flag('--keep', 14)) })
  .then((r) => console.log(`backup ok: ${r.file}  (${r.orders} orders, ${r.mailboxes} mailboxes, ${r.checkouts} checkouts; keeping ${r.kept})`))
  .catch((e) => { console.error(`backup FAILED: ${e.message}`); process.exit(1); });
