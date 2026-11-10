const round = (n) => Math.round(n * 100) / 100;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

export const refundedSoFar = (order) => round(sum((order.refunds || []).map((r) => r.amount)));

/**
 * Suggested refund for an order: pro-rata share of the total for every domain
 * that did not finish all steps, minus what was already refunded.
 * (Policy choice: sunk costs such as an already-registered domain are NOT
 * deducted. Adjust here if the business decides otherwise.)
 */
export function suggestedRefund(order) {
  const failedDomains = (order.progress || [])
    .filter((p) => Object.values(p.steps).some((s) => s.status !== 'done'))
    .map((p) => p.domain);
  const failedBoxes = order.domains
    .filter((d) => failedDomains.includes(d.name))
    .reduce((n, d) => n + d.mailboxes.length, 0);
  const gross = round(order.quote.total * (failedBoxes / order.quote.mailboxCount));
  return { failedDomains, amount: round(Math.max(0, gross - refundedSoFar(order))) };
}

/** Validate an admin-requested refund amount against what is still refundable. */
export function checkRefundAmount(order, amount) {
  const max = round(order.quote.total - refundedSoFar(order));
  if (!(amount > 0)) throw Object.assign(new Error('Refund amount must be positive'), { status: 400 });
  if (amount > max) throw Object.assign(new Error(`Refund exceeds remaining refundable amount (${max})`), { status: 400 });
  return amount;
}
