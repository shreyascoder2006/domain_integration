import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Store } from '../lib/store.js';
import { createRateLimiter, clientKey } from '../lib/ratelimit.js';
import { checkEnv } from '../lib/startup.js';
import { createZapmailVendor } from '../lib/providers/zapmail.js';
import { createVendorWebhookHandler, domainOf } from '../lib/vendorHooks.js';
import { wakeWaiting, publicOrder } from '../lib/provisioner.js';

const tmp = (name) => join(tmpdir(), `cl-ops-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}.json`);

/* ---------------- Store safety ---------------- */
test('store: a corrupt data file stops startup, keeps a copy, and is never overwritten with an empty database', () => {
  const file = tmp('corrupt');
  writeFileSync(file, '{"orders": {"ord_1": {"id": "ord_1"');            // truncated JSON
  assert.throws(() => new Store(file), /unreadable.*copy was kept/s);
  assert.match(readFileSync(file, 'utf8'), /ord_1/, 'the original must be untouched');
  const kept = readdirSync(tmpdir()).filter((f) => f.startsWith(file.split(/[\\/]/).pop() + '.corrupt-'));
  assert.equal(kept.length, 1);
});

test('store: writes are atomic (no temp files left), keep a .bak, and survive a reload', () => {
  const file = tmp('atomic');
  const s = new Store(file);
  s.putOrder({ id: 'ord_a', n: 1 });
  s.putOrder({ id: 'ord_a', n: 2 });
  const base = file.split(/[\\/]/).pop();
  assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith(base) && f.includes('.tmp-')), []);
  assert.equal(JSON.parse(readFileSync(file + '.bak', 'utf8')).orders.ord_a.n, 1, 'the previous good copy is kept');
  assert.equal(new Store(file).getOrder('ord_a').n, 2);
});

test('store: stale unpaid checkouts are purged, paid ones are not', () => {
  const s = new Store(tmp('purge'));
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  s.putCheckout({ id: 'chk_old', status: 'awaiting_payment', createdAt: old });
  s.putCheckout({ id: 'chk_paid', status: 'paid', createdAt: old });
  s.putCheckout({ id: 'chk_new', status: 'awaiting_payment', createdAt: new Date().toISOString() });
  assert.equal(s.purgeStaleCheckouts(14 * 86_400_000), 1);
  assert.deepEqual(Object.keys(s.data.checkouts).sort(), ['chk_new', 'chk_paid']);
});

/* ---------------- Rate limiting ---------------- */
test('rate limiter: blocks over the limit, reports retry time, recovers after the window', () => {
  const clock = { t: 0 };
  const rl = createRateLimiter({ windowMs: 60_000, max: 3, now: () => clock.t });
  assert.deepEqual([1, 2, 3].map(() => rl.take('a').ok), [true, true, true]);
  const blocked = rl.take('a');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
  assert.equal(rl.take('b').ok, true, 'other clients are unaffected');
  clock.t += 60_001;
  assert.equal(rl.take('a').ok, true);
});

test('rate limiter: peek checks a lockout without counting, reset clears it, memory is bounded', () => {
  const clock = { t: 0 };
  const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => clock.t, maxKeys: 5 });
  assert.equal(rl.peek('x'), true);
  rl.take('x'); rl.take('x');
  assert.equal(rl.peek('x'), false);
  rl.reset('x');
  assert.equal(rl.peek('x'), true);
  for (let i = 0; i < 50; i++) rl.take('k' + i);
  assert.ok(rl.size <= 5, 'an attack with many addresses cannot grow memory without bound');
});

test('clientKey: X-Forwarded-For is ignored unless a proxy is trusted, and then the last hop wins', () => {
  const req = { headers: { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }, socket: { remoteAddress: '10.0.0.5' } };
  assert.equal(clientKey(req, false), '10.0.0.5');
  assert.equal(clientKey(req, true), '9.9.9.9');
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: '10.0.0.5' } }, true), '10.0.0.5');
});

/* ---------------- Startup safety ---------------- */
test('startup: production refuses mock adapters and a missing credentials key; demos can opt in', () => {
  const prod = { NODE_ENV: 'production', ADMIN_TOKEN: 'x'.repeat(30), TRUST_PROXY: '1' };
  const r = checkEnv(prod);
  assert.ok(r.errors.some((e) => /CREDENTIALS_KEY/.test(e)));
  assert.equal(r.errors.filter((e) => /"mock" in production/.test(e)).length, 4);
  const ok = checkEnv({ ...prod, CREDENTIALS_KEY: 'k', REGISTRAR: 'namesilo', DNS_PROVIDER: 'cloudflare', MAILBOX_VENDOR: 'zapmail', PAYMENTS: 'razorpay', RAZORPAY_WEBHOOK_SECRET: 's', ZAPMAIL_WEBHOOK_SECRET: 's', ZAPMAIL_WORKSPACE_KEY: 'w', NOTIFY_PROVIDER: 'resend', PUBLIC_URL: 'https://x.test', STORE: 'sqlite' });
  assert.deepEqual(ok, { errors: [], warnings: [] });
  assert.deepEqual(checkEnv({ ...prod, CREDENTIALS_KEY: 'k', ALLOW_MOCKS: '1' }).errors, []);
  assert.ok(checkEnv({ NODE_ENV: 'production', CREDENTIALS_KEY: 'k', ALLOW_MOCKS: '1', ADMIN_TOKEN: 'short' }).errors.some((e) => /ADMIN_TOKEN/.test(e)));
});

test('startup: development stays easy; missing webhook secrets are warnings, not errors', () => {
  assert.deepEqual(checkEnv({}), { errors: [], warnings: [] });
  const r = checkEnv({ PAYMENTS: 'razorpay', MAILBOX_VENDOR: 'zapmail' });
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => /RAZORPAY_WEBHOOK_SECRET/.test(w)));
  assert.ok(r.warnings.some((w) => /ZAPMAIL_WEBHOOK_SECRET/.test(w)));
});

/* ---------------- Zapmail webhooks ---------------- */
const SECRET = 'whsec_test';
const sign = (body, t, secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const zm = () => createZapmailVendor({ apiKey: 'k', webhookSecret: SECRET, fetchImpl: async () => ({}) });

test('zapmail webhook: verifies HMAC of "t.body", enforces the 5 minute window, rejects tampering', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'mailbox.updated', created: 1, data: { mailboxDetails: { domain: 'x.com', status: 'ACTIVE' } } });
  const now = 1_800_000_000_000, t = now / 1000;
  const ev = zm().verifyWebhook(Buffer.from(body), { 'x-zapmail-signature': sign(body, t) }, now);
  assert.equal(ev.id, 'evt_1');
  assert.equal(ev.type, 'mailbox.updated');

  const bad = (h, b = body, n = now) => () => zm().verifyWebhook(Buffer.from(b), h, n);
  assert.throws(bad({ 'x-zapmail-signature': sign(body, t, 'other') }), /Invalid signature/);
  assert.throws(bad({ 'x-zapmail-signature': sign(body, t) }, body + ' '), /Invalid signature/);
  assert.throws(bad({}), /Invalid signature/);
  assert.throws(bad({ 'x-zapmail-signature': 't=abc,v1=zz' }), /Invalid signature/);
  assert.throws(bad({ 'x-zapmail-signature': sign(body, t) }, body, now + 6 * 60_000), /outside tolerance/);
  assert.throws(() => createZapmailVendor({ apiKey: 'k', fetchImpl: async () => ({}) }).verifyWebhook(Buffer.from(body), {}), (e) => e.status === 503);
});

test('vendor webhooks: extract the domain from the payloads the docs show', () => {
  assert.equal(domainOf({ mailboxDetails: { domain: 'A.com' } }), 'a.com');
  assert.equal(domainOf({ domainDetails: { domainName: 'b.com' } }), 'b.com');
  assert.equal(domainOf({ domain: 'c.com' }), 'c.com');
  assert.equal(domainOf({ foo: 1 }), null);
  assert.equal(domainOf(null), null);
});

function waitingOrder(id, domains, status = 'provisioning') {
  return {
    id, status, domains: [], progress: domains.map((d) => ({ domain: d, steps: {
      register: { status: 'done' },
      connect_domain: { status: 'waiting', nextCheckAt: Date.now() + 3_600_000, waitingSince: Date.now() }
    } }))
  };
}

test('wakeWaiting: wakes only the matching domain (or all when unknown), only for provisioning orders, never marks work done', () => {
  const s = new Store(tmp('wake'));
  s.putOrder(waitingOrder('o1', ['a.com', 'b.com']));
  s.putOrder(waitingOrder('o2', ['c.com'], 'completed'));
  assert.equal(wakeWaiting(s, 'a.com'), 1);
  const o1 = s.getOrder('o1');
  assert.equal(o1.progress[0].steps.connect_domain.nextCheckAt, 0);
  assert.ok(o1.progress[1].steps.connect_domain.nextCheckAt > Date.now(), 'b.com keeps waiting');
  assert.equal(o1.progress[0].steps.connect_domain.status, 'waiting', 'still waiting: the step must ask the vendor');
  assert.equal(wakeWaiting(s, null), 1);                                  // now wakes b.com too
  assert.equal(s.getOrder('o2').progress[0].steps.connect_domain.nextCheckAt > 0, true, 'completed orders are untouched');
  assert.equal(wakeWaiting(s, 'zzz.com'), 0);
});

test('vendor webhook handler: wakes the order, de-duplicates by event id, and triggers a resume in the background', async () => {
  const s = new Store(tmp('hook'));
  s.putOrder(waitingOrder('o1', ['a.com']));
  let resumed = 0;
  const vendor = createZapmailVendor({ apiKey: 'k', webhookSecret: SECRET, fetchImpl: async () => ({}) });
  const handle = createVendorWebhookHandler({ store: s, providers: { vendor }, resume: () => { resumed++; }, log: { error() {} } });
  const body = JSON.stringify({ id: 'evt_9', type: 'domain.updated', data: { domainDetails: { domain: 'a.com' } } });
  const headers = { 'x-zapmail-signature': sign(body, Math.floor(Date.now() / 1000)) };

  const r = handle(Buffer.from(body), headers);
  assert.deepEqual({ handled: r.handled, woken: r.woken }, { handled: true, woken: 1 });
  assert.equal(resumed, 0, 'resume happens after the response, not before');
  await new Promise((r2) => setImmediate(r2));
  assert.equal(resumed, 1);
  assert.deepEqual(handle(Buffer.from(body), headers), { handled: false, reason: 'duplicate' });
  assert.throws(() => handle(Buffer.from(body), { 'x-zapmail-signature': 't=1,v1=bad' }), (e) => e.status === 400);

  const noHooks = createVendorWebhookHandler({ store: s, providers: { vendor: {} }, resume() {}, log: { error() {} } });
  assert.throws(() => noHooks(Buffer.from('{}'), {}), (e) => e.status === 404);
});

/* ---------------- Privacy ---------------- */
test('public order view never includes the buyer\'s contact details; the admin view does', () => {
  const o = { id: 'ord_1', contact: { email: 'a@b.co', phone: '123' }, manageToken: 'secret', internalMargin: 5, progress: [], quote: { total: 1 } };
  const pub = publicOrder(o);
  assert.ok(!('contact' in pub) && !('manageToken' in pub) && !('internalMargin' in pub));
  const adm = publicOrder(o, { admin: true });
  assert.equal(adm.contact.email, 'a@b.co');
  assert.ok(!('manageToken' in adm));
});
