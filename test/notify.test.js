import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { render, TEMPLATE_TYPES } from '../lib/templates.js';
import { createNotifier } from '../lib/notify.js';
import { createMockMailer, createResendMailer } from '../lib/mailers.js';
import { createAlerter, createSlackSink } from '../lib/alerts.js';
import { orderProblems } from '../lib/problems.js';
import { buildSchedule, createBillingService } from '../lib/billing.js';
import { quote } from '../lib/pricing.js';

const DAY = 86_400_000;
const newStore = () => new Store(join(tmpdir(), `cl-notify-${Date.now()}-${Math.random().toString(16).slice(2)}.json`));
const silent = { error() {}, warn() {}, info() {} };
const box = (n) => Array.from({ length: n }, (_, i) => ({ firstName: 'A', lastName: 'B', emailPrefix: 'a' + i }));

function makeOrder(over = {}) {
  return {
    id: 'ord_1', provider: 'google', status: 'completed', manageToken: 'tok_secret_123',
    contact: { firstName: 'Asha', lastName: 'Rao', email: 'asha@co.in', company: 'Co' },
    domains: [{ name: 'getx.com', mailboxes: [{ firstName: 'A', lastName: 'B', emailPrefix: 'a.b' }, { firstName: 'A', lastName: 'B', emailPrefix: 'b.a' }] }],
    quote: { total: 37.94, currency: 'USD' }, ...over
  };
}

/* ---------------- templates ---------------- */
test('templates: every type renders, never names an internal vendor, and includes the manage link', () => {
  const order = makeOrder();
  const summary = { currency: 'USD', nextChargeAmount: 23.94, nextChargeAt: '2027-02-08T00:00:00Z', payBy: '2026-12-01T00:00:00Z', serviceEndsAt: '2027-02-08T00:00:00Z' };
  for (const type of TEMPLATE_TYPES) {
    const m = render(type, { order, summary, extra: { cycle: 5 }, manageUrl: 'https://app.test/manage.html#o=ord_1&t=tok_secret_123' });
    assert.ok(m.subject && m.text && m.html, type);
    const all = `${m.subject} ${m.text} ${m.html}`;
    assert.ok(!/zapmail|namesilo|cloudflare|razorpay|vendor|mock/i.test(all), `${type} leaks an internal name`);
  }
  assert.match(render('order_ready', { order, manageUrl: 'https://app.test/m' }).text, /Manage your plan: https:\/\/app\.test\/m/);
  assert.match(render('order_ready', { order }).text, /a\.b@getx\.com/);
});

test('templates: customer-supplied text is HTML-escaped, and a payment link is used when the gateway gave one', () => {
  const evil = makeOrder({ contact: { firstName: '<script>alert(1)</script>', email: 'x@y.co' } });
  const m = render('order_ready', { order: evil, manageUrl: 'https://app.test/m' });
  assert.ok(!m.html.includes('<script>alert'), 'script tag must be escaped');
  assert.match(m.html, /&lt;script&gt;/);
  const failed = render('payment_failed', { order: makeOrder(), summary: { currency: 'USD', nextChargeAmount: 10, payBy: '2026-12-01T00:00:00Z' }, extra: { updateUrl: 'https://pay.example/hosted' }, manageUrl: 'https://app.test/m' });
  assert.match(failed.text, /Update payment method: https:\/\/pay\.example\/hosted/);
  assert.throws(() => render('nope', { order: makeOrder() }), /Unknown email template/);
});

/* ---------------- outbox ---------------- */
function notifierHarness(over = {}) {
  const store = newStore();
  const mailer = createMockMailer();
  const clock = { t: Date.UTC(2026, 0, 1) };
  const notifier = createNotifier({ store, mailer, publicUrl: 'https://app.test', from: 'CloudLead <hi@app.test>', log: silent, now: () => clock.t, summarize: () => ({ currency: 'USD', nextChargeAmount: 23.94 }), ...over });
  const order = makeOrder();
  store.putOrder(order);
  return { store, mailer, clock, notifier, order };
}

test('outbox: the same event queues once; different cycles queue separately; no address means no email', async () => {
  const { notifier, store, order } = notifierHarness();
  order.billing = { paidCount: 1 };
  assert.equal(notifier.notify('order_ready', order), true);
  assert.equal(notifier.notify('order_ready', order), false, 'a webhook retry must not send twice');
  assert.equal(notifier.notify('payment_failed', order), true);
  assert.equal(notifier.notify('payment_failed', order), false, 'one payment-failed email per cycle, not one per retry');
  order.billing.paidCount = 2;
  assert.equal(notifier.notify('payment_failed', order), true, 'the next cycle is a new event');
  assert.equal(notifier.notify('order_ready', { ...order, contact: {} }), false);
  assert.equal(notifier.notify('not_a_type', order), false);
  assert.equal(store.listOutbox().length, 3);
});

test('outbox: flush renders at send time, marks sent, and the database never holds the manage token', async () => {
  const { notifier, mailer, store, order } = notifierHarness();
  notifier.notify('manage_link', order);
  assert.ok(!JSON.stringify(store.listOutbox()).includes('tok_secret_123'), 'no secrets at rest in the outbox');
  assert.equal(await notifier.flush(), 1);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'asha@co.in');
  assert.equal(mailer.sent[0].from, 'CloudLead <hi@app.test>');
  assert.match(mailer.sent[0].text, /https:\/\/app\.test\/manage\.html#o=ord_1&t=tok_secret_123/);
  assert.equal(store.listOutbox()[0].status, 'sent');
  assert.equal(await notifier.flush(), 0, 'nothing is sent twice');
});

test('outbox: failures back off and retry, then give up as "dead" (and show up as a problem)', async () => {
  const flaky = { name: 'flaky', calls: 0, async send() { this.calls++; throw new Error('provider down'); } };
  const { notifier, store, order, clock } = notifierHarness({ mailer: flaky });
  notifier.notify('order_ready', order);
  assert.equal(await notifier.flush(), 0);
  assert.equal(flaky.calls, 1);
  await notifier.flush();
  assert.equal(flaky.calls, 1, 'not retried before the back-off has passed');
  for (let i = 0; i < 10; i++) { clock.t += 7 * 3_600_000; await notifier.flush(); }
  const item = store.listOutbox()[0];
  assert.equal(item.status, 'dead');
  assert.equal(item.attempts, 6);
  assert.equal(flaky.calls, 6, 'no more attempts once dead');
  assert.equal(item.error, 'provider down');
});

test('outbox: an order that disappeared, or a throwing queue, never breaks the caller', async () => {
  const { notifier, store, order } = notifierHarness();
  notifier.notify('order_ready', order);
  store.data.orders = {};
  await notifier.flush();
  assert.notEqual(store.listOutbox()[0].status, 'sent');
  const broken = createNotifier({ store: { listOutbox() { throw new Error('db down'); } }, mailer: createMockMailer(), log: silent });
  assert.equal(broken.notify('order_ready', makeOrder()), false, 'notify must swallow storage errors');
});

test('resend mailer: sends the documented shape and its errors never contain the API key', async () => {
  const calls = [];
  const ok = createResendMailer({ apiKey: 're_SECRET', fetchImpl: async (u, i) => { calls.push({ u, i }); return { ok: true, json: async () => ({ id: 'msg_1' }) }; } });
  assert.deepEqual(await ok.send({ from: 'a@b.co', to: 'c@d.co', subject: 's', text: 't', html: '<p>t</p>' }), { id: 'msg_1' });
  assert.equal(calls[0].i.headers.Authorization, 'Bearer re_SECRET');
  assert.deepEqual(JSON.parse(calls[0].i.body).to, ['c@d.co']);
  const bad = createResendMailer({ apiKey: 're_SECRET', fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'domain not verified' }) }) });
  await assert.rejects(() => bad.send({ to: 'x' }), (e) => /403/.test(e.message) && /domain not verified/.test(e.message) && !e.message.includes('re_SECRET'));
  assert.throws(() => createResendMailer({}), /RESEND_API_KEY/);
});

/* ---------------- triggers: billing events become emails ---------------- */
function billingHarness() {
  const store = newStore();
  const mailer = createMockMailer();
  const clock = { t: Date.UTC(2026, 0, 1) };
  let svc;
  const notifier = createNotifier({ store, mailer, publicUrl: 'https://app.test', log: silent, now: () => clock.t, summarize: (o) => svc.summary(o) });
  const providers = { payments: { name: 'spy', async changePlan() {}, async cancelSubscription() {} }, registrar: { async renew() { return { orderAmount: 10 }; } }, vendor: { async scheduleRemoval() {}, async cancelRemoval() {} } };
  svc = createBillingService({ store, providers, log: silent, now: () => clock.t, notify: notifier.notify });
  const q = quote({ provider: 'google', plan: 'quarterly', domains: ['getx.com'], mailboxes: box(2) });
  const order = makeOrder({ quote: q });
  order.billing = svc.init({ schedule: buildSchedule(q), subscriptionId: 'sub_1', planIds: { renewal: 'pr', base: 'pb' }, subscription: { paid_count: 1, current_end: (clock.t + 90 * DAY) / 1000 } });
  store.putOrder(order); store.addMailboxes([{ orderId: 'ord_1', email: 'a@getx.com', status: 'ready_for_warmup' }]);
  const ev = (type, sub = {}) => ({ type, subscription: { id: 'sub_1', ...sub } });
  const types = () => store.listOutbox().map((i) => i.type);
  return { store, mailer, clock, svc, notifier, order, ev, types, b: order.billing };
}

test('triggers: failed payment -> warning -> suspended -> reinstated, each emailed exactly once', async () => {
  const h = billingHarness();
  h.svc.handleEvent(h.ev('subscription.pending', { short_url: 'https://pay.example/hosted' }));
  h.svc.handleEvent(h.ev('subscription.pending'));            // a retry of the same failure
  h.svc.handleEvent(h.ev('subscription.halted'));
  assert.deepEqual(h.types(), ['payment_failed'], 'one email for the cycle, however many retries');
  assert.equal(h.store.listOutbox()[0].extra.updateUrl, 'https://pay.example/hosted');

  h.clock.t += 6 * DAY; await h.svc.tick(); await h.svc.tick();
  assert.deepEqual(h.types(), ['payment_failed', 'suspension_warning'], 'warned in the last 2 days of grace, once');
  h.clock.t += 2 * DAY; await h.svc.tick();
  assert.deepEqual(h.types(), ['payment_failed', 'suspension_warning', 'suspended']);
  await h.svc.handleEvent(h.ev('subscription.charged', { paid_count: 2, current_end: (h.clock.t + 90 * DAY) / 1000 })).after();
  assert.deepEqual(h.types(), ['payment_failed', 'suspension_warning', 'suspended', 'reinstated']);
  await h.notifier.flush();
  assert.equal(h.mailer.sent.length, 4);
  assert.match(h.mailer.sent.find((m) => /did not go through/.test(m.subject)).text, /https:\/\/pay\.example\/hosted/);
});

test('triggers: renewal reminder a week out, domain renewal and cancellation emails', async () => {
  const h = billingHarness();
  h.clock.t += 80 * DAY; await h.svc.tick();
  assert.deepEqual(h.types(), [], '10 days before the period ends is too early');
  h.clock.t += 4 * DAY; await h.svc.tick(); await h.svc.tick();
  assert.deepEqual(h.types(), ['renewal_reminder'], '6 days out: reminded, once');

  const h2 = billingHarness();
  await h2.svc.syncPlan(h2.order);
  for (const c of [2, 3, 4]) await h2.svc.handleEvent(h2.ev('subscription.charged', { paid_count: c, current_end: (h2.clock.t + 90 * DAY) / 1000 })).after();
  await h2.svc.handleEvent(h2.ev('subscription.charged', { paid_count: 5, current_end: (h2.clock.t + 90 * DAY) / 1000 })).after();
  assert.ok(h2.types().includes('domains_renewed'));
  await h2.svc.cancel('ord_1', { atCycleEnd: true });
  assert.ok(h2.types().includes('cancelled'));
});

test('triggers: a failed or finished setup emails the customer once', async () => {
  const { provision, initProgress } = await import('../lib/provisioner.js');
  const { mockRegistrar, mockDns, mockMailboxVendor } = await import('../lib/providers/mock.js');
  const store = newStore(), seen = [];
  const order = makeOrder({ domains: [{ name: 'getx.com', mailboxes: [{ firstName: 'A', lastName: 'B', emailPrefix: 'a' }] }] });
  initProgress(order);
  await provision(order, { providers: { registrar: mockRegistrar, dns: mockDns, vendor: mockMailboxVendor }, store, notify: (t) => seen.push(t) });
  assert.deepEqual(seen, ['order_ready']);
  const failing = makeOrder({ id: 'ord_f', domains: [{ name: 'getx.com', mailboxes: [{ firstName: 'A', lastName: 'B', emailPrefix: 'a' }] }] });
  initProgress(failing);
  const bad = { registrar: { register: async () => { throw new Error('boom'); } }, dns: mockDns, vendor: mockMailboxVendor };
  process.env.RETRY_BASE_MS = '1';
  await provision(failing, { providers: bad, store, notify: (t) => seen.push(t) });
  assert.deepEqual(seen, ['order_ready', 'order_delayed']);
});

/* ---------------- alerts ---------------- */
test('alerts: a new problem alerts once, repeats only after the interval, and "resolved" is announced', async () => {
  const store = newStore();
  const sent = [], clock = { t: 0 };
  const alerter = createAlerter({ store, sinks: [{ name: 't', send: async (x) => sent.push(x) }], adminUrl: 'https://app.test', repeatMs: 1000, now: () => clock.t, log: silent });
  store.putOrder({ id: 'o1', status: 'partial_failure', domains: [], progress: [] });
  assert.deepEqual(await alerter.scan(), { fresh: 1, repeats: 0, resolved: 0 });
  assert.match(sent[0], /NEW \(1\)[\s\S]*\[o1\] Provisioning failed[\s\S]*https:\/\/app\.test\/admin\.html/);
  assert.deepEqual(await alerter.scan(), { fresh: 0, repeats: 0, resolved: 0 }, 'no spam while it persists');
  clock.t += 1001;
  assert.deepEqual(await alerter.scan(), { fresh: 0, repeats: 1, resolved: 0 });
  store.putOrder({ id: 'o1', status: 'completed', domains: [], progress: [] });
  assert.deepEqual(await alerter.scan(), { fresh: 0, repeats: 0, resolved: 1 });
  assert.match(sent.at(-1), /RESOLVED/);
  assert.deepEqual(store.listAlerts(), {});
});

test('alerts: a broken sink does not stop the others, and the Slack sink never leaks its URL', async () => {
  const store = newStore(), got = [];
  const alerter = createAlerter({ store, sinks: [{ name: 'bad', send: async () => { throw new Error('nope'); } }, { name: 'ok', send: async (x) => got.push(x) }], log: silent });
  store.putOrder({ id: 'o1', status: 'partial_failure', domains: [], progress: [] });
  await alerter.scan();
  assert.equal(got.length, 1);
  const slack = createSlackSink('https://hooks.slack.com/services/T000/B000/SECRETPART', async () => ({ ok: false, status: 500 }));
  await assert.rejects(() => slack.send('x'), (e) => /500/.test(e.message) && !e.message.includes('SECRETPART'));
});

test('problems: every kind of trouble is detected with a stable code', () => {
  const p = orderProblems({ status: 'partial_failure', billing: { status: 'past_due', needsAttention: 'Vendor removal failed', planError: 'pending', domainRenewals: [{ status: 'failed', domain: 'a.com', cycle: 5, error: 'down' }, { status: 'done', domain: 'b.com', cycle: 5 }] } });
  assert.deepEqual(p.map((x) => x.code).sort(), ['billing_past_due', 'needs_attention', 'plan_change_failing', 'provisioning_failed', 'renewal_failed:a.com:5']);
  assert.deepEqual(orderProblems({ status: 'completed', billing: { status: 'active', domainRenewals: [] } }), []);
});
