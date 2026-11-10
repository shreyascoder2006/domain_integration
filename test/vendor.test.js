import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZapmailVendor } from '../lib/providers/zapmail.js';
import { PendingError } from '../lib/errors.js';
import { provision, initProgress, publicOrder, resumeDue } from '../lib/provisioner.js';
import { mockRegistrar, mockDns } from '../lib/providers/mock.js';
import { open } from '../lib/crypto.js';

process.env.MOCK_DELAY_MS = '1';
process.env.RETRY_BASE_MS = '1';

/** A tiny simulated Zapmail account. */
function fakeZapmail(init = {}) {
  const st = { connections: [], domainListed: true, free: 10, mailboxes: [], posts: [], headers: [], ...init };
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const m = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    st.headers.push(init.headers);
    st.posts.push({ m, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
    const ok = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
    if (st.rateLimited) return ok({ message: 'Too many requests' }, 429);
    if (m === 'GET' && u.pathname === '/api/v2/domains/connection-requests') return ok({ data: { data: st.connections } });
    if (m === 'POST' && u.pathname === '/api/v2/domains/connect-domain') {
      st.connections.push({ domainName: body.domainNames[0], status: 'CHECKING_NS_IN_WHOIS' });
      return ok({ message: 'ok' });
    }
    if (m === 'GET' && u.pathname === '/api/v2/domains') {
      const q = u.searchParams.get('contains');
      return ok({ data: { domains: st.domainListed ? [{ id: 'dom-1', domain: q }] : [] } });
    }
    if (m === 'POST' && (u.pathname === '/api/v2/domains/dmarc' || u.pathname === '/api/v2/domains/forwarding')) return ok({ data: null });
    if (m === 'GET' && u.pathname === '/api/v2/mailboxes/list') {
      const q = u.searchParams.get('contains');
      return ok({ data: { availableMailboxes: st.free, domains: q ? [{ domain: q, mailboxes: st.mailboxes }] : [] } });
    }
    if (m === 'POST' && u.pathname === '/api/v2/mailboxes') {
      for (const list of Object.values(body)) {
        for (const a of list) {
          st.mailboxes.push({ email: `${a.mailboxUsername}@${a.domainName}`, firstName: a.firstName, lastName: a.lastName, status: 'IN_PROGRESS', password: null, appPassword: null });
          st.free--;
        }
      }
      return ok({ status: 200, message: 'Mailboxes will be assigned shortly', data: null });
    }
    if (m === 'GET' && u.pathname === '/api/v2/wallet/balance') return ok({ walletBalance: 54, autoRechargeEnabled: false });
    return ok({ message: 'not found' }, 404);
  };
  return { f, st };
}

const vendorWith = (f) => createZapmailVendor({ apiKey: 'ZKEY', workspaceKey: 'ws1', fetchImpl: f });
const acct = (p) => ({ firstName: 'A', lastName: 'B', emailPrefix: p });

test('zapmail: connectDomain requests, waits, then succeeds', async () => {
  const { f, st } = fakeZapmail();
  const v = vendorWith(f);
  await assert.rejects(() => v.connectDomain('x.com'), PendingError);              // creates request
  assert.ok(st.posts.some((p) => p.path === '/api/v2/domains/connect-domain'));
  await assert.rejects(() => v.connectDomain('x.com'), /CHECKING_NS_IN_WHOIS/);    // still checking
  st.connections[0].status = 'NS_NOT_CHANGED';
  await assert.rejects(() => v.connectDomain('x.com'), (e) => e instanceof PendingError && e.retryAfterMs >= 300000);
  st.connections[0].status = 'SUCCESS';
  assert.deepEqual(await v.connectDomain('x.com'), { ready: true });
  st.connections[0].status = 'DOMAIN_NOT_REGISTERED';
  await assert.rejects(() => v.connectDomain('x.com'), (e) => !(e instanceof PendingError) && /DOMAIN_NOT_REGISTERED/.test(e.message));
});

test('zapmail: sends auth + workspace + provider headers, never the key in the URL', async () => {
  const { f, st } = fakeZapmail();
  await vendorWith(f).createMailboxes({ domain: 'x.com', provider: 'google', accounts: [acct('a.b')] });
  const h = st.headers.at(-1);
  assert.equal(h['x-auth-zapmail'], 'ZKEY');
  assert.equal(h['x-workspace-key'], 'ws1');
  assert.equal(h['x-service-provider'], 'GOOGLE');
  assert.ok(st.posts.every((p) => !JSON.stringify(p).includes('ZKEY')));
});

test('zapmail: createMailboxes keys body by domain id, is idempotent, and checks capacity', async () => {
  const { f, st } = fakeZapmail({ free: 2 });
  const v = vendorWith(f);
  await v.createMailboxes({ domain: 'x.com', provider: 'google', accounts: [acct('a'), acct('b')] });
  const post = st.posts.find((p) => p.m === 'POST' && p.path === '/api/v2/mailboxes');
  assert.equal(post.query.serviceProvider, 'GOOGLE');
  assert.deepEqual(Object.keys(post.body), ['dom-1']);
  assert.deepEqual(post.body['dom-1'][0], { firstName: 'A', lastName: 'B', mailboxUsername: 'a', domainName: 'x.com' });

  const before = st.posts.filter((p) => p.m === 'POST' && p.path === '/api/v2/mailboxes').length;
  await v.createMailboxes({ domain: 'x.com', provider: 'google', accounts: [acct('a'), acct('b')] }); // retry
  assert.equal(st.posts.filter((p) => p.m === 'POST' && p.path === '/api/v2/mailboxes').length, before, 'must not assign twice');

  await assert.rejects(
    () => v.createMailboxes({ domain: 'x.com', provider: 'google', accounts: [acct('c'), acct('d')] }),
    (e) => e.code === 'CAPACITY'
  );
});

test('zapmail: rejects usernames Zapmail would reject, and unsupported providers', async () => {
  const v = vendorWith(fakeZapmail().f);
  for (const bad of ['.a', 'a.', 'a..b', '-x']) {
    await assert.rejects(() => v.createMailboxes({ domain: 'x.com', provider: 'google', accounts: [acct(bad)] }), /Invalid mailbox username/);
  }
  await assert.rejects(() => v.createMailboxes({ domain: 'x.com', provider: 'azure', accounts: [acct('a')] }), /not supported/);
});

test('zapmail: collectMailboxes waits for ACTIVE + credentials, fails on FAILED', async () => {
  const { f, st } = fakeZapmail({ mailboxes: [{ email: 'a@x.com', status: 'IN_PROGRESS' }] });
  const v = vendorWith(f);
  await assert.rejects(() => v.collectMailboxes({ domain: 'x.com', provider: 'google', emails: ['a@x.com'] }), PendingError);
  st.mailboxes[0] = { email: 'a@x.com', status: 'ACTIVE', firstName: 'A', lastName: 'B', password: 'pw', appPassword: 'app', secret: null };
  const r = await v.collectMailboxes({ domain: 'x.com', provider: 'google', emails: ['a@x.com'] });
  assert.deepEqual(r.mailboxes[0].credentials, { username: 'a@x.com', password: 'pw', appPassword: 'app', secret: null });
  assert.equal(r.mailboxes[0].smtp.host, 'smtp.gmail.com');
  await assert.rejects(() => v.collectMailboxes({ domain: 'x.com', provider: 'google', emails: ['a@x.com', 'missing@x.com'] }), PendingError);
  st.mailboxes[0].status = 'FAILED';
  await assert.rejects(() => v.collectMailboxes({ domain: 'x.com', provider: 'google', emails: ['a@x.com'] }), (e) => !(e instanceof PendingError));
});

test('zapmail: rate limit becomes a pending wait; capacity check reports free slots', async () => {
  const limited = fakeZapmail({ rateLimited: true });
  await assert.rejects(() => vendorWith(limited.f).connectDomain('x.com'), PendingError);
  const v = vendorWith(fakeZapmail({ free: 3 }).f);
  assert.equal((await v.checkCapacity({ provider: 'google', mailboxCount: 3 })).ok, true);
  assert.equal((await v.checkCapacity({ provider: 'google', mailboxCount: 4 })).ok, false);
  assert.equal((await v.checkCapacity({ provider: 'azure', mailboxCount: 1 })).ok, false);
});

/* ---- Full pipeline: real adapter + real provisioner against the fake account ---- */
const memStore = () => ({
  data: { orders: {}, mailboxes: [] },
  putOrder(o) { this.data.orders[o.id] = o; },
  addMailboxes(l) { this.data.mailboxes.push(...l); }
});
const newOrder = () => {
  const o = {
    id: 'ord_zm', userId: 'u', provider: 'google', forwardingDomain: 'acme.com', contact: {},
    domains: [{ name: 'getx.com', mailboxes: [acct('a.b'), acct('b.a')] }]
  };
  initProgress(o);
  return o;
};
const makeDue = (order) => { for (const s of Object.values(order.progress[0].steps)) if (s.status === 'waiting') s.nextCheckAt = 0; };

test('pipeline with an async DNS-managing vendor: waits, resumes, completes, hides vendor details', async () => {
  const { f, st } = fakeZapmail();
  const nsCalls = [];
  const registrar = { ...mockRegistrar, setNameservers: async (d, n) => { nsCalls.push([d, n]); return {}; } };
  let dnsTouched = false;
  const dns = new Proxy(mockDns, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { dnsTouched = true; return t[k](...a); } : t[k]) });
  const providers = { registrar, dns, vendor: vendorWith(f) };
  const store = memStore();
  const order = newOrder();

  await provision(order, { providers, store });
  assert.equal(order.status, 'provisioning', 'waiting on domain verification is not a failure');
  assert.equal(order.progress[0].steps.connect_domain.status, 'waiting');
  assert.deepEqual(nsCalls[0], ['getx.com', providers.vendor.nameServers], 'registrar points at the vendor, not our DNS');

  // Not due yet: the resume loop must leave it alone.
  assert.equal(resumeDue({ providers, store: { data: { orders: { [order.id]: order } }, putOrder() {}, addMailboxes() {} } }), 0);

  st.connections[0].status = 'SUCCESS'; makeDue(order);
  await provision(order, { providers, store });
  assert.equal(order.progress[0].steps.mailboxes_ready.status, 'waiting', 'mailboxes still being created');
  assert.ok(st.posts.some((p) => p.path === '/api/v2/domains/dmarc'));
  assert.ok(st.posts.some((p) => p.path === '/api/v2/domains/forwarding' && p.body.forwardTo === 'acme.com'));

  for (const m of st.mailboxes) Object.assign(m, { status: 'ACTIVE', password: 'pw-' + m.email, appPassword: 'app-' + m.email });
  makeDue(order);
  await provision(order, { providers, store });

  assert.equal(order.status, 'completed');
  assert.equal(dnsTouched, false, 'our DNS is not used when the vendor manages DNS');
  assert.equal(order.progress[0].steps.dns_dkim.result.skipped, 'vendor manages DNS');
  assert.equal(store.data.mailboxes.length, 2);
  assert.equal(open(store.data.mailboxes[0].credentialsEnc).appPassword, 'app-a.b@getx.com');
  assert.ok(!JSON.stringify(store.data).includes('app-a.b@getx.com'), 'no plaintext credentials persisted');

  const shown = JSON.stringify(publicOrder(order));
  assert.ok(!/zapmail|vendor|pns6|app-a\.b/i.test(shown), 'customer view must not leak vendor or secrets');
});

test('pipeline: a fatal vendor error is a failure, customers see a generic message, admins see the cause', async () => {
  const { f } = fakeZapmail({ free: 0 });
  const { st } = { st: null };
  const providers = { registrar: mockRegistrar, dns: mockDns, vendor: vendorWith(f) };
  const store = memStore();
  const order = newOrder();
  // connection already verified so we reach mailbox creation
  const first = await provision(order, { providers, store });
  assert.equal(first.status, 'provisioning');
  // flip connection to SUCCESS through the fake by re-creating with a connected state
  const { f: f2 } = fakeZapmail({ free: 0, connections: [{ domainName: 'getx.com', status: 'SUCCESS' }] });
  const order2 = newOrder(); order2.id = 'ord_zm2';
  const r = await provision(order2, { providers: { ...providers, vendor: vendorWith(f2) }, store });
  assert.equal(r.status, 'partial_failure');
  assert.equal(r.progress[0].steps.mailboxes.status, 'failed');
  assert.match(publicOrder(r).progress[0].steps.mailboxes.error, /needs attention/);
  assert.match(publicOrder(r, { admin: true }).progress[0].steps.mailboxes.error, /Out of vendor mailbox slots/);
});

test('resumeDue: starts due and crashed orders, skips orders waiting in the future', async () => {
  const { f, st } = fakeZapmail();
  const providers = { registrar: mockRegistrar, dns: mockDns, vendor: vendorWith(f) };
  const store = memStore();
  const future = newOrder(); future.id = 'o_future'; future.status = 'provisioning';
  future.progress[0].steps.connect_domain = { status: 'waiting', nextCheckAt: Date.now() + 3_600_000, waitingSince: Date.now() };
  const due = newOrder(); due.id = 'o_due'; due.status = 'provisioning';
  due.progress[0].steps.connect_domain = { status: 'waiting', nextCheckAt: Date.now() - 1, waitingSince: Date.now() };
  const crashed = newOrder(); crashed.id = 'o_crashed'; crashed.status = 'provisioning';
  crashed.progress[0].steps.register = { status: 'running' };
  for (const o of [future, due, crashed]) store.data.orders[o.id] = o;
  const started = resumeDue({ providers, store });
  assert.equal(started, 2);
  for (let i = 0; i < 60 && st.posts.length === 0; i++) await new Promise((r) => setTimeout(r, 100)); // mock registrar has its own delay
  assert.ok(st.posts.length > 0, 'resumed orders must reach the vendor');
});
