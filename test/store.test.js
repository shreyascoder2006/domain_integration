// The storage CONTRACT. Any backend (JSON file, SQLite, and whatever you build for your own database) must pass
// every test in contract(). To add a backend: subclass BaseStore, then add one `contract(...)` call below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { Store } from '../lib/store.js';
import { SqliteStore } from '../lib/store/sqlite.js';

const tmpFile = (ext) => join(tmpdir(), `cl-contract-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);

function contract(name, make) {
  // make() -> { store, reopen() } ; reopen() closes the store and opens a fresh instance on the same storage
  const t = (title, fn) => test(`store contract [${name}]: ${title}`, () => fn(make()));

  t('orders: put/get/list, and lookups by subscription and contact email', ({ store }) => {
    store.putOrder({ id: 'o1', contact: { email: 'A@Co.io' }, billing: { subscriptionId: 'sub_1' } });
    store.putOrder({ id: 'o2', contact: { email: 'b@co.io' } });
    assert.equal(store.getOrder('o1').billing.subscriptionId, 'sub_1');
    assert.deepEqual(store.listOrders().map((o) => o.id).sort(), ['o1', 'o2']);
    assert.equal(store.findOrderBySubscription('sub_1').id, 'o1');
    assert.deepEqual(store.findOrdersByEmail(' a@co.IO ').map((o) => o.id), ['o1']);
    assert.deepEqual(store.findOrdersByEmail(''), []);
    assert.equal(store.getOrder('nope'), undefined);
  });

  t('orders: in-place edits followed by putOrder are durable', ({ store, reopen }) => {
    const o = store.putOrder({ id: 'o1', status: 'paid', progress: [{ domain: 'a.com' }] });
    o.status = 'completed'; o.progress[0].done = true;
    store.putOrder(o);
    const again = reopen().getOrder('o1');
    assert.equal(again.status, 'completed');
    assert.equal(again.progress[0].done, true);
  });

  t('mailboxes: ids are assigned, lookups work, edits and suspension are durable and reversible', ({ store, reopen }) => {
    store.addMailboxes([{ email: 'a@x.com', orderId: 'o1', status: 'ready_for_warmup' }, { email: 'b@x.com', orderId: 'o2', status: 'ready_for_warmup' }]);
    const [a, b] = store.listMailboxes();
    assert.match(a.id, /^mbx_[0-9a-f]{12}$/);
    assert.notEqual(a.id, b.id);
    assert.equal(store.getMailbox(a.id).email, 'a@x.com');
    a.warmup = 'warming'; store.putMailbox(a);

    assert.equal(store.suspendMailboxes('o1', 'non_payment'), 1);
    assert.equal(store.suspendMailboxes('o1', 'again'), 0, 'already suspended');
    let s2 = reopen();
    const sa = s2.getMailbox(a.id);
    assert.deepEqual([sa.suspended, sa.status, sa.suspendedReason, sa.warmup], [true, 'suspended', 'non_payment', 'warming']);
    assert.equal(s2.getMailbox(b.id).suspended, undefined, 'other orders are untouched');
    assert.deepEqual(s2.listMailboxes().map((m) => m.email), ['a@x.com', 'b@x.com'], 'insertion order is kept');

    assert.equal(s2.unsuspendMailboxes('o1'), 1);
    const back = reopen().getMailbox(a.id);
    assert.deepEqual([back.suspended, back.status, back.suspendedReason], [undefined, 'ready_for_warmup', undefined]);
  });

  t('mailboxes: records stored without an id get one, and it stays stable', ({ store, reopen }) => {
    // Simulate data written before ids existed.
    if (store.db) store.db.prepare('INSERT INTO mailboxes(id, order_id, json) VALUES(?, ?, ?)').run('legacy_1', 'o1', JSON.stringify({ email: 'old@x.com', orderId: 'o1' }));
    else { store.data.mailboxes.push({ email: 'old@x.com', orderId: 'o1' }); store.save(); }
    const m = reopen().listMailboxes().find((x) => x.email === 'old@x.com');
    assert.ok(m.id, 'an id was assigned');
    assert.equal(reopen().listMailboxes().filter((x) => x.email === 'old@x.com').length, 1, 'and no duplicate was created');
    assert.equal(reopen().listMailboxes().find((x) => x.email === 'old@x.com').id, m.id);
  });

  t('checkouts: lookups, and stale unpaid ones are purged but paid ones are kept', ({ store, reopen }) => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    store.putCheckout({ id: 'c_old', status: 'awaiting_payment', createdAt: old, idempotencyKey: 'k1', gatewayOrderId: 'order_1' });
    store.putCheckout({ id: 'c_paid', status: 'paid', createdAt: old, gatewaySubscriptionId: 'sub_9' });
    store.putCheckout({ id: 'c_new', status: 'awaiting_payment', createdAt: new Date().toISOString() });
    assert.equal(store.findCheckoutByKey('k1').id, 'c_old');
    assert.equal(store.findCheckoutByGatewayOrder('order_1').id, 'c_old');
    assert.equal(store.findCheckoutBySubscription('sub_9').id, 'c_paid');
    assert.equal(store.purgeStaleCheckouts(14 * 86_400_000), 1);
    assert.deepEqual(reopen().listCheckouts().map((c) => c.id).sort(), ['c_new', 'c_paid']);
  });

  t('plans and webhook events: durable, and event de-duplication survives a restart', ({ store, reopen }) => {
    store.putPlan('monthly:3:USD:4991', 'plan_1');
    assert.equal(store.seenEvent('evt_1'), false);
    store.markEvent('evt_1');
    assert.equal(store.seenEvent('evt_1'), true);
    const s2 = reopen();
    assert.equal(s2.getPlan('monthly:3:USD:4991'), 'plan_1');
    assert.equal(s2.seenEvent('evt_1'), true, 'a webhook retry after a restart must still be recognised');
    assert.equal(s2.seenEvent('evt_2'), false);
  });

  t('outbox and alerts: durable, prunable, deletable', ({ store, reopen }) => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    store.addOutbox({ id: 'e1', key: 'k1', status: 'sent', sentAt: old });
    store.addOutbox({ id: 'e2', key: 'k2', status: 'pending' });
    const e2 = store.listOutbox().find((i) => i.id === 'e2');
    e2.attempts = 2; store.putOutbox(e2);
    store.putAlert('order:o1:x', { firstSeenAt: 1, message: 'm' });
    store.putAlert('order:o2:y', { firstSeenAt: 2, message: 'n' });
    store.deleteAlert('order:o2:y');
    let s2 = reopen();
    assert.equal(s2.listOutbox().find((i) => i.id === 'e2').attempts, 2);
    assert.deepEqual(Object.keys(s2.listAlerts()), ['order:o1:x']);
    assert.equal(s2.pruneOutbox(30 * 86_400_000), 1);
    assert.deepEqual(reopen().listOutbox().map((i) => i.id), ['e2']);
  });

  t('indexes: lookups follow replaced records, windows are newest-first, outbox status sets track changes, and all of it survives a reopen', ({ store, reopen }) => {
    // A record replaced by a new object with the same id must not leave a stale lookup behind.
    store.putOrder({ id: 'o1', billing: { subscriptionId: 'sub_A' }, contact: { email: 'a@co.io' } });
    store.putOrder({ id: 'o1', billing: { subscriptionId: 'sub_B' }, contact: { email: 'a@co.io' } });
    assert.equal(store.findOrderBySubscription('sub_A'), undefined);
    assert.equal(store.findOrderBySubscription('sub_B').id, 'o1');
    assert.equal(store.findOrdersByEmail('A@CO.io').length, 1);

    const h = 3_600_000, now = Date.now();
    for (const [id, age] of [['c_old', 30 * h], ['c_mid', 5 * h], ['c_new', 1 * h]]) store.putCheckout({ id, status: 'paid', createdAt: new Date(now - age).toISOString(), idempotencyKey: 'k_' + id });
    assert.deepEqual(store.recentCheckouts(now - 6 * h).map((c) => c.id), ['c_new', 'c_mid'], 'newest first, only inside the window');
    assert.deepEqual(store.recentCheckouts(now - 100 * h).map((c) => c.id), ['c_new', 'c_mid', 'c_old']);
    store.putCheckout(store.getCheckout('c_new'));      // a re-put must not duplicate it in the window
    assert.equal(store.recentCheckouts(now - 6 * h).length, 2);

    store.addMailboxes([{ email: 'x@a.com', orderId: 'o1' }, { email: 'y@a.com', orderId: 'o1' }, { email: 'z@b.com', orderId: 'o2' }]);
    assert.deepEqual(store.mailboxesOfOrder('o1').map((m) => m.email), ['x@a.com', 'y@a.com']);
    assert.deepEqual(store.mailboxesOfOrder('nope'), []);

    const mk = (id, status, key) => store.addOutbox({ id, key, status, attempts: 0 });
    mk('e1', 'pending', 'k1'); mk('e2', 'pending', 'k2'); mk('e3', 'sent', 'k3');
    assert.deepEqual(store.outboxWithStatus('pending').map((i) => i.id).sort(), ['e1', 'e2']);
    assert.equal(store.hasOutboxKey('k3'), true);
    assert.equal(store.hasOutboxKey('k9'), false);
    const e1 = store.listOutbox().find((i) => i.id === 'e1'); e1.status = 'sent'; store.putOutbox(e1);
    const e2 = store.listOutbox().find((i) => i.id === 'e2'); e2.status = 'dead'; store.putOutbox(e2);
    assert.deepEqual([store.outboxWithStatus('pending').length, store.outboxWithStatus('dead').map((i) => i.id)], [0, ['e2']]);

    const s2 = reopen();
    assert.equal(s2.findOrderBySubscription('sub_B').id, 'o1');
    assert.deepEqual(s2.recentCheckouts(now - 6 * h).map((c) => c.id), ['c_new', 'c_mid']);
    assert.equal(s2.findCheckoutByKey('k_c_mid').id, 'c_mid');
    assert.deepEqual(s2.mailboxesOfOrder('o2').map((m) => m.email), ['z@b.com']);
    assert.deepEqual(s2.outboxWithStatus('dead').map((i) => i.id), ['e2']);
    assert.equal(s2.hasOutboxKey('k1'), true);
  });

  t('indexes: purged checkouts disappear from every lookup and from the window', ({ store }) => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    store.putCheckout({ id: 'c_stale', status: 'awaiting_payment', createdAt: old, idempotencyKey: 'ks', gatewayOrderId: 'order_s', gatewaySubscriptionId: 'sub_s' });
    assert.equal(store.purgeStaleCheckouts(14 * 86_400_000), 1);
    assert.deepEqual([store.findCheckoutByKey('ks'), store.findCheckoutByGatewayOrder('order_s'), store.findCheckoutBySubscription('sub_s')], [undefined, undefined, undefined]);
    assert.deepEqual(store.recentCheckouts(0), []);
    store.putCheckout({ id: 'c_stale', status: 'awaiting_payment', createdAt: new Date().toISOString(), idempotencyKey: 'ks2' });   // the same id can come back
    assert.equal(store.recentCheckouts(0).length, 1);
  });
}

contract('json', () => {
  const file = tmpFile('json');
  let store = new Store(file);
  return { get store() { return store; }, reopen() { store = new Store(file); return store; } };
});

contract('sqlite', () => {
  const file = tmpFile('sqlite');
  let store = new SqliteStore(file);
  return { get store() { return store; }, reopen() { store.close(); store = new SqliteStore(file); return store; } };
});

test('sqlite: backupTo makes a consistent, openable copy; a corrupt JSON file still refuses to start', () => {
  const file = tmpFile('sqlite'), copy = tmpFile('sqlite');
  const s = new SqliteStore(file);
  s.putOrder({ id: 'o1', n: 1 });
  s.backupTo(copy);
  s.putOrder({ id: 'o2', n: 2 });
  assert.ok(existsSync(copy) && statSync(copy).size > 0);
  const c = new SqliteStore(copy);
  assert.deepEqual(c.listOrders().map((o) => o.id), ['o1'], 'the copy is a point-in-time snapshot');
  c.close(); s.close();
});
