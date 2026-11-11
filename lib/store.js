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
    this.reindex();
  }

  /* ---- persistence hooks: subclasses implement these ---- */
  persistOrder() {} persistCheckout() {} persistMailbox() {} persistPlan() {} persistOutbox() {} persistAlert() {}
  persistEvent() {} deleteCheckout() {}

  /* ------------------------------------------------------------------------------------------------
   * Indexes. Lookups that used to scan every record are O(1), so the app stays fast as data grows.
   * They are rebuilt from `data` after loading and kept current by every put and add method. They map to
   * IDs (not objects) wherever the app may replace a record with a new object of the same id.
   * If you edit `this.data` directly, call reindex().
   * ------------------------------------------------------------------------------------------------ */
  reindex() {
    this.ix = {
      orderBySub: new Map(), ordersByEmail: new Map(),
      mbById: new Map(), mbByOrder: new Map(),
      coByKey: new Map(), coByOrder: new Map(), coBySub: new Map(), coUnpaid: new Set(), coKnown: new Set(), coTimes: [],   // coTimes: [{ id, t }] in creation order
      outboxKeys: new Set(), outboxByStatus: { pending: new Set(), dead: new Set() },
      events: new Set(this.data.events)
    };
    for (const o of Object.values(this.data.orders)) this.indexOrder(o);
    for (const m of this.data.mailboxes) this.indexMailbox(m);
    for (const c of Object.values(this.data.checkouts).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) this.indexCheckout(c);
    for (const i of this.data.outbox) this.indexOutbox(i);
  }
  indexOrder(o) {
    if (o.billing?.subscriptionId) this.ix.orderBySub.set(o.billing.subscriptionId, o.id);
    const e = String(o.contact?.email || '').trim().toLowerCase();
    if (e) { if (!this.ix.ordersByEmail.has(e)) this.ix.ordersByEmail.set(e, new Set()); this.ix.ordersByEmail.get(e).add(o.id); }
  }
  indexMailbox(m) {
    if (!m.id) return;
    this.ix.mbById.set(m.id, m);
    if (m.orderId) { if (!this.ix.mbByOrder.has(m.orderId)) this.ix.mbByOrder.set(m.orderId, new Map()); this.ix.mbByOrder.get(m.orderId).set(m.id, m); }
  }
  indexCheckout(c) {
    const ix = this.ix;
    if (c.idempotencyKey) ix.coByKey.set(c.idempotencyKey, c.id);
    if (c.gatewayOrderId) ix.coByOrder.set(c.gatewayOrderId, c.id);
    if (c.gatewaySubscriptionId) ix.coBySub.set(c.gatewaySubscriptionId, c.id);
    if (c.status === 'awaiting_payment') ix.coUnpaid.add(c.id); else ix.coUnpaid.delete(c.id);
    if (!ix.coKnown.has(c.id)) { ix.coKnown.add(c.id); ix.coTimes.push({ id: c.id, t: Date.parse(c.createdAt) || 0 }); } // checkouts arrive in time order
  }
  indexOutbox(i) {
    if (i.key) this.ix.outboxKeys.add(i.key);
    for (const s of ['pending', 'dead']) { if (i.status === s) this.ix.outboxByStatus[s].add(i); else this.ix.outboxByStatus[s].delete(i); }
  }

  /** After loading: give every mailbox a stable id (older data had none). */
  backfillIds() {
    for (const m of this.data.mailboxes.filter((x) => !x.id)) { m.id = newMailboxId(); this.persistMailbox(m); }
    this.reindex();
  }

  /* ---- orders ---- */
  getOrder(id) { return this.data.orders[id]; }
  putOrder(order) { this.data.orders[order.id] = order; this.indexOrder(order); this.persistOrder(order); return order; }
  listOrders() { return Object.values(this.data.orders); }
  findOrderBySubscription(id) {
    const o = this.data.orders[this.ix.orderBySub.get(id)];
    return o && o.billing?.subscriptionId === id ? o : undefined;
  }
  findOrdersByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return [...(this.ix.ordersByEmail.get(e) || [])].map((id) => this.data.orders[id]).filter((o) => o && String(o.contact?.email || '').trim().toLowerCase() === e);
  }

  /* ---- mailboxes ---- */
  addMailboxes(list) {
    for (const m of list) { m.id ??= newMailboxId(); this.data.mailboxes.push(m); this.indexMailbox(m); this.persistMailbox(m); }
  }
  getMailbox(id) { return this.ix.mbById.get(id); }
  putMailbox(m) { this.persistMailbox(m); return m; }
  listMailboxes() { return this.data.mailboxes; }
  mailboxesOfOrder(orderId) { return [...(this.ix.mbByOrder.get(orderId)?.values() || [])]; }

  /** Stop mailboxes being used for sending/warm-up (non-payment or cancellation). Reversible. */
  suspendMailboxes(orderId, reason) {
    let n = 0;
    for (const m of this.mailboxesOfOrder(orderId)) {
      if (m.suspended) continue;
      Object.assign(m, { suspended: true, suspendedReason: reason, statusBeforeSuspend: m.status, status: 'suspended' });
      this.persistMailbox(m); n++;
    }
    return n;
  }
  unsuspendMailboxes(orderId) {
    let n = 0;
    for (const m of this.mailboxesOfOrder(orderId)) {
      if (!m.suspended) continue;
      m.status = m.statusBeforeSuspend || 'ready_for_warmup';
      delete m.suspended; delete m.suspendedReason; delete m.statusBeforeSuspend;
      this.persistMailbox(m); n++;
    }
    return n;
  }

  /* ---- checkouts: a cart snapshot + the payment we are waiting for. The price lives here, server-side. ---- */
  getCheckout(id) { return this.data.checkouts[id]; }
  putCheckout(co) { this.data.checkouts[co.id] = co; this.indexCheckout(co); this.persistCheckout(co); return co; }
  listCheckouts() { return Object.values(this.data.checkouts); }
  findCheckoutByKey(key) { const c = this.data.checkouts[this.ix.coByKey.get(key)]; return c && c.idempotencyKey === key ? c : undefined; }
  findCheckoutByGatewayOrder(id) { const c = this.data.checkouts[this.ix.coByOrder.get(id)]; return c && c.gatewayOrderId === id ? c : undefined; }
  findCheckoutBySubscription(id) { const c = this.data.checkouts[this.ix.coBySub.get(id)]; return c && c.gatewaySubscriptionId === id ? c : undefined; }
  /** Checkouts created at or after `sinceMs`, newest first. Cost is the size of the window, not of the whole history. */
  recentCheckouts(sinceMs) {
    const out = [];
    for (let i = this.ix.coTimes.length - 1; i >= 0 && this.ix.coTimes[i].t >= sinceMs; i--) {
      const c = this.data.checkouts[this.ix.coTimes[i].id];
      if (c) out.push(c);
    }
    return out;
  }

  /** Drop checkouts nobody paid for. A payment arriving after this is logged as "unknown order". */
  purgeStaleCheckouts(maxAgeMs, now = Date.now()) {
    let n = 0;
    for (const id of [...this.ix.coUnpaid]) {
      const co = this.data.checkouts[id];
      if (!co) { this.ix.coUnpaid.delete(id); continue; }
      if (co.status === 'awaiting_payment' && now - Date.parse(co.createdAt) > maxAgeMs) {
        delete this.data.checkouts[id]; this.ix.coUnpaid.delete(id); this.deleteCheckout(id); n++;
      }
    }
    if (n) { this.ix.coTimes = this.ix.coTimes.filter((x) => this.data.checkouts[x.id]); this.ix.coKnown = new Set(this.ix.coTimes.map((x) => x.id)); }
    return n;
  }

  /* ---- gateway plans are permanent, so we reuse them by (period, amount, currency) ---- */
  getPlan(key) { return this.data.plans[key]; }
  putPlan(key, id) { this.data.plans[key] = id; this.persistPlan(key, id); }

  /* ---- webhook de-duplication ---- */
  seenEvent(id) { return this.ix.events.has(id); }
  markEvent(id) {
    this.data.events.push(id); this.ix.events.add(id);
    if (this.data.events.length > MAX_EVENTS) { for (const old of this.data.events.splice(0, this.data.events.length - MAX_EVENTS)) this.ix.events.delete(old); }
    this.persistEvent(id);
  }

  /* ---- email outbox (lib/notify.js) and de-duplicated ops alerts (lib/alerts.js) ---- */
  addOutbox(item) { this.data.outbox.push(item); this.indexOutbox(item); this.persistOutbox(item); return item; }
  putOutbox(item) { this.indexOutbox(item); this.persistOutbox(item); return item; }
  listOutbox() { return this.data.outbox; }
  hasOutboxKey(key) { return this.ix.outboxKeys.has(key); }
  /** Items still to send, or given up on: the timer looks only at these, never at the whole history. */
  outboxWithStatus(status) { return [...(this.ix.outboxByStatus[status] || [])]; }
  /** Keep the outbox bounded: forget sent items older than maxAgeMs. */
  pruneOutbox(maxAgeMs, now = Date.now()) {
    const keep = this.data.outbox.filter((i) => i.status !== 'sent' || now - Date.parse(i.sentAt) <= maxAgeMs);
    const dropped = this.data.outbox.length - keep.length;
    if (dropped) { this.data.outbox = keep; this.ix.outboxKeys = new Set(keep.map((i) => i.key).filter(Boolean)); this.persistOutbox(null); }
    return dropped;
  }
  getAlert(key) { return this.data.alerts[key]; }
  putAlert(key, value) { this.data.alerts[key] = value; this.persistAlert(key, value); }
  deleteAlert(key) { delete this.data.alerts[key]; this.persistAlert(key, null); }
  listAlerts() { return this.data.alerts; }

  /**
   * Replace the whole dataset at once (migrations, load tests, tests). One write, not one per record.
   * `data` may omit collections; missing ones become empty.
   */
  bulkLoad(data) {
    this.data = { orders: {}, mailboxes: [], checkouts: {}, events: [], plans: {}, outbox: [], alerts: {}, ...data };
    this.backfillIds(); // also rebuilds the indexes
    this.persistAll();
  }
  persistAll() {}

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
  persistAll() { this.save(); }
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
