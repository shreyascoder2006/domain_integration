// Vendor webhooks make the pipeline faster; they are never the source of truth.
//
// The pipeline polls the vendor whenever a step is "waiting". A vendor event only says
// "something changed": we respond by making waiting steps due now, and the step then asks
// the vendor for the real state. So a missed, late, duplicated or forged event cannot
// create or skip anything: the worst case is one extra poll.
import { wakeWaiting } from './provisioner.js';
import { httpError } from './validate.js';

/** Best-effort domain name from a vendor event payload (null = unknown, wake everything). */
export function domainOf(data) {
  const d = data || {};
  const candidates = [d.mailboxDetails?.domain, d.domainDetails?.domain, d.domainDetails?.domainName, d.domain, d.domainName, d.domain_name];
  const hit = candidates.find((c) => typeof c === 'string' && c.includes('.'));
  return hit ? hit.toLowerCase() : null;
}

/**
 * Returns handle(raw, headers) -> { handled, woken? }. `resume` runs the pipeline for due orders
 * (resumeDue) and is called after the response is ready, in the background.
 */
export function createVendorWebhookHandler({ store, providers, resume, log = console }) {
  return function handle(raw, headers) {
    if (!providers.vendor.verifyWebhook) throw httpError(404, 'Not found');
    const ev = providers.vendor.verifyWebhook(raw, headers); // throws on a bad signature or stale timestamp
    if (ev.id && store.seenEvent(ev.id)) return { handled: false, reason: 'duplicate' };
    const woken = wakeWaiting(store, domainOf(ev.data));
    if (ev.id) store.markEvent(ev.id);
    if (woken) setImmediate(() => { try { resume(); } catch (e) { log.error('[vendor webhook] resume failed:', e.message); } });
    return { handled: woken > 0, woken, type: ev.type };
  };
}
