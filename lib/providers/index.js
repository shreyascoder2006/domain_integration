// Provider registry. To go live, add e.g. namesilo.js / zapmail.js exporting
// objects with the same shape as the mocks, then select them via env vars.
//
//   registrar:     checkAvailability(domains[]) -> [{domain, available}]
//                  register({domain, contact, years}) -> {domain, registeredAt}
//   dns:           applyRecords(domain, records[]) ; setForwarding(domain, url)
//   mailboxVendor: createMailboxes({domain, provider, accounts[]}) -> {dkim, mailboxes[]}
//   payments:      charge({amount, currency, source}) -> {id, status}
import { mockRegistrar, mockDns, mockMailboxVendor, mockPayments } from './mock.js';
import { createCloudflareDns } from './cloudflare.js';
import { createNameSiloRegistrar } from './namesilo.js';

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
const vendors = { mock: () => mockMailboxVendor };
const payments = { mock: () => mockPayments };

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
