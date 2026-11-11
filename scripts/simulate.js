#!/usr/bin/env node
// Drive the billing lifecycle of a running server without waiting weeks or touching a real gateway.
//
//   node scripts/simulate.js <event> [orderId|latest] [--advance <days>] [--url http://localhost:3000]
//
//   events:  charged  pending  halted  cancelled  completed  updated
//   --advance N  jump the server's billing clock forward N days (needs DEV_TOOLS=1, never works in production)
//
// Needs ADMIN_TOKEN (to find the order) and the webhook secret the server verifies with:
// MOCK_WEBHOOK_SECRET (mock payments, default "mock-webhook-secret") or RAZORPAY_WEBHOOK_SECRET.
//
// Typical demo:   simulate pending latest  ->  simulate halted latest --advance 8  (suspended)  ->  simulate charged latest  (reinstated)
import { createHmac, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const EVENTS = ['charged', 'pending', 'halted', 'cancelled', 'completed', 'updated'];

/** The Razorpay-shaped webhook body for `type`, derived from an order's billing state. */
export function buildEvent(type, billing, { nowMs = Date.now() } = {}) {
  if (!EVENTS.includes(type)) throw new Error(`Unknown event "${type}". Use one of: ${EVENTS.join(', ')}`);
  const planId = billing.planIds?.[billing.plan] ?? Object.values(billing.planIds || {})[0];
  const paid = type === 'charged' ? billing.paidCount + 1 : billing.paidCount;
  const periodSec = (billing.schedule?.periodMonths ?? 3) * 30 * 86400;
  const subscription = {
    id: billing.subscriptionId, entity: 'subscription', plan_id: planId, status: { charged: 'active', pending: 'pending', halted: 'halted', cancelled: 'cancelled', completed: 'completed', updated: 'active' }[type],
    paid_count: paid, current_start: Math.floor(nowMs / 1000), current_end: Math.floor(nowMs / 1000) + periodSec,
    ...(type === 'cancelled' || type === 'completed' ? { ended_at: Math.floor(nowMs / 1000) } : {}),
    short_url: `https://pay.example/hosted/${billing.subscriptionId}`
  };
  const payload = { subscription: { entity: subscription } };
  if (type === 'charged') payload.payment = { entity: { id: 'pay_sim_' + randomBytes(4).toString('hex'), status: 'captured', invoice_id: 'inv_sim', amount: 0, currency: billing.schedule?.currency || 'USD' } };
  return { entity: 'event', event: `subscription.${type}`, contains: ['subscription'], payload, created_at: Math.floor(nowMs / 1000) };
}

export const sign = (body, secret) => createHmac('sha256', secret).update(body).digest('hex');

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const [, v] = args.splice(i, 2); return v ?? dflt; };
  const url = (flag('--url', process.env.SIM_URL || 'http://localhost:3000')).replace(/\/$/, '');
  const advance = Number(flag('--advance', 0));
  const [type, which = 'latest'] = args;
  if (!type || !EVENTS.includes(type)) { console.error(`Usage: simulate <${EVENTS.join('|')}> [orderId|latest] [--advance days] [--url ...]`); process.exit(2); }
  const admin = process.env.ADMIN_TOKEN;
  if (!admin) { console.error('Set ADMIN_TOKEN (the same value the server uses).'); process.exit(2); }

  const listed = await (await fetch(`${url}/api/admin/orders?filter=all&limit=200`, { headers: { 'x-admin-token': admin } })).json();
  const orders = listed.items;
  if (!Array.isArray(orders)) { console.error('Could not list orders:', listed.error || listed); process.exit(1); }
  const subs = orders.filter((o) => o.billing).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const order = which === 'latest' ? subs[0] : subs.find((o) => o.id === which);
  if (!order) { console.error('No subscription order found.'); process.exit(1); }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.MOCK_WEBHOOK_SECRET || 'mock-webhook-secret';
  const body = JSON.stringify(buildEvent(type, order.billing));
  const res = await fetch(`${url}/api/webhooks/razorpay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sign(body, secret), 'x-razorpay-event-id': 'evt_sim_' + randomBytes(6).toString('hex') }, body });
  console.log(`${order.id}  subscription.${type}  ->  HTTP ${res.status}  ${await res.text()}`);

  if (advance > 0) {
    const r = await fetch(`${url}/api/admin/dev/advance`, { method: 'POST', headers: { 'x-admin-token': admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ days: advance }) });
    console.log(`advance ${advance} day(s)  ->  HTTP ${r.status}  ${await r.text()}`);
  }
  const after = (await (await fetch(`${url}/api/admin/orders?filter=all&limit=200`, { headers: { 'x-admin-token': admin } })).json()).items.find((o) => o.id === order.id);
  console.log(`billing now: ${after.billing.status}, paid cycles ${after.billing.paidCount}, problems: ${after.problems.map((p) => p.message).join('; ') || 'none'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
