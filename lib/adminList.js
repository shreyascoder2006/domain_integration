// The admin "orders" list, paginated and searchable on the server, so the dashboard stays fast with 100,000 orders
// (the old endpoint returned every order with every detail in one response).
import { publicOrder } from './provisioner.js';
import { orderProblems } from './problems.js';
import { suggestedRefund } from './refunds.js';

export const FILTERS = ['attention', 'all', 'past_due', 'failed', 'active'];
const BAD_BILLING = new Set(['past_due', 'suspended', 'terminated']);

const haystack = (o) => [o.id, o.contact?.email, o.contact?.company, o.contact?.lastName, o.paymentId, o.billing?.subscriptionId, ...(o.domains || []).map((d) => d.name)]
  .filter(Boolean).join(' ').toLowerCase();

/** The full admin view of ONE order (what the dashboard expands). */
export function adminView(o) {
  return {
    ...publicOrder(o, { admin: true }),
    internalMargin: o.internalMargin,
    billing: o.billing || null, // full detail: plan ids, history, renewals, anything needing attention
    problems: orderProblems(o),
    refunds: o.refunds || [],
    suggestedRefund: o.progress ? suggestedRefund(o) : null
  };
}

/**
 * One pass over the orders for the cards (counts are always for ALL orders), then filter, search, sort newest first,
 * and build the heavy view for just the requested page.
 */
export function listOrdersPage(store, { filter = 'attention', q = '', limit = 50, offset = 0 } = {}) {
  if (!FILTERS.includes(filter)) filter = 'attention';
  limit = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 50));
  offset = Math.max(0, Math.floor(Number(offset)) || 0);
  const needle = String(q || '').trim().toLowerCase().slice(0, 100);

  const counts = { orders: 0, attention: 0, pastDue: 0, failed: 0, active: 0, margin: 0 };
  const matches = [];
  for (const o of store.listOrders()) {
    counts.orders++;
    counts.margin += o.internalMargin || 0;
    const problems = orderProblems(o).length > 0;
    if (problems) counts.attention++;
    if (BAD_BILLING.has(o.billing?.status)) counts.pastDue++;
    if (o.status === 'partial_failure') counts.failed++;
    if (o.billing?.status === 'active') counts.active++;

    const inFilter = filter === 'all' ? true : filter === 'attention' ? problems : filter === 'past_due' ? BAD_BILLING.has(o.billing?.status)
      : filter === 'failed' ? o.status === 'partial_failure' : o.billing?.status === 'active';
    if (inFilter && (!needle || haystack(o).includes(needle))) matches.push(o);
  }
  counts.margin = Math.round(counts.margin * 100) / 100;
  matches.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { total: matches.length, counts, filter, limit, offset, items: matches.slice(offset, offset + limit).map(adminView) };
}
