// Runs the post-payment pipeline per domain. Every step records its result on
// the order, so a retry/resume skips what already succeeded (idempotent).
//
// Steps per domain:  register -> dns_base -> mailboxes -> dns_dkim -> connect
import { seal } from './crypto.js';

const STEPS = ['register', 'nameservers', 'dns_base', 'mailboxes', 'dns_dkim', 'connect'];
const MAX_ATTEMPTS = 3;

const spf = (provider) => provider === 'microsoft' ? 'v=spf1 include:spf.protection.outlook.com ~all' : 'v=spf1 include:_spf.google.com ~all';
const mxFor = (provider, domain) => provider === 'microsoft'
  ? [{ type: 'MX', name: domain, value: `${domain.replace(/\./g, '-')}.mail.protection.outlook.com`, priority: 0 }]
  : [{ type: 'MX', name: domain, value: 'smtp.google.com', priority: 1 }];

export function initProgress(order) {
  order.progress = order.domains.map((d) => ({
    domain: d.name,
    steps: Object.fromEntries(STEPS.map((s) => [s, { status: 'pending' }]))
  }));
}

async function runStep(entry, step, fn, order, save) {
  const s = entry.steps[step];
  if (s.status === 'done') return;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    s.status = 'running'; s.attempts = attempt; save();
    try {
      s.result = await fn();
      s.status = 'done'; delete s.error; save();
      return;
    } catch (err) {
      s.error = err.message;
      if (attempt === MAX_ATTEMPTS) { s.status = 'failed'; save(); throw err; }
      await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
}

export async function provision(order, { providers, store }) {
  const save = () => store.putOrder(order);
  order.status = 'provisioning'; save();
  let failed = false;

  for (const entry of order.progress) {
    const d = order.domains.find((x) => x.name === entry.domain);
    try {
      await runStep(entry, 'register', () =>
        providers.registrar.register({ domain: d.name, contact: order.contact, years: 1 }), order, save);

      // Create the DNS zone, then point the registrar's nameservers at it.
      await runStep(entry, 'nameservers', async () => {
        const zone = await providers.dns.prepareZone(d.name);
        await providers.registrar.setNameservers(d.name, zone.nameServers);
        return { nameServers: zone.nameServers };
      }, order, save);

      await runStep(entry, 'dns_base', async () => {
        await providers.dns.applyRecords(d.name, [
          { type: 'TXT', name: d.name, value: spf(order.provider) },
          { type: 'TXT', name: `_dmarc.${d.name}`, value: 'v=DMARC1; p=none; rua=mailto:dmarc@cloudlead.ai' },
          ...mxFor(order.provider, d.name)
        ]);
        if (order.forwardingDomain) await providers.dns.setForwarding(d.name, `https://${order.forwardingDomain}`);
        return { ok: true };
      }, order, save);

      await runStep(entry, 'mailboxes', async () => {
        const r = await providers.vendor.createMailboxes({ domain: d.name, provider: order.provider, accounts: d.mailboxes });
        // Seal credentials before anything is persisted: plaintext never hits disk.
        return {
          ...r,
          mailboxes: r.mailboxes.map(({ credentials, ...m }) => ({ ...m, credentialsEnc: seal(credentials) }))
        };
      }, order, save);

      await runStep(entry, 'dns_dkim', async () => {
        await providers.dns.applyRecords(d.name, [entry.steps.mailboxes.result.dkim]);
        return { ok: true };
      }, order, save);

      await runStep(entry, 'connect', async () => {
        const created = entry.steps.mailboxes.result.mailboxes.map((m) => ({
          ...m, orderId: order.id, userId: order.userId, warmup: 'queued', createdAt: new Date().toISOString()
        }));
        store.addMailboxes(created);
        return { connected: created.length };
      }, order, save);
    } catch {
      failed = true; // keep going: other domains can still succeed
    }
  }

  order.status = failed ? 'partial_failure' : 'completed';
  order.completedAt = new Date().toISOString();
  save();
  return order;
}

/** Strip secrets before sending an order to the browser. */
export function publicOrder(order) {
  const clean = JSON.parse(JSON.stringify(order));
  delete clean.internalMargin; // cost data is admin-only
  delete clean.idempotencyKey;
  for (const p of clean.progress || []) {
    if (p.steps.mailboxes?.result) {
      p.steps.mailboxes.result = { count: p.steps.mailboxes.result.mailboxes.length };
    }
    if (p.steps.dns_dkim?.result) delete p.steps.dns_dkim.result;
  }
  return clean;
}

export { STEPS };
