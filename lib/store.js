import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_EVENTS = 2000; // webhook event ids remembered for de-duplication

// Tiny JSON-file store. Replace with Postgres/Mongo when integrating with CloudLead.
//
// Every write is synchronous and atomic (temp file + rename), so a mutation is on disk
// before the caller carries on. That matters: a payment webhook is acknowledged right
// after the order is saved, and the gateway will not send it again.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { orders: {}, mailboxes: [], checkouts: {}, events: [], plans: {} };
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

  /** Drop checkouts nobody paid for. A payment arriving after this is logged as "unknown order". */
  purgeStaleCheckouts(maxAgeMs, now = Date.now()) {
    let n = 0;
    for (const [id, co] of Object.entries(this.data.checkouts)) {
      if (co.status === 'awaiting_payment' && now - Date.parse(co.createdAt) > maxAgeMs) { delete this.data.checkouts[id]; n++; }
    }
    if (n) this.save();
    return n;
  }
  getOrder(id) { return this.data.orders[id]; }
  putOrder(order) { this.data.orders[order.id] = order; this.save(); return order; }
  addMailboxes(list) { this.data.mailboxes.push(...list); this.save(); }
  listMailboxes() { return this.data.mailboxes; }

  // A checkout is a cart snapshot + the payment we are waiting for. The price
  // lives here, server-side, so the browser can never change what is charged.
  getCheckout(id) { return this.data.checkouts[id]; }
  putCheckout(co) { this.data.checkouts[co.id] = co; this.save(); return co; }
  findCheckoutByKey(key) { return Object.values(this.data.checkouts).find((c) => c.idempotencyKey === key); }
  findCheckoutByGatewayOrder(id) { return Object.values(this.data.checkouts).find((c) => c.gatewayOrderId === id); }

  findCheckoutBySubscription(id) { return Object.values(this.data.checkouts).find((c) => c.gatewaySubscriptionId === id); }
  findOrderBySubscription(id) { return Object.values(this.data.orders).find((o) => o.billing?.subscriptionId === id); }

  // Gateway plans are permanent and cannot be deleted, so we reuse them by (period, amount, currency).
  getPlan(key) { return this.data.plans[key]; }
  putPlan(key, id) { this.data.plans[key] = id; this.save(); }

  /** Stop mailboxes being used for sending/warm-up (non-payment or cancellation). Reversible. */
  suspendMailboxes(orderId, reason) {
    let n = 0;
    for (const m of this.data.mailboxes) {
      if (m.orderId !== orderId || m.suspended) continue;
      Object.assign(m, { suspended: true, suspendedReason: reason, statusBeforeSuspend: m.status, status: 'suspended' });
      n++;
    }
    if (n) this.save();
    return n;
  }
  unsuspendMailboxes(orderId) {
    let n = 0;
    for (const m of this.data.mailboxes) {
      if (m.orderId !== orderId || !m.suspended) continue;
      m.status = m.statusBeforeSuspend || 'ready_for_warmup';
      delete m.suspended; delete m.suspendedReason; delete m.statusBeforeSuspend;
      n++;
    }
    if (n) this.save();
    return n;
  }

  seenEvent(id) { return this.data.events.includes(id); }
  markEvent(id) {
    this.data.events.push(id);
    if (this.data.events.length > MAX_EVENTS) this.data.events.splice(0, this.data.events.length - MAX_EVENTS);
    this.save();
  }
}
