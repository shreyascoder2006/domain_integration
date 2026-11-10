import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { Store } from '../lib/store.js';
import { SqliteStore } from '../lib/store/sqlite.js';
import { createBackup, restoreBackup, migrateJsonToSqlite } from '../lib/backup.js';
import { runPreflight } from '../lib/preflight.js';
import { createNameSiloRegistrar } from '../lib/providers/namesilo.js';
import { createCloudflareDns } from '../lib/providers/cloudflare.js';
import { createRazorpayPayments } from '../lib/providers/razorpay.js';
import { createZapmailVendor } from '../lib/providers/zapmail.js';
import { PendingError } from '../lib/errors.js';
import { initProgress, provision } from '../lib/provisioner.js';
import { mockRegistrar, mockDns, mockMailboxVendor } from '../lib/providers/mock.js';

const dir = (n) => { const d = join(tmpdir(), `cl-tools-${Date.now()}-${Math.random().toString(16).slice(2)}-${n}`); mkdirSync(d, { recursive: true }); return d; };
const seed = (s) => {
  s.putOrder({ id: 'o1', status: 'completed', contact: { email: 'a@b.co' } });
  s.putOrder({ id: 'o2', status: 'paid' });
  s.addMailboxes([{ email: 'a@x.com', orderId: 'o1' }, { email: 'b@x.com', orderId: 'o1' }]);
  s.putCheckout({ id: 'c1', status: 'paid', createdAt: new Date().toISOString() });
  s.putPlan('k', 'plan_1'); s.markEvent('evt_1');
  s.addOutbox({ id: 'e1', key: 'k', status: 'pending' }); s.putAlert('a', { message: 'm' });
};

/* ---------------- backup / restore ---------------- */
for (const kind of ['json', 'sqlite']) {
  test(`backup [${kind}]: snapshots a live database, proves it opens, and keeps only the newest N`, async () => {
    const d = dir(kind), file = join(d, kind === 'json' ? 'db.json' : 'db.sqlite');
    const env = { STORE: kind === 'sqlite' ? 'sqlite' : '', DATA_FILE: file, SQLITE_FILE: file };
    const live = kind === 'json' ? new Store(file) : new SqliteStore(file);
    seed(live);
    const bdir = join(d, 'backups');
    const a = await createBackup({ env, dir: bdir, keep: 2, now: Date.UTC(2026, 0, 1) });
    assert.deepEqual([a.orders, a.mailboxes, a.checkouts], [2, 2, 1]);
    assert.ok(existsSync(a.file));
    live.putOrder({ id: 'o3', status: 'paid' });                         // the server keeps writing while we back up
    await createBackup({ env, dir: bdir, keep: 2, now: Date.UTC(2026, 0, 2) });
    const c = await createBackup({ env, dir: bdir, keep: 2, now: Date.UTC(2026, 0, 3) });
    assert.equal(c.orders, 3);
    assert.equal(readdirSync(bdir).length, 2, 'retention keeps only the newest');
    assert.ok(!existsSync(a.file), 'the oldest was pruned');
    if (kind === 'sqlite') live.close();
  });

  test(`restore [${kind}]: validates the backup, refuses to overwrite without --force, and keeps the previous data`, async () => {
    const d = dir(kind), file = join(d, kind === 'json' ? 'db.json' : 'db.sqlite');
    const env = { STORE: kind === 'sqlite' ? 'sqlite' : '', DATA_FILE: file, SQLITE_FILE: file };
    const live = kind === 'json' ? new Store(file) : new SqliteStore(file);
    seed(live);
    const b = await createBackup({ env, dir: join(d, 'b'), now: Date.UTC(2026, 0, 1) });
    live.putOrder({ id: 'o_after', status: 'paid' });                    // damage done after the backup
    if (kind === 'sqlite') live.close();

    await assert.rejects(() => restoreBackup({ env, file: b.file }), /already exists.*--force/);
    const bad = join(d, 'bad.' + (kind === 'json' ? 'json' : 'sqlite'));
    writeFileSync(bad, kind === 'json' ? '{"orders": {' : 'this is not a database');
    await assert.rejects(() => restoreBackup({ env, file: bad, force: true }));
    const r = await restoreBackup({ env, file: b.file, force: true, now: Date.UTC(2026, 0, 5) });
    assert.equal(r.orders, 2);
    assert.ok(r.savedAs && existsSync(r.savedAs), 'the pre-restore copy exists');
    const back = kind === 'json' ? new Store(file) : new SqliteStore(file);
    assert.deepEqual(back.listOrders().map((o) => o.id).sort(), ['o1', 'o2']);
    assert.equal(back.seenEvent('evt_1'), true);
    if (kind === 'sqlite') back.close();
  });
}

test('backup: refuses when there is nothing to back up; restore rejects a missing file', async () => {
  const env = { DATA_FILE: join(dir('none'), 'nope.json') };
  await assert.rejects(() => createBackup({ env, dir: dir('b') }), /Nothing to back up/);
  await assert.rejects(() => restoreBackup({ env, file: join(tmpdir(), 'does-not-exist.json') }), /not found/);
});

test('migrate: JSON -> SQLite copies everything with ids preserved, verifies, and refuses to merge', async () => {
  const d = dir('mig'), jf = join(d, 'db.json'), sf = join(d, 'db.sqlite');
  const j = new Store(jf); seed(j);
  const ids = j.listMailboxes().map((m) => m.id);
  const r = await migrateJsonToSqlite({ jsonFile: jf, sqliteFile: sf });
  assert.deepEqual(r.migrated, { orders: 2, mailboxes: 2, checkouts: 1 });
  const s = new SqliteStore(sf);
  assert.deepEqual(s.listMailboxes().map((m) => m.id), ids);
  assert.equal(s.getPlan('k'), 'plan_1');
  assert.equal(s.seenEvent('evt_1'), true);
  assert.equal(s.listOutbox().length, 1);
  assert.deepEqual(Object.keys(s.listAlerts()), ['a']);
  s.close();
  await assert.rejects(() => migrateJsonToSqlite({ jsonFile: jf, sqliteFile: sf }), /already contains data/);
  assert.equal(JSON.parse(readFileSync(jf, 'utf8')).orders.o1.id, 'o1', 'the JSON source is untouched');
});

/* ---------------- preflight ---------------- */
const adapter = (name, result, extra = {}) => ({ name, preflight: async () => result, ...extra });

test('preflight: reports every service, skips DNS when the vendor runs it, and fails overall if anything fails', async () => {
  const providers = {
    registrar: adapter('namesilo', { ok: true, detail: 'key accepted' }),
    dns: adapter('cloudflare-dns', { ok: false, detail: 'should be skipped' }),
    vendor: adapter('zapmail', { ok: true, detail: 'wallet $50' }, { managesDns: true, verifyWebhook() {} }),
    payments: adapter('razorpay', { ok: false, detail: 'Razorpay GET /payments failed (401): invalid key' }, { verifyWebhook() {} })
  };
  const mailer = { name: 'mock-mailer' };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) });
  const r = await runPreflight({ env: { PUBLIC_URL: 'https://app.test', CREDENTIALS_KEY: Buffer.alloc(32).toString('base64') }, providers, mailer, fetchImpl });
  const by = Object.fromEntries(r.checks.map((c) => [c.name, c]));
  assert.equal(by['registrar (namesilo)'].status, 'ok');
  assert.equal(by.dns.status, 'skip');
  assert.equal(by['mailbox vendor (zapmail)'].status, 'ok');
  assert.equal(by['payments (razorpay)'].status, 'fail');
  assert.equal(by['email (mock-mailer)'].status, 'skip');
  assert.equal(by['PUBLIC_URL reachable'].status, 'ok');
  assert.equal(by.CREDENTIALS_KEY.status, 'ok');
  assert.match(by['webhook: payments'].detail, /https:\/\/app\.test\/api\/webhooks\/razorpay/);
  assert.equal(r.ok, false);
});

test('preflight: catches a bad key, an unreachable public URL, a hung service, and production mistakes', async () => {
  const hung = { name: 'slow', preflight: () => new Promise(() => {}) };
  const r = await runPreflight({
    env: { NODE_ENV: 'production', PUBLIC_URL: 'http://app.test', CREDENTIALS_KEY: 'c2hvcnQ=' },
    providers: { registrar: hung, vendor: { name: 'v' }, payments: { name: 'p' } }, mailer: null,
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); }, timeoutMs: 20
  });
  const text = r.checks.map((c) => `${c.status}:${c.name}:${c.detail}`).join('\n');
  assert.match(text, /fail:CREDENTIALS_KEY:decodes to 5 bytes/);
  assert.match(text, /fail:PUBLIC_URL:must be https/);
  assert.match(text, /fail:PUBLIC_URL reachable:connect ECONNREFUSED/);
  assert.match(text, /fail:registrar \(slow\):registrar check timed out/);
  assert.match(text, /mock or no read-only check/);
  assert.equal(r.ok, false);
});

test('preflight: a clean development setup passes with only reminders', async () => {
  const r = await runPreflight({ env: {}, providers: { registrar: { name: 'mock-registrar' }, dns: { name: 'mock-dns' }, vendor: { name: 'mock-vendor' }, payments: { name: 'mock-payments' } }, mailer: { name: 'mock-mailer' } });
  assert.equal(r.ok, true);
});

/* ---------------- adapters' read-only checks ---------------- */
const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });

test('adapter preflights: NameSilo explains an IP block; Cloudflare, Razorpay and Zapmail report what they see', async () => {
  const ns = (reply) => createNameSiloRegistrar({ apiKey: 'K', fetchImpl: async () => json({ reply }) });
  assert.equal((await ns({ code: 300, detail: 'success' }).preflight()).ok, true);
  const blocked = await ns({ code: 113, detail: 'error' }).preflight();
  assert.equal(blocked.ok, false);
  assert.match(blocked.detail, /IP is not allowlisted/);

  const cf = (res) => createCloudflareDns({ token: 't', fetchImpl: async () => res });
  assert.equal((await cf(json({ success: true, result: [] })).preflight()).ok, true);
  assert.match((await cf(json({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }] }, 403)).preflight()).detail, /9109/);

  const rz = (keyId, res, webhookSecret) => createRazorpayPayments({ keyId, keySecret: 's', webhookSecret, fetchImpl: async () => res });
  const t = await rz('rzp_test_abc', json({ items: [] }), 'wh').preflight();
  assert.deepEqual([t.ok, /TEST keys/.test(t.detail)], [true, true]);
  assert.match((await rz('rzp_live_abc', json({}), undefined).preflight()).detail, /LIVE keys.*WEBHOOK_SECRET is not set/);
  assert.equal((await rz('rzp_test_abc', json({ error: { code: 'BAD_REQUEST_ERROR', description: 'auth failed' } }, 401)).preflight()).ok, false);

  const zm = createZapmailVendor({ apiKey: 'k', workspaceKey: 'w', fetchImpl: async (u) => json(String(u).includes('wallet') ? { walletBalance: 54 } : { data: { availableMailboxes: 7 } }) });
  const z = await zm.preflight();
  assert.equal(z.ok, true);
  assert.match(z.detail, /wallet \$54.*google 7/);
});

/* ---------------- retry-later codes and timeouts ---------------- */
test('namesilo: "try again later" codes are waits, other errors still fail', async () => {
  const ns = (code) => createNameSiloRegistrar({ apiKey: 'K', fetchImpl: async () => json({ reply: { code, detail: 'x' } }) });
  for (const [code, ms] of [[268, 600_000], [115, 300_000], [400, 60_000]]) {
    await assert.rejects(() => ns(code).setNameservers('x.com', ['a', 'b']), (e) => e instanceof PendingError && e.retryAfterMs === ms && e.nameSiloCode === code);
  }
  await assert.rejects(() => ns(119).setNameservers('x.com', ['a', 'b']), (e) => !(e instanceof PendingError) && /119/.test(e.message));
});

const tinyOrder = () => {
  const o = { id: 'ord_t', userId: 'u', provider: 'google', contact: {}, domains: [{ name: 'getx.com', mailboxes: [{ firstName: 'A', lastName: 'B', emailPrefix: 'a' }] }] };
  initProgress(o); return o;
};
const memStore = () => new Store(join(dir('mem'), 'db.json'));

test('pipeline: domain verification gives up after 20 hours (before the vendor\'s 24 hour limit) with a useful reason', async () => {
  const store = memStore(), order = tinyOrder();
  const vendor = { ...mockMailboxVendor, managesDns: true, nameServers: ['n1', 'n2'], connectDomain: async () => { throw new PendingError('Domain connection NS_NOT_CHANGED', 1); } };
  const providers = { registrar: mockRegistrar, dns: mockDns, vendor };
  await provision(order, { providers, store });
  const s = order.progress[0].steps.connect_domain;
  assert.equal(s.status, 'waiting');
  s.waitingSince = Date.now() - 21 * 3_600_000; s.nextCheckAt = 0;     // it has been waiting 21 hours
  await provision(order, { providers, store });
  assert.equal(s.status, 'failed');
  assert.match(s.error, /did not verify in time.*nameservers/);
  assert.equal(order.status, 'partial_failure');
});

test('pipeline: the connect step is idempotent, so a resume after a crash cannot duplicate mailboxes', async () => {
  process.env.RETRY_BASE_MS = '1';
  const store = memStore(), order = tinyOrder();
  const providers = { registrar: mockRegistrar, dns: mockDns, vendor: mockMailboxVendor };
  await provision(order, { providers, store });
  assert.equal(order.status, 'completed');
  assert.equal(store.listMailboxes().length, 1);
  order.progress[0].steps.connect.status = 'pending';                   // as if we crashed before recording the step
  order.status = 'paid';
  await provision(order, { providers, store });
  assert.equal(store.listMailboxes().length, 1, 'still exactly one mailbox');
  assert.equal(order.status, 'completed');
});
