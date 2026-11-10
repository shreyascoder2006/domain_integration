// Provider registry. To go live, add e.g. namesilo.js / zapmail.js exporting
// objects with the same shape as the mocks, then select them via env vars.
//
//   registrar:     checkAvailability(domains[]) -> [{domain, available}]
//                  register({domain, contact, years}) -> {domain, registeredAt}
//   dns:           applyRecords(domain, records[]) ; setForwarding(domain, url)
//   mailboxVendor: createMailboxes({domain, provider, accounts[]}) -> {dkim?, mailboxes[]}
//                  optional: managesDns + nameServers + connectDomain(domain) + configureDomain(...)
//                  optional: collectMailboxes({domain, provider, emails[]}) -> {mailboxes[]} (async vendors)
//                  optional: checkCapacity({provider, mailboxCount}) -> {ok}; getCapacity() for admins
//                  Adapters throw PendingError (lib/errors.js) for "still working, check later".
//   payments:      createCheckout({amount, currency, receipt, notes, customer}) -> {mode, gatewayOrderId, amountMinor, client}
//                  confirm({gatewayOrderId, paymentId, signature, amountMinor, currency}) -> {paymentId, status:'succeeded'}
//                  refund({paymentId, amount, currency, idempotencyKey, reason}) -> {id, status}
//                  optional: verifyWebhook(rawBody, headers) -> {id, type, payment, order, refund}
//                  Errors with `expose: true` + `status` are shown to customers; all others become a generic 500.
import { mockRegistrar, mockDns, mockMailboxVendor, mockPayments } from './mock.js';
import { createCloudflareDns } from './cloudflare.js';
import { createNameSiloRegistrar } from './namesilo.js';
import { createZapmailVendor } from './zapmail.js';
import { createRazorpayPayments } from './razorpay.js';

const registrars = {
  mock: () => mockRegistrar,
  namesilo: () => createNameSiloRegistrar({
    apiKey: process.env.NAMESILO_API_KEY,
    baseUrl: process.env.NAMESILO_BASE_URL,
    autoRenew: process.env.NAMESILO_AUTO_RENEW
  })
};
const dnsProviders = {
  mock: () => mockDns,
  cloudflare: () => createCloudflareDns({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID })
};
const vendors = {
  mock: () => mockMailboxVendor,
  zapmail: () => createZapmailVendor({
    apiKey: process.env.ZAPMAIL_API_KEY,
    workspaceKey: process.env.ZAPMAIL_WORKSPACE_KEY,
    webhookSecret: process.env.ZAPMAIL_WEBHOOK_SECRET,
    baseUrl: process.env.ZAPMAIL_BASE_URL,
    nameServers: process.env.ZAPMAIL_NAMESERVERS?.split(',').map((s) => s.trim()).filter(Boolean)
  })
};
const payments = {
  mock: () => mockPayments,
  razorpay: () => createRazorpayPayments({
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    merchantName: process.env.PAYMENT_MERCHANT_NAME || 'CloudLead'
  })
};

// Adapters are factories so a real one only reads its env keys when selected.
const pick = (table, envKey) => {
  const name = process.env[envKey] || 'mock';
  if (!table[name]) throw new Error(`${envKey}=${name} is not a registered adapter (have: ${Object.keys(table).join(', ')})`);
  return table[name]();
};

export function loadProviders() {
  return {
    registrar: pick(registrars, 'REGISTRAR'),
    dns: pick(dnsProviders, 'DNS_PROVIDER'),
    vendor: pick(vendors, 'MAILBOX_VENDOR'),
    payments: pick(payments, 'PAYMENTS')
  };
}
