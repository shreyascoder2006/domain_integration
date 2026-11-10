// Runs the post-payment pipeline per domain. Every step records its result on
// the order, so a retry/resume skips what already succeeded (idempotent).
//
//   register -> nameservers -> connect_domain -> dns_base -> mailboxes
//            -> mailboxes_ready -> dns_dkim -> connect
//
// Two vendor models are supported:
//  * vendor.managesDns === false (mock): we run DNS ourselves via the dns
//    adapter (Cloudflare), and the vendor returns DKIM for us to publish.
//  * vendor.managesDns === true (Zapmail): registrar nameservers point at the
//    vendor, the vendor verifies the domain and handles DNS, and our DNS
//    steps are skipped.
//
// Long-running work: an adapter throws PendingError and the step is parked as
// "waiting". resumeDue() (called by a timer in server.js) re-checks due steps,
// which also recovers orders interrupted by a crash.
import { seal } from './crypto.js';
import { log as defaultLog } from './log.js';
import { PendingError } from './errors.js';

const STEPS = ['register', 'nameservers', 'connect_domain', 'dns_base', 'mailboxes', 'mailboxes_ready', 'dns_dkim', 'connect'];
const MAX_ATTEMPTS = 3;
const waitTimeoutMs = () => Number(process.env.WAIT_TIMEOUT_MS ?? 48 * 3600 * 1000);
const retryBaseMs = () => Number(process.env.RETRY_BASE_MS ?? 1000); // quick retries for blips; slow work uses "waiting" instead

class WaitSignal extends Error {}
const running = new Set(); // order ids currently being provisioned in this process

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stepsOf = (order) => order.progress.flatMap((p) => Object.values(p.steps));

async function runStep(entry, step, fn, save) {
  const s = entry.steps[step];
  if (s.status === 'done') return;

  if (s.status === 'waiting') {
    if (Date.now() - s.waitingSince > waitTimeoutMs()) {
      s.status = 'failed'; s.error = `Timed out waiting: ${s.note || step}`; save();
      throw new Error(s.error);
    }
    if (Date.now() < s.nextCheckAt) throw new WaitSignal();
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const waitingSince = s.waitingSince;
    s.status = 'running'; s.attempts = attempt; save();
    try {
      s.result = await fn();
      s.status = 'done';
      for (const k of ['error', 'note', 'nextCheckAt', 'waitingSince']) delete s[k];
      save();
      return;
    } catch (err) {
      if (err instanceof PendingError) {
        s.status = 'waiting'; s.waitingSince = waitingSince ?? Date.now();
        s.nextCheckAt = Date.now() + err.retryAfterMs; s.note = err.message; delete s.error; save();
        throw new WaitSignal();
      }
      s.error = err.message;
      if (attempt === MAX_ATTEMPTS) { s.status = 'failed'; save(); throw err; }
      await sleep(retryBaseMs() * attempt);
    }
  }
}

const skip = (entry, step, reason) => {
  const s = entry.steps[step];
  if (s.status !== 'done') { s.status = 'done'; s.result = { skipped: reason }; }
};

/** Move credentials out of plaintext before anything is persisted. */
const sealMailboxes = (list) => list.map(({ credentials, ...m }) => (credentials ? { ...m, credentialsEnc: seal(credentials) } : m));

export async function provision(order, { providers, store, notify = () => {} }) {
  if (running.has(order.id)) return order;
  running.add(order.id);
  const save = () => store.putOrder(order);
  const { vendor } = providers;
  const managed = !!vendor.managesDns;
  try {
    order.status = 'provisioning'; save();

    for (const entry of order.progress) {
      const d = order.domains.find((x) => x.name === entry.domain);
      try {
        await runStep(entry, 'register', () =>
          providers.registrar.register({ domain: d.name, contact: order.contact, years: 1 }), save);

        await runStep(entry, 'nameservers', async () => {
          if (managed) {
            await providers.registrar.setNameservers(d.name, vendor.nameServers);
            return { nameServers: vendor.nameServers };
          }
          const zone = await providers.dns.prepareZone(d.name);
          await providers.registrar.setNameservers(d.name, zone.nameServers);
          return { nameServers: zone.nameServers };
        }, save);

        if (managed) await runStep(entry, 'connect_domain', () => vendor.connectDomain(d.name), save);
        else skip(entry, 'connect_domain', 'not needed');

        await runStep(entry, 'dns_base', async () => {
          const forwardingUrl = order.forwardingDomain ? `https://${order.forwardingDomain}` : null;
          if (managed) {
            if (!vendor.configureDomain) return { skipped: 'vendor manages DNS' };
            return vendor.configureDomain({ domain: d.name, forwardingUrl, dmarcEmail: 'dmarc@cloudlead.ai' });
          }
          await providers.dns.applyRecords(d.name, [
            { type: 'TXT', name: d.name, value: spf(order.provider) },
            { type: 'TXT', name: `_dmarc.${d.name}`, value: 'v=DMARC1; p=none; rua=mailto:dmarc@cloudlead.ai' },
            ...mxFor(order.provider, d.name)
          ]);
          if (forwardingUrl) await providers.dns.setForwarding(d.name, forwardingUrl);
          return { ok: true };
        }, save);

        await runStep(entry, 'mailboxes', async () => {
          const r = await vendor.createMailboxes({ domain: d.name, provider: order.provider, accounts: d.mailboxes });
          return { ...r, mailboxes: sealMailboxes(r.mailboxes) };
        }, save);

        // Vendors that create mailboxes asynchronously must hand them back here.
        await runStep(entry, 'mailboxes_ready', async () => {
          if (!vendor.collectMailboxes) return { mailboxes: entry.steps.mailboxes.result.mailboxes };
          const r = await vendor.collectMailboxes({
            domain: d.name, provider: order.provider,
            emails: d.mailboxes.map((m) => `${m.emailPrefix}@${d.name}`)
          });
          return { mailboxes: sealMailboxes(r.mailboxes) };
        }, save);

        const dkim = entry.steps.mailboxes.result.dkim;
        if (managed || !dkim) skip(entry, 'dns_dkim', managed ? 'vendor manages DNS' : 'no DKIM record');
        else await runStep(entry, 'dns_dkim', async () => { await providers.dns.applyRecords(d.name, [dkim]); return { ok: true }; }, save);

        await runStep(entry, 'connect', async () => {
          const created = entry.steps.mailboxes_ready.result.mailboxes.map((m) => ({
            ...m, orderId: order.id, userId: order.userId, warmup: 'queued', createdAt: new Date().toISOString()
          }));
          store.addMailboxes(created);
          return { connected: created.length };
        }, save);
      } catch (e) {
        if (!(e instanceof WaitSignal)) { /* recorded on the step as failed; keep going with other domains */ }
      }
    }

    const all = stepsOf(order);
    if (all.some((s) => s.status === 'waiting')) {
      order.status = 'provisioning';
    } else {
      order.status = all.some((s) => s.status === 'failed') ? 'partial_failure' : 'completed';
      order.completedAt = new Date().toISOString();
    }
    save();
    if (order.status === 'completed') notify('order_ready', order);
    else if (order.status === 'partial_failure') notify('order_delayed', order);
    return order;
  } finally {
    running.delete(order.id);
  }
}

/**
 * Resume orders that are not currently being worked on: newly paid orders,
 * orders whose waiting steps are due, and orders interrupted by a crash.
 * Orders whose only pending work is a waiting step in the future are left alone.
 */
export function resumeDue({ providers, store, notify }, now = Date.now()) {
  let started = 0;
  for (const o of store.listOrders()) {
    if (!['paid', 'provisioning'].includes(o.status) || running.has(o.id) || !o.progress) continue;
    const waiting = stepsOf(o).filter((s) => s.status === 'waiting');
    if (waiting.length && waiting.every((s) => s.nextCheckAt > now)) continue;
    started++;
    provision(o, { providers, store, notify }).catch((e) => defaultLog.error('resume crashed', { order: o.id }, e));
  }
  return started;
}

/**
 * A vendor told us something changed: stop waiting for the next poll. Marks waiting steps due now
 * (for one domain, or all when the domain is unknown) so resumeDue() re-checks them immediately.
 * It never marks anything done: the step still asks the vendor, so a spoofed or stale event is harmless.
 */
export function wakeWaiting(store, domain = null) {
  let n = 0;
  for (const o of store.listOrders()) {
    if (o.status !== 'provisioning' || !o.progress) continue;
    const before = n;
    for (const p of o.progress) {
      if (domain && p.domain !== domain) continue;
      for (const s of Object.values(p.steps)) {
        if (s.status === 'waiting' && s.nextCheckAt > 0) { s.nextCheckAt = 0; n++; }
      }
    }
    if (n > before) store.putOrder(o);
  }
  return n;
}

const GENERIC_ERROR = 'This step needs attention. Our team has been notified.';

/**
 * Strip secrets and vendor details before sending an order to the browser.
 * Raw errors (which can name vendors and costs) are only kept when admin=true.
 */
export function publicOrder(order, { admin = false } = {}) {
  const clean = JSON.parse(JSON.stringify(order));
  delete clean.manageToken; // a secret: only handed out once, at purchase
  delete clean.billing;     // plan ids, history, vendor notes: callers add a safe summary or the admin view
  if (!admin) { delete clean.internalMargin; delete clean.idempotencyKey; delete clean.contact; } // contact = the buyer's PII
  for (const p of clean.progress || []) {
    for (const s of Object.values(p.steps)) {
      if (!admin) {
        if (s.error) s.error = GENERIC_ERROR;
        delete s.note; delete s.nextCheckAt; delete s.waitingSince;
        // Results and skip reasons can contain internal wording (vendor names, nameservers): show only counts.
        if (s.result) s.result = s.result.mailboxes ? { count: s.result.mailboxes.length } : s.result.skipped ? { skipped: true } : undefined;
      } else if (s.result?.mailboxes) {
        s.result = { count: s.result.mailboxes.length };
      }
    }
  }
  return clean;
}

export { STEPS };
