import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { quote } from './lib/pricing.js';
import { suggestDomains, normalizeSeed } from './lib/domainSuggest.js';
import { Store } from './lib/store.js';
import { loadProviders } from './lib/providers/index.js';
import { provision, publicOrder, resumeDue } from './lib/provisioner.js';
import { suggestedRefund, checkRefundAmount, refundedSoFar } from './lib/refunds.js';
import { createCheckoutService } from './lib/checkout.js';
import { validateCart, httpError } from './lib/validate.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const store = new Store(process.env.DATA_FILE || join(ROOT, 'data', 'db.json'));
const providers = loadProviders();
const checkout = createCheckoutService({ store, providers });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readRaw = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(httpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readBody = async (req) => {
  const raw = await readRaw(req);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw httpError(400, 'Invalid JSON'); }
};

const route = {
  'GET /api/config': async () => ({
    currency: config.currency,
    domainPricePerYear: config.domainPricePerYear,
    recommendedMailboxesPerDomain: config.recommendedMailboxesPerDomain,
    maxMailboxesPerDomain: config.maxMailboxesPerDomain,
    plans: config.plans,
    azure: config.azure,
    providers: config.providers
  }),

  'GET /api/domains/suggest': async (req, url) => {
    const seed = normalizeSeed(url.searchParams.get('seed'));
    if (seed.length < 2) throw httpError(400, 'Enter a brand or domain name');
    const available = await suggestDomains(providers.registrar, seed, { tld: config.tld, want: 12 });
    const exact = (await providers.registrar.checkAvailability([`${seed}.${config.tld}`]))[0];
    return { seed, exact: { domain: exact.domain, available: exact.available }, pricePerYear: config.domainPricePerYear, domains: available };
  },

  'POST /api/quote': async (req) => {
    const cart = validateCart(await readBody(req));
    return quote({ ...cart, mailboxes: cart.domains.flatMap((d) => d.mailboxes) });
  },

  // Step 1 of paying: validate, price on the server, create the gateway order.
  'POST /api/checkout': async (req) => checkout.create(await readBody(req)),

  'GET /api/mailboxes': async () =>
    store.listMailboxes().map(({ credentialsEnc, smtp, ...safe }) => safe) // never leak credentials
};

const refundsInFlight = new Set();
function requireAdmin(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) throw httpError(403, 'Admin API is disabled (set ADMIN_TOKEN)');
  const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw httpError(401, 'Invalid admin token');
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // ---- Payments ----
    const cs = url.pathname.match(/^\/api\/checkout\/(\w+)(\/confirm)?$/);
    if (cs && req.method === 'GET' && !cs[2]) return send(res, 200, checkout.status(cs[1]));
    if (cs && req.method === 'POST' && cs[2]) return send(res, 200, await checkout.confirm(cs[1], await readBody(req)));

    // Razorpay webhook: needs the RAW body for the signature, and a fast 2xx.
    if (req.method === 'POST' && url.pathname === '/api/webhooks/razorpay') {
      return send(res, 200, checkout.handleWebhook(await readRaw(req), req.headers));
    }

    // ---- Orders ----
    const m = url.pathname.match(/^\/api\/orders\/([\w]+)$/);
    if (req.method === 'GET' && m) {
      const o = store.getOrder(m[1]);
      if (!o) throw httpError(404, 'Order not found');
      return send(res, 200, publicOrder(o));
    }
    // POST /api/orders/:id/retry  (resume a partially failed order; done steps are skipped)
    const r = url.pathname.match(/^\/api\/orders\/(\w+)\/retry$/);
    if (req.method === 'POST' && r) {
      const o = store.getOrder(r[1]);
      if (!o) throw httpError(404, 'Order not found');
      if (o.status !== 'partial_failure') throw httpError(409, 'Only partially failed orders can be retried');
      provision(o, { providers, store }).catch((e) => console.error('retry crashed', e));
      return send(res, 202, publicOrder(o));
    }

    // ---- Admin API (disabled unless ADMIN_TOKEN is set) ----
    if (url.pathname.startsWith('/api/admin/')) {
      requireAdmin(req);
      if (req.method === 'GET' && url.pathname === '/api/admin/orders') {
        return send(res, 200, Object.values(store.data.orders).map((o) => ({
          ...publicOrder(o, { admin: true }),
          internalMargin: o.internalMargin,
          refunds: o.refunds || [],
          suggestedRefund: o.progress ? suggestedRefund(o) : null
        })));
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/vendor') {
        if (!providers.vendor.getCapacity) return send(res, 200, { vendor: providers.vendor.name, capacity: null });
        return send(res, 200, { vendor: providers.vendor.name, capacity: await providers.vendor.getCapacity() });
      }
      const ar = url.pathname.match(/^\/api\/admin\/orders\/(\w+)\/refund$/);
      if (req.method === 'POST' && ar) {
        const o = store.getOrder(ar[1]);
        if (!o) throw httpError(404, 'Order not found');
        if (!o.paymentId) throw httpError(409, 'This order has no payment to refund');
        if (refundsInFlight.has(o.id)) throw httpError(409, 'A refund for this order is already in progress');
        refundsInFlight.add(o.id);
        try {
          const b = await readBody(req);
          const amount = checkRefundAmount(o, b.amount ?? suggestedRefund(o).amount);
          // Same key + same amount = the gateway returns the same refund, so a double click cannot refund twice.
          const idempotencyKey = `${o.id}-r${(o.refunds || []).length + 1}-${Math.round(amount * 100)}`;
          let re;
          try {
            re = await providers.payments.refund({ paymentId: o.paymentId, amount, currency: o.quote.currency, idempotencyKey, reason: String(b.reason || '') });
          } catch (e) {
            console.error('[refund] gateway error:', e.message);
            throw httpError(502, 'The payment gateway rejected the refund');
          }
          if (re.status === 'failed') throw httpError(502, 'The payment gateway reports the refund failed');
          o.refunds = [...(o.refunds || []), { id: re.id, amount, status: re.status, reason: String(b.reason || ''), at: new Date().toISOString() }];
          if (refundedSoFar(o) >= o.quote.total) o.status = 'refunded';
          store.putOrder(o);
          return send(res, 200, { ...publicOrder(o), refunds: o.refunds });
        } finally { refundsInFlight.delete(o.id); }
      }
      throw httpError(404, 'Not found');
    }

    const handler = route[`${req.method} ${url.pathname}`];
    if (handler) return send(res, 200, await handler(req, url));
    if (url.pathname.startsWith('/api/')) throw httpError(404, 'Not found');

    // static files
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/, '');
    if (rel.includes('..')) throw httpError(400, 'Bad path');
    const data = await readFile(join(PUBLIC, rel)).catch(() => null);
    if (!data) throw httpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    // Only errors deliberately marked `expose` reach the customer. Adapter errors can carry
    // an HTTP `status` of their own and would otherwise leak vendor/gateway details.
    send(res, err.expose ? err.status : 500, { error: err.expose ? err.message : 'Internal error' });
    if (!err.expose) console.error(err);
  }
}).listen(process.env.PORT || 3000, () => {
  console.log(`CloudLead infra purchase prototype on http://localhost:${process.env.PORT || 3000}`);
  // Re-check waiting steps, finish new orders and recover from crashes.
  const pollMs = Number(process.env.POLL_INTERVAL_MS ?? 15000);
  if (pollMs > 0) {
    resumeDue({ providers, store }); // pick up anything left over from the last run
    setInterval(() => resumeDue({ providers, store }), pollMs).unref();
  }
  console.log(`adapters: registrar=${providers.registrar.name} dns=${providers.dns.name} vendor=${providers.vendor.name} payments=${providers.payments.name}`);
});
