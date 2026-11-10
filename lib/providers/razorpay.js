// Razorpay payments adapter (Orders + Standard Checkout + webhooks + refunds).
//
// Built from Razorpay's published docs (razorpay.com/docs, read 2026-11-10) and
// tested only against fake HTTP. NOT yet run against the live API.
//
// Flow:
//   1. createCheckout  -> POST /v1/orders (server decides the amount)
//   2. browser opens checkout.js with that order_id; on success it returns
//      razorpay_payment_id + razorpay_signature
//   3. confirm         -> verify HMAC-SHA256(order_id|payment_id, key_secret), then
//                         fetch the payment and check status/amount/currency/order
//   4. verifyWebhook   -> fallback when the browser never calls confirm
//   5. refund          -> POST /v1/payments/:id/refund with an idempotency header
//
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET  (use TEST keys first)
//      RAZORPAY_WEBHOOK_SECRET               (set in Dashboard > Webhooks; NOT the key secret)
//      PAYMENT_MERCHANT_NAME                 (shown in the checkout popup)
//
// Account prerequisites: USD (or any non-INR) orders fail with
// BAD_REQUEST_INVALID_CURRENCY until "International payments" is activated in
// the Razorpay Dashboard (Account & Settings > International payments).
// Auto-capture is a Dashboard setting; if it is off, confirm() captures itself.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { toMinor } from '../money.js';

const BASE = 'https://api.razorpay.com/v1';
const MIN_MINOR = 100; // docs are inconsistent about the minimum (INR 1.00): stay at/above 100 minor units

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
// Errors flagged `expose` are safe to show to customers; everything else becomes a generic 500.
const publicError = (status, message) => Object.assign(new Error(message), { status, expose: true });

export function createRazorpayPayments({ keyId, keySecret, webhookSecret, merchantName = 'CloudLead', fetchImpl = fetch } = {}) {
  if (!keyId || !keySecret) throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required');
  const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  async function rz(method, path, { body, headers } = {}) {
    const res = await fetchImpl(BASE + path, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = json.error || {};
      throw Object.assign(new Error(`Razorpay ${method} ${path} failed (${res.status}): ${e.code || ''} ${e.description || ''}`.trim()), {
        gatewayStatus: res.status, gatewayCode: e.code
      });
    }
    return json;
  }

  return {
    name: 'razorpay',

    /** Create the gateway order. The amount comes from OUR quote, never from the browser. */
    async createCheckout({ amount, currency, receipt, notes = {}, customer = {}, description = 'Email infrastructure' }) {
      const amountMinor = toMinor(amount, currency);
      if (amountMinor < MIN_MINOR) throw new Error('Amount is below the gateway minimum');
      if (!/^[\x20-\x7E]{1,40}$/.test(receipt || '')) throw new Error('receipt must be 1-40 ASCII characters');
      const safeNotes = Object.fromEntries(Object.entries(notes).slice(0, 15).map(([k, v]) => [k, String(v).slice(0, 256)]));
      // `receipt` is unique per checkout and Razorpay treats a repeat as a duplicate request.
      const o = await rz('POST', '/orders', { body: { amount: amountMinor, currency, receipt, notes: safeNotes } });
      if (Number(o.amount) !== amountMinor) throw new Error('Gateway order amount mismatch');
      return {
        mode: 'razorpay', gatewayOrderId: o.id, amountMinor, currency,
        client: {
          key: keyId, name: merchantName, description,
          prefill: { name: customer.name, email: customer.email, contact: customer.contact },
          notes: safeNotes
        }
      };
    },

    /**
     * Verify what the browser says happened. Never trust the browser alone:
     * the signature proves it came from Razorpay, the fetch proves the money.
     */
    async confirm({ gatewayOrderId, paymentId, signature, amountMinor, currency }) {
      if (!paymentId || !signature) throw publicError(400, 'Missing payment details');
      // Use OUR stored order id, not the one the browser sends back.
      const expected = createHmac('sha256', keySecret).update(`${gatewayOrderId}|${paymentId}`).digest('hex');
      if (!safeEqual(signature, expected)) throw publicError(400, 'Payment verification failed');

      let p;
      try {
        p = await rz('GET', `/payments/${encodeURIComponent(paymentId)}`);
        if (p.status === 'authorized') {
          p = await rz('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { body: { amount: amountMinor, currency } });
        }
      } catch (e) {
        console.error('[razorpay] confirm lookup failed:', e.message);
        throw publicError(502, 'We could not verify your payment yet. Please try again in a moment.');
      }
      if (p.order_id !== gatewayOrderId || Number(p.amount) !== amountMinor || p.currency !== currency) {
        throw publicError(409, 'Payment does not match this order');
      }
      if (p.status !== 'captured') throw publicError(402, 'Payment was not completed');
      return { paymentId: p.id, status: 'succeeded', amountMinor: Number(p.amount), currency: p.currency };
    },

    /**
     * Verify a webhook. `raw` MUST be the unparsed request body: the signature is
     * HMAC-SHA256(raw body, webhook secret) as hex, in X-Razorpay-Signature.
     */
    verifyWebhook(raw, headers) {
      if (!webhookSecret) throw publicError(503, 'Webhooks are not configured');
      const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      const sig = headers['x-razorpay-signature'];
      const expected = createHmac('sha256', webhookSecret).update(body).digest('hex');
      if (!sig || !safeEqual(sig, expected)) throw publicError(400, 'Invalid signature');
      let ev;
      try { ev = JSON.parse(body.toString('utf8')); } catch { throw publicError(400, 'Invalid payload'); }
      return {
        id: headers['x-razorpay-event-id'] || null, // unique per event: used to ignore retries
        type: ev.event,
        payment: ev.payload?.payment?.entity || null,
        order: ev.payload?.order?.entity || null,
        refund: ev.payload?.refund?.entity || null
      };
    },

    /** amount is in major units (e.g. 12.5 USD). Same idempotencyKey + body = same refund. */
    async refund({ paymentId, amount, currency, idempotencyKey, reason }) {
      if (!/^[A-Za-z0-9_-]{10,}$/.test(idempotencyKey || '')) throw new Error('idempotencyKey must be 10+ chars of [A-Za-z0-9_-]');
      const r = await rz('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, {
        body: { amount: toMinor(amount, currency), speed: 'normal', notes: { reason: String(reason || '').slice(0, 250) } },
        headers: { 'X-Refund-Idempotency': idempotencyKey }
      });
      return { id: r.id, status: r.status, speed: r.speed_processed }; // status: pending | processed | failed
    }
  };
}
