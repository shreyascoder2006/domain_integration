import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { quote } from './lib/pricing.js';
import { suggestDomains, normalizeSeed } from './lib/domainSuggest.js';
import { createStore } from './lib/store.js';
import { loadProviders } from './lib/providers/index.js';
import { provision, publicOrder, resumeDue } from './lib/provisioner.js';
import { suggestedRefund, checkRefundAmount, refundedSoFar } from './lib/refunds.js';
import { createCheckoutService } from './lib/checkout.js';
import { createVendorWebhookHandler } from './lib/vendorHooks.js';
import { createRateLimiter, clientKey } from './lib/ratelimit.js';
import { checkEnv } from './lib/startup.js';
import { validateCart, httpError } from './lib/validate.js';
import { log } from './lib/log.js';
import { createMailer } from './lib/mailers.js';
import { createNotifier } from './lib/notify.js';
import { createAlerter, sinksFromEnv } from './lib/alerts.js';
import { orderProblems } from './lib/problems.js';
import { createEngineApi } from './lib/engine.js';
import { buildReceipts, sellerFromEnv } from './lib/receipts.js';
import { createAbuseGuard } from './lib/abuse.js';
import { createHttpCounters, renderMetrics } from './lib/metrics.js';
import { PendingError } from './lib/errors.js';

// ---- Refuse to boot in a configuration that would lose money or data ----
const env = checkEnv();
for (const w of env.warnings) log.warn(`startup: ${w}`);
if (env.errors.length) {
  for (const e of env.errors) log.error(`startup: ${e}`);
  process.exit(1);
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const FROM = process.env.NOTIFY_FROM || `${process.env.PAYMENT_MERCHANT_NAME || 'CloudLead'} <no-reply@localhost>`;

// Demo/test only: lets `npm run simulate` jump forward in time so grace periods and renewals can be watched.
const DEV_TOOLS = process.env.DEV_TOOLS === '1' && !IS_PROD;
let clockOffsetMs = 0;
const now = () => Date.now() + clockOffsetMs;

const store = await createStore(process.env, join(ROOT, 'data', 'db.json'));
const providers = loadProviders();
const mailer = createMailer();
const abuse = createAbuseGuard({ store, now });
let checkout; // assigned below: the notifier asks it for the customer-safe billing summary
const notifier = createNotifier({ store, mailer, publicUrl: PUBLIC_URL, from: FROM, brand: process.env.PAYMENT_MERCHANT_NAME || 'CloudLead', summarize: (o) => checkout.billing.summary(o), now });
checkout = createCheckoutService({ store, providers, notify: notifier.notify, now, abuse });
const engine = createEngineApi({ store });
const http = createHttpCounters();
const resume = () => resumeDue({ providers, store, notify: notifier.notify });
const vendorWebhook = createVendorWebhookHandler({ store, providers, resume });

// Vendor capacity is an API call, so it is refreshed at most every 30 minutes and cached for the alerter.
let capacityProblems = [];
let capacityCheckedAt = 0;
async function refreshCapacity() {
  if (!providers.vendor.getCapacity || Date.now() - capacityCheckedAt < 30 * 60_000) return;
  capacityCheckedAt = Date.now();
  try {
    const c = await providers.vendor.getCapacity();
    const minSlots = Number(process.env.ALERT_MIN_SLOTS ?? 10);
    capacityProblems = Object.entries(c.providers || {}).filter(([, v]) => (v.availableMailboxes ?? Infinity) < minSlots)
      .map(([k, v]) => ({ code: `vendor_slots_low:${k}`, message: `Mailbox vendor has only ${v.availableMailboxes} free ${k} slots` }));
    if (c.walletBalanceUsd != null && c.walletBalanceUsd < Number(process.env.ALERT_MIN_WALLET ?? 20)) {
      capacityProblems.push({ code: 'vendor_wallet_low', message: `Mailbox vendor wallet is low ($${c.walletBalanceUsd})` });
    }
  } catch (e) { log.warn('vendor capacity check failed', e); }
}
const alerter = createAlerter({ store, sinks: sinksFromEnv(process.env, { mailer, from: FROM, log }), adminUrl: PUBLIC_URL, now, extra: () => capacityProblems });

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
  manage: mk(60_000, 60),
  resend: mk(3_600_000, 5),  // "email me my link"
  admin: mk(60_000, 120),
  engine: mk(60_000, 600)
};
const authFailures = { admin: mk(15 * 60_000, 10), engine: mk(15 * 60_000, 10), metrics: mk(15 * 60_000, 10) }; // wrong tokens lock the address out
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
  let size = 0, tooBig = false;
  // Stop buffering at the limit but let the 413 reply go out before the socket is closed (see the error handler).
  req.on('data', (c) => { if (tooBig) return; size += c.length; if (size > 1e6) { tooBig = true; chunks.length = 0; reject(httpError(413, 'Body too large')); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readBody = async (req) => {
  const raw = await readRaw(req);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw httpError(400, 'Invalid JSON'); }
};
const digest = (s) => createHash('sha256').update(String(s)).digest();
const sameToken = (given, expected) => timingSafeEqual(digest(given || ''), digest(expected));

/** Shared token check with a lockout after repeated failures. `kind` selects the failure counter. */
function requireToken(kind, req, expected, disabledMessage) {
  if (!expected) throw httpError(403, disabledMessage);
  const key = clientKey(req);
  if (!limitsOff && !authFailures[kind].peek(key)) throw Object.assign(httpError(429, 'Too many failed attempts. Try again later.'), { retryAfter: 900 });
  const given = kind === 'metrics' ? String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') : req.headers[kind === 'admin' ? 'x-admin-token' : 'x-engine-token'];
  if (!sameToken(given, expected)) { authFailures[kind].take(key); throw httpError(401, 'Invalid token'); }
}
const requireAdmin = (req) => { requireToken('admin', req, process.env.ADMIN_TOKEN, 'Admin API is disabled (set ADMIN_TOKEN)'); limit('admin', req); };
const requireEngine = (req) => { requireToken('engine', req, process.env.ENGINE_TOKEN, 'Engine API is disabled (set ENGINE_TOKEN)'); limit('engine', req); };
/** A buyer proves they own an order with the manage token handed out once at purchase (swap for real auth when integrating). */
function requireManage(req, order) {
  if (!order.manageToken || !sameToken(req.headers['x-manage-token'], order.manageToken)) throw httpError(403, 'Not allowed');
}

const safeMailbox = ({ credentialsEnc, smtp, ...safe }) => safe; // never leak credentials

const route = {
  'GET /api/config': async () => ({
    currency: config.currency,
    domainPricePerYear: config.domainPricePerYear,
    recommendedMailboxesPerDomain: config.recommendedMailboxesPerDomain,
    maxMailboxesPerDomain: config.maxMailboxesPerDomain,
    plans: config.plans,
    azure: config.azure,
    providers: config.providers,
    // Links shown beside the terms checkbox. Only real https URLs are used; nothing is shown if unset.
    legal: { terms: process.env.TERMS_URL || '', privacy: process.env.PRIVACY_URL || '', refund: process.env.REFUND_URL || '' }
  }),

  'GET /api/domains/suggest': async (req, url) => {
    limit('suggest', req);
    const seed = normalizeSeed(url.searchParams.get('seed'));
    if (seed.length < 2) throw httpError(400, 'Enter a brand or domain name');
    const want = Math.min(60, Math.max(1, Number(url.searchParams.get('want')) || 12));
    const available = await suggestDomains(providers.registrar, seed, { tld: config.tld, want, isAllowed: (d) => !abuse.isBlockedName(d) });
    const exactName = `${seed}.${config.tld}`;
    const exact = abuse.isBlockedName(exactName) ? { domain: exactName, available: false } : (await providers.registrar.checkAvailability([exactName]))[0];
    return { seed, exact: { domain: exact.domain, available: exact.available }, pricePerYear: config.domainPricePerYear, domains: available };
  },

  'POST /api/quote': async (req) => {
    limit('quote', req);
    const cart = validateCart(await readBody(req));
    return quote({ ...cart, mailboxes: cart.domains.flatMap((d) => d.mailboxes) });
  },

  // Step 1 of paying: validate, price on the server, create the gateway order or subscription.
  'POST /api/checkout': async (req) => { limit('checkout', req); return checkout.create(await readBody(req), { ip: clientKey(req) }); },

  // "Email me my link": for people who lost the manage link. Always answers the same, so it cannot be used to find customers.
  'POST /api/manage/resend': async (req) => {
    limit('resend', req);
    const b = await readBody(req);
    for (const o of store.findOrdersByEmail(b.email)) notifier.notify('manage_link', o);
    return { ok: true, message: 'If that address has an order, we have emailed a link.' };
  }
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const started = Date.now();
  const requestId = randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    http.observe(res.statusCode);
    if (url.pathname !== '/healthz' && url.pathname !== '/metrics') {
      log.info('request', { id: requestId, method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started, ip: clientKey(req) });
    }
  });
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/metrics') {
      requireToken('metrics', req, process.env.METRICS_TOKEN || process.env.ADMIN_TOKEN, 'Metrics are disabled (set METRICS_TOKEN or ADMIN_TOKEN)');
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end(renderMetrics({ store, http, storeName: process.env.STORE === 'sqlite' ? 'sqlite' : 'json' }));
    }

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
    const sub = url.pathname.match(/^\/api\/orders\/(\w+)\/(mailboxes|receipts|cancel)$/);
    if (sub) {
      const o = store.getOrder(sub[1]);
      if (sub[2] === 'cancel' && req.method === 'POST') {
        limit('cancel', req);
        if (!o) throw httpError(404, 'Order not found');
        requireManage(req, o);
        return send(res, 200, await checkout.billing.cancel(o.id, { atCycleEnd: true }));
      }
      if (req.method === 'GET') {
        limit('manage', req);
        if (!o) throw httpError(404, 'Order not found');
        requireManage(req, o); // mailbox addresses and billing history belong to the buyer
        if (sub[2] === 'mailboxes') return send(res, 200, store.listMailboxes().filter((x) => x.orderId === o.id).map(safeMailbox));
        if (sub[2] === 'receipts') {
          const receipts = buildReceipts(o, sellerFromEnv());
          return send(res, 200, { receipts: [...receipts], credits: receipts.credits || [] });
        }
      }
    }

    // ---- Engine API: the sending/warm-up engine reads mailboxes and reports back (ENGINE_TOKEN) ----
    if (url.pathname.startsWith('/api/engine/')) {
      requireEngine(req);
      if (req.method === 'GET' && url.pathname === '/api/engine/mailboxes') {
        const q = url.searchParams;
        return send(res, 200, engine.listMailboxes({ sendable: q.get('sendable') === '1', orderId: q.get('orderId') || undefined, userId: q.get('userId') || undefined }));
      }
      const em = url.pathname.match(/^\/api\/engine\/mailboxes\/(\w+)\/(credentials|state)$/);
      if (em && req.method === 'GET' && em[2] === 'credentials') return send(res, 200, engine.getCredentials(em[1]));
      if (em && req.method === 'POST' && em[2] === 'state') return send(res, 200, engine.setState(em[1], await readBody(req)));
      throw httpError(404, 'Not found');
    }

    // ---- Admin API (disabled unless ADMIN_TOKEN is set) ----
    if (url.pathname.startsWith('/api/admin/')) {
      requireAdmin(req);
      if (req.method === 'GET' && url.pathname === '/api/admin/orders') {
        return send(res, 200, store.listOrders().map((o) => ({
          ...publicOrder(o, { admin: true }),
          internalMargin: o.internalMargin,
          billing: o.billing || null, // full detail: plan ids, history, renewals, anything needing attention
          problems: orderProblems(o),
          refunds: o.refunds || [],
          suggestedRefund: o.progress ? suggestedRefund(o) : null
        })));
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/mailboxes') {
        return send(res, 200, store.listMailboxes().map(safeMailbox));
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/outbox') {
        return send(res, 200, { mailer: mailer.name, items: store.listOutbox().slice(-200).reverse(), sent: mailer.sent?.slice(-50).reverse() ?? null });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/vendor') {
        if (!providers.vendor.getCapacity) return send(res, 200, { vendor: providers.vendor.name, capacity: null });
        return send(res, 200, { vendor: providers.vendor.name, capacity: await providers.vendor.getCapacity() });
      }
      // Demo only (DEV_TOOLS=1, never in production): move the billing clock forward to watch grace periods and renewals.
      if (url.pathname === '/api/admin/dev/advance' && req.method === 'POST') {
        if (!DEV_TOOLS) throw httpError(404, 'Not found');
        const b = await readBody(req);
        clockOffsetMs += Math.max(0, Number(b.days) || 0) * 86_400_000;
        await checkout.billing.tick(); await notifier.flush(); await alerter.scan();
        return send(res, 200, { offsetDays: clockOffsetMs / 86_400_000, now: new Date(now()).toISOString() });
      }
      const ar0 = url.pathname.match(/^\/api\/admin\/orders\/(\w+)\/retry$/);
      if (req.method === 'POST' && ar0) {
        const o = store.getOrder(ar0[1]);
        if (!o) throw httpError(404, 'Order not found');
        if (o.status !== 'partial_failure') throw httpError(409, 'Only partially failed orders can be retried');
        provision(o, { providers, store, notify: notifier.notify }).catch((e) => log.error('retry crashed', { order: o.id }, e));
        return send(res, 202, publicOrder(o, { admin: true }));
      }
      const ac = url.pathname.match(/^\/api\/admin\/orders\/(\w+)\/cancel$/);
      if (req.method === 'POST' && ac) {
        const b = await readBody(req);
        return send(res, 200, await checkout.billing.cancel(ac[1], { atCycleEnd: b.atCycleEnd !== false }));
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/billing/tick') {
        await checkout.billing.tick(); await notifier.flush(); await alerter.scan();
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
            log.error('refund gateway error', { order: o.id }, e);
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
    // A vendor that says "try again later" is not our bug: tell the caller to retry instead of reporting a crash.
    if (err instanceof PendingError) {
      log.warn('upstream asked us to retry later', { id: requestId, path: url.pathname }, err);
      return send(res, 503, { error: 'This is temporarily unavailable. Please try again in a few minutes.' }, { 'Retry-After': String(Math.ceil(err.retryAfterMs / 1000)) });
    }
    const extra = { ...(err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {}), ...(err.status === 413 ? { Connection: 'close' } : {}) };
    if (err.status === 413) res.once('finish', () => req.socket.destroy());
    send(res, err.expose ? err.status : 500, { error: err.expose ? err.message : 'Internal error' }, extra);
    if (!err.expose) log.error('unhandled error', { id: requestId, path: url.pathname }, err);
  }
});

const refundsInFlight = new Set();
const port = process.env.PORT || 3000;
let timer = null;
server.listen(port, () => {
  log.info(`CloudLead infra purchase listening on http://localhost:${port}`, { store: process.env.STORE || 'json' });
  // Re-check waiting steps, finish new orders, run billing, send email and alerts, tidy up. Recovers from crashes too.
  const pollMs = Number(process.env.POLL_INTERVAL_MS ?? 15000);
  if (pollMs > 0) {
    const run = async () => {
      try {
        resume();
        await checkout.billing.tick();
        await notifier.flush();
        await refreshCapacity();
        await alerter.scan();
        store.purgeStaleCheckouts(14 * 86_400_000);
        store.pruneOutbox(30 * 86_400_000);
      } catch (e) { log.error('timer run failed', e); }
    };
    run(); // pick up anything left over from the last run
    timer = setInterval(run, pollMs);
    timer.unref();
  }
  log.info('adapters', { registrar: providers.registrar.name, dns: providers.dns.name, vendor: providers.vendor.name, payments: providers.payments.name, mailer: mailer.name, devTools: DEV_TOOLS });
});

// Graceful shutdown (deploys, container stop). All work is resumable, so this only has to stop
// taking new requests and let in-flight ones finish; anything half-done is picked up on the next start.
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info(`${signal} received, shutting down`);
  if (timer) clearInterval(timer);
  server.close(() => { try { store.close(); } catch { /* already closed */ } process.exit(0); });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(1), 10_000).unref(); // do not hang a deploy on a stuck connection
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
