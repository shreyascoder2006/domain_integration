// "What needs a human?" in one place: used by the admin dashboard, the alerts, and the metrics.
// Each problem has a stable `code` (so alerts can de-duplicate) and a readable `message`.

export function orderProblems(o) {
  const out = [];
  if (o.status === 'partial_failure') out.push({ code: 'provisioning_failed', message: 'Provisioning failed' });
  const b = o.billing;
  if (b) {
    if (b.needsAttention) out.push({ code: 'needs_attention', message: b.needsAttention });
    if (b.planError) out.push({ code: 'plan_change_failing', message: `Plan change failing: ${b.planError}` });
    if (['past_due', 'suspended', 'terminated'].includes(b.status)) out.push({ code: `billing_${b.status}`, message: `Billing: ${b.status.replace('_', ' ')}` });
    for (const r of b.domainRenewals || []) {
      if (r.status !== 'done') out.push({ code: `renewal_${r.status}:${r.domain}:${r.cycle}`, message: `Renewal ${r.status}: ${r.domain}${r.error ? ` (${r.error})` : ''}` });
    }
  }
  return out;
}

/** Problems not tied to one order: dead emails, an empty outbox of hope. */
export function systemProblems(store) {
  const dead = store.outboxWithStatus('dead');
  return dead.map((i) => ({ code: `email_dead:${i.id}`, message: `Email "${i.type}" for ${i.orderId} could not be delivered: ${i.error || 'unknown error'}` }));
}
