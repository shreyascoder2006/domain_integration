import { config } from './config.js';

const round = (n) => Math.round(n * 100) / 100;

/**
 * Compute a quote. Throws Error with .status = 400 on invalid input.
 * input: { provider, plan, domains: string[], mailboxes: [{...}] }
 */
export function quote({ provider, plan, domains = [], mailboxes = [] }) {
  const fail = (m) => { throw Object.assign(new Error(m), { status: 400, expose: true }); };

  if (!config.providers[provider]) fail('Unknown provider');
  if (!domains.length) fail('Select at least one domain');
  if (!mailboxes.length) fail('Add at least one mailbox');

  const domainTotal = round(domains.length * config.domainPricePerYear);
  let recurring, recurringLabel, billingMonths, mailboxCount = mailboxes.length, detail;

  if (provider === 'azure') {
    const a = config.azure;
    const tenants = Math.ceil(mailboxCount / a.mailboxesPerTenant);
    billingMonths = a.billingMonths;
    recurring = round(tenants * a.pricePerTenantMonth * a.billingMonths);
    recurringLabel = `${tenants} Azure tenant${tenants > 1 ? 's' : ''} (per ${a.billingMonths} months)`;
    detail = { tenants };
  } else {
    const p = config.plans[plan];
    if (!p) fail('Unknown plan');
    if (mailboxCount < p.minMailboxes) fail(`${p.label} requires at least ${p.minMailboxes} mailboxes`);
    billingMonths = p.billingMonths;
    recurring = round(mailboxCount * p.pricePerMailboxMonth * p.billingMonths);
    recurringLabel = `Email accounts (per ${p.billingMonths === 12 ? 'year' : 'quarter'})`;
    detail = { pricePerMailboxMonth: p.pricePerMailboxMonth };
  }

  return {
    currency: config.currency,
    domainCount: domains.length,
    mailboxCount,
    billingMonths,
    lines: [
      { key: 'domains', label: 'Domains (per year)', amount: domainTotal },
      { key: 'mailboxes', label: recurringLabel, amount: recurring }
    ],
    total: round(domainTotal + recurring),
    ...detail
  };
}

/** Internal margin view (admin only, not exposed to customers). */
export function margin(q) {
  const cost = q.mailboxCount * config.vendorCostPerMailboxMonth * q.billingMonths +
               q.domainCount * config.registrarCostPerYear;
  return round(q.total - cost);
}
