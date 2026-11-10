// Single place for pricing and rules. Numbers mirror the Saleshandy reference
// screens; change here, nothing else needs to know.
export const config = {
  currency: 'USD',
  domainPricePerYear: 14.0,
  recommendedMailboxesPerDomain: 4,
  maxMailboxesPerDomain: 5,
  tld: 'com',

  // Per-mailbox providers (Google Workspace, Microsoft 365)
  plans: {
    quarterly:   { label: 'Quarterly',     pricePerMailboxMonth: 3.99, billingMonths: 3,  minMailboxes: 1,  replacement: false, commitment: 'No annual commitment' },
    annual_flexi:{ label: 'Annual Flexi',  pricePerMailboxMonth: 3.49, billingMonths: 12, minMailboxes: 25, replacement: true,  commitment: 'Annual commitment', note: 'Free mailbox replacement (needs new domain)' },
    annual_fixed:{ label: 'Annual Fixed',  pricePerMailboxMonth: 2.99, billingMonths: 12, minMailboxes: 1,  replacement: false, commitment: 'Annual commitment' }
  },

  // Azure / dedicated SMTP: priced per tenant, 50 mailboxes included
  azure: { pricePerTenantMonth: 20, billingMonths: 3, mailboxesPerTenant: 50, label: 'Azure (per tenant)' },

  providers: {
    google:    { label: 'Google Workspace' },
    microsoft: { label: 'Microsoft 365' },
    azure:     { label: 'Azure' }
  },

  // Recurring billing rules. Business decisions: change here.
  billing: {
    maxYears: 10,                                                    // Razorpay: a subscription can charge for at most 10 years
    get graceDays() { return Number(process.env.BILLING_GRACE_DAYS ?? 7); },         // after all charge retries fail, keep service this long
    get retentionDays() { return Number(process.env.BILLING_RETENTION_DAYS ?? 14); } // suspended mailboxes are kept this long, then removed
  },

  // Internal only. Never returned to the customer (white-label).
  vendorCostPerMailboxMonth: 2.75,
  registrarCostPerYear: 10.5
};
