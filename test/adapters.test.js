import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNameSiloRegistrar } from '../lib/providers/namesilo.js';
import { createCloudflareDns } from '../lib/providers/cloudflare.js';
import { seal, open } from '../lib/crypto.js';
import { suggestedRefund, checkRefundAmount, refundedSoFar } from '../lib/refunds.js';
import { provision, initProgress, publicOrder } from '../lib/provisioner.js';
import { loadProviders } from '../lib/providers/index.js';

/** Fake fetch: responds from a handler(url, init) -> {status?, body}. Records calls. */
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const r = handler(u, init, calls.length);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}

/* ---------------- NameSilo ---------------- */
const ns = (fetchImpl) => createNameSiloRegistrar({ apiKey: 'SECRETKEY', fetchImpl });
const reply = (code, extra = {}) => ({ body: { reply: { code, detail: code === 300 ? 'success' : 'error', ...extra } } });

test('namesilo: availability handles array + single-object results and premium', async () => {
  const f = fakeFetch(() => reply(300, {
    available: [{ domain: 'a.com', price: 9.99, premium: 0 }, { domain: 'prem.com', price: 5000, premium: 1 }],
    unavailable: { domain: 'taken.com' },
    invalid: { domain: 'bad!.com' }
  }));
  const r = await ns(f).checkAvailability(['a.com', 'prem.com', 'taken.com', 'bad!.com']);
  assert.deepEqual(r.map((x) => x.available), [true, false, false, false]);
  assert.equal(r[0].price, 9.99);
  assert.equal(f.calls[0].url.searchParams.get('domains'), 'a.com,prem.com,taken.com,bad!.com');
  assert.equal(f.calls[0].url.searchParams.get('type'), 'json');
  assert.equal(f.calls[0].method, 'GET');
});

test('namesilo: single available result as a bare object is normalised', async () => {
  const f = fakeFetch(() => reply(300, { available: { domain: 'one.com', price: 9, premium: 0 } }));
  const r = await ns(f).checkAvailability(['one.com']);
  assert.equal(r[0].available, true);
});

test('namesilo: register sends contact + privacy and formats phone as +CC.NSN', async () => {
  const f = fakeFetch(() => reply(300, { order_amount: 9.99 }));
  const out = await ns(f).register({
    domain: 'x.com', years: 1,
    contact: { firstName: 'A', lastName: 'B', company: 'Co', address: '1 St', city: 'Nagpur', state: 'MH', zip: '440001', country: 'IN', email: 'a@b.co', phoneCc: '91', phone: '98000 00000' }
  });
  const p = f.calls[0].url.searchParams;
  assert.equal(p.get('ph'), '+91.9800000000');
  assert.equal(p.get('private'), '1');
  assert.equal(p.get('ct'), 'IN');
  assert.equal(p.get('auto_renew'), '0');
  assert.equal(out.orderAmount, 9.99);
  assert.deepEqual(out.warnings, []);
});

test('namesilo: code 302 succeeds with a warning; 119 throws a helpful error without leaking the key', async () => {
  const contact = { firstName: 'A', lastName: 'B', address: '1', city: 'c', state: 's', zip: '1', country: 'US', email: 'a@b.co', phoneCc: '1', phone: '4805555555' };
  const w = await ns(fakeFetch(() => reply(302))).register({ domain: 'x.com', contact });
  assert.equal(w.warnings.length, 1);
  await assert.rejects(
    () => ns(fakeFetch(() => reply(119))).register({ domain: 'x.com', contact }),
    (e) => /119/.test(e.message) && /funds/i.test(e.message) && !e.message.includes('SECRETKEY')
  );
});

test('namesilo: setNameservers sends ns1..nsN and needs at least 2', async () => {
  const f = fakeFetch(() => reply(300));
  await ns(f).setNameservers('x.com', ['a.ns.cloudflare.com', 'b.ns.cloudflare.com']);
  const p = f.calls[0].url.searchParams;
  assert.equal(p.get('ns1'), 'a.ns.cloudflare.com');
  assert.equal(p.get('ns2'), 'b.ns.cloudflare.com');
  await assert.rejects(() => ns(f).setNameservers('x.com', ['only.one']), /2 nameservers/);
});

/* ---------------- Cloudflare ---------------- */
function cfHandler({ existingZone = false, dupRecords = false } = {}) {
  return (u, init) => {
    const m = init.method || 'GET';
    if (u.pathname.endsWith('/zones') && m === 'GET') {
      return { body: { success: true, result: existingZone ? [{ id: 'z1', name_servers: ['n1', 'n2'] }] : [] } };
    }
    if (u.pathname.endsWith('/zones') && m === 'POST') return { body: { success: true, result: { id: 'z1', name_servers: ['bob.ns.cloudflare.com', 'lola.ns.cloudflare.com'] } } };
    if (u.pathname.endsWith('/dns_records')) {
      return dupRecords
        ? { status: 400, body: { success: false, errors: [{ code: 81058, message: 'An identical record already exists.' }] } }
        : { body: { success: true, result: {} } };
    }
    if (u.pathname.includes('/rulesets/phases/')) return { body: { success: true, result: {} } };
    return { status: 404, body: { success: false, errors: [{ code: 1, message: 'nope' }] } };
  };
}

test('cloudflare: creates zone (type full) and returns nameservers; reuses an existing zone', async () => {
  const f1 = fakeFetch(cfHandler());
  const z = await createCloudflareDns({ token: 't', accountId: 'acc', fetchImpl: f1 }).prepareZone('x.com');
  assert.deepEqual(z.nameServers, ['bob.ns.cloudflare.com', 'lola.ns.cloudflare.com']);
  const post = f1.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, { name: 'x.com', type: 'full', account: { id: 'acc' } });

  const f2 = fakeFetch(cfHandler({ existingZone: true }));
  await createCloudflareDns({ token: 't', fetchImpl: f2 }).prepareZone('x.com');
  assert.equal(f2.calls.filter((c) => c.method === 'POST').length, 0, 'must not create a duplicate zone');
});

test('cloudflare: records use ttl 1, MX gets priority, auth header is Bearer', async () => {
  const f = fakeFetch(cfHandler());
  const dns = createCloudflareDns({ token: 'TOK', fetchImpl: f });
  await dns.applyRecords('x.com', [
    { type: 'TXT', name: 'x.com', value: 'v=spf1 include:_spf.google.com ~all' },
    { type: 'MX', name: 'x.com', value: 'smtp.google.com', priority: 1 }
  ]);
  const recs = f.calls.filter((c) => c.url.pathname.endsWith('/dns_records')).map((c) => c.body);
  assert.deepEqual(recs[0], { type: 'TXT', name: 'x.com', content: 'v=spf1 include:_spf.google.com ~all', ttl: 1 });
  assert.equal(recs[1].priority, 1);
});

test('cloudflare: duplicate-record errors are treated as success (idempotent retries)', async () => {
  const dns = createCloudflareDns({ token: 't', fetchImpl: fakeFetch(cfHandler({ dupRecords: true })) });
  const r = await dns.applyRecords('x.com', [{ type: 'TXT', name: 'x.com', value: 'v=spf1 ~all' }]);
  assert.equal(r.applied, 1);
});

test('cloudflare: forwarding adds proxied records then a 301 redirect rule', async () => {
  const f = fakeFetch(cfHandler());
  await createCloudflareDns({ token: 't', fetchImpl: f }).setForwarding('x.com', 'https://acme.com');
  const proxied = f.calls.filter((c) => c.url.pathname.endsWith('/dns_records')).map((c) => c.body);
  assert.ok(proxied.length === 2 && proxied.every((b) => b.proxied === true && b.type === 'A'));
  const put = f.calls.find((c) => c.method === 'PUT');
  assert.match(put.url.pathname, /rulesets\/phases\/http_request_dynamic_redirect\/entrypoint$/);
  assert.equal(put.body.rules[0].action, 'redirect');
  assert.equal(put.body.rules[0].action_parameters.from_value.status_code, 301);
});

test('cloudflare: API failure surfaces codes', async () => {
  const dns = createCloudflareDns({ token: 't', fetchImpl: fakeFetch(() => ({ status: 403, body: { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] } })) });
  await assert.rejects(() => dns.prepareZone('x.com'), /9109.*Invalid access token/);
});

/* ---------------- Crypto ---------------- */
test('crypto: seal/open round-trips, is randomised and rejects tampering', () => {
  const a = seal({ t: 'secret' });
  assert.notEqual(a, seal({ t: 'secret' }));
  assert.deepEqual(open(a), { t: 'secret' });
  assert.ok(!a.includes('secret'));
  const bad = a.slice(0, -4) + (a.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => open(bad));
});

/* ---------------- Refunds ---------------- */
const mkOrder = () => ({
  quote: { total: 100, mailboxCount: 4 },
  domains: [{ name: 'a.com', mailboxes: [1, 2] }, { name: 'b.com', mailboxes: [1, 2] }],
  progress: [
    { domain: 'a.com', steps: { x: { status: 'done' } } },
    { domain: 'b.com', steps: { x: { status: 'done' }, y: { status: 'failed' } } }
  ]
});

test('refunds: pro-rata for failed domains, capped by remaining amount', () => {
  const o = mkOrder();
  assert.deepEqual(suggestedRefund(o), { failedDomains: ['b.com'], amount: 50 });
  o.refunds = [{ amount: 50 }];
  assert.equal(suggestedRefund(o).amount, 0);
  assert.equal(refundedSoFar(o), 50);
  assert.throws(() => checkRefundAmount(o, 60), /exceeds/);
  assert.equal(checkRefundAmount(o, 50), 50);
  assert.throws(() => checkRefundAmount(o, 0), /positive/);
});

/* ---------------- Provisioner (mock adapters) ---------------- */
test('provisioner: completes, seals credentials, never exposes them', async () => {
  process.env.MOCK_DELAY_MS = '1';
  const providers = loadProviders();
  const mem = { data: { orders: {}, mailboxes: [] }, listOrders() { return Object.values(this.data.orders); }, putOrder(o) { this.data.orders[o.id] = o; }, addMailboxes(l) { this.data.mailboxes.push(...l); } };
  const order = {
    id: 'ord_t', userId: 'u', provider: 'google', forwardingDomain: 'acme.com', contact: {},
    domains: [{ name: 'getx.com', mailboxes: [{ firstName: 'A', lastName: 'B', emailPrefix: 'a.b' }] }]
  };
  initProgress(order);
  await provision(order, { providers, store: mem });
  assert.equal(order.status, 'completed');
  const saved = mem.data.mailboxes[0];
  assert.ok(saved.credentialsEnc.startsWith('enc:v1:') && !saved.credentials);
  assert.ok(open(saved.credentialsEnc).oauthRefreshToken);
  assert.ok(!JSON.stringify(publicOrder(order)).includes('oauthRefreshToken'));
});
