import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRazorpayPayments } from '../lib/providers/razorpay.js';
import { createCheckoutService } from '../lib/checkout.js';
import { toMinor } from '../lib/money.js';
import { Store } from '../lib/store.js';
import { mockRegistrar, mockDns, mockMailboxVendor } from '../lib/providers/mock.js';

// This file covers the one-off payment path. With a gateway that supports subscriptions checkout
// uses those by default (see billing.test.js), so pin the mode here. Each test file runs in its own process.
process.env.BILLING_MODE = 'one_time';

const hmac = (key, msg) => createHmac('sha256', key).update(msg).digest('hex');
const SECRET = 'KEYSECRET', WH = 'WHSECRET';

/** Simulated Razorpay account. */
function fakeRazorpay(init = {}) {
  const st = { orders: {}, payments: {}, calls: [], down: false, ...init };
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const m = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    st.calls.push({ m, path: u.pathname, body, headers: init.headers });
    const out = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
    if (st.down) return out({ error: { code: 'SERVER_ERROR', description: 'boom' } }, 500);
    if (m === 'POST' && u.pathname === '/v1/orders') {
      const id = 'order_' + (Object.keys(st.orders).length + 1);
      st.orders[id] = { id, amount: st.orderAmountOverride ?? body.amount, currency: body.currency, receipt: body.receipt, status: 'created' };
      return out(st.orders[id]);
    }
    let mm = u.pathname.match(/^\/v1\/payments\/([\w]+)$/);
    if (m === 'GET' && mm) return st.payments[mm[1]] ? out(st.payments[mm[1]]) : out({ error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } }, 400);
    mm = u.pathname.match(/^\/v1\/payments\/([\w]+)\/capture$/);
    if (m === 'POST' && mm) { st.payments[mm[1]].status = 'captured'; return out(st.payments[mm[1]]); }
    if (m === 'POST' && /\/refund$/.test(u.pathname)) return out({ id: 'rfnd_1', status: 'pending', speed_processed: 'normal' });
    return out({ error: { code: 'BAD_REQUEST_ERROR', description: 'unknown route' } }, 404);
  };
  return { f, st };
}
const rzWith = (f) => createRazorpayPayments({ keyId: 'rzp_test_abc', keySecret: SECRET, webhookSecret: WH, fetchImpl: f });
const pay = (id, orderId, over = {}) => ({ id, order_id: orderId, amount: 4991, currency: 'USD', status: 'captured', ...over });

/* ---------------- money ---------------- */
test('money: minor units for 2-, 0- and 3-decimal currencies, no float drift', () => {
  assert.equal(toMinor(49.91, 'USD'), 4991);
  assert.equal(toMinor(0.1 + 0.2, 'USD'), 30);
  assert.equal(toMinor(295, 'JPY'), 295);
  assert.equal(toMinor(99.991, 'KWD'), 99990);
  assert.equal(toMinor(1129.99, 'inr'), 112999);
});

/* ---------------- Razorpay adapter ---------------- */
test('razorpay: createCheckout posts an integer-minor-unit order with Basic auth', async () => {
  const { f, st } = fakeRazorpay();
  const r = await rzWith(f).createCheckout({ amount: 49.91, currency: 'USD', receipt: 'chk_1', notes: { checkout_id: 'chk_1' }, customer: { name: 'A B', email: 'a@b.co', contact: '+919800000000' } });
  const c = st.calls[0];
  assert.equal(c.headers.Authorization, 'Basic ' + Buffer.from('rzp_test_abc:KEYSECRET').toString('base64'));
  assert.deepEqual(c.body, { amount: 4991, currency: 'USD', receipt: 'chk_1', notes: { checkout_id: 'chk_1' } });
  assert.equal(r.mode, 'razorpay');
  assert.equal(r.gatewayOrderId, 'order_1');
  assert.equal(r.client.key, 'rzp_test_abc');
  assert.ok(!JSON.stringify(r).includes(SECRET), 'secret must never reach the browser config');
});

test('razorpay: createCheckout rejects tiny amounts, bad receipts and a mismatched gateway amount', async () => {
  const { f } = fakeRazorpay();
  await assert.rejects(() => rzWith(f).createCheckout({ amount: 0.5, currency: 'USD', receipt: 'x' }), /minimum/);
  await assert.rejects(() => rzWith(f).createCheckout({ amount: 5, currency: 'USD', receipt: 'x'.repeat(41) }), /receipt/);
  const bad = fakeRazorpay({ orderAmountOverride: 1 });
  await assert.rejects(() => rzWith(bad.f).createCheckout({ amount: 5, currency: 'USD', receipt: 'ok' }), /mismatch/);
});

test('razorpay: confirm accepts a valid signature + captured payment of the right amount', async () => {
  const { f, st } = fakeRazorpay({ payments: { pay_1: pay('pay_1', 'order_1') } });
  const r = await rzWith(f).confirm({ gatewayOrderId: 'order_1', paymentId: 'pay_1', signature: hmac(SECRET, 'order_1|pay_1'), amountMinor: 4991, currency: 'USD' });
  assert.deepEqual(r, { paymentId: 'pay_1', status: 'succeeded', amountMinor: 4991, currency: 'USD' });
  assert.equal(st.calls.filter((c) => c.path.endsWith('/capture')).length, 0);
});

test('razorpay: a signature made for a different order is rejected before any gateway call', async () => {
  const { f, st } = fakeRazorpay({ payments: { pay_1: pay('pay_1', 'order_1') } });
  await assert.rejects(
    () => rzWith(f).confirm({ gatewayOrderId: 'order_1', paymentId: 'pay_1', signature: hmac(SECRET, 'order_999|pay_1'), amountMinor: 4991, currency: 'USD' }),
    (e) => e.status === 400 && e.expose === true
  );
  await assert.rejects(() => rzWith(f).confirm({ gatewayOrderId: 'order_1', paymentId: 'pay_1', signature: 'zz', amountMinor: 4991, currency: 'USD' }), /verification failed/);
  assert.equal(st.calls.length, 0);
});

test('razorpay: confirm rejects amount/order mismatch and unpaid payments, captures authorized ones', async () => {
  const sig = (p) => hmac(SECRET, `order_1|${p}`);
  const args = (p) => ({ gatewayOrderId: 'order_1', paymentId: p, signature: sig(p), amountMinor: 4991, currency: 'USD' });

  let { f } = fakeRazorpay({ payments: { p1: pay('p1', 'order_1', { amount: 100 }) } });
  await assert.rejects(() => rzWith(f).confirm(args('p1')), (e) => e.status === 409);
  ({ f } = fakeRazorpay({ payments: { p2: pay('p2', 'order_other') } }));
  await assert.rejects(() => rzWith(f).confirm(args('p2')), (e) => e.status === 409);
  ({ f } = fakeRazorpay({ payments: { p3: pay('p3', 'order_1', { status: 'failed' }) } }));
  await assert.rejects(() => rzWith(f).confirm(args('p3')), (e) => e.status === 402);

  const auth = fakeRazorpay({ payments: { p4: pay('p4', 'order_1', { status: 'authorized' }) } });
  const r = await rzWith(auth.f).confirm(args('p4'));
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(auth.st.calls.find((c) => c.path.endsWith('/capture')).body, { amount: 4991, currency: 'USD' });
});

test('razorpay: a gateway outage during confirm is a retryable 502 that leaks nothing', async () => {
  const { f } = fakeRazorpay({ down: true });
  await assert.rejects(
    () => rzWith(f).confirm({ gatewayOrderId: 'order_1', paymentId: 'pay_1', signature: hmac(SECRET, 'order_1|pay_1'), amountMinor: 4991, currency: 'USD' }),
    (e) => e.status === 502 && e.expose && !/razorpay|boom|SERVER_ERROR/i.test(e.message)
  );
});

test('razorpay: webhook signature is HMAC of the RAW body with the webhook secret', () => {
  const rz = rzWith(fakeRazorpay().f);
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 4991, currency: 'USD', status: 'captured' } } } }));
  const ok = rz.verifyWebhook(raw, { 'x-razorpay-signature': hmac(WH, raw), 'x-razorpay-event-id': 'evt_1' });
  assert.equal(ok.type, 'payment.captured');
  assert.equal(ok.id, 'evt_1');
  assert.equal(ok.payment.order_id, 'order_1');
  assert.throws(() => rz.verifyWebhook(raw, { 'x-razorpay-signature': hmac(SECRET, raw) }), /Invalid signature/);   // key secret is not the webhook secret
  assert.throws(() => rz.verifyWebhook(Buffer.from(raw.toString() + ' '), { 'x-razorpay-signature': hmac(WH, raw) }), /Invalid signature/); // tampered body
  assert.throws(() => rz.verifyWebhook(raw, {}), /Invalid signature/);
  const noSecret = createRazorpayPayments({ keyId: 'k', keySecret: 's', fetchImpl: fakeRazorpay().f });
  assert.throws(() => noSecret.verifyWebhook(raw, { 'x-razorpay-signature': 'x' }), (e) => e.status === 503);
});

test('razorpay: refund uses minor units, idempotency header, and validates the key', async () => {
  const { f, st } = fakeRazorpay();
  const r = await rzWith(f).refund({ paymentId: 'pay_1', amount: 12.5, currency: 'USD', idempotencyKey: 'ord_abc-r1-1250', reason: 'vendor outage' });
  const c = st.calls[0];
  assert.equal(c.path, '/v1/payments/pay_1/refund');
  assert.equal(c.body.amount, 1250);
  assert.equal(c.body.speed, 'normal');
  assert.equal(c.headers['X-Refund-Idempotency'], 'ord_abc-r1-1250');
  assert.deepEqual(r, { id: 'rfnd_1', status: 'pending', speed: 'normal' });
  await assert.rejects(() => rzWith(f).refund({ paymentId: 'p', amount: 1, currency: 'USD', idempotencyKey: 'short' }), /idempotencyKey/);
});

/* ---------------- Checkout service (real Store + real adapter + mock fulfilment) ---------------- */
const silent = { error() {} };
async function freeDomain(tag) {
  for (let i = 0; i < 50; i++) {
    const d = `${tag}${i}.com`;
    if ((await mockRegistrar.checkAvailability([d]))[0].available) return d;
  }
  throw new Error('no free mock domain');
}
const contact = { firstName: 'Asha', lastName: 'Rao', company: 'Co', email: 'asha@co.in', address: '12 MG Road', country: 'in', state: 'MH', city: 'Nagpur', zip: '440001', phoneCc: '91', phone: '9800000000' };
const body = (domain, extra = {}) => ({
  provider: 'google', plan: 'quarterly', acceptedTerms: true, contact, ...extra,
  domains: [{ name: domain, mailboxes: [{ firstName: 'A', lastName: 'B', emailPrefix: 'a.b' }] }]
});
function setup() {
  const rzf = fakeRazorpay();
  const rz = rzWith(rzf.f);
  const store = new Store(join(tmpdir(), `cl-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`));
  const svc = createCheckoutService({ store, providers: { registrar: mockRegistrar, dns: mockDns, vendor: mockMailboxVendor, payments: rz }, log: silent });
  return { ...rzf, rz, store, svc };
}
const hook = (event, payment, id) => {
  const raw = Buffer.from(JSON.stringify({ event, payload: { payment: { entity: payment } } }));
  return [raw, { 'x-razorpay-signature': hmac(WH, raw), 'x-razorpay-event-id': id }];
};

test('checkout: the server prices the cart; client-supplied amounts are ignored', async () => {
  const { svc, store, st } = setup();
  const d = await freeDomain('price');
  const co = await svc.create(body(d, { amount: 1, total: 1, quote: { total: 1 } }));
  assert.equal(co.quote.total, 25.97);                       // $14 domain + 1 mailbox x $3.99 x 3
  assert.equal(co.payment.amountMinor, 2597);
  assert.equal(st.calls[0].body.amount, 2597);
  assert.equal(store.getCheckout(co.checkoutId).cart.domains[0].name, d);
});

test('checkout: invalid input is rejected before any gateway order exists', async () => {
  const { svc, st } = setup();
  const d = await freeDomain('bad');
  await assert.rejects(() => svc.create(body(d, { acceptedTerms: false })), (e) => e.status === 400 && e.expose);
  await assert.rejects(() => svc.create(body(d, { contact: { ...contact, email: 'nope' } })), /email/);
  assert.equal(st.calls.length, 0);
});

test('checkout: the same idempotency key returns the same checkout and one gateway order', async () => {
  const { svc, st } = setup();
  const d = await freeDomain('idem');
  const a = await svc.create(body(d, { idempotencyKey: 'k-1' }));
  const b = await svc.create(body(d, { idempotencyKey: 'k-1' }));
  assert.equal(a.checkoutId, b.checkoutId);
  assert.equal(st.calls.filter((c) => c.path === '/v1/orders').length, 1);
});

test('checkout: a gateway failure while starting payment is a generic 502', async () => {
  const { svc, st } = setup();
  st.down = true;
  const d = await freeDomain('down');
  await assert.rejects(() => svc.create(body(d)), (e) => e.status === 502 && !/razorpay/i.test(e.message));
});

test('checkout: confirm creates exactly one order, even when confirmed twice', async () => {
  const { svc, store, st } = setup();
  const co = await svc.create(body(await freeDomain('conf')));
  st.payments.pay_1 = pay('pay_1', co.payment.orderId, { amount: co.payment.amountMinor });
  const proof = { paymentId: 'pay_1', signature: hmac(SECRET, `${co.payment.orderId}|pay_1`) };
  const o1 = await svc.confirm(co.checkoutId, proof);
  const o2 = await svc.confirm(co.checkoutId, proof);
  assert.equal(o1.id, o2.id);
  assert.equal(Object.keys(store.data.orders).length, 1);
  assert.equal(store.getOrder(o1.id).paymentId, 'pay_1');
  assert.equal(svc.status(co.checkoutId).order.id, o1.id);
  assert.ok(!('internalMargin' in o1), 'customer view hides margins');
});

test('checkout: a forged confirm never creates an order', async () => {
  const { svc, store } = setup();
  const co = await svc.create(body(await freeDomain('forge')));
  await assert.rejects(() => svc.confirm(co.checkoutId, { paymentId: 'pay_x', signature: 'deadbeef' }), (e) => e.status === 400);
  assert.equal(Object.keys(store.data.orders).length, 0);
  await assert.rejects(() => svc.confirm('chk_missing', {}), (e) => e.status === 404);
});

test('webhook fulfils the order when the browser never confirms, and confirm afterwards is a no-op', async () => {
  const { svc, store } = setup();
  const co = await svc.create(body(await freeDomain('hook')));
  const p = pay('pay_9', co.payment.orderId, { amount: co.payment.amountMinor });
  const r = svc.handleWebhook(...hook('payment.captured', p, 'evt_1'));
  assert.deepEqual(r, { handled: true });
  assert.equal(Object.keys(store.data.orders).length, 1);
  // Razorpay retries / sends order.paid too: must not create a second order.
  assert.deepEqual(svc.handleWebhook(...hook('payment.captured', p, 'evt_1')), { handled: false, reason: 'duplicate' });
  assert.equal(svc.handleWebhook(...hook('order.paid', p, 'evt_2')).handled, true);
  assert.equal(Object.keys(store.data.orders).length, 1);
  assert.equal(svc.status(co.checkoutId).status, 'paid');
});

test('webhook: amount mismatch, unknown order and bad signature create nothing', async () => {
  const { svc, store } = setup();
  const co = await svc.create(body(await freeDomain('mism')));
  const wrong = svc.handleWebhook(...hook('payment.captured', pay('pay_a', co.payment.orderId, { amount: 1 }), 'evt_a'));
  assert.equal(wrong.handled, false);
  assert.match(wrong.reason, /does not match/);
  assert.equal(svc.handleWebhook(...hook('payment.captured', pay('pay_b', 'order_nope'), 'evt_b')).reason, 'unknown order');
  assert.equal(svc.handleWebhook(...hook('payment.failed', pay('pay_c', co.payment.orderId, { status: 'failed' }), 'evt_c')).handled, false);
  const [raw] = hook('payment.captured', pay('pay_d', co.payment.orderId), 'evt_d');
  assert.throws(() => svc.handleWebhook(raw, { 'x-razorpay-signature': 'bad' }), (e) => e.status === 400 && e.expose);
  assert.equal(Object.keys(store.data.orders).length, 0);
});

test('webhooks are unavailable on a gateway without webhook support', () => {
  const store = new Store(join(tmpdir(), `cl-test-${Date.now()}-nohook.json`));
  const svc = createCheckoutService({ store, providers: { payments: {} }, log: silent });
  assert.throws(() => svc.handleWebhook(Buffer.from('{}'), {}), (e) => e.status === 404);
});
