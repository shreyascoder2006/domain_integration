// Chaos and property tests: the failure modes that only show up in production.
//   1. Kill the pipeline at EVERY possible save point and prove a restart still finishes correctly.
//   2. Fuzz the webhooks with hostile, malformed and random events: nothing may crash or leak.
//   3. Throw random event sequences at the billing rules and check invariants after every step.
//   4. Property-test the pricing schedule over random sizes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, BaseStore } from '../lib/store.js';
import { initProgress, provision } from '../lib/provisioner.js';
import { createBillingService, buildSchedule, amountForCycle, planForCycle, isDomainCycle } from '../lib/billing.js';
import { createCheckoutService } from '../lib/checkout.js';
import { createVendorWebhookHandler } from '../lib/vendorHooks.js';
import { createZapmailVendor } from '../lib/providers/zapmail.js';
import { quote } from '../lib/pricing.js';

process.env.MOCK_DELAY_MS = '0';
process.env.RETRY_BASE_MS = '1';
const { mockRegistrar, mockDns, mockMailboxVendor, mockPayments } = await import('../lib/providers/mock.js');

const tmp = (n) => join(tmpdir(), `cl-chaos-${Date.now()}-${Math.random().toString(16).slice(2)}-${n}.json`);
const silent = { error() {}, warn() {}, info() {} };
/** Pure in-memory store (the persistence hooks are no-ops): thousands of operations without touching disk. */
class MemStore extends BaseStore {}
const DAY = 86_400_000;

/** Small deterministic PRNG so a failing run can be reproduced from its seed. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p };
}

/* ------------------------------------------------------------------ */
/* 1. Crash at every save point                                         */
/* ------------------------------------------------------------------ */
class Crash extends Error {}
/** A store that "loses power" on its Nth write: that write and every later one never reach disk. */
class CrashingStore extends Store {
  constructor(file, crashAt) { super(file); this.n = 0; this.crashAt = crashAt; this.dead = false; }
  tick() { if (this.dead || ++this.n === this.crashAt) { this.dead = true; throw new Crash('power lost'); } }
  persistOrder(o) { this.tick(); super.persistOrder(o); }
  persistMailbox(m) { this.tick(); super.persistMailbox(m); }
}

const newOrder = () => {
  const o = {
    id: 'ord_chaos', userId: 'u', provider: 'google', contact: {}, forwardingDomain: 'acme.com',
    domains: [
      { name: 'getone.com', mailboxes: [{ firstName: 'A', lastName: 'B', emailPrefix: 'a' }, { firstName: 'A', lastName: 'B', emailPrefix: 'b' }] },
      { name: 'gettwo.com', mailboxes: [{ firstName: 'A', lastName: 'B', emailPrefix: 'c' }] }
    ]
  };
  initProgress(o); o.status = 'paid';
  return o;
};
const EXPECTED = ['a@getone.com', 'b@getone.com', 'c@gettwo.com'];

function countingProviders(calls) {
  const registered = new Set();
  return {
    registrar: {
      ...mockRegistrar,
      async register(a) {
        calls.register = (calls.register || 0) + 1;
        if (registered.has(a.domain)) return { domain: a.domain, alreadyRegistered: true }; // what the real adapter does on NameSilo code 262
        registered.add(a.domain);
        return mockRegistrar.register(a);
      }
    },
    dns: mockDns, vendor: mockMailboxVendor
  };
}

async function runCrashAt(k) {
  const file = tmp('crash');
  const calls = {};
  const providers = countingProviders(calls);
  const store = new CrashingStore(file, k);
  const order = newOrder();
  let crashed = false;
  try { store.putOrder(order); await provision(order, { providers, store }); } catch (e) { if (!(e instanceof Crash)) throw e; crashed = true; }

  // "Restart": a new process reads whatever reached the disk.
  const after = new Store(file);
  const saved = after.getOrder('ord_chaos');
  if (!saved) { assert.ok(crashed && k === 1, `order must be on disk unless power failed on the very first write (k=${k})`); return { n: store.n, lost: true, crashed }; }
  for (let i = 0; i < 6 && saved.status !== 'completed'; i++) await provision(saved, { providers, store: after });

  assert.equal(saved.status, 'completed', `k=${k}: order must finish after a restart`);
  assert.deepEqual(after.listMailboxes().map((m) => m.email).sort(), EXPECTED, `k=${k}: exactly the right mailboxes, no duplicates`);
  assert.ok(saved.progress.every((p) => Object.values(p.steps).every((s) => s.status === 'done')), `k=${k}: every step done`);
  assert.ok(calls.register <= 4, `k=${k}: at most one repeat registration per domain (got ${calls.register})`);
  return { n: store.n, crashed };
}

test('chaos: power loss at EVERY save point still ends with a correct, complete order', async () => {
  // Dry run (never crashes) to learn how many writes a full run makes.
  const dry = await runCrashAt(Number.MAX_SAFE_INTEGER);
  assert.ok(dry.n >= 30, `expected a realistic number of writes, got ${dry.n}`);
  let lost = 0, crashes = 0;
  for (let k = 1; k <= dry.n; k++) {
    const r = await runCrashAt(k);
    if (r.lost) lost++;
    if (r.crashed) crashes++;
  }
  assert.equal(crashes, dry.n, 'every crash point was exercised');
  assert.ok(lost <= 1, 'only a crash before the very first write may lose the order (the payment webhook recreates it)');
});

/* ------------------------------------------------------------------ */
/* 2. Webhook fuzzing                                                   */
/* ------------------------------------------------------------------ */
function junk(r, depth = 0) {
  const leaf = () => r.pick([null, undefined, 0, -1, 1e21, NaN, '', 'x', 'a'.repeat(300), true, false, 'ord_x', 'sub_x', '2026-01-01', '<script>', '../../etc/passwd', 4991]);
  if (depth > 3 || r.chance(0.4)) return leaf();
  if (r.chance(0.3)) return Array.from({ length: r.int(4) }, () => junk(r, depth + 1));
  const o = {};
  for (const k of ['id', 'order_id', 'amount', 'currency', 'status', 'plan_id', 'paid_count', 'current_end', 'entity', 'invoice_id', 'payment_id', 'domain', 'domainName', 'mailboxDetails', 'domainDetails', r.pick(['x', 'y', '__proto__', 'constructor'])]) {
    if (r.chance(0.35)) o[k] = junk(r, depth + 1);
  }
  return o;
}

test('chaos: hostile and random webhook events never crash the server or leak internals', async () => {
  const store = new Store(tmp('fuzz'));
  const checkout = createCheckoutService({ store, providers: { registrar: mockRegistrar, dns: mockDns, vendor: mockMailboxVendor, payments: mockPayments }, log: silent });
  const events = ['payment.captured', 'order.paid', 'payment.failed', 'subscription.charged', 'subscription.pending', 'subscription.halted', 'subscription.cancelled', 'subscription.completed', 'subscription.updated', 'subscription.paused', 'refund.processed', 'refund.failed', '', 'x.y', null, 42];
  const r = rng(12345);
  const sign = (raw) => createHmac('sha256', 'mock-webhook-secret').update(raw).digest('hex');
  let accepted = 0, rejected = 0;
  for (let i = 0; i < 600; i++) {
    const body = r.chance(0.1)
      ? Buffer.from(r.pick(['', 'not json', '{', '[]', 'null', '"str"', '{"event":', '\u0000\u0001']))
      : Buffer.from(JSON.stringify({ event: r.pick(events), payload: { payment: { entity: junk(r) }, subscription: { entity: junk(r) }, order: { entity: junk(r) }, refund: { entity: junk(r) } } }));
    const headers = { 'x-razorpay-signature': r.chance(0.1) ? 'bad' : sign(body), 'x-razorpay-event-id': r.chance(0.5) ? `evt_${r.int(40)}` : undefined };
    try {
      const res = checkout.handleWebhook(body, headers);
      await res.done;
      accepted++;
    } catch (e) {
      assert.ok(e.expose === true && Number.isInteger(e.status), `iteration ${i}: only deliberate, customer-safe errors may escape, got ${e?.name}: ${e?.message}`);
      rejected++;
    }
  }
  assert.ok(accepted > 100 && rejected > 20, `the fuzzer exercised both paths (${accepted} accepted, ${rejected} rejected)`);
  assert.equal(store.listOrders().length, 0, 'garbage must never create an order');
});

test('chaos: vendor webhooks with random payloads and clocks never crash and never mark work done', () => {
  const store = new MemStore();
  store.putOrder({ id: 'o1', status: 'provisioning', progress: [{ domain: 'a.com', steps: { connect_domain: { status: 'waiting', nextCheckAt: Date.now() + 1e9, waitingSince: 1 } } }] });
  const vendor = createZapmailVendor({ apiKey: 'k', webhookSecret: 'whsec', fetchImpl: async () => ({}) });
  const handle = createVendorWebhookHandler({ store, providers: { vendor }, resume() {}, log: silent });
  const r = rng(777);
  for (let i = 0; i < 400; i++) {
    const body = JSON.stringify({ id: r.chance(0.7) ? `evt_${i}` : undefined, type: r.pick(['mailbox.updated', 'domain.updated', 'x']), data: junk(r) });
    const t = Math.floor(Date.now() / 1000) + (r.chance(0.2) ? 99999 : 0);
    const sig = `t=${t},v1=${createHmac('sha256', r.chance(0.1) ? 'wrong' : 'whsec').update(`${t}.${body}`).digest('hex')}`;
    try { handle(Buffer.from(body), { 'x-zapmail-signature': sig }); } catch (e) { assert.ok(e.expose === true, `iteration ${i}: ${e?.message}`); }
  }
  const step = store.getOrder('o1').progress[0].steps.connect_domain;
  assert.equal(step.status, 'waiting', 'an event can only make a step due sooner, never finish it');
});

/* ------------------------------------------------------------------ */
/* 3. Billing: random event sequences vs invariants                     */
/* ------------------------------------------------------------------ */
function billingWorld(seedNo) {
  const store = new MemStore();
  const clock = { t: Date.UTC(2026, 0, 1) };
  const spy = { renew: [], plan: [], cancel: [], remove: [], restore: [] };
  const providers = {
    payments: { name: 'spy', async changePlan(a) { spy.plan.push(a.planId); }, async cancelSubscription() { spy.cancel.push(1); } },
    registrar: { async renew(a) { spy.renew.push(a.domain); return { orderAmount: 1 }; } },
    vendor: { async scheduleRemoval(a) { spy.remove.push(a.domain); }, async cancelRemoval(a) { spy.restore.push(a.domain); } }
  };
  const svc = createBillingService({ store, providers, log: silent, now: () => clock.t, notify() {} });
  const q = quote({ provider: 'google', plan: 'quarterly', domains: ['a.com', 'b.com'], mailboxes: [1, 2, 3, 4].map((i) => ({ firstName: 'A', lastName: 'B', emailPrefix: 'm' + i })) });
  const order = { id: 'o1', provider: 'google', status: 'completed', quote: q, domains: [{ name: 'a.com', mailboxes: [] }, { name: 'b.com', mailboxes: [] }] };
  order.billing = svc.init({ schedule: buildSchedule(q), subscriptionId: 'sub_1', planIds: { renewal: 'pr', base: 'pb' }, subscription: { paid_count: 1, current_end: (clock.t + 90 * DAY) / 1000 } });
  store.putOrder(order);
  store.addMailboxes([{ orderId: 'o1', email: 'x@a.com', status: 'ready_for_warmup' }, { orderId: 'o1', email: 'y@b.com', status: 'ready_for_warmup' }]);
  return { store, clock, spy, svc, order, b: order.billing };
}

test('chaos: random sequences of billing events never break the invariants', async () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const w = billingWorld(seed);
    const ev = (type, sub = {}) => ({ type, subscription: { id: 'sub_1', ...sub } });
    for (let step = 0; step < 40; step++) {
      const op = r.pick(['charged', 'charged', 'charged-dup', 'charged-skip', 'pending', 'halted', 'cancelled', 'completed', 'tick', 'tick', 'advance', 'cancel-request', 'sync']);
      try {
        if (op.startsWith('charged')) {
          const paid = op === 'charged' ? w.b.paidCount + 1 : op === 'charged-dup' ? Math.max(1, w.b.paidCount - r.int(3)) : w.b.paidCount + 1 + r.int(3);
          const res = w.svc.handleEvent(ev('subscription.charged', { paid_count: paid, current_end: (w.clock.t + 90 * DAY) / 1000 }));
          await res.after?.();
        } else if (op === 'pending' || op === 'halted' || op === 'cancelled' || op === 'completed') {
          await w.svc.handleEvent(ev(`subscription.${op}`, { ended_at: Math.floor(w.clock.t / 1000), short_url: r.chance(0.5) ? 'https://pay.test/x' : undefined })).after?.();
        } else if (op === 'tick') await w.svc.tick();
        else if (op === 'advance') w.clock.t += r.int(25) * DAY;
        else if (op === 'cancel-request') await w.svc.cancel('o1', { atCycleEnd: r.chance(0.7) });
        else await w.svc.syncPlan(w.order);
      } catch (e) { assert.ok(e.expose === true, `seed ${seed} step ${step} (${op}): unexpected ${e?.message}`); }

      const b = w.b, where = `seed ${seed} step ${step} after ${op}`;
      assert.equal(new Set(b.processedCycles).size, b.processedCycles.length, `${where}: a cycle was processed twice`);
      assert.equal(b.paidCount, Math.max(...b.processedCycles), `${where}: paidCount must be the highest paid cycle`);
      assert.ok(['active', 'past_due', 'suspended', 'terminated', 'cancelling', 'ended'].includes(b.status), `${where}: unknown status ${b.status}`);
      if (b.status === 'active') assert.ok(w.store.listMailboxes().every((m) => !m.suspended), `${where}: active but mailboxes are suspended`);
      assert.ok(['base', 'renewal'].includes(b.plan), `${where}: bad plan ${b.plan}`);
      const domainCycles = b.processedCycles.filter((c) => c > 1 && isDomainCycle(c, b.schedule)).length;
      assert.ok(w.spy.renew.length <= domainCycles * 2, `${where}: ${w.spy.renew.length} renewals for ${domainCycles} renewal cycles x 2 domains`);
      assert.ok(w.spy.plan.every((p) => p === 'pb' || p === 'pr'), `${where}: plan change to an unknown plan`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 4. Pricing schedule properties                                       */
/* ------------------------------------------------------------------ */
test('property: over any year of billing cycles the customer pays the domain fee exactly once', () => {
  const r = rng(2026);
  const round = (n) => Math.round(n * 100) / 100;
  for (let i = 0; i < 300; i++) {
    const plan = r.pick(['quarterly', 'annual_fixed', 'annual_flexi']);
    const nBoxes = plan === 'annual_flexi' ? 25 + r.int(76) : 1 + r.int(100);
    const nDomains = 1 + r.int(20);
    const q = quote({ provider: 'google', plan, domains: Array.from({ length: nDomains }, (_, k) => `d${k}.com`), mailboxes: Array.from({ length: nBoxes }, (_, k) => ({ firstName: 'A', lastName: 'B', emailPrefix: 'm' + k })) });
    const s = buildSchedule(q);
    assert.equal(s.renewalAmount, q.total, 'the first payment equals the checkout total');
    assert.equal(s.renewalMinor, Math.round(q.total * 100));
    const domainFee = nDomains * 14;
    for (let start = 1; start <= 12; start++) {
      let sum = 0, domainCycles = 0;
      for (let c = start; c < start + s.cyclesPerYear; c++) { sum += amountForCycle(c, s); if (isDomainCycle(c, s)) domainCycles++; }
      assert.equal(domainCycles, 1, `${plan}: exactly one domain cycle in any ${s.cyclesPerYear}-cycle window starting at ${start}`);
      assert.equal(round(sum), round(s.cyclesPerYear * s.baseAmount + domainFee), `${plan} n=${nBoxes} d=${nDomains} start=${start}`);
      assert.equal(planForCycle(start, s), isDomainCycle(start, s) ? 'renewal' : 'base');
    }
  }
});
