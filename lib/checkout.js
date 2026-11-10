// Checkout = cart snapshot + the payment we are waiting for.
//
//   create()   validates, checks availability + vendor capacity, prices the cart
//              SERVER-SIDE, and asks the gateway for a payment order.
//   confirm()  the browser says "paid": we verify with the gateway, then fulfil.
//   handleWebhook()  same fulfilment if the browser never came back.
//
// finalize() is the only place an order is created. It is synchronous and keyed
// on the checkout, so a confirm() and a webhook racing each other (or a webhook
// retry) can never create two orders.
import { randomBytes } from 'node:crypto';
import { quote, margin } from './pricing.js';
import { toMinor } from './money.js';
import { initProgress, publicOrder, provision } from './provisioner.js';
import { validateCart, validateCheckoutExtras, httpError } from './validate.js';

const CAPTURED_EVENTS = new Set(['payment.captured', 'order.paid']);

export function createCheckoutService({ store, providers, log = console }) {
  const view = (co) => ({ checkoutId: co.id, quote: co.quote, payment: co.payment });

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
      createdAt: new Date().toISOString()
    };
    initProgress(order);
    store.putOrder(order);
    co.status = 'paid'; co.orderId = order.id; co.paymentId = pay.paymentId;
    store.putCheckout(co);
    // Fire and forget: the UI polls GET /api/orders/:id, and a timer resumes it after a crash.
    provision(order, { providers, store }).catch((e) => log.error('provision crashed', e));
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
    let pay;
    try {
      pay = await providers.payments.createCheckout({
        amount: q.total, currency: q.currency, receipt: id,
        notes: { checkout_id: id },
        customer: { name: `${contact.firstName} ${contact.lastName}`, email: contact.email, contact: `+${String(contact.phoneCc).replace(/\D/g, '')}${String(contact.phone).replace(/\D/g, '')}` }
      });
    } catch (e) {
      log.error('[payments] createCheckout failed:', e.message);
      throw httpError(502, 'We could not start the payment. Please try again.');
    }

    const co = {
      id, idempotencyKey: key, status: 'awaiting_payment',
      cart, contact, forwardingDomain, quote: q,
      amountMinor: pay.amountMinor ?? toMinor(q.total, q.currency), currency: q.currency,
      gatewayOrderId: pay.gatewayOrderId,
      payment: { mode: pay.mode, orderId: pay.gatewayOrderId, amountMinor: pay.amountMinor, currency: q.currency, client: pay.client },
      createdAt: new Date().toISOString()
    };
    store.putCheckout(co);
    return view(co);
  }

  /** Browser says "paid". Idempotent: confirming twice returns the same order. */
  async function confirm(id, body) {
    const co = store.getCheckout(id);
    if (!co) throw httpError(404, 'Checkout not found');
    if (co.orderId) return publicOrder(store.getOrder(co.orderId));
    const pay = await providers.payments.confirm({
      gatewayOrderId: co.gatewayOrderId, paymentId: body.paymentId, signature: body.signature,
      amountMinor: co.amountMinor, currency: co.currency
    });
    return publicOrder(finalize(co, pay));
  }

  /** Lets the browser find its order after a webhook fulfilled it. */
  function status(id) {
    const co = store.getCheckout(id);
    if (!co) throw httpError(404, 'Checkout not found');
    return { status: co.status, order: co.orderId ? publicOrder(store.getOrder(co.orderId)) : null };
  }

  /**
   * Gateway webhook. Must answer fast (Razorpay allows 5 s and retries for 24 h),
   * so it only verifies, de-duplicates and fulfils. Returns { handled, reason? }.
   */
  function handleWebhook(raw, headers) {
    if (!providers.payments.verifyWebhook) throw httpError(404, 'Not found');
    const ev = providers.payments.verifyWebhook(raw, headers); // throws on a bad signature
    if (ev.id && store.seenEvent(ev.id)) return { handled: false, reason: 'duplicate' };

    let result = { handled: false, reason: 'ignored' };
    if (CAPTURED_EVENTS.has(ev.type) && ev.payment) {
      const co = store.findCheckoutByGatewayOrder(ev.payment.order_id);
      if (!co) {
        log.error(`[webhook] payment ${ev.payment.id} for unknown order ${ev.payment.order_id}`);
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
    return result;
  }

  return { create, confirm, status, handleWebhook, finalize };
}
