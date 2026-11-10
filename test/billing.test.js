import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchedule, isDomainCycle, planForCycle, amountForCycle, createBillingService } from '../lib/billing.js';
import { quote } from '../lib/pricing.js';
import { Store } from '../lib/store.js';
import { createCheckoutService } from '../lib/checkout.js';
import { createRazorpayPayments } from '../lib/providers/razorpay.js';
import { createNameSiloRegistrar } from '../lib/providers/namesilo.js';
import { mockRegistrar, mockDns, mockMailboxVendor, mockPayments } from '../lib/providers/mock.js';

const DAY = 86_400_000;
const box = (n) => Array.from({ length: n }, (_, i) => ({ firstName: 'A', lastName: 'B', emailPrefix: 'a' + i }));
const quarterly = () => buildSchedule(quote({ provider: 'google', plan: 'quarterly', domains: ['a.com', 'b.com'], mailboxes: box(6) }));

/* ---------------- pure schedule maths ---------------- */
test('schedule: quarterly = mailboxes per quarter + yearly domain fee in renewal cycles', () => {
  const s = quarterly();
  assert.equal(s.baseAmount, 71.82);            // 6 mailboxes x 3.99 x 3
  assert.equal(s.renewalAmount, 99.82);         // + 2 domains x $14 (equals the first payment)
  assert.equal(s.baseMinor, 7182);
  assert.equal(s.renewalMinor, 9982);
  assert.equal(s.cyclesPerYear, 4);
  assert.deepEqual(s.period, { unit: 'monthly', interval: 3 });
  assert.equal(s.totalCount, 40);               // 10 years of quarters
});

test('schedule: the domain fee falls in cycles 1, 5, 9 ... and nowhere else', () => {
  const s = quarterly();
  const plans = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => planForCycle(c, s));
  assert.deepEqual(plans, ['renewal', 'base', 'base', 'base', 'renewal', 'base', 'base', 'base', 'renewal']);
  assert.equal(isDomainCycle(13, s), true);
  assert.equal(amountForCycle(2, s), 71.82);
  assert.equal(amountForCycle(5, s), 99.82);
  // Over any 4 consecutive quarters the customer pays the domain fee exactly once.
  const year = [1, 2, 3, 4].reduce((sum, c) => sum + amountForCycle(c, s), 0);
  assert.equal(Math.round(year * 100) / 100, Math.round((4 * 71.82 + 28) * 100) / 100);
});

test('schedule: annual plans bill yearly and every cycle includes the domains', () => {
  const s = buildSchedule(quote({ provider: 'google', plan: 'annual_fixed', domains: ['a.com'], mailboxes: box(3) }));
  assert.deepEqual(s.period, { unit: 'yearly', interval: 1 });
  assert.equal(s.cyclesPerYear, 1);
  assert.equal(s.totalCount, 10);
  assert.ok([1, 2, 3, 10].every((c) => planForCycle(c, s) === 'renewal'));
});

/* ---------------- lifecycle service ---------------- */
function setup({ failRenew = 0, failPlan = 0, failCancel = false } = {}) {
  const calls = { changePlan: [], cancel: [], renew: [], remove: [], restore: [] };
  const st = { failRenew, failPlan };
  const providers = {
    payments: {
      name: 'spy',
      async changePlan(a) { if (st.failPlan-- > 0) throw new Error('subscription is pending'); calls.changePlan.push(a); },
      async cancelSubscription(a) { if (failCancel) throw new Error('gateway down'); calls.cancel.push(a); }
    },
    registrar: { async renew(a) { if (st.failRenew-- > 0) throw new Error('registrar down'); calls.renew.push(a); return { orderAmount: 10.5 }; } },
    vendor: {
      async scheduleRemoval(a) { calls.remove.push(a); },
      async cancelRemoval(a) { calls.restore.push(a); }
    }
  };
  const clock = { t: Date.UTC(2026, 0, 1) };
  const store = new Store(join(tmpdir(), `cl-bill-${Date.now()}-${Math.random().toString(16).slice(2)}.json`));
  const svc = createBillingService({ store, providers, log: { error() {} }, now: () => clock.t });
  const schedule = quarterly();
  const order = {
    id: 'ord_1', provider: 'google', domains: [{ name: 'a.com', mailboxes: [] }, { name: 'b.com', mailboxes: [] }],
    quote: { total: 99.82 }, status: 'completed',
    billing: svc.init({ schedule, subscriptionId: 'sub_1', planIds: { renewal: 'plan_r', base: 'plan_b' }, subscription: { paid_count: 1, current_end: (clock.t + 90 * DAY) / 1000 } })
  };
  store.putOrder(order);
  store.data.mailboxes.push({ orderId: 'ord_1', email: 'x@a.com', status: 'ready_for_warmup' }, { orderId: 'ord_1', email: 'y@b.com', status: 'ready_for_warmup' });
  const ev = (type, sub = {}) => ({ type, subscription: { id: 'sub_1', ...sub } });
  const charged = (n) => svc.handleEvent(ev('subscription.charged', { paid_count: n, current_end: (clock.t + 90 * DAY) / 1000 }));
  return { svc, store, order, calls, clock, ev, charged, b: order.billing };
}

test('after the first cycle the plan is switched to the cheaper base plan', async () => {
  const { svc, order, calls, b } = setup();
  assert.equal(b.plan, 'renewal');
  await svc.syncPlan(order);
  assert.deepEqual(calls.changePlan, [{ subscriptionId: 'sub_1', planId: 'plan_b' }]);
  assert.equal(b.plan, 'base');
  await svc.syncPlan(order);
  assert.equal(calls.changePlan.length, 1, 'no repeat call when nothing changed');
});

test('a full year of quarterly cycles: domains renew once, plans switch back and forth, webhook retries are harmless', async () => {
  const { svc, order, calls, charged, b } = setup();
  await svc.syncPlan(order); // after cycle 1 -> base

  for (const c of [2, 3]) { const r = charged(c); assert.equal(r.handled, true); await r.after(); }
  assert.equal(calls.renew.length, 0);
  assert.equal(calls.changePlan.length, 1);

  const r4 = charged(4); await r4.after();
  assert.equal(calls.changePlan.at(-1).planId, 'plan_r', 'cycle 5 must be charged on the renewal plan');
  assert.equal(calls.renew.length, 0);

  const r5 = charged(5); await r5.after();
  assert.deepEqual(calls.renew.map((c) => [c.domain, c.years]), [['a.com', 1], ['b.com', 1]]);
  assert.equal(calls.changePlan.at(-1).planId, 'plan_b', 'and back to the base plan afterwards');

  const dup = charged(5);
  assert.deepEqual({ handled: dup.handled, reason: dup.reason }, { handled: false, reason: 'duplicate' });
  assert.equal(calls.renew.length, 2, 'a repeated webhook must not renew twice');
  assert.equal(b.paidCount, 5);
  assert.equal(b.domainRenewals.every((r) => r.status === 'done'), true);
});

test('a failed plan change is retried an hour later', async () => {
  const { svc, order, calls, clock, b } = setup({ failPlan: 1 });
  await svc.syncPlan(order);
  assert.equal(calls.changePlan.length, 0);
  assert.equal(b.plan, 'renewal');
  await svc.syncPlan(order);                       // too soon
  assert.equal(calls.changePlan.length, 0);
  clock.t += 3_600_001;
  await svc.tick();
  assert.equal(calls.changePlan.length, 1);
  assert.equal(b.plan, 'base');
});

test('a failed domain renewal is retried by the timer, then flagged for a human after five tries', async () => {
  const s = setup({ failRenew: 1 });
  await s.svc.syncPlan(s.order);
  for (const c of [2, 3, 4]) await s.charged(c).after();
  await s.charged(5).after();
  assert.equal(s.calls.renew.length, 1, 'b.com succeeded, a.com failed');
  assert.equal(s.b.domainRenewals.find((r) => r.domain === 'a.com').status, 'pending');
  s.clock.t += 3_600_001; await s.svc.tick();
  assert.equal(s.calls.renew.length, 2);
  assert.equal(s.b.domainRenewals.every((r) => r.status === 'done'), true);

  const f = setup({ failRenew: 99 });
  await f.svc.syncPlan(f.order);
  for (const c of [2, 3, 4]) await f.charged(c).after();
  await f.charged(5).after();
  for (let i = 0; i < 6; i++) { f.clock.t += 6 * 3_600_000; await f.svc.tick(); }
  assert.match(f.b.needsAttention, /Domain renewal failed/);
});

test('dunning: failed charge -> past due -> grace -> suspended -> removed, and payment brings it all back', async () => {
  const { svc, order, store, calls, clock, ev, charged, b } = setup();
  svc.handleEvent(ev('subscription.pending'));
  assert.equal(b.status, 'past_due');
  assert.equal(b.graceEndsAt, null, 'still retrying: no deadline yet');

  svc.handleEvent(ev('subscription.halted'));
  assert.equal(b.graceEndsAt, clock.t + 7 * DAY);
  clock.t += 6 * DAY; await svc.tick();
  assert.equal(b.status, 'past_due');
  assert.ok(store.data.mailboxes.every((m) => !m.suspended), 'service continues during the grace period');

  clock.t += 2 * DAY; await svc.tick();
  assert.equal(b.status, 'suspended');
  assert.ok(store.data.mailboxes.every((m) => m.suspended && m.status === 'suspended' && m.suspendedReason === 'non_payment'));

  clock.t += 15 * DAY; await svc.tick();
  assert.equal(b.status, 'terminated');
  assert.deepEqual(calls.remove.map((r) => r.domain).sort(), ['a.com', 'b.com']);

  // Customer finally pays: removal is cancelled and mailboxes come back.
  const r = charged(2); await r.after();
  assert.deepEqual(calls.restore.map((x) => x.domain).sort(), ['a.com', 'b.com']);
  assert.equal(b.status, 'active');
  assert.ok(store.data.mailboxes.every((m) => !m.suspended && m.status === 'ready_for_warmup'));
});

test('paying during the grace period clears the deadline; paying after suspension reinstates', async () => {
  const a = setup();
  a.svc.handleEvent(a.ev('subscription.halted'));
  assert.ok(a.b.graceEndsAt);
  await a.charged(2).after();
  assert.equal(a.b.status, 'active');
  assert.equal(a.b.graceEndsAt, null);

  const b2 = setup();
  b2.svc.handleEvent(b2.ev('subscription.halted'));
  b2.clock.t += 8 * DAY; await b2.svc.tick();
  assert.equal(b2.b.status, 'suspended');
  await b2.charged(2).after();
  assert.equal(b2.b.status, 'active');
  assert.ok(b2.store.data.mailboxes.every((m) => !m.suspended));
  assert.equal(b2.calls.restore.length, 0, 'nothing was removed at the vendor yet');
});

test('cancellation at cycle end: service continues until the paid period ends, then stops', async () => {
  const { svc, store, calls, clock, b } = setup();
  const s = await svc.cancel('ord_1', { atCycleEnd: true });
  assert.deepEqual(calls.cancel, [{ subscriptionId: 'sub_1', atCycleEnd: true }]);
  assert.equal(s.status, 'cancelling');
  assert.equal(s.cancelAtPeriodEnd, true);
  assert.ok(s.serviceEndsAt);

  clock.t += 80 * DAY; await svc.tick();
  assert.equal(b.status, 'cancelling');
  assert.ok(store.data.mailboxes.every((m) => !m.suspended));

  clock.t += 11 * DAY; await svc.tick();
  assert.equal(b.status, 'ended');
  assert.ok(store.data.mailboxes.every((m) => m.suspendedReason === 'cancelled'));
  await assert.rejects(() => svc.cancel('ord_1'), (e) => e.status === 409 && e.expose);

  clock.t += 15 * DAY; await svc.tick();
  assert.equal(b.status, 'terminated');
  assert.equal(calls.remove.length, 2);
});

test('cancel: unknown order is 404, and a gateway failure changes nothing and leaks nothing', async () => {
  await assert.rejects(() => setup().svc.cancel('ord_missing'), (e) => e.status === 404);
  const { svc, b } = setup({ failCancel: true });
  await assert.rejects(() => svc.cancel('ord_1'), (e) => e.status === 502 && !/gateway down/.test(e.message));
  assert.equal(b.status, 'active');
  assert.equal(b.cancelAtPeriodEnd, false);
});

test('gateway-side cancellation and completion are respected; unknown subscriptions are ignored', () => {
  const a = setup();
  assert.equal(a.svc.handleEvent(a.ev('subscription.cancelled', { ended_at: Math.floor(Date.UTC(2026, 6, 1) / 1000) })).handled, true);
  assert.equal(a.b.status, 'cancelling');
  assert.equal(a.b.endsAt, Date.UTC(2026, 6, 1));
  const c = setup();
  assert.equal(c.svc.handleEvent(c.ev('subscription.completed')).handled, true);
  assert.equal(c.b.status, 'cancelling');
  assert.deepEqual(a.svc.handleEvent({ type: 'subscription.charged', subscription: { id: 'sub_nope', paid_count: 2 } }), { handled: false, reason: 'unknown subscription' });
});

test('the customer summary shows the next charge but none of the internals', async () => {
  const { svc, order, charged, ev } = setup();
  let s = svc.summary(order);
  assert.equal(s.nextChargeAmount, 71.82);       // cycle 2 is a base cycle
  assert.equal(s.paymentFailed, false);
  await charged(4).after();
  assert.equal(svc.summary(order).nextChargeAmount, 99.82, 'cycle 5 includes the domain renewals');
  svc.handleEvent(ev('subscription.halted'));
  s = svc.summary(order);
  assert.equal(s.paymentFailed, true);
  assert.ok(s.payBy);
  assert.ok(!/plan_|sub_1|spy|history|planIds/.test(JSON.stringify(s)));
});

/* ---------------- Razorpay subscription adapter ---------------- */
const SECRET = 'KEYSECRET', WH = 'WHSECRET';
const hmac = (key, msg) => createHmac('sha256', key).update(msg).digest('hex');

function fakeRazorpay(init = {}) {
  const st = { plans: {}, subs: {}, calls: [], ...init };
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const m = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    st.calls.push({ m, path: u.pathname, body });
    const out = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
    if (m === 'POST' && u.pathname === '/v1/plans') {
      const id = 'plan_' + (Object.keys(st.plans).length + 1);
      st.plans[id] = { id, ...body };
      return out({ id });
    }
    if (m === 'POST' && u.pathname === '/v1/subscriptions') {
      const id = 'sub_' + (Object.keys(st.subs).length + 1);
      st.subs[id] = { id, plan_id: body.plan_id, total_count: body.total_count, status: 'created', paid_count: 0 };
      return out(st.subs[id]);
    }
    let mm = u.pathname.match(/^\/v1\/subscriptions\/(\w+)$/);
    if (mm && m === 'GET') return st.subs[mm[1]] ? out(st.subs[mm[1]]) : out({ error: { code: 'BAD_REQUEST_ERROR', description: 'nf' } }, 400);
    if (mm && m === 'PATCH') return out({ id: mm[1], has_scheduled_changes: true });
    mm = u.pathname.match(/^\/v1\/subscriptions\/(\w+)\/cancel$/);
    if (mm && m === 'POST') return out({ id: mm[1], status: 'cancelled' });
    return out({ error: { code: 'BAD_REQUEST_ERROR', description: 'unknown route' } }, 404);
  };
  return { f, st };
}
const rzWith = (f) => createRazorpayPayments({ keyId: 'rzp_test_abc', keySecret: SECRET, webhookSecret: WH, fetchImpl: f });
const cache = (map = new Map()) => ({ get: (k) => map.get(k), set: (k, v) => map.set(k, v), map });

test('razorpay subscriptions: two plans (reused across customers), subscription starts on the renewal plan', async () => {
  const { f, st } = fakeRazorpay();
  const rz = rzWith(f), c = cache(), s = quarterly();
  const a = await rz.createSubscriptionCheckout({ receipt: 'chk_1', currency: 'USD', schedule: s, notes: { checkout_id: 'chk_1' }, customer: {}, planCache: c });
  assert.equal(a.kind, 'subscription');
  assert.equal(a.amountMinor, 9982);
  assert.notEqual(a.planIds.base, a.planIds.renewal);
  const plans = Object.values(st.plans);
  assert.deepEqual(plans.map((p) => [p.period, p.interval, p.item.amount, p.item.currency]).sort(), [['monthly', 3, 7182, 'USD'], ['monthly', 3, 9982, 'USD']]);
  assert.equal(st.subs.sub_1.plan_id, a.planIds.renewal);
  assert.equal(st.subs.sub_1.total_count, 40);

  await rz.createSubscriptionCheckout({ receipt: 'chk_2', currency: 'USD', schedule: s, planCache: c });
  assert.equal(Object.keys(st.plans).length, 2, 'same amounts reuse the same plans');
  assert.ok(!JSON.stringify(a).includes(SECRET));
});

test('razorpay subscriptions: annual plans need only one plan', async () => {
  const { f, st } = fakeRazorpay();
  const s = buildSchedule(quote({ provider: 'google', plan: 'annual_fixed', domains: ['a.com'], mailboxes: box(3) }));
  const r = await rzWith(f).createSubscriptionCheckout({ receipt: 'chk_a', currency: 'USD', schedule: s, planCache: cache() });
  assert.equal(Object.keys(st.plans).length, 1);
  assert.equal(r.planIds.base, r.planIds.renewal);
  assert.equal(Object.values(st.plans)[0].period, 'yearly');
});

test('razorpay subscriptions: signature is HMAC(payment_id|subscription_id), and plan + paid_count are checked', async () => {
  const sig = (p, s) => hmac(SECRET, `${p}|${s}`);
  const good = fakeRazorpay({ subs: { sub_1: { id: 'sub_1', plan_id: 'plan_r', paid_count: 1, status: 'active' } } });
  const r = await rzWith(good.f).confirmSubscription({ gatewaySubscriptionId: 'sub_1', paymentId: 'pay_1', signature: sig('pay_1', 'sub_1'), planId: 'plan_r' });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.subscription.paid_count, 1);

  // The ORDER signature scheme (order_id|payment_id) must not be accepted here.
  await assert.rejects(() => rzWith(good.f).confirmSubscription({ gatewaySubscriptionId: 'sub_1', paymentId: 'pay_1', signature: sig('sub_1', 'pay_1'), planId: 'plan_r' }), (e) => e.status === 400);
  await assert.rejects(() => rzWith(good.f).confirmSubscription({ gatewaySubscriptionId: 'sub_1', paymentId: 'pay_1', signature: sig('pay_1', 'sub_1'), planId: 'plan_other' }), (e) => e.status === 409);

  const unpaid = fakeRazorpay({ subs: { sub_1: { id: 'sub_1', plan_id: 'plan_r', paid_count: 0, status: 'created' } } });
  await assert.rejects(
    () => rzWith(unpaid.f).confirmSubscription({ gatewaySubscriptionId: 'sub_1', paymentId: 'pay_1', signature: sig('pay_1', 'sub_1'), planId: 'plan_r' }),
    (e) => e.status === 409 && /still being confirmed/.test(e.message) && !/verification failed|does not match|not completed/i.test(e.message) // the wizard must keep waiting, not fail
  );
});

test('razorpay subscriptions: plan changes are scheduled for cycle end; cancel sends cancel_at_cycle_end', async () => {
  const { f, st } = fakeRazorpay();
  const rz = rzWith(f);
  await rz.changePlan({ subscriptionId: 'sub_1', planId: 'plan_b' });
  assert.deepEqual(st.calls[0], { m: 'PATCH', path: '/v1/subscriptions/sub_1', body: { plan_id: 'plan_b', schedule_change_at: 'cycle_end' } });
  await rz.cancelSubscription({ subscriptionId: 'sub_1', atCycleEnd: true });
  assert.deepEqual(st.calls[1].body, { cancel_at_cycle_end: true });
  await rz.cancelSubscription({ subscriptionId: 'sub_1', atCycleEnd: false });
  assert.deepEqual(st.calls[2].body, { cancel_at_cycle_end: false });
});

/* ---------------- Checkout service with subscriptions (end to end) ---------------- */
const silent = { error() {} };
async function freeDomain(tag) {
  for (let i = 0; i < 50; i++) {
    const d = `${tag}${i}.com`;
    if ((await mockRegistrar.checkAvailability([d]))[0].available) return d;
  }
  throw new Error('no free mock domain');
}
const contact = { firstName: 'Asha', lastName: 'Rao', company: 'Co', email: 'asha@co.in', address: '12 MG Road', country: 'in', state: 'MH', city: 'Nagpur', zip: '440001', phoneCc: '91', phone: '9800000000' };
const body = (domain) => ({
  provider: 'google', plan: 'quarterly', acceptedTerms: true, contact,
  domains: [{ name: domain, mailboxes: [{ firstName: 'A', lastName: 'B', emailPrefix: 'a.b' }, { firstName: 'A', lastName: 'B', emailPrefix: 'b.a' }] }]
});
function setupCheckout() {
  const rzf = fakeRazorpay();
  const store = new Store(join(tmpdir(), `cl-sub-${Date.now()}-${Math.random().toString(16).slice(2)}.json`));
  const svc = createCheckoutService({ store, providers: { registrar: mockRegistrar, dns: mockDns, vendor: mockMailboxVendor, payments: rzWith(rzf.f) }, log: silent });
  return { ...rzf, store, svc };
}
const hook = (event, subscription, payment, id) => {
  const raw = Buffer.from(JSON.stringify({ event, payload: { subscription: { entity: subscription }, ...(payment ? { payment: { entity: payment } } : {}) } }));
  return [raw, { 'x-razorpay-signature': hmac(WH, raw), 'x-razorpay-event-id': id }];
};

test('checkout (recurring): server-priced subscription, confirm creates the order with billing and a one-time manage token', async () => {
  const { svc, store, st } = setupCheckout();
  const co = await svc.create(body(await freeDomain('sub')));
  assert.equal(co.payment.kind, 'subscription');
  assert.equal(co.payment.subscriptionId, 'sub_1');
  assert.equal(co.quote.total, 37.94);                                // $14 + 2 mailboxes x 3.99 x 3
  assert.equal(co.payment.amountMinor, 3794);

  st.subs.sub_1.paid_count = 1; st.subs.sub_1.status = 'active';
  const proof = { paymentId: 'pay_1', signature: hmac(SECRET, 'pay_1|sub_1') };
  const o = await svc.confirm(co.checkoutId, proof);
  assert.ok(o.manageToken && o.manageToken.length === 32);
  assert.equal(o.billing.status, 'active');
  assert.equal(o.billing.nextChargeAmount, 23.94);                    // cycle 2: 2 mailboxes x 3.99 x 3
  assert.ok(!JSON.stringify(o.billing).includes('plan_'));

  const stored = store.getOrder(o.id);
  assert.equal(stored.billing.subscriptionId, 'sub_1');
  assert.equal(stored.billing.paidCount, 1);
  assert.ok(!('manageToken' in (await import('../lib/provisioner.js')).publicOrder(stored)), 'the token is never in a public order');
  assert.equal((await svc.confirm(co.checkoutId, proof)).id, o.id, 'confirming twice returns the same order');

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(st.calls.some((c) => c.m === 'PATCH'), 'the plan is switched to base right after the first payment');
});

test('checkout (recurring): the webhook creates the order if the browser never confirms, then later cycles are billing events', async () => {
  const { svc, store, st } = setupCheckout();
  const co = await svc.create(body(await freeDomain('subhook')));
  const sub = (over) => ({ id: 'sub_1', plan_id: st.subs.sub_1.plan_id, current_end: Math.floor(Date.now() / 1000) + 90 * 86400, ...over });

  assert.equal(svc.handleWebhook(...hook('subscription.authenticated', sub({ paid_count: 0 }), null, 'e0')).reason, 'awaiting first charge');
  assert.equal(Object.keys(store.data.orders).length, 0);

  const r1 = svc.handleWebhook(...hook('subscription.charged', sub({ paid_count: 1 }), { id: 'pay_1', invoice_id: 'inv_1' }, 'e1'));
  assert.deepEqual(r1, { handled: true });
  assert.equal(Object.keys(store.data.orders).length, 1);
  const order = Object.values(store.data.orders)[0];
  assert.equal(order.paymentId, 'pay_1');

  assert.deepEqual(svc.handleWebhook(...hook('subscription.charged', sub({ paid_count: 1 }), { id: 'pay_1' }, 'e1')), { handled: false, reason: 'duplicate' });
  const r2 = svc.handleWebhook(...hook('subscription.charged', sub({ paid_count: 1 }), { id: 'pay_1' }, 'e1b'));
  assert.equal(r2.handled, false);                                    // cycle 1 already processed
  assert.equal(Object.keys(store.data.orders).length, 1);

  const r3 = svc.handleWebhook(...hook('subscription.charged', sub({ paid_count: 2 }), { id: 'pay_2' }, 'e2'));
  assert.equal(r3.handled, true);
  await r3.done;
  assert.equal(order.billing.paidCount, 2);

  const h = svc.handleWebhook(...hook('subscription.halted', sub({}), null, 'e3'));
  assert.equal(h.handled, true);
  assert.equal(order.billing.status, 'past_due');
  assert.ok(order.billing.graceEndsAt);
});

test('checkout (recurring): a forged subscription confirm and a plan mismatch create nothing', async () => {
  const { svc, store, st } = setupCheckout();
  const co = await svc.create(body(await freeDomain('subforge')));
  await assert.rejects(() => svc.confirm(co.checkoutId, { paymentId: 'pay_x', signature: 'nope' }), (e) => e.status === 400);
  st.subs.sub_1.paid_count = 1; st.subs.sub_1.plan_id = 'plan_someone_elses';
  await assert.rejects(() => svc.confirm(co.checkoutId, { paymentId: 'pay_1', signature: hmac(SECRET, 'pay_1|sub_1') }), (e) => e.status === 409);
  assert.equal(Object.keys(store.data.orders).length, 0);
});

test('checkout (recurring): subscription charge payments do not raise "unknown order" noise', async () => {
  const errors = [];
  const rzf = fakeRazorpay();
  const store = new Store(join(tmpdir(), `cl-noise-${Date.now()}.json`));
  const svc = createCheckoutService({ store, providers: { registrar: mockRegistrar, dns: mockDns, vendor: mockMailboxVendor, payments: rzWith(rzf.f) }, log: { error: (m) => errors.push(m) } });
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_9', order_id: 'order_x', invoice_id: 'inv_9', amount: 100, currency: 'USD', status: 'captured' } } } }));
  const r = svc.handleWebhook(raw, { 'x-razorpay-signature': hmac(WH, raw), 'x-razorpay-event-id': 'ev_n' });
  assert.equal(r.handled, false);
  assert.equal(errors.length, 0);
});

test('checkout (mock gateway): the whole recurring flow works with no keys', async () => {
  const store = new Store(join(tmpdir(), `cl-mock-${Date.now()}.json`));
  const svc = createCheckoutService({ store, providers: { registrar: mockRegistrar, dns: mockDns, vendor: mockMailboxVendor, payments: mockPayments }, log: silent });
  const co = await svc.create(body(await freeDomain('mocksub')));
  assert.equal(co.payment.mode, 'mock');
  assert.equal(co.payment.kind, 'subscription');
  const o = await svc.confirm(co.checkoutId, { paymentId: 'pay_mock_abc' });
  assert.equal(o.billing.status, 'active');
  await assert.rejects(() => svc.confirm(co.checkoutId.replace('chk_', 'chk_x'), { paymentId: 'pay_mock_abc' }), (e) => e.status === 404);
  const cancelled = await svc.billing.cancel(o.id, { atCycleEnd: true });
  assert.equal(cancelled.status, 'cancelling');
});

test('BILLING_MODE=one_time falls back to a plain one-off payment', async () => {
  process.env.BILLING_MODE = 'one_time';
  try {
    const store = new Store(join(tmpdir(), `cl-one-${Date.now()}.json`));
    const svc = createCheckoutService({ store, providers: { registrar: mockRegistrar, dns: mockDns, vendor: mockMailboxVendor, payments: mockPayments }, log: silent });
    const co = await svc.create(body(await freeDomain('onetime')));
    assert.equal(co.payment.kind, 'order');
    const o = await svc.confirm(co.checkoutId, { paymentId: 'pay_mock_1' });
    assert.equal(o.billing, null);
  } finally { delete process.env.BILLING_MODE; }
});

/* ---------------- NameSilo: renewals and idempotent registration ---------------- */
const nsReply = (code, extra = {}) => ({ body: { reply: { code, detail: code === 300 ? 'success' : 'error', ...extra } } });
const nsWith = (handler) => {
  const calls = [];
  const f = async (url) => { const u = new URL(url); calls.push(u); const r = handler(u); return { ok: true, status: 200, json: async () => r.body }; };
  return { ns: createNameSiloRegistrar({ apiKey: 'SECRETKEY', fetchImpl: f }), calls };
};

test('namesilo: renew sends domain + years and returns the charge; getDomainInfo returns the expiry', async () => {
  const { ns, calls } = nsWith((u) => (u.pathname.endsWith('/renewDomain') ? nsReply(300, { order_amount: 10.5 }) : nsReply(300, { created: '2026-01-01', expires: '2027-01-01', status: 'Active', auto_renew: 'No' })));
  const r = await ns.renew({ domain: 'x.com', years: 1 });
  assert.equal(calls[0].searchParams.get('years'), '1');
  assert.equal(calls[0].searchParams.get('domain'), 'x.com');
  assert.equal(r.orderAmount, 10.5);
  assert.deepEqual(await ns.getDomainInfo('x.com'), { domain: 'x.com', created: '2026-01-01', expires: '2027-01-01', status: 'Active', autoRenew: false });
});

test('namesilo: a renewal that fails explains why without leaking the key', async () => {
  const { ns } = nsWith(() => nsReply(119));
  await assert.rejects(() => ns.renew({ domain: 'x.com' }), (e) => /119/.test(e.message) && /funds/i.test(e.message) && !e.message.includes('SECRETKEY'));
});

test('namesilo: "already active" (262) is treated as success only when the domain is in OUR account', async () => {
  const contact2 = { firstName: 'A', lastName: 'B', address: '1', city: 'c', state: 's', zip: '1', country: 'US', email: 'a@b.co', phoneCc: '1', phone: '4805555555' };
  const ours = nsWith((u) => (u.pathname.endsWith('/registerDomain') ? nsReply(262) : nsReply(300, { expires: '2027-01-01' })));
  const r = await ours.ns.register({ domain: 'x.com', contact: contact2 });
  assert.equal(r.alreadyRegistered, true);
  assert.equal(r.expires, '2027-01-01');

  const theirs = nsWith((u) => (u.pathname.endsWith('/registerDomain') ? nsReply(262) : nsReply(200)));
  await assert.rejects(() => theirs.ns.register({ domain: 'x.com', contact: contact2 }), (e) => e.nameSiloCode === 262);
});
