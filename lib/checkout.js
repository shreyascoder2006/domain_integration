// Checkout = cart snapshot + the payment we are waiting for.
//
//   create()   validates, checks availability + vendor capacity, prices the cart
//              SERVER-SIDE, and asks the gateway for a payment (a one-off order, or
//              a recurring subscription when the gateway supports it).
//   confirm()  the browser says "paid": we verify with the gateway, then fulfil.
//   handleWebhook()  same fulfilment if the browser never came back, plus the
//              subscription lifecycle events that keep an order billed and alive.
//
// finalize() is the only place an order is created. It is synchronous and keyed
// on the checkout, so a confirm() and a webhook racing each other (or a webhook
// retry) can never create two orders.
import { randomBytes } from 'node:crypto';
import { quote, margin } from './pricing.js';
import { toMinor } from './money.js';
import { initProgress, publicOrder, provision } from './provisioner.js';
import { validateCart, validateCheckoutExtras, httpError } from './validate.js';
import { buildSchedule, createBillingService } from './billing.js';

const CAPTURED_EVENTS = new Set(['payment.captured', 'order.paid']);

export function createCheckoutService({ store, providers, log = console }) {
  const billing = createBillingService({ store, providers, log });
  const view = (co) => ({ checkoutId: co.id, quote: co.quote, payment: co.payment });
  const useSubscriptions = () => !!providers.payments.createSubscriptionCheckout && process.env.BILLING_MODE !== 'one_time';

  /** An order as the buyer sees it right after paying: includes the one-time manage token. */
  const buyerView = (order) => ({ ...publicOrder(order), manageToken: order.manageToken, billing: billing.summary(order) });

  function finalize(co, pay = {}) {
    if (co.orderId) return store.getOrder(co.orderId); // already fulfilled (retry / race)
    if (pay.amountMinor != null && (pay.amountMinor !== co.amountMinor || pay.currency !== co.currency)) {
      throw httpError(409, 'Payment does not match this order');
    }
    const order = {
      id: 'ord_' + randomBytes(6).toString('hex'),
      checkoutId: co.id,
      userId: 'demo-user',
      status: 'paid',
      provider: co.cart.provider,
      plan: co.cart.plan,
      domains: co.cart.domains,
      forwardingDomain: co.forwardingDomain,
      contact: co.contact,
      quote: co.quote,
      internalMargin: margin(co.quote),
      paymentId: pay.paymentId,
      manageToken: randomBytes(16).toString('hex'), // lets the buyer manage (cancel) without an account
      createdAt: new Date().toISOString()
    };
    if (co.kind === 'subscription') {
      order.billing = billing.init({ schedule: co.schedule, subscriptionId: co.gatewaySubscriptionId, planIds: co.planIds, subscription: pay.subscription });
    }
    initProgress(order);
    store.putOrder(order);
    co.status = 'paid'; co.orderId = order.id; co.paymentId = pay.paymentId;
    store.putCheckout(co);
    // Fire and forget: the UI polls GET /api/orders/:id, and a timer resumes it after a crash.
    provision(order, { providers, store }).catch((e) => log.error('provision crashed', e));
    if (order.billing) billing.syncPlan(order).catch((e) => log.error('plan sync failed', e));
    return order;
  }

  async function create(body) {
    const cart = validateCart(body);
    const { contact, forwardingDomain } = validateCheckoutExtras(body);

    // Idempotency: the same key returns the same checkout instead of a second gateway order.
    const key = body.idempotencyKey ? String(body.idempotencyKey) : null;
    if (key) {
      const existing = store.findCheckoutByKey(key);
      if (existing) return view(existing);
    }

    // Re-check availability right before asking for money (names can be taken meanwhile).
    const checks = await providers.registrar.checkAvailability(cart.domains.map((d) => d.name));
    const taken = checks.filter((r) => !r.available).map((r) => r.domain);
    if (taken.length) throw httpError(409, `No longer available: ${taken.join(', ')}`);

    const q = quote({ ...cart, mailboxes: cart.domains.flatMap((d) => d.mailboxes) });

    // Never take money we cannot fulfil: make sure the mailbox vendor has free capacity.
    if (providers.vendor.checkCapacity) {
      const cap = await providers.vendor.checkCapacity({ provider: cart.provider, mailboxCount: q.mailboxCount });
      if (!cap.ok) {
        log.error(`[capacity] refusing checkout: ${cap.reason || 'vendor out of capacity'}`);
        throw httpError(503, 'We are temporarily out of mailbox capacity. Please try again shortly.');
      }
    }

    const id = 'chk_' + randomBytes(8).toString('hex'); // doubles as the gateway receipt (<= 40 chars)
    const customer = {
      name: `${contact.firstName} ${contact.lastName}`, email: contact.email,
      contact: `+${String(contact.phoneCc).replace(/\D/g, '')}${String(contact.phone).replace(/\D/g, '')}`
    };
    const recurring = useSubscriptions();
    const schedule = recurring ? buildSchedule(q) : null;
    let pay;
    try {
      pay = recurring
        ? await providers.payments.createSubscriptionCheckout({
            receipt: id, currency: q.currency, schedule, notes: { checkout_id: id }, customer,
            planCache: { get: (k) => store.getPlan(k), set: (k, v) => store.putPlan(k, v) }
          })
        : await providers.payments.createCheckout({ amount: q.total, currency: q.currency, receipt: id, notes: { checkout_id: id }, customer });
    } catch (e) {
      log.error('[payments] could not start the payment:', e.message);
      throw httpError(502, 'We could not start the payment. Please try again.');
    }

    const co = {
      id, idempotencyKey: key, status: 'awaiting_payment',
      kind: recurring ? 'subscription' : 'order',
      cart, contact, forwardingDomain, quote: q, schedule,
      amountMinor: pay.amountMinor ?? toMinor(q.total, q.currency), currency: q.currency,
      gatewayOrderId: pay.gatewayOrderId, gatewaySubscriptionId: pay.gatewaySubscriptionId, planIds: pay.planIds,
      payment: {
        mode: pay.mode, kind: recurring ? 'subscription' : 'order',
        orderId: pay.gatewayOrderId, subscriptionId: pay.gatewaySubscriptionId,
        amountMinor: pay.amountMinor, currency: q.currency, client: pay.client
      },
      createdAt: new Date().toISOString()
    };
    store.putCheckout(co);
    return view(co);
  }

  /** Browser says "paid". Idempotent: confirming twice returns the same order. */
  async function confirm(id, body) {
    const co = store.getCheckout(id);
    if (!co) throw httpError(404, 'Checkout not found');
    if (co.orderId) return buyerView(store.getOrder(co.orderId));
    const pay = co.kind === 'subscription'
      ? await providers.payments.confirmSubscription({
          gatewaySubscriptionId: co.gatewaySubscriptionId, paymentId: body.paymentId, signature: body.signature, planId: co.planIds.renewal
        })
      : await providers.payments.confirm({
          gatewayOrderId: co.gatewayOrderId, paymentId: body.paymentId, signature: body.signature,
          amountMinor: co.amountMinor, currency: co.currency
        });
    return buyerView(finalize(co, pay));
  }

  /** Lets the browser find its order after a webhook fulfilled it. */
  function status(id) {
    const co = store.getCheckout(id);
    if (!co) throw httpError(404, 'Checkout not found');
    return { status: co.status, order: co.orderId ? buyerView(store.getOrder(co.orderId)) : null };
  }

  /**
   * Gateway webhook. Must answer fast (Razorpay allows 5 s and retries for 24 h), so it
   * verifies, de-duplicates, applies state changes, and pushes slow work (registrar and
   * gateway calls) to the background where a timer retries it. Returns { handled, reason? };
   * the non-enumerable `done` promise settles when the background work has finished (tests).
   */
  function handleWebhook(raw, headers) {
    if (!providers.payments.verifyWebhook) throw httpError(404, 'Not found');
    const ev = providers.payments.verifyWebhook(raw, headers); // throws on a bad signature
    if (ev.id && store.seenEvent(ev.id)) return withDone({ handled: false, reason: 'duplicate' });

    let result = { handled: false, reason: 'ignored' };
    let after = null;

    if (ev.type?.startsWith('subscription.')) {
      const sub = ev.subscription;
      const co = sub && store.findCheckoutBySubscription(sub.id);
      if (co && !co.orderId) {
        // Not yet an order: only the first successful charge creates one.
        if (ev.type === 'subscription.charged' && Number(sub.paid_count) >= 1 && sub.plan_id === co.planIds.renewal) {
          finalize(co, { paymentId: ev.payment?.id, subscription: sub });
          result = { handled: true };
        } else {
          result = { handled: false, reason: 'awaiting first charge' };
        }
      } else {
        ({ after, ...result } = billing.handleEvent(ev));
      }
    } else if (CAPTURED_EVENTS.has(ev.type) && ev.payment) {
      const co = store.findCheckoutByGatewayOrder(ev.payment.order_id);
      if (!co) {
        // Subscription charges also raise payment events (they carry an invoice, not one of our orders).
        if (!ev.payment.invoice_id) log.error(`[webhook] payment ${ev.payment.id} for unknown order ${ev.payment.order_id}`);
        result = { handled: false, reason: 'unknown order' };
      } else if (ev.payment.status !== 'captured') {
        result = { handled: false, reason: 'not captured' };
      } else {
        try {
          finalize(co, { paymentId: ev.payment.id, amountMinor: Number(ev.payment.amount), currency: ev.payment.currency });
          result = { handled: true };
        } catch (e) {
          // A mismatch will never fix itself: log loudly for a human and stop retries.
          log.error(`[webhook] cannot fulfil checkout ${co.id}: ${e.message}`);
          result = { handled: false, reason: e.message };
        }
      }
    } else if (ev.type?.startsWith('refund.')) {
      log.error(`[webhook] ${ev.type} refund=${ev.refund?.id} payment=${ev.refund?.payment_id} status=${ev.refund?.status}`);
    }

    if (ev.id) store.markEvent(ev.id);
    return withDone(result, after);
  }

  function withDone(result, after) {
    const done = after ? Promise.resolve().then(after).catch((e) => log.error('[billing] background work failed:', e.message)) : Promise.resolve();
    Object.defineProperty(result, 'done', { value: done, enumerable: false });
    return result;
  }

  return { create, confirm, status, handleWebhook, finalize, billing };
}
