#!/usr/bin/env node
// Fill an EMPTY database with realistic sample orders so you can explore the dashboard, the manage page and the
// alerts without making purchases.   node scripts/seed-demo.js [--orders 120]
// Uses the same STORE / DATA_FILE / SQLITE_FILE as the server and refuses to touch a database that already has data.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { createBillingService, buildSchedule } from '../lib/billing.js';
import { quote } from '../lib/pricing.js';
import { seal } from '../lib/crypto.js';
import { createNotifier } from '../lib/notify.js';
import { createMockMailer } from '../lib/mailers.js';

const args = process.argv.slice(2);
const N = Math.max(10, Number(args[args.indexOf('--orders') + 1]) || 120);
const root = fileURLToPath(new URL('..', import.meta.url));
const store = await createStore(process.env, join(root, 'data', 'db.json'));
if (store.listOrders().length) { console.error('This database already has orders: refusing to add demo data to it.'); process.exit(1); }

const FIRST = ['Asha', 'Ben', 'Chitra', 'Dev', 'Elena', 'Farid', 'Grace', 'Hiro', 'Imani', 'Jonas'];
const LAST = ['Rao', 'Lee', 'Iyer', 'Patel', 'Rossi', 'Khan', 'Park', 'Sato', 'Okafor', 'Berg'];
const CO = ['Acme', 'Zebra Labs', 'Northwind', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark', 'Wayne', 'Wonka'];
const DAY = 86_400_000, now = Date.now();
const steps = (status = 'done') => Object.fromEntries(['register', 'nameservers', 'connect_domain', 'dns_base', 'mailboxes', 'mailboxes_ready', 'dns_dkim', 'connect'].map((s) => [s, { status, attempts: 1 }]));

const svc = createBillingService({ store, providers: { payments: { name: 'demo' } }, log: { error() {}, warn() {}, info() {} } });
const orders = {}, mailboxes = [], checkouts = {}, outbox = [];

for (let i = 0; i < N; i++) {
  const id = `ord_${(0xd3a000 + i * 7919).toString(16).padStart(12, '0')}`;
  const created = now - (N - i) * 7 * 3_600_000 - (i % 5) * DAY;
  const nMail = 2 + (i % 4);
  const domain = `${['get', 'try', 'use', 'join'][i % 4]}${CO[i % CO.length].toLowerCase().replace(/\W/g, '')}${i}.com`;
  const q = quote({ provider: 'google', plan: 'quarterly', domains: [domain], mailboxes: Array.from({ length: nMail }, (_, k) => ({ firstName: 'A', lastName: 'B', emailPrefix: 'm' + k })) });
  const prefixes = ['asha.rao', 'rao.asha', 'asha', 'asha.r', 'a.rao'].slice(0, nMail);
  const order = {
    id, createdAt: new Date(created).toISOString(), userId: 'demo-user', status: 'completed', provider: 'google', plan: 'quarterly',
    contact: { firstName: FIRST[i % 10], lastName: LAST[(i * 3) % 10], company: CO[i % 10], email: `${FIRST[i % 10].toLowerCase()}.${LAST[(i * 3) % 10].toLowerCase()}${i}@example.com`, phoneCc: '91', phone: '9800000000' },
    domains: [{ name: domain, mailboxes: prefixes.map((p) => ({ firstName: FIRST[i % 10], lastName: LAST[(i * 3) % 10], emailPrefix: p })) }],
    quote: q, internalMargin: Math.round(q.total * 0.3 * 100) / 100, paymentId: 'pay_demo_' + i, manageToken: 'demo_token_' + i,
    progress: [{ domain, steps: steps() }]
  };
  const mode = i % 12;                      // the mix of situations
  order.billing = svc.init({ schedule: buildSchedule(q), subscriptionId: 'sub_demo_' + i, planIds: { renewal: 'plan_r', base: 'plan_b' }, subscription: { paid_count: 1 + (i % 3), current_end: (now + (30 + (i % 50)) * DAY) / 1000 } });
  order.billing.paidCount = 1 + (i % 3); order.billing.processedCycles = Array.from({ length: order.billing.paidCount }, (_, k) => k + 1); order.billing.plan = 'base';
  const mbs = prefixes.map((p) => ({ email: `${p}@${domain}`, orderId: id, userId: 'demo-user', provider: 'google', status: 'ready_for_warmup', warmup: i % 3 === 0 ? 'warming' : 'queued', smtp: { host: 'smtp.gmail.com', port: 587 }, createdAt: order.createdAt, credentialsEnc: seal({ username: `${p}@${domain}`, appPassword: 'demo-app-password' }) }));

  if (mode === 3) { Object.assign(order.billing, { status: 'past_due', graceEndsAt: now + 4 * DAY, updateUrl: 'https://pay.example/hosted/' + i }); }
  if (mode === 5) { Object.assign(order.billing, { status: 'suspended', suspendedAt: now - 2 * DAY }); mbs.forEach((m) => Object.assign(m, { suspended: true, suspendedReason: 'non_payment', statusBeforeSuspend: m.status, status: 'suspended' })); }
  if (mode === 7) { order.status = 'partial_failure'; order.progress[0].steps.mailboxes = { status: 'failed', attempts: 3, error: 'Vendor POST /v2/mailboxes failed (503): upstream unavailable' }; for (const k of ['mailboxes_ready', 'dns_dkim', 'connect']) order.progress[0].steps[k] = { status: 'pending' }; mbs.length = 0; }
  if (mode === 9) { Object.assign(order.billing, { status: 'cancelling', cancelAtPeriodEnd: true, endsAt: now + 20 * DAY }); }
  if (mode === 10) { order.billing.domainRenewals = [{ cycle: 5, domain, status: 'pending', attempts: 2, error: 'registrar balance too low', nextAttemptAt: now + 3_600_000 }]; }
  if (mode === 11) { order.billing.needsAttention = 'Payment received after termination but vendor removal could not be cancelled'; order.billing.status = 'terminated'; }
  orders[id] = order; mailboxes.push(...mbs);
  checkouts['chk_demo_' + i] = { id: 'chk_demo_' + i, status: 'paid', orderId: id, createdAt: order.createdAt, gatewaySubscriptionId: 'sub_demo_' + i, contact: { email: order.contact.email }, cart: { domains: [{}] } };
  outbox.push({ id: 'eml_demo_' + i, key: `order_ready:${id}:${id}`, type: 'order_ready', orderId: id, status: mode === 2 ? 'dead' : 'sent', attempts: mode === 2 ? 6 : 1, error: mode === 2 ? 'Email provider error 403: domain not verified' : undefined, nextAttemptAt: 0, createdAt: order.createdAt, sentAt: order.createdAt });
}
store.bulkLoad({ orders, mailboxes, checkouts, outbox });
const counts = Object.values(orders).reduce((m, o) => { const k = o.status === 'partial_failure' ? 'failed provisioning' : o.billing.status; m[k] = (m[k] || 0) + 1; return m; }, {});
console.log(`seeded ${N} demo orders: ${JSON.stringify(counts)}; ${mailboxes.length} mailboxes; 1 in 12 emails undeliverable`);
console.log('Demo manage link for order 0:  /manage.html#o=' + Object.keys(orders)[0] + '&t=demo_token_0');
store.close();
