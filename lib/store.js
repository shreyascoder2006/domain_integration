// Storage seam. Everything in the app talks to the store through the methods of BaseStore;
// nothing else reads or writes the database. To move to Postgres/Mongo/etc., subclass BaseStore
// and implement the persist* hooks (or implement the same methods), then run the contract tests
// in test/store.test.js against it.
//
// Both backends keep the working set in memory and write through on every change:
//   Store         one JSON file, rewritten atomically (temp file + rename) with a .bak copy
//   SqliteStore   one row per record in SQLite (lib/store/sqlite.js), no full rewrites
// Every write is synchronous and durable before the caller carries on. That matters: a payment
// webhook is acknowledged right after the order is saved, and the gateway will not send it again.
// Only ONE server process may use a store at a time.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_EVENTS = 2000; // webhook event ids remembered for de-duplication

export class BaseStore {
  constructor() {
    this.data = { orders: {}, mailboxes: [], checkouts: {}, events: [], plans: {}, outbox: [], alerts: {} };
  }

  /* ---- persistence hooks: subclasses implement these ---- */
  persistOrder() {} persistCheckout() {} persistMailbox() {} persistPlan() {} persistOutbox() {} persistAlert() {}
  persistEvent() {} deleteCheckout() {}

  /** After loading: give every mailbox a stable id (older data had none). */
  backfillIds() {
    const missing = this.data.mailboxes.filter((m) => !m.id);
    for (const m of missing) { m.id = newMailboxId(); this.persistMailbox(m); }
  }

  /* ---- orders ---- */
  getOrder(id) { return this.data.orders[id]; }
  putOrder(order) { this.data.orders[order.id] = order; this.persistOrder(order); return order; }
  listOrders() { return Object.values(this.data.orders); }
  findOrderBySubscription(id) { return this.listOrders().find((o) => o.billing?.subscriptionId === id); }
  findOrdersByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return e ? this.listOrders().filter((o) => String(o.contact?.email || '').toLowerCase() === e) : [];
  }

  /* ---- mailboxes ---- */
  addMailboxes(list) {
    for (const m of list) { m.id ??= newMailboxId(); this.data.mailboxes.push(m); this.persistMailbox(m); }
  }
  getMailbox(id) { return this.data.mailboxes.find((m) => m.id === id); }
  putMailbox(m) { this.persistMailbox(m); return m; }
  listMailboxes() { return this.data.mailboxes; }

  /** Stop mailboxes being used for sending/warm-up (non-payment or cancellation). Reversible. */
  suspendMailboxes(orderId, reason) {
    let n = 0;
    for (const m of this.data.mailboxes) {
      if (m.orderId !== orderId || m.suspended) continue;
      Object.assign(m, { suspended: true, suspendedReason: reason, statusBeforeSuspend: m.status, status: 'suspended' });
      this.persistMailbox(m); n++;
    }
    return n;
  }
  unsuspendMailboxes(orderId) {
    let n = 0;
    for (const m of this.data.mailboxes) {
      if (m.orderId !== orderId || !m.suspended) continue;
      m.status = m.statusBeforeSuspend || 'ready_for_warmup';
      delete m.suspended; delete m.suspendedReason; delete m.statusBeforeSuspend;
      this.persistMailbox(m); n++;
    }
    return n;
  }

  /* ---- checkouts: a cart snapshot + the payment we are waiting for. The price lives here, server-side. ---- */
  getCheckout(id) { return this.data.checkouts[id]; }
  putCheckout(co) { this.data.checkouts[co.id] = co; this.persistCheckout(co); return co; }
  listCheckouts() { return Object.values(this.data.checkouts); }
  findCheckoutByKey(key) { return this.listCheckouts().find((c) => c.idempotencyKey === key); }
  findCheckoutByGatewayOrder(id) { return this.listCheckouts().find((c) => c.gatewayOrderId === id); }
  findCheckoutBySubscription(id) { return this.listCheckouts().find((c) => c.gatewaySubscriptionId === id); }

  /** Drop checkouts nobody paid for. A payment arriving after this is logged as "unknown order". */
  purgeStaleCheckouts(maxAgeMs, now = Date.now()) {
    let n = 0;
    for (const co of this.listCheckouts()) {
      if (co.status === 'awaiting_payment' && now - Date.parse(co.createdAt) > maxAgeMs) {
        delete this.data.checkouts[co.id]; this.deleteCheckout(co.id); n++;
      }
    }
    return n;
  }

  /* ---- gateway plans are permanent, so we reuse them by (period, amount, currency) ---- */
  getPlan(key) { return this.data.plans[key]; }
  putPlan(key, id) { this.data.plans[key] = id; this.persistPlan(key, id); }

  /* ---- webhook de-duplication ---- */
  seenEvent(id) { return this.data.events.includes(id); }
  markEvent(id) {
    this.data.events.push(id);
    if (this.data.events.length > MAX_EVENTS) this.data.events.splice(0, this.data.events.length - MAX_EVENTS);
    this.persistEvent(id);
  }

  /* ---- email outbox (lib/notify.js) and de-duplicated ops alerts (lib/alerts.js) ---- */
  addOutbox(item) { this.data.outbox.push(item); this.persistOutbox(item); return item; }
  putOutbox(item) { this.persistOutbox(item); return item; }
  listOutbox() { return this.data.outbox; }
  /** Keep the outbox bounded: forget sent items older than maxAgeMs. */
  pruneOutbox(maxAgeMs, now = Date.now()) {
    const keep = this.data.outbox.filter((i) => i.status !== 'sent' || now - Date.parse(i.sentAt) <= maxAgeMs);
    const dropped = this.data.outbox.length - keep.length;
    if (dropped) { this.data.outbox = keep; this.persistOutbox(null); }
    return dropped;
  }
  getAlert(key) { return this.data.alerts[key]; }
  putAlert(key, value) { this.data.alerts[key] = value; this.persistAlert(key, value); }
  deleteAlert(key) { delete this.data.alerts[key]; this.persistAlert(key, null); }
  listAlerts() { return this.data.alerts; }

  close() {}
}

export const newMailboxId = () => 'mbx_' + randomBytes(6).toString('hex');

/** JSON file store: simple, atomic, fine for a single process and light load. */
export class Store extends BaseStore {
  constructor(file) {
    super();
    this.file = file;
    if (existsSync(file)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        // Never "start fresh": the next save would overwrite every order with an empty database.
        const kept = `${file}.corrupt-${Date.now()}`;
        copyFileSync(file, kept);
        throw new Error(`Data file ${file} is unreadable (${e.message}). A copy was kept at ${kept}. Restore ${file}.bak if you have it, then restart.`);
      }
      this.data = { ...this.data, ...parsed };
      this.backfillIds();
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    // Keep the previous good copy: cheap insurance against a bad deploy or a manual edit.
    if (existsSync(this.file)) { try { copyFileSync(this.file, `${this.file}.bak`); } catch { /* best effort */ } }
    // Windows can briefly lock the target (antivirus, indexer): retry the rename a few times.
    for (let attempt = 1; ; attempt++) {
      try { renameSync(tmp, this.file); return; } catch (e) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { rmSync(tmp, { force: true }); throw e; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
      }
    }
  }
  persistOrder() { this.save(); }
  persistCheckout() { this.save(); }
  persistMailbox() { this.save(); }
  persistPlan() { this.save(); }
  persistEvent() { this.save(); }
  persistOutbox() { this.save(); }
  persistAlert() { this.save(); }
  deleteCheckout() { this.save(); }
}

/** Pick the backend from the environment: STORE=sqlite (file from SQLITE_FILE or DATA_FILE) or the default JSON file. */
export async function createStore(env = process.env, defaultFile = './data/db.json') {
  if (env.STORE === 'sqlite') {
    const { SqliteStore } = await import('./store/sqlite.js');
    return new SqliteStore(env.SQLITE_FILE || env.DATA_FILE || defaultFile.replace(/\.json$/, '.sqlite'));
  }
  return new Store(env.DATA_FILE || defaultFile);
}
