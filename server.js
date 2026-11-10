import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
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
import { createVendorWebhookHandler } from './lib/vendorHooks.js';
import { createRateLimiter, clientKey } from './lib/ratelimit.js';
import { checkEnv } from './lib/startup.js';
import { validateCart, httpError } from './lib/validate.js';

// ---- Refuse to boot in a configuration that would lose money or data ----
const env = checkEnv();
for (const w of env.warnings) console.warn(`[startup] WARNING: ${w}`);
if (env.errors.length) {
  for (const e of env.errors) console.error(`[startup] ERROR: ${e}`);
  process.exit(1);
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const store = new Store(process.env.DATA_FILE || join(ROOT, 'data', 'db.json'));
const providers = loadProviders();
const checkout = createCheckoutService({ store, providers });
const resume = () => resumeDue({ providers, store });
const vendorWebhook = createVendorWebhookHandler({ store, providers, resume });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',            // our pages cannot be framed (clickjacking); Razorpay's popup is framed INSIDE our page, which is fine
  'Referrer-Policy': 'no-referrer'
};

// ---- Rate limits (per client address). RATE_LIMIT=off disables them (tests, load checks). ----
const limitsOff = process.env.RATE_LIMIT === 'off';
const mk = (windowMs, max) => createRateLimiter({ windowMs, max });
const limits = {
  suggest: mk(60_000, 30),   // each search costs registrar calls
  quote: mk(60_000, 60),
  checkout: mk(60_000, 10),  // each creates a gateway order
  confirm: mk(60_000, 30),
  cancel: mk(60_000, 10),
  read: mk(60_000, 120),
  admin: mk(60_000, 120)
};
const adminFailures = mk(15 * 60_000, 10); // wrong admin tokens: lock the address out for the window
function limit(kind, req) {
  if (limitsOff) return;
  const r = limits[kind].take(clientKey(req));
  if (!r.ok) throw Object.assign(httpError(429, 'Too many requests. Please slow down and try again shortly.'), { retryAfter: r.retryAfterSec });
}

const send = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
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
const digest = (s) => createHash('sha256').update(String(s)).digest();

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
    limit('suggest', req);
    const seed = normalizeSeed(url.searchParams.get('seed'));
    if (seed.length < 2) throw httpError(400, 'Enter a brand or domain name');
    const available = await suggestDomains(providers.registrar, seed, { tld: config.tld, want: 12 });
    const exact = (await providers.registrar.checkAvailability([`${seed}.${config.tld}`]))[0];
    return { seed, exact: { domain: exact.domain, available: exact.available }, pricePerYear: config.domainPricePerYear, domains: available };
  },

  'POST /api/quote': async (req) => {
    limit('quote', req);
    const cart = validateCart(await readBody(req));
    return quote({ ...cart, mailboxes: cart.domains.flatMap((d) => d.mailboxes) });
  },

  // Step 1 of paying: validate, price on the server, create the gateway order or subscription.
  'POST /api/checkout': async (req) => { limit('checkout', req); return checkout.create(await readBody(req)); }
};

const safeMailbox = ({ credentialsEnc, smtp, ...safe }) => safe; // never leak credentials

const refundsInFlight = new Set();
function requireAdmin(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) throw httpError(403, 'Admin API is disabled (set ADMIN_TOKEN)');
  const key = clientKey(req);
  if (!limitsOff && !adminFailures.peek(key)) throw Object.assign(httpError(429, 'Too many failed attempts. Try again later.'), { retryAfter: 900 });
  // Compare fixed-length digests so neither the length nor the content of the token leaks through timing.
  if (!timingSafeEqual(digest(req.headers['x-admin-token'] || ''), digest(expected))) {
    adminFailures.take(key);
    throw httpError(401, 'Invalid admin token');
  }
  limit('admin', req);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

    // ---- Payments ----
    const cs = url.pathname.match(/^\/api\/checkout\/(\w+)(\/confirm)?$/);
    if (cs && req.method === 'GET' && !cs[2]) { limit('read', req); return send(res, 200, checkout.status(cs[1])); }
    if (cs && req.method === 'POST' && cs[2]) { limit('confirm', req); return send(res, 200, await checkout.confirm(cs[1], await readBody(req))); }

    // Gateway webhooks need the RAW body for the signature, and a fast 2xx. Signed, so not rate-limited.
    if (req.method === 'POST' && url.pathname === '/api/webhooks/razorpay') {
      return send(res, 200, checkout.handleWebhook(await readRaw(req), req.headers));
    }
    if (req.method === 'POST' && url.pathname === '/api/webhooks/zapmail') {
      return send(res, 200, vendorWebhook(await readRaw(req), req.headers));
    }

    // ---- Orders ----
    const m = url.pathname.match(/^\/api\/orders\/([\w]+)$/);
    if (req.method === 'GET' && m) {
      limit('read', req);
      const o = store.getOrder(m[1]);
      if (!o) throw httpError(404, 'Order not found');
      return send(res, 200, { ...publicOrder(o), billing: checkout.billing.summary(o) });
    }
    // An order's own mailboxes (the buyer's page). The global list is admin-only.
    const mb = url.pathname.match(/^\/api\/orders\/(\w+)\/mailboxes$/);
    if (req.method === 'GET' && mb) {
      limit('read', req);
      if (!store.getOrder(mb[1])) throw httpError(404, 'Order not found');
      return send(res, 200, store.listMailboxes().filter((x) => x.orderId === mb[1]).map(safeMailbox));
    }
    // Customer cancels their subscription at the end of the paid period. Proof of ownership is the
    // manage token handed out once at purchase (swap for CloudLead's real auth when integrating).
    const cn = url.pathname.match(/^\/api\/orders\/(\w+)\/cancel$/);
    if (req.method === 'POST' && cn) {
      limit('cancel', req);
      const o = store.getOrder(cn[1]);
      if (!o) throw httpError(404, 'Order not found');
      if (!o.manageToken || !timingSafeEqual(digest(req.headers['x-manage-token'] || ''), digest(o.manageToken))) throw httpError(403, 'Not allowed');
      return send(res, 200, await checkout.billing.cancel(o.id, { atCycleEnd: true }));
    }

    // ---- Admin API (disabled unless ADMIN_TOKEN is set) ----
    if (url.pathname.startsWith('/api/admin/')) {
      requireAdmin(req);
      if (req.method === 'GET' && url.pathname === '/api/admin/orders') {
        return send(res, 200, Object.values(store.data.orders).map((o) => ({
          ...publicOrder(o, { admin: true }),
          internalMargin: o.internalMargin,
          billing: o.billing || null, // full detail: plan ids, history, renewals, anything needing attention
          refunds: o.refunds || [],
          suggestedRefund: o.progress ? suggestedRefund(o) : null
        })));
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/mailboxes') {
        return send(res, 200, store.listMailboxes().map(safeMailbox));
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/vendor') {
        if (!providers.vendor.getCapacity) return send(res, 200, { vendor: providers.vendor.name, capacity: null });
        return send(res, 200, { vendor: providers.vendor.name, capacity: await providers.vendor.getCapacity() });
      }
      const ar0 = url.pathname.match(/^\/api\/admin\/orders\/(\w+)\/retry$/);
      if (req.method === 'POST' && ar0) {
        const o = store.getOrder(ar0[1]);
        if (!o) throw httpError(404, 'Order not found');
        if (o.status !== 'partial_failure') throw httpError(409, 'Only partially failed orders can be retried');
        provision(o, { providers, store }).catch((e) => console.error('retry crashed', e));
        return send(res, 202, publicOrder(o, { admin: true }));
      }
      const ac = url.pathname.match(/^\/api\/admin\/orders\/(\w+)\/cancel$/);
      if (req.method === 'POST' && ac) {
        const b = await readBody(req);
        return send(res, 200, await checkout.billing.cancel(ac[1], { atCycleEnd: b.atCycleEnd !== false }));
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/billing/tick') {
        await checkout.billing.tick();
        return send(res, 200, { ok: true });
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
          return send(res, 200, { ...publicOrder(o, { admin: true }), refunds: o.refunds });
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
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(data);
  } catch (err) {
    // Only errors deliberately marked `expose` reach the customer. Adapter errors can carry
    // an HTTP `status` of their own and would otherwise leak vendor/gateway details.
    send(res, err.expose ? err.status : 500, { error: err.expose ? err.message : 'Internal error' }, err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {});
    if (!err.expose) console.error(err);
  }
});

const port = process.env.PORT || 3000;
let timer = null;
server.listen(port, () => {
  console.log(`CloudLead infra purchase on http://localhost:${port}`);
  // Re-check waiting steps, finish new orders, run the billing lifecycle and tidy up. Recovers from crashes too.
  const pollMs = Number(process.env.POLL_INTERVAL_MS ?? 15000);
  if (pollMs > 0) {
    const run = () => {
      resume();
      checkout.billing.tick().catch((e) => console.error('billing tick failed', e));
      store.purgeStaleCheckouts(14 * 86_400_000);
    };
    run(); // pick up anything left over from the last run
    timer = setInterval(run, pollMs);
    timer.unref();
  }
  console.log(`adapters: registrar=${providers.registrar.name} dns=${providers.dns.name} vendor=${providers.vendor.name} payments=${providers.payments.name}`);
});

// Graceful shutdown (deploys, container stop). All work is resumable, so this only has to stop
// taking new requests and let in-flight ones finish; anything half-done is picked up on the next start.
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[shutdown] ${signal} received, closing`);
  if (timer) clearInterval(timer);
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(1), 10_000).unref(); // do not hang a deploy on a stuck connection
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
