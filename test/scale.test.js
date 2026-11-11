// Scaling guards. These do not measure absolute speed (CI machines vary); they check that cost does NOT grow with the
// size of the database, which is what an accidental return to "scan every record" would break.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BaseStore } from '../lib/store.js';
import { listOrdersPage, FILTERS } from '../lib/adminList.js';
import { createNotifier } from '../lib/notify.js';
import { createAbuseGuard } from '../lib/abuse.js';
import { createMockMailer } from '../lib/mailers.js';

class MemStore extends BaseStore {}
const silent = { error() {}, warn() {}, info() {} };

function populated(n) {
  const store = new MemStore();
  const now = Date.now();
  const orders = {}, checkouts = {}, outbox = [], mailboxes = [];
  for (let i = 0; i < n; i++) {
    const id = `ord_${i}`;
    const createdAt = new Date(now - (n - i) * 60_000).toISOString();
    orders[id] = { id, createdAt, status: i % 10 === 0 ? 'partial_failure' : 'completed', contact: { email: `u${i}@x.io`, company: i === 7 ? 'Zebra Labs' : 'Co' }, domains: [{ name: `d${i}.com`, mailboxes: [] }], internalMargin: 2, quote: { total: 10 }, paymentId: 'pay_' + i,
      billing: { subscriptionId: `sub_${i}`, status: i % 7 === 0 ? 'past_due' : 'active', domainRenewals: [] }, progress: [] };
    checkouts['c' + i] = { id: 'c' + i, status: 'paid', createdAt, idempotencyKey: 'k' + i, gatewayOrderId: 'go_' + i, gatewaySubscriptionId: `sub_${i}`, contact: { email: `u${i}@x.io` }, cart: { domains: [{}] } };
    outbox.push({ id: 'e' + i, key: `order_ready:${id}:${id}`, type: 'order_ready', orderId: id, status: 'sent', sentAt: createdAt, nextAttemptAt: 0 });
    mailboxes.push({ id: 'm' + i, email: `a@d${i}.com`, orderId: id });
  }
  store.bulkLoad({ orders, checkouts, outbox, mailboxes });
  return store;
}

/** Time `fn` over `reps` calls, with a floor so near-zero timings do not make ratios meaningless. */
function ms(fn, reps) { const t = performance.now(); for (let i = 0; i < reps; i++) fn(i); return Math.max(1, performance.now() - t); }

test('scale: indexed lookups cost the same at 2,000 and 40,000 records (no full scans)', () => {
  const small = populated(2_000), big = populated(40_000);
  const lookups = (s, n) => (i) => {
    const k = (i * 37) % n;
    s.findCheckoutByKey('k' + k); s.findCheckoutByGatewayOrder('go_' + k); s.findOrderBySubscription('sub_' + k);
    s.findOrdersByEmail(`u${k}@x.io`); s.hasOutboxKey(`order_ready:ord_${k}:ord_${k}`); s.mailboxesOfOrder('ord_' + k); s.getMailbox('m' + k);
  };
  const t2 = ms(lookups(small, 2_000), 3_000);
  const t40 = ms(lookups(big, 40_000), 3_000);
  assert.ok(t40 / t2 < 8, `20x more data made lookups ${(t40 / t2).toFixed(1)}x slower (${t2.toFixed(0)} ms vs ${t40.toFixed(0)} ms): something scans`);
  assert.ok(t40 < 1_500, `21,000 lookups at 40,000 records took ${t40.toFixed(0)} ms`);
});

test('scale: the abuse guard and the email timer cost the window, not the history', async () => {
  const big = populated(40_000);
  const guard = createAbuseGuard({ store: big, env: { DAILY_DOMAIN_CAP: '1000000000' } });
  const tGuard = ms(() => guard.check({ email: 'new@x.io', ip: '1.2.3.4', domains: ['getnew.com'] }), 100);
  // Only ~1,440 of the 40,000 checkouts are inside the last 24 hours: that is all the guard may look at.
  assert.ok(big.recentCheckouts(Date.now() - 86_400_000).length < 1_500);
  assert.ok(tGuard / 100 < 25, `abuse.check took ${(tGuard / 100).toFixed(1)} ms each at 40,000 checkouts`);

  const notifier = createNotifier({ store: big, mailer: createMockMailer(), log: silent });
  const t = ms(() => { notifier.flush(); }, 20);   // nothing is pending: must not walk 40,000 sent emails
  assert.ok(t / 20 < 5, `flush with nothing pending took ${(t / 20).toFixed(1)} ms at 40,000 emails`);
  assert.equal(await notifier.flush(), 0);
});

/* ---------------- paginated admin list ---------------- */
test('admin list: counts are for ALL orders; filters, search, paging and ordering are applied on the server', () => {
  const store = populated(300);
  const all = listOrdersPage(store, { filter: 'all', limit: 50, offset: 0 });
  assert.equal(all.counts.orders, 300);
  assert.equal(all.total, 300);
  assert.equal(all.items.length, 50);
  assert.equal(all.items[0].id, 'ord_299', 'newest first');
  assert.equal(all.counts.margin, 600);

  const page3 = listOrdersPage(store, { filter: 'all', limit: 50, offset: 250 });
  assert.deepEqual([page3.items.length, page3.items.at(-1).id], [50, 'ord_0']);
  assert.equal(listOrdersPage(store, { filter: 'all', limit: 50, offset: 5000 }).items.length, 0);

  const failed = listOrdersPage(store, { filter: 'failed', limit: 200 });
  assert.equal(failed.total, 30);                                     // every 10th
  assert.ok(failed.items.every((o) => o.status === 'partial_failure'));
  assert.equal(failed.counts.orders, 300, 'cards still describe everything, not just this filter');

  const att = listOrdersPage(store, { filter: 'attention', limit: 200 });
  assert.ok(att.items.every((o) => o.problems.length > 0));
  assert.equal(att.total, att.counts.attention);
  assert.equal(listOrdersPage(store, { filter: 'past_due', limit: 200 }).total, 43);    // every 7th of 0..299
  assert.equal(listOrdersPage(store, { filter: 'active', limit: 200 }).total, 300 - 43);
});

test('admin list: search matches id, email, company, domain and subscription; inputs are clamped; secrets never appear', () => {
  const store = populated(300);
  store.getOrder('ord_9').manageToken = 'SUPER_SECRET_TOKEN';
  const ids = (q) => listOrdersPage(store, { filter: 'all', q }).items.map((o) => o.id);
  assert.deepEqual(ids('ord_150'), ['ord_150']);
  assert.deepEqual(ids('U42@X.IO'), ['ord_42']);
  assert.deepEqual(ids('zebra'), ['ord_7']);
  assert.deepEqual(ids('d99.com'), ['ord_99']);
  assert.deepEqual(ids('sub_201'), ['ord_201']);
  assert.deepEqual(ids('no such thing'), []);
  assert.equal(listOrdersPage(store, { filter: 'bogus' }).filter, 'attention', 'unknown filter falls back');
  assert.equal(listOrdersPage(store, { filter: 'all', limit: 99999 }).limit, 200);
  assert.equal(listOrdersPage(store, { filter: 'all', limit: -5, offset: -9 }).offset, 0);
  assert.equal(listOrdersPage(store, { filter: 'all', q: 'x'.repeat(5000) }).total, 0, 'an absurd search string is handled');
  assert.ok(!JSON.stringify(listOrdersPage(store, { filter: 'all', limit: 200 })).includes('SUPER_SECRET_TOKEN'), 'the manage token never leaves the server');
  assert.deepEqual(FILTERS, ['attention', 'all', 'past_due', 'failed', 'active']);
});

test('admin list: a page of 50 out of 40,000 orders is built quickly (only the page gets the heavy view)', () => {
  const big = populated(40_000);
  const t = performance.now();
  const page = listOrdersPage(big, { filter: 'all', q: 'd39999', limit: 50 });
  const took = performance.now() - t;
  assert.equal(page.items[0].id, 'ord_39999');
  assert.ok(took < 2_500, `one page over 40,000 orders took ${took.toFixed(0)} ms`);
});
