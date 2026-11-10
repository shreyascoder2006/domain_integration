import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { seal } from '../lib/crypto.js';
import { createEngineApi } from '../lib/engine.js';
import { buildReceipts, sellerFromEnv } from '../lib/receipts.js';
import { buildSchedule, amountForCycle } from '../lib/billing.js';
import { createAbuseGuard } from '../lib/abuse.js';
import { createHttpCounters, renderMetrics } from '../lib/metrics.js';
import { createLogger, redact } from '../lib/log.js';
import { generateCandidates, suggestDomains } from '../lib/domainSuggest.js';
import { quote } from '../lib/pricing.js';
import { mockPayments } from '../lib/providers/mock.js';

const newStore = () => new Store(join(tmpdir(), `cl-feat-${Date.now()}-${Math.random().toString(16).slice(2)}.json`));
const box = (n) => Array.from({ length: n }, (_, i) => ({ firstName: 'A', lastName: 'B', emailPrefix: 'a' + i }));

/* ---------------- Engine API ---------------- */
function engineHarness() {
  const store = newStore();
  store.addMailboxes([
    { email: 'a@x.com', orderId: 'o1', userId: 'u1', provider: 'google', status: 'ready_for_warmup', smtp: { host: 'smtp.gmail.com', port: 587 }, credentialsEnc: seal({ username: 'a@x.com', appPassword: 'app-pass-1' }) },
    { email: 'b@x.com', orderId: 'o2', userId: 'u2', provider: 'google', status: 'ready_for_warmup', credentialsEnc: seal({ username: 'b@x.com', password: 'pw' }) }
  ]);
  return { store, engine: createEngineApi({ store }) };
}

test('engine: lists mailboxes with a sendable flag; suspended ones drop out of ?sendable', () => {
  const { store, engine } = engineHarness();
  assert.equal(engine.listMailboxes().length, 2);
  assert.deepEqual(engine.listMailboxes({ orderId: 'o1' }).map((m) => m.email), ['a@x.com']);
  assert.deepEqual(engine.listMailboxes({ userId: 'u2' }).map((m) => m.email), ['b@x.com']);
  store.suspendMailboxes('o1', 'non_payment');
  assert.deepEqual(engine.listMailboxes({ sendable: true }).map((m) => m.email), ['b@x.com']);
  const a = engine.listMailboxes().find((m) => m.email === 'a@x.com');
  assert.deepEqual([a.sendable, a.suspended, a.suspendedReason], [false, true, 'non_payment']);
  assert.ok(!('credentialsEnc' in a), 'the listing never carries credentials');
});

test('engine: credentials are decrypted for ONE mailbox and refused while it is suspended', () => {
  const { store, engine } = engineHarness();
  const id = engine.listMailboxes()[0].id;
  const c = engine.getCredentials(id);
  assert.deepEqual(c.credentials, { username: 'a@x.com', appPassword: 'app-pass-1' });
  assert.deepEqual(c.smtp, { host: 'smtp.gmail.com', port: 587 });
  store.suspendMailboxes('o1', 'non_payment');
  assert.throws(() => engine.getCredentials(id), (e) => e.status === 409 && /suspended/.test(e.message));
  assert.throws(() => engine.getCredentials('mbx_nope'), (e) => e.status === 404);
});

test('engine: the engine reports warm-up state back, validated and durable', () => {
  const { store, engine } = engineHarness();
  const id = engine.listMailboxes()[0].id;
  const v = engine.setState(id, { warmup: 'warming', note: 'day 3'.repeat(100) });
  assert.equal(v.warmup, 'warming');
  assert.equal(store.getMailbox(id).engineNote.length, 200);
  assert.throws(() => engine.setState(id, { warmup: 'sending-spam' }), (e) => e.status === 400);
  assert.throws(() => engine.setState('mbx_nope', { warmup: 'ready' }), (e) => e.status === 404);
});

/* ---------------- Receipts ---------------- */
function receiptOrder() {
  const q = quote({ provider: 'google', plan: 'quarterly', domains: ['getx.com', 'getx2.com'], mailboxes: box(4) });
  const schedule = buildSchedule(q);
  return {
    id: 'ord_1', createdAt: '2026-01-01T00:00:00.000Z', paymentId: 'pay_1', quote: q,
    contact: { firstName: 'Asha', lastName: 'Rao', company: 'Co', email: 'asha@co.in' },
    domains: [{ name: 'getx.com', mailboxes: box(2) }, { name: 'getx2.com', mailboxes: box(2) }],
    billing: { schedule, processedCycles: [1, 2, 5], history: [{ event: 'charged', detail: 'cycle 2', at: '2026-04-01T00:00:00.000Z' }, { event: 'charged', detail: 'cycle 5', at: '2027-01-01T00:00:00.000Z' }] },
    refunds: [{ id: 're_1', amount: 5, status: 'processed', reason: 'goodwill', at: '2026-02-01T00:00:00.000Z' }, { id: 're_2', amount: 9, status: 'failed' }]
  };
}

test('receipts: one per paid cycle; the domain line appears only in cycles 1 and 5; totals match what was charged', () => {
  const o = receiptOrder();
  const r = buildReceipts(o, sellerFromEnv({ INVOICE_SELLER_NAME: 'Acme Ltd', INVOICE_TAX_ID: 'GST123', INVOICE_TAX_LABEL: 'GSTIN' }));
  assert.deepEqual(r.map((x) => x.cycle), [1, 2, 5]);
  const has = (rec) => rec.items.some((i) => /Domain/.test(i.description));
  assert.deepEqual(r.map(has), [true, false, true]);
  assert.deepEqual(r.map((x) => x.total), [1, 2, 5].map((c) => amountForCycle(c, o.billing.schedule)));
  assert.equal(r[0].total, o.quote.total, 'the first receipt equals what the customer paid at checkout');
  assert.equal(r[0].date, o.createdAt);
  assert.equal(r[1].date, '2026-04-01T00:00:00.000Z');
  assert.equal(r[0].paymentId, 'pay_1');
  assert.equal(r[0].billTo.email, 'asha@co.in');
  assert.deepEqual([r[0].seller.name, r[0].seller.taxLabel, r[0].seller.taxId], ['Acme Ltd', 'GSTIN', 'GST123']);
  assert.deepEqual(r.credits.map((c) => [c.amount, c.reason]), [[5, 'goodwill']], 'failed refunds are not credits');
});

test('receipts: a one-off order has a single receipt; seller defaults are safe', () => {
  const o = receiptOrder(); delete o.billing;
  const r = buildReceipts(o, sellerFromEnv({}));
  assert.equal(r.length, 1);
  assert.equal(r[0].total, o.quote.total);
  assert.deepEqual([r[0].seller.title, r[0].seller.taxId], ['Receipt', '']);
});

/* ---------------- Abuse guard ---------------- */
function abuseHarness(env = {}) {
  const store = newStore();
  const clock = { t: Date.UTC(2026, 5, 1) };
  return { store, clock, guard: createAbuseGuard({ store, env, now: () => clock.t }) };
}
const ok = { email: 'asha@acme.co', ip: '1.2.3.4', domains: ['getacme.com'] };
const addCheckout = (store, clock, over = {}) => store.putCheckout({ id: 'c' + Math.random().toString(16).slice(2), status: 'awaiting_payment', createdAt: new Date(clock.t - 60_000).toISOString(), contact: { email: ok.email }, cart: { domains: [{}] }, ipHash: null, ...over });

test('abuse: disposable email addresses are refused; normal ones pass', () => {
  const { guard } = abuseHarness();
  assert.doesNotThrow(() => guard.check(ok));
  assert.throws(() => guard.check({ ...ok, email: 'x@mailinator.com' }), (e) => e.status === 400 && /permanent email/.test(e.message));
  assert.throws(() => abuseHarness({ ABUSE_DISPOSABLE_DOMAINS: 'tmp.example' }).guard.check({ ...ok, email: 'x@tmp.example' }), /permanent email/);
});

test('abuse: phishing-style brand names are blocked, with an allowlist and no hint about which rule fired', () => {
  const { guard } = abuseHarness({ ABUSE_ALLOW_DOMAINS: 'pineapplecorp.com' });
  assert.equal(guard.isBlockedName('paypal-secure.com'), true);
  assert.equal(guard.isBlockedName('getgooglehelp.com'), true);
  assert.equal(guard.isBlockedName('getacme.com'), false);
  assert.throws(() => guard.check({ ...ok, domains: ['paypal-login.com'] }), (e) => e.status === 400 && !/paypal/i.test(e.message));
  assert.equal(abuseHarness({ ABUSE_BLOCK_TERMS: 'acme' }).guard.isBlockedName('getacme.com'), true);
  assert.equal(guard.isBlockedName('pineapplecorp.com'), false, 'allowlist overrides');
});

test('abuse: caps domains per order, unfinished checkouts per email, and checkouts per network', () => {
  const { guard, store, clock } = abuseHarness({ MAX_DOMAINS_PER_ORDER: '3' });
  assert.throws(() => guard.check({ ...ok, domains: ['a.com', 'b.com', 'c.com', 'd.com'] }), /at most 3 domains/);
  for (let i = 0; i < 3; i++) addCheckout(store, clock);
  assert.throws(() => guard.check(ok), (e) => e.status === 429 && e.retryAfter > 0 && /unfinished/.test(e.message));
  assert.doesNotThrow(() => guard.check({ ...ok, email: 'someone@else.co' }), 'other customers are unaffected');
  const g2 = abuseHarness();
  for (let i = 0; i < 20; i++) addCheckout(g2.store, g2.clock, { status: 'paid', contact: { email: `u${i}@x.co` }, ipHash: g2.guard.ipHash('9.9.9.9') });
  assert.throws(() => g2.guard.check({ ...ok, ip: '9.9.9.9' }), (e) => e.status === 429 && /network/.test(e.message));
  assert.doesNotThrow(() => g2.guard.check({ ...ok, ip: '8.8.8.8' }));
});

test('abuse: the daily domain cap protects the registrar balance and reports what happened', () => {
  const { guard, store, clock } = abuseHarness({ DAILY_DOMAIN_CAP: '5' });
  for (let i = 0; i < 4; i++) addCheckout(store, clock, { status: 'paid', contact: { email: `u${i}@x.co` } });
  assert.doesNotThrow(() => guard.check({ ...ok, domains: ['a.com'] }));
  try { guard.check({ ...ok, domains: ['a.com', 'b.com'] }); assert.fail('should refuse'); } catch (e) {
    assert.equal(e.status, 503);
    assert.deepEqual(e.capacity, { reserved: 6, cap: 5 });
  }
  clock.t += 25 * 3_600_000;
  assert.doesNotThrow(() => guard.check({ ...ok, domains: ['a.com', 'b.com'] }), 'the window rolls');
});

test('domain suggestions: many more candidates, and blocked names are never even checked at the registrar', async () => {
  const c = generateCandidates('acme');
  assert.ok(c.length >= 60 && new Set(c).size === c.length);
  assert.ok(c.includes('getacmehq.com'));
  const checked = [];
  const registrar = { async checkAvailability(ds) { checked.push(...ds); return ds.map((domain) => ({ domain, available: true })); } };
  const out = await suggestDomains(registrar, 'paypalish', { want: 5, isAllowed: (d) => !/paypal/.test(d) });
  assert.deepEqual(out, []);
  assert.equal(checked.length, 0);
  assert.equal((await suggestDomains(registrar, 'acme', { want: 30 })).length, 30);
});

/* ---------------- Metrics ---------------- */
test('metrics: valid Prometheus text reflecting orders, billing, steps, outbox and problems', () => {
  const store = newStore();
  store.putOrder({ id: 'o1', status: 'completed', billing: { status: 'active', domainRenewals: [] }, progress: [{ domain: 'a.com', steps: { register: { status: 'done' }, connect_domain: { status: 'waiting' } } }] });
  store.putOrder({ id: 'o2', status: 'partial_failure', billing: { status: 'past_due', domainRenewals: [] }, progress: [{ domain: 'b.com', steps: { mailboxes: { status: 'failed' } } }] });
  store.addMailboxes([{ email: 'a@a.com', status: 'ready_for_warmup', orderId: 'o1' }]);
  store.addOutbox({ id: 'e1', key: 'k', status: 'dead', error: 'x' });
  const http = createHttpCounters(); http.observe(200); http.observe(200); http.observe(404); http.observe(500);
  const text = renderMetrics({ store, http, storeName: 'json', now: http.startedAt + 5000 });
  for (const line of text.trim().split('\n').filter((l) => !l.startsWith('#'))) assert.match(line, /^[a-z_]+(\{[^}]*\})? -?[0-9.]+$/, `bad line: ${line}`);
  assert.match(text, /cl_orders\{status="completed"\} 1/);
  assert.match(text, /cl_billing\{status="past_due"\} 1/);
  assert.match(text, /cl_pipeline_steps\{status="waiting",step="connect_domain"\} 1/);
  assert.match(text, /cl_pipeline_steps\{status="failed",step="mailboxes"\} 1/);
  assert.match(text, /cl_outbox\{status="dead"\} 1/);
  assert.match(text, /cl_http_requests_total\{class="2xx"\} 2/);
  assert.match(text, /cl_open_problems 3/);                      // provisioning failed + past due + dead email
  assert.match(text, /cl_uptime_seconds 5/);
});

/* ---------------- Logger ---------------- */
test('logger: secrets are redacted at any depth, errors become messages, levels filter', () => {
  const lines = [];
  const log = createLogger({ level: 'info', format: 'json', out: (l) => lines.push(JSON.parse(l)) });
  log.info('hello', { user: 'u1', password: 'hunter2', nested: { Authorization: 'Bearer abc', ok: 1, list: [{ apiKey: 'k' }] } });
  log.debug('hidden');
  log.error('boom', new Error('db exploded'), { 'x-admin-token': 'adm', signature: 's' });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].nested, { Authorization: '[redacted]', ok: 1, list: [{ apiKey: '[redacted]' }] });
  assert.equal(lines[0].password, '[redacted]');
  assert.equal(lines[0].user, 'u1');
  assert.equal(lines[1].err, 'db exploded');
  assert.equal(lines[1]['x-admin-token'], '[redacted]');
  assert.ok(!JSON.stringify(lines).includes('hunter2') && !JSON.stringify(lines).includes('Bearer abc'));
  assert.deepEqual(redact({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }).a.b.c.d.e.f.g, '[deep]');
});

test('logger: text format is readable and child loggers carry their fields', () => {
  const lines = [];
  const log = createLogger({ level: 'info', format: 'text', out: (l) => lines.push(l) }).child({ order: 'o1' });
  log.warn('careful', { n: 2 });
  assert.match(lines[0], /WARN\s+careful \{"order":"o1","n":2\}/);
});

/* ---------------- Mock webhooks (used by the simulator) ---------------- */
test('mock gateway webhooks use the same HMAC scheme as Razorpay', () => {
  const raw = Buffer.from(JSON.stringify({ event: 'subscription.halted', payload: { subscription: { entity: { id: 'sub_1' } } } }));
  const sig = createHmac('sha256', 'mock-webhook-secret').update(raw).digest('hex');
  const ev = mockPayments.verifyWebhook(raw, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'e1' });
  assert.equal(ev.type, 'subscription.halted');
  assert.equal(ev.subscription.id, 'sub_1');
  assert.throws(() => mockPayments.verifyWebhook(raw, { 'x-razorpay-signature': 'bad' }), (e) => e.status === 400);
});

/* ---------------- Replay protection and keyed IP hashing ---------------- */
import { createCheckoutService } from '../lib/checkout.js';
import { createHash } from 'node:crypto';
import { mockRegistrar, mockDns, mockMailboxVendor } from '../lib/providers/mock.js';

test('webhooks: an old signed event cannot be replayed to suspend a paying customer', async () => {
  const store = newStore();
  const svc = createCheckoutService({ store, providers: { registrar: mockRegistrar, dns: mockDns, vendor: mockMailboxVendor, payments: mockPayments }, log: { error() {}, warn() {}, info() {} } });
  const checkoutBody = { provider: 'google', plan: 'quarterly', acceptedTerms: true,
    contact: { firstName: 'A', lastName: 'B', company: 'C', email: 'a@acme.co', address: '1', country: 'IN', state: 'MH', city: 'N', zip: '1', phoneCc: '91', phone: '9800000000' },
    domains: [{ name: 'getreplaytest9.com', mailboxes: [{ firstName: 'A', lastName: 'B', emailPrefix: 'a' }] }] };
  let co;
  for (const name of ['getreplaytest9.com', 'getreplaytest8.com', 'getreplaytest7.com', 'getreplaytest6.com']) {
    try { co = await svc.create({ ...checkoutBody, domains: [{ ...checkoutBody.domains[0], name }] }); break; } catch { /* mock marks ~1 in 5 names taken */ }
  }
  const order = await svc.confirm(co.checkoutId, { paymentId: 'pay_mock_replay' });
  const o = store.getOrder(order.id);
  const send = (event, createdAt) => {
    const raw = Buffer.from(JSON.stringify({ event, created_at: createdAt, payload: { subscription: { entity: { id: o.billing.subscriptionId, paid_count: 1 } } } }));
    return svc.handleWebhook(raw, { 'x-razorpay-signature': createHmac('sha256', 'mock-webhook-secret').update(raw).digest('hex') });
  };
  const nowSec = Math.floor(Date.now() / 1000);
  assert.deepEqual(send('subscription.halted', nowSec - 3 * 86_400), { handled: false, reason: 'stale' });
  assert.equal(o.billing.status, 'active', 'the replayed event changed nothing');
  assert.equal(send('subscription.halted', nowSec - 600).handled, true, 'a fresh event is processed normally');
  assert.equal(o.billing.status, 'past_due');
  assert.equal(send('subscription.pending', null).handled, true, 'events without a timestamp are still handled (the event id de-duplicates them)');
});

test('abuse: IP hashes are keyed, so they cannot be reversed by hashing every IPv4 address', () => {
  const store = newStore();
  const a = createAbuseGuard({ store, env: { ABUSE_SALT: 'salt-a' } }).ipHash('1.2.3.4');
  const b = createAbuseGuard({ store, env: { ABUSE_SALT: 'salt-b' } }).ipHash('1.2.3.4');
  assert.notEqual(a, b);
  assert.notEqual(a, createHash('sha256').update('1.2.3.4').digest('hex').slice(0, 24), 'not a bare SHA-256');
  assert.equal(a, createAbuseGuard({ store, env: { ABUSE_SALT: 'salt-a' } }).ipHash('1.2.3.4'), 'stable for the same key');
});
