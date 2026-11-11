// SQLite backend (node:sqlite, built into Node 22; prints an "experimental" warning).
// One row per record, so a change writes one row instead of rewriting the whole database, and every
// write is a durable transaction (WAL + synchronous=FULL). The working set is cached in memory like
// the JSON store, so one server process only; webhook de-duplication reads the database directly.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BaseStore } from '../store.js';

const MAX_EVENTS = 2000;

export class SqliteStore extends BaseStore {
  constructor(file) {
    super();
    this.file = file;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS orders    (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mailboxes (id TEXT PRIMARY KEY, order_id TEXT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkouts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans     (key TEXT PRIMARY KEY, id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events    (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox    (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts    (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mailboxes_order ON mailboxes(order_id);
    `);
    const all = (sql) => this.db.prepare(sql).all();
    for (const r of all('SELECT json FROM orders')) { const o = JSON.parse(r.json); this.data.orders[o.id] = o; }
    // A row's id column is authoritative: a record whose JSON lacks an id reuses it (no duplicate row is created).
    this.data.mailboxes = all('SELECT id, json FROM mailboxes ORDER BY rowid').map((r) => { const m = JSON.parse(r.json); m.id ??= r.id; return m; });
    for (const r of all('SELECT json FROM checkouts')) { const c = JSON.parse(r.json); this.data.checkouts[c.id] = c; }
    for (const r of all('SELECT key, id FROM plans')) this.data.plans[r.key] = r.id;
    this.data.outbox = all('SELECT json FROM outbox ORDER BY rowid').map((r) => JSON.parse(r.json));
    for (const r of all('SELECT key, json FROM alerts')) this.data.alerts[r.key] = JSON.parse(r.json);
    this.up = {
      order: this.db.prepare('INSERT INTO orders(id, json) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json'),
      mailbox: this.db.prepare('INSERT INTO mailboxes(id, order_id, json) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET order_id = excluded.order_id, json = excluded.json'),
      checkout: this.db.prepare('INSERT INTO checkouts(id, json) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json'),
      plan: this.db.prepare('INSERT INTO plans(key, id) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET id = excluded.id'),
      outbox: this.db.prepare('INSERT INTO outbox(id, json) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json'),
      alert: this.db.prepare('INSERT INTO alerts(key, json) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json')
    };
    this.backfillIds(); // needs the prepared statements above
  }

  persistAll() {
    this.db.exec('BEGIN');
    try {
      for (const t of ['orders', 'mailboxes', 'checkouts', 'plans', 'events', 'outbox', 'alerts']) this.db.exec(`DELETE FROM ${t}`);
      for (const o of Object.values(this.data.orders)) this.persistOrder(o);
      for (const m of this.data.mailboxes) this.persistMailbox(m);
      for (const c of Object.values(this.data.checkouts)) this.persistCheckout(c);
      for (const [k, v] of Object.entries(this.data.plans)) this.persistPlan(k, v);
      for (const e of this.data.events) this.db.prepare('INSERT OR IGNORE INTO events(id, at) VALUES(?, ?)').run(e, Date.now());
      for (const i of this.data.outbox) this.up.outbox.run(i.id, JSON.stringify(i));
      for (const [k, v] of Object.entries(this.data.alerts)) this.up.alert.run(k, JSON.stringify(v));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  persistOrder(o) { this.up.order.run(o.id, JSON.stringify(o)); }
  persistMailbox(m) { this.up.mailbox.run(m.id, m.orderId ?? null, JSON.stringify(m)); }
  persistCheckout(c) { this.up.checkout.run(c.id, JSON.stringify(c)); }
  deleteCheckout(id) { this.db.prepare('DELETE FROM checkouts WHERE id = ?').run(id); }
  persistPlan(key, id) { this.up.plan.run(key, id); }
  persistAlert(key, value) {
    if (value === null) this.db.prepare('DELETE FROM alerts WHERE key = ?').run(key);
    else this.up.alert.run(key, JSON.stringify(value));
  }
  persistOutbox(item) {
    if (item) { this.up.outbox.run(item.id, JSON.stringify(item)); return; }
    // pruneOutbox replaced the in-memory list: rewrite the table to match, atomically.
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM outbox');
      for (const i of this.data.outbox) this.up.outbox.run(i.id, JSON.stringify(i));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // De-duplication reads the database, not the cache, so it stays right even across a restart mid-retry.
  seenEvent(id) { return !!this.db.prepare('SELECT 1 AS x FROM events WHERE id = ?').get(id); }
  markEvent(id) {
    this.db.prepare('INSERT OR IGNORE INTO events(id, at) VALUES(?, ?)').run(id, Date.now());
    this.db.prepare('DELETE FROM events WHERE rowid <= (SELECT MAX(rowid) - ? FROM events)').run(MAX_EVENTS);
  }

  /** A consistent copy of the whole database (used by the backup script). */
  backupTo(path) {
    this.db.prepare('VACUUM INTO ?').run(path);
  }
  close() { this.db.close(); }
}
