// Mock adapters so the whole flow runs with no vendor accounts.
// Each real vendor must implement the SAME method signatures (see providers/index.js).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
  },
  async renew({ domain, years = 1 }) {
    await sleep(DELAY / 4);
    if (process.env.MOCK_FAIL === 'renew') throw new Error('registrar unavailable');
    return { domain, years, renewedAt: new Date().toISOString(), orderAmount: 10.5 };
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
  removals: [], // scheduleRemoval / cancelRemoval calls, for tests and demos
  async scheduleRemoval({ domain }) { this.removals.push({ domain, remove: true }); },
  async cancelRemoval({ domain }) { this.removals.push({ domain, remove: false }); },
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
  },

  // Recurring billing, simulated: lets the wizard and the lifecycle run end to end with no gateway.
  async createSubscriptionCheckout({ receipt, currency, schedule }) {
    await sleep(DELAY / 4);
    const id = `mocksub_${receipt}`;
    return {
      mode: 'mock', kind: 'subscription', gatewaySubscriptionId: id,
      planIds: { renewal: `mockplan_${schedule.renewalMinor}`, base: schedule.cyclesPerYear > 1 ? `mockplan_${schedule.baseMinor}` : `mockplan_${schedule.renewalMinor}` },
      amountMinor: schedule.renewalMinor, currency, client: {}
    };
  },
  async confirmSubscription({ paymentId }) {
    await sleep(DELAY / 4);
    if (!/^pay_mock_/.test(paymentId || '')) throw Object.assign(new Error('Payment verification failed'), { status: 400, expose: true });
    return { paymentId, status: 'succeeded', subscription: { paid_count: 1, current_end: Math.floor(Date.now() / 1000) + 90 * 86400 } };
  },
  async changePlan() { await sleep(DELAY / 4); },
  // Mock webhooks use the same HMAC scheme as Razorpay so `npm run simulate` can drive the whole lifecycle locally.
  verifyWebhook(raw, headers) {
    const secret = process.env.MOCK_WEBHOOK_SECRET || 'mock-webhook-secret';
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    const got = String(headers['x-razorpay-signature'] || '');
    if (got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) throw Object.assign(new Error('Invalid signature'), { status: 400, expose: true });
    let ev;
    try { ev = JSON.parse(body.toString('utf8')); } catch { throw Object.assign(new Error('Invalid payload'), { status: 400, expose: true }); }
    if (!ev || typeof ev !== 'object') throw Object.assign(new Error('Invalid payload'), { status: 400, expose: true });
    return { id: headers['x-razorpay-event-id'] || null, type: ev.event, payment: ev.payload?.payment?.entity || null, order: ev.payload?.order?.entity || null, subscription: ev.payload?.subscription?.entity || null, refund: ev.payload?.refund?.entity || null, createdAt: Number(ev.created_at) || null };
  },
  async cancelSubscription() { await sleep(DELAY / 4); }
};
