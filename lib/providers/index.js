// Provider registry. To go live, add e.g. namesilo.js / zapmail.js exporting
// objects with the same shape as the mocks, then select them via env vars.
//
//   registrar:     checkAvailability(domains[]) -> [{domain, available}]
//                  register({domain, contact, years}) -> {domain, registeredAt}
//   dns:           applyRecords(domain, records[]) ; setForwarding(domain, url)
//   mailboxVendor: createMailboxes({domain, provider, accounts[]}) -> {dkim, mailboxes[]}
//   payments:      charge({amount, currency, source}) -> {id, status}
import { mockRegistrar, mockDns, mockMailboxVendor, mockPayments } from './mock.js';

const registrars = { mock: mockRegistrar };
const dnsProviders = { mock: mockDns };
const vendors = { mock: mockMailboxVendor };
const payments = { mock: mockPayments };

const pick = (table, envKey) => {
  const name = process.env[envKey] || 'mock';
  if (!table[name]) throw new Error(`${envKey}=${name} is not a registered adapter`);
  return table[name];
};

export function loadProviders() {
  return {
    registrar: pick(registrars, 'REGISTRAR'),
    dns: pick(dnsProviders, 'DNS_PROVIDER'),
    vendor: pick(vendors, 'MAILBOX_VENDOR'),
    payments: pick(payments, 'PAYMENTS')
  };
}
