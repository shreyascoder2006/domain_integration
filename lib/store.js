import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_EVENTS = 2000; // webhook event ids remembered for de-duplication

// Tiny JSON-file store. Replace with Postgres/Mongo when integrating with CloudLead.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { orders: {}, mailboxes: [], checkouts: {}, events: [], plans: {} };
    if (existsSync(file)) {
      try { this.data = { ...this.data, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* start fresh */ }
    }
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
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
