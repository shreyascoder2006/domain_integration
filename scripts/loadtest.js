#!/usr/bin/env node
// Where does this break as the data grows?  Builds a synthetic database and times the things the server does.
//
//   node scripts/loadtest.js [--orders 5000] [--store json|sqlite|both]
//
// No network and no real services: it exercises the store, the timers, the abuse guard and the lookups directly.
// Numbers are for THIS machine; compare runs, not absolutes. Writes only to a temp folder.
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { SqliteStore } from '../lib/store/sqlite.js';
import { createBillingService, buildSchedule } from '../lib/billing.js';
import { createNotifier } from '../lib/notify.js';
import { createAlerter } from '../lib/alerts.js';
import { createAbuseGuard } from '../lib/abuse.js';
import { renderMetrics, createHttpCounters } from '../lib/metrics.js';
import { createMockMailer } from '../lib/mailers.js';
import { resumeDue, publicOrder } from '../lib/provisioner.js';
import { orderProblems } from '../lib/problems.js';
import { listOrdersPage } from '../lib/adminList.js';
import { quote } from '../lib/pricing.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const N = Number(flag('--orders', 5000));
const which = flag('--store', 'both');
const silent = { error() {}, warn() {}, info() {} };
const DAY = 86_400_000;

function dataset(n) {
  const now = Date.now();
  const orders = {}, mailboxes = [], checkouts = {}, outbox = [];
  const q = quote({ provider: 'google', plan: 'quarterly', domains: ['a.com'], mailboxes: [1, 2, 3].map((i) => ({ firstName: 'A', lastName: 'B', emailPrefix: 'm' + i })) });
  const schedule = buildSchedule(q);
  const steps = () => Object.fromEntries(['register', 'nameservers', 'connect_domain', 'dns_base', 'mailboxes', 'mailboxes_ready', 'dns_dkim', 'connect'].map((s) => [s, { status: 'done', attempts: 1 }]));
  for (let i = 0; i < n; i++) {
    const id = `ord_${i.toString(16).padStart(12, '0')}`;
    const createdAt = new Date(now - (n - i) * 60_000).toISOString();
    const state = i % 97 === 0 ? 'failed' : i % 53 === 0 ? 'past_due' : 'ok';
    orders[id] = {
      id, createdAt, status: state === 'failed' ? 'partial_failure' : 'completed', provider: 'google', userId: 'u' + (i % 500),
      contact: { firstName: 'A', lastName: 'B', company: 'Co', email: `user${i}@example.com` },
      domains: [{ name: `d${i}.com`, mailboxes: [1, 2, 3].map((k) => ({ firstName: 'A', lastName: 'B', emailPrefix: 'm' + k })) }],
      quote: q, paymentId: 'pay_' + i, manageToken: 'tok' + i, internalMargin: 5,
      progress: [{ domain: `d${i}.com`, steps: steps() }],
      billing: {
        gateway: 'mock', subscriptionId: `sub_${i}`, planIds: { renewal: 'pr', base: 'pb' }, schedule, plan: 'base',
        status: state === 'past_due' ? 'past_due' : 'active', paidCount: 2, processedCycles: [1, 2], currentEnd: now + 30 * DAY, graceEndsAt: state === 'past_due' ? now + 3 * DAY : null,
        cancelAtPeriodEnd: false, domainRenewals: [], history: [{ at: createdAt, event: 'subscribed', detail: 'cycle 1 paid' }]
      }
    };
    for (let k = 1; k <= 3; k++) mailboxes.push({ id: `mbx_${i}_${k}`, email: `m${k}@d${i}.com`, orderId: id, userId: 'u' + (i % 500), provider: 'google', status: 'ready_for_warmup', credentialsEnc: 'enc:v1:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
    const coId = 'chk_' + i;
    checkouts[coId] = { id: coId, status: 'paid', orderId: id, createdAt, idempotencyKey: 'key' + i, gatewayOrderId: 'order_' + i, gatewaySubscriptionId: `sub_${i}`, contact: { email: `user${i}@example.com` }, cart: { domains: [{}] }, ipHash: 'ip' + (i % 800) };
    for (const [j, type] of ['order_ready', 'renewal_reminder', 'payment_failed'].entries()) outbox.push({ id: `eml_${i}_${j}`, key: j === 0 ? `order_ready:${id}:${id}` : `${type}:${id}:${j}`, type, orderId: id, status: i % 200 === 0 && j === 2 ? 'pending' : 'sent', attempts: 1, nextAttemptAt: i % 200 === 0 && j === 2 ? now - 1000 : 0, createdAt, sentAt: createdAt });
  }
  return { orders, mailboxes, checkouts, outbox };
}

const rows = [];
async function time(label, fn, reps = 1) {
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) await fn(i);
  const ms = performance.now() - t0;
  rows.push([label, reps > 1 ? `${(ms / reps).toFixed(3)} ms/op  (x${reps})` : `${ms.toFixed(1)} ms`]);
  return ms;
}

async function run(kind) {
  rows.length = 0;
  const dir = mkdtempSync(join(tmpdir(), `cl-load-${kind}-`));
  const store = kind === 'sqlite' ? new SqliteStore(join(dir, 'db.sqlite')) : new Store(join(dir, 'db.json'));
  const providers = { payments: { name: 'x' }, registrar: {}, vendor: {} };
  const mailer = createMockMailer();
  const svc = createBillingService({ store, providers, log: silent });
  const notifier = createNotifier({ store, mailer, log: silent, summarize: (o) => svc.summary(o) });
  const alerter = createAlerter({ store, sinks: [], log: silent });
  const abuse = createAbuseGuard({ store, env: { DAILY_DOMAIN_CAP: '100000000' } }); // the cap would (correctly) trip on the synthetic data
  const ids = []; // sampled after load

  const data = dataset(N);
  await time(`build + bulk load ${N} orders / ${data.mailboxes.length} mailboxes / ${data.outbox.length} emails`, () => store.bulkLoad(data));
  const orderIds = store.listOrders().map((o) => o.id);
  for (let i = 0; i < 200; i++) ids.push(orderIds[(i * 7919) % orderIds.length]);

  const writes = kind === 'json' ? 30 : 300;
  await time('WRITE: putOrder (one change)', (i) => { const o = store.getOrder(ids[i % ids.length]); o.status = 'completed'; store.putOrder(o); }, writes);
  await time('WRITE: addOutbox (one email queued)', (i) => store.addOutbox({ id: `eml_new_${i}`, key: `new:${i}`, type: 'order_ready', orderId: ids[0], status: 'sent', attempts: 0, nextAttemptAt: 0, createdAt: new Date().toISOString(), sentAt: new Date().toISOString() }), writes);

  await time('LOOKUP: findCheckoutByKey', (i) => store.findCheckoutByKey('key' + ((i * 31) % N)), 500);
  await time('LOOKUP: findCheckoutByGatewayOrder', (i) => store.findCheckoutByGatewayOrder('order_' + ((i * 31) % N)), 500);
  await time('LOOKUP: findOrderBySubscription', (i) => store.findOrderBySubscription('sub_' + ((i * 31) % N)), 500);
  await time('LOOKUP: findOrdersByEmail', (i) => store.findOrdersByEmail(`user${(i * 31) % N}@example.com`), 500);
  await time('LOOKUP: notify() de-duplication check', (i) => notifier.notify('order_ready', store.getOrder(ids[i % ids.length]), {}), 500);
  await time('REQUEST: abuse.check (every checkout)', () => abuse.check({ email: 'new@example.com', ip: '1.2.3.4', domains: ['getnew.com'] }), 200);

  await time('TIMER: resumeDue', () => resumeDue({ providers, store }));
  await time('TIMER: billing.tick', () => svc.tick());
  await time('TIMER: notifier.flush', () => notifier.flush());
  await time('TIMER: alerter.scan (first run: raises every alert)', () => alerter.scan());
  await time('TIMER: alerter.scan (steady state)', () => alerter.scan());
  await time('TIMER: purge + prune', () => { store.purgeStaleCheckouts(14 * DAY); store.pruneOutbox(30 * DAY); });
  await time('SCRAPE: /metrics render', () => renderMetrics({ store, http: createHttpCounters() }));
  await time('ADMIN: dashboard page (attention filter, 50 rows + counts)', () => JSON.stringify(listOrdersPage(store, { filter: 'attention', limit: 50 })));
  await time('ADMIN: search one order among all', () => JSON.stringify(listOrdersPage(store, { filter: 'all', q: `d${Math.floor(N / 2)}.com`, limit: 50 })));
  await time('(for comparison) the OLD endpoint: every order, every detail', () => JSON.stringify(store.listOrders().map((o) => ({ ...publicOrder(o, { admin: true }), billing: o.billing, problems: orderProblems(o) }))));
  rows.push(['MEMORY: resident set size after load', `${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`]);

  const w = Math.max(...rows.map((r) => r[0].length));
  console.log(`\n=== ${kind.toUpperCase()} store, ${N} orders ===`);
  for (const [l, v] of rows) console.log(`${l.padEnd(w)}  ${v}`);
  store.close?.();
  rmSync(dir, { recursive: true, force: true });
}

for (const kind of which === 'both' ? ['json', 'sqlite'] : [which]) await run(kind);
