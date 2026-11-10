// Backup, restore and migration for either storage backend. Pure functions (the scripts in /scripts are thin CLIs).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Store } from './store.js';

const stamp = (now) => new Date(now).toISOString().replace(/[:.]/g, '-');
const isSqlite = (env) => env.STORE === 'sqlite';
export const dataFileOf = (env, root = '.') => (isSqlite(env) ? (env.SQLITE_FILE || env.DATA_FILE || join(root, 'data', 'db.sqlite')) : (env.DATA_FILE || join(root, 'data', 'db.json')));

async function openStore(file, sqlite) {
  if (sqlite) { const { SqliteStore } = await import('./store/sqlite.js'); return new SqliteStore(file); }
  return new Store(file);
}
const summarize = (s) => ({ orders: s.listOrders().length, mailboxes: s.listMailboxes().length, checkouts: s.listCheckouts().length });

/**
 * Snapshot the live data into `dir`, then OPEN the snapshot to prove it is readable, and keep only the newest `keep`.
 * Safe while the server runs: SQLite uses VACUUM INTO (a consistent copy); the JSON file is replaced atomically, so a copy is whole.
 */
export async function createBackup({ env = process.env, dir = 'backups', keep = 14, now = Date.now(), root = '.' } = {}) {
  const sqlite = isSqlite(env);
  const src = dataFileOf(env, root);
  if (!existsSync(src)) throw new Error(`Nothing to back up: ${src} does not exist`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `cloudlead-${stamp(now)}.${sqlite ? 'sqlite' : 'json'}`);
  if (sqlite) { const live = await openStore(src, true); try { live.backupTo(target); } finally { live.close(); } }
  else copyFileSync(src, target);

  const check = await openStore(target, sqlite); // throws if the copy is unreadable
  const counts = summarize(check); check.close();

  const mine = readdirSync(dir).filter((f) => f.startsWith('cloudlead-') && f.endsWith(sqlite ? '.sqlite' : '.json')).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) rmSync(join(dir, old), { force: true });
  return { file: target, ...counts, kept: Math.min(mine.length, keep) };
}

/**
 * Put a backup in place. The backup is validated first, the current data is saved next to it
 * (`.pre-restore-<time>`), and an existing target is only replaced with `force`. STOP THE SERVER first:
 * a running server holds the data in memory and would overwrite the restore on its next write.
 */
export async function restoreBackup({ env = process.env, file, force = false, now = Date.now(), root = '.' }) {
  const sqlite = isSqlite(env);
  if (!file || !existsSync(file)) throw new Error(`Backup file not found: ${file}`);
  const probe = await openStore(file, sqlite);
  const counts = summarize(probe); probe.close();

  const target = dataFileOf(env, root);
  mkdirSync(dirname(target), { recursive: true });
  let savedAs = null;
  if (existsSync(target)) {
    if (!force) throw new Error(`${target} already exists. Re-run with --force to replace it (the current file is kept as .pre-restore-*).`);
    savedAs = `${target}.pre-restore-${stamp(now)}`;
    copyFileSync(target, savedAs);
  }
  for (const ext of ['-wal', '-shm', '.bak']) rmSync(target + ext, { force: true }); // stale journals would be replayed onto the restored file
  copyFileSync(file, target);
  return { restoredTo: target, savedAs, ...counts };
}

/** Copy a JSON-file database into a (new, empty) SQLite database through the store interface, then verify the counts. */
export async function migrateJsonToSqlite({ jsonFile, sqliteFile }) {
  const { SqliteStore } = await import('./store/sqlite.js');
  const from = new Store(jsonFile);
  const to = new SqliteStore(sqliteFile);
  try {
    if (to.listOrders().length || to.listMailboxes().length) throw new Error(`${sqliteFile} already contains data: refusing to merge. Use a new file.`);
    for (const o of from.listOrders()) to.putOrder(o);
    to.addMailboxes(from.listMailboxes().map((m) => ({ ...m })));      // ids are preserved
    for (const c of from.listCheckouts()) to.putCheckout(c);
    for (const [k, v] of Object.entries(from.data.plans)) to.putPlan(k, v);
    for (const e of from.data.events) to.markEvent(e);
    for (const i of from.listOutbox()) to.addOutbox({ ...i });
    for (const [k, v] of Object.entries(from.listAlerts())) to.putAlert(k, v);
    const a = summarize(from), b = summarize(to);
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`Verification failed: JSON has ${JSON.stringify(a)}, SQLite has ${JSON.stringify(b)}`);
    return { migrated: a, sqliteFile };
  } finally { to.close(); }
}

