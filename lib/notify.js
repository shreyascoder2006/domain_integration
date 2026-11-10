// Customer notifications: an outbox with de-duplication and retries.
//
//   notify(type, order, extra)  enqueue (cheap, synchronous, never throws)
//   flush()                     send everything due; call it from the timer
//
// The outbox stores only { type, orderId, extra }, never the rendered message, so no manage token or
// payment link sits in the database: messages are rendered from the live order at send time.
// A `key` makes enqueueing idempotent: the same event (a webhook retry, a timer tick) sends once.
import { randomBytes } from 'node:crypto';
import { render } from './templates.js';
import { log as defaultLog } from './log.js';

const MAX_ATTEMPTS = 6;
const backoffMs = (attempts) => Math.min(60_000 * 2 ** attempts, 6 * 3_600_000); // 2m, 4m, 8m ... capped at 6h

// What makes two emails "the same event" (so we never send it twice).
const KEYS = {
  order_ready: (o) => o.id,
  order_delayed: (o) => o.id,
  payment_failed: (o) => `${o.billing?.paidCount ?? 0}`,           // once per billing cycle, not once per retry
  suspension_warning: (o) => `${o.billing?.graceEndsAt ?? 0}`,
  suspended: (o) => `${o.billing?.suspendedAt ?? 0}`,
  reinstated: (o) => `${o.billing?.paidCount ?? 0}`,
  renewal_reminder: (o) => `${(o.billing?.paidCount ?? 0) + 1}`,    // once per upcoming cycle
  domains_renewed: (o, x) => `${x.cycle ?? 0}`,
  cancelled: (o) => `${o.billing?.endsAt ?? 0}`,
  ended: (o) => `${o.billing?.suspendedAt ?? 0}`,
  manage_link: (o, x, now) => `${Math.floor(now / 600_000)}`         // at most one per 10 minutes
};

export function createNotifier({ store, mailer, publicUrl = '', from = 'CloudLead <no-reply@localhost>', brand = 'CloudLead', summarize = () => null, log = defaultLog, now = () => Date.now() }) {
  function notify(type, order, extra = {}) {
    try {
      const to = order?.contact?.email;
      if (!to || !KEYS[type]) return false;
      const key = `${type}:${order.id}:${KEYS[type](order, extra, now())}`;
      if (store.listOutbox().some((i) => i.key === key)) return false;
      store.addOutbox({ id: 'eml_' + randomBytes(6).toString('hex'), key, type, orderId: order.id, extra, status: 'pending', attempts: 0, nextAttemptAt: 0, createdAt: new Date(now()).toISOString() });
      return true;
    } catch (e) {
      log.error('could not queue email', { type }, e); // a notification problem must never break billing or provisioning
      return false;
    }
  }

  const manageUrl = (o) => (publicUrl && o.manageToken ? `${publicUrl.replace(/\/$/, '')}/manage.html#o=${o.id}&t=${o.manageToken}` : null);

  async function flush() {
    let sent = 0;
    for (const item of store.listOutbox()) {
      if (item.status !== 'pending' || item.nextAttemptAt > now()) continue;
      const order = store.getOrder(item.orderId);
      try {
        if (!order) throw new Error('order no longer exists');
        const msg = render(item.type, { order, summary: summarize(order), extra: item.extra, manageUrl: manageUrl(order), brand });
        await mailer.send({ from, to: order.contact.email, ...msg });
        Object.assign(item, { status: 'sent', sentAt: new Date(now()).toISOString() });
        delete item.error; sent++;
      } catch (e) {
        item.attempts++;
        item.error = e.message;
        if (item.attempts >= MAX_ATTEMPTS) { item.status = 'dead'; log.error('email gave up', { type: item.type, order: item.orderId }, e); }
        else item.nextAttemptAt = now() + backoffMs(item.attempts);
      }
      store.putOutbox(item);
    }
    return sent;
  }

  return { notify, flush };
}
