// Receipts: one per paid billing cycle, rebuilt from the order (nothing extra is stored).
// A receipt is not necessarily a tax invoice: tax wording and numbering rules depend on your jurisdiction.
// Seller details and the tax note come from the environment so your accountant can set them.
import { amountForCycle, isDomainCycle } from './billing.js';

export function sellerFromEnv(env = process.env) {
  return {
    title: env.INVOICE_TITLE || 'Receipt',
    name: env.INVOICE_SELLER_NAME || env.PAYMENT_MERCHANT_NAME || 'CloudLead',
    address: env.INVOICE_SELLER_ADDRESS || '',
    taxId: env.INVOICE_TAX_ID || '',
    taxLabel: env.INVOICE_TAX_LABEL || 'Tax ID',
    taxNote: env.INVOICE_TAX_NOTE || ''
  };
}

const round = (n) => Math.round(n * 100) / 100;

export function buildReceipts(order, seller = sellerFromEnv()) {
  const q = order.quote;
  const cur = q.currency;
  const b = order.billing;
  const billTo = { name: `${order.contact?.firstName || ''} ${order.contact?.lastName || ''}`.trim(), company: order.contact?.company || '', email: order.contact?.email || '' };
  const nDomains = order.domains.length;
  const nBoxes = order.domains.reduce((n, d) => n + d.mailboxes.length, 0);
  const domainFee = q.lines.find((l) => l.key === 'domains')?.amount ?? 0;
  const boxFee = q.lines.find((l) => l.key === 'mailboxes')?.amount ?? 0;

  const make = (cycle, date, includeDomains, paymentId) => {
    const items = [];
    if (includeDomains && nDomains) items.push({ description: `Domain registration/renewal x ${nDomains} (1 year)`, amount: round(domainFee) });
    items.push({ description: `Email mailboxes x ${nBoxes} (${b ? (b.schedule.periodMonths === 12 ? '12 months' : `${b.schedule.periodMonths} months`) : 'billing period'})`, amount: round(boxFee) });
    const total = round(items.reduce((s, i) => s + i.amount, 0));
    return { number: `${order.id}-${cycle}`, cycle, date, currency: cur, items, total, paymentId: paymentId ?? null, billTo, seller };
  };

  if (!b) return [make(1, order.createdAt, true, order.paymentId)];
  const chargedAt = Object.fromEntries((b.history || []).filter((h) => h.event === 'charged').map((h) => [Number(String(h.detail).replace(/\D/g, '')), h.at]));
  const receipts = [...b.processedCycles].sort((a, c) => a - c).map((cycle) => {
    const date = cycle === 1 ? order.createdAt : chargedAt[cycle] || null;
    const r = make(cycle, date, isDomainCycle(cycle, b.schedule), cycle === 1 ? order.paymentId : null);
    r.total = round(amountForCycle(cycle, b.schedule)); // the amount the gateway actually charged for that cycle
    return r;
  });
  const credits = (order.refunds || []).filter((r) => r.status !== 'failed').map((r) => ({ number: `${order.id}-refund-${r.id}`, date: r.at, currency: cur, amount: r.amount, reason: r.reason || '' }));
  return Object.assign(receipts, { credits });
}

