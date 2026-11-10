// Mock adapters so the whole flow runs with no vendor accounts.
// Each real vendor must implement the SAME method signatures (see providers/index.js).
import { createHash, randomBytes } from 'node:crypto';
import { toMinor } from '../money.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => parseInt(createHash('sha1').update(s).digest('hex').slice(0, 8), 16);
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 400);

// ~20% of names are "taken", deterministically, so the UI can show that case.
const TAKEN_BASES = new Set(['careerbricks']);

export const mockRegistrar = {
  name: 'mock-registrar',
  async checkAvailability(domains) {
    await sleep(DELAY / 4);
    return domains.map((domain) => ({
      domain,
      available: !TAKEN_BASES.has(domain.split('.')[0]) && hash(domain) % 5 !== 0
    }));
  },
  async register({ domain, contact, years = 1 }) {
    await sleep(DELAY);
    if (process.env.MOCK_FAIL === 'registrar') throw new Error('registrar unavailable');
    return { domain, years, registeredAt: new Date().toISOString(), whoisPrivacy: true };
  },
  async setNameservers(domain, nameServers) {
    await sleep(DELAY / 4);
    return { domain, nameServers };
  }
};

export const mockDns = {
  name: 'mock-dns',
  async prepareZone(domain) {
    await sleep(DELAY / 4);
    return { zoneId: 'zone_' + hash(domain), nameServers: ['ns1.mock-dns.test', 'ns2.mock-dns.test'] };
  },
  async applyRecords(domain, records) {
    await sleep(DELAY / 2);
    return { domain, applied: records.length };
  },
  async setForwarding(domain, url) {
    await sleep(DELAY / 4);
    return { domain, forwardsTo: url };
  }
};

export const mockMailboxVendor = {
  name: 'mock-vendor',
  async createMailboxes({ domain, provider, accounts }) {
    await sleep(DELAY * 1.5);
    if (process.env.MOCK_FAIL === 'vendor') throw new Error('vendor API 503');
    const dkimSelector = provider === 'microsoft' ? 'selector1' : 'google';
    return {
      dkim: { type: 'TXT', name: `${dkimSelector}._domainkey.${domain}`, value: `v=DKIM1; k=rsa; p=${randomBytes(24).toString('base64')}` },
      mailboxes: accounts.map((a) => ({
        email: `${a.emailPrefix}@${domain}`,
        firstName: a.firstName,
        lastName: a.lastName,
        provider,
        // Internal only: never sent to the browser.
        credentials: { oauthRefreshToken: randomBytes(12).toString('hex') },
        smtp: provider === 'google' ? { host: 'smtp.gmail.com', port: 587 } : { host: 'smtp.office365.com', port: 587 },
        status: 'ready_for_warmup'
      }))
    };
  }
};

// Mock gateway: no popup. The wizard sees mode "mock" and confirms immediately.
export const mockPayments = {
  name: 'mock-payments',
  async createCheckout({ amount, currency, receipt }) {
    await sleep(DELAY / 4);
    return { mode: 'mock', gatewayOrderId: `mock_${receipt}`, amountMinor: toMinor(amount, currency), currency, client: {} };
  },
  async confirm({ paymentId, amountMinor, currency }) {
    await sleep(DELAY / 4);
    if (!/^pay_mock_/.test(paymentId || '')) throw Object.assign(new Error('Payment verification failed'), { status: 400, expose: true });
    return { paymentId, status: 'succeeded', amountMinor, currency };
  },
  async refund({ paymentId, amount }) {
    await sleep(DELAY / 4);
    return { id: 're_' + randomBytes(6).toString('hex'), paymentId, amount, status: 'processed' };
  }
};
