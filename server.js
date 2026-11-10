import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { suggestedRefund, checkRefundAmount, refundedSoFar } from './lib/refunds.js';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { quote, margin } from './lib/pricing.js';
import { suggestDomains, normalizeSeed } from './lib/domainSuggest.js';
import { Store } from './lib/store.js';
import { loadProviders } from './lib/providers/index.js';
import { provision, initProgress, publicOrder } from './lib/provisioner.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const store = new Store(process.env.DATA_FILE || join(ROOT, 'data', 'db.json'));
const providers = loadProviders();

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const PREFIX_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const httpError = (status, message) => Object.assign(new Error(message), { status });
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) { reject(httpError(413, 'Body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(httpError(400, 'Invalid JSON')); } });
});

/** Validate + normalise the cart. Returns clean { provider, plan, domains[] }. */
function validateCart(b) {
  const provider = b.provider;
  const plan = provider === 'azure' ? 'azure' : b.plan;
  if (!Array.isArray(b.domains) || !b.domains.length) throw httpError(400, 'Select at least one domain');
  const seenDomains = new Set();
  const domains = b.domains.map((d) => {
    const name = String(d.name || '').toLowerCase().trim();
    if (!DOMAIN_RE.test(name)) throw httpError(400, `Invalid domain: ${d.name}`);
    if (seenDomains.has(name)) throw httpError(400, `Duplicate domain: ${name}`);
    seenDomains.add(name);
    if (!Array.isArray(d.mailboxes) || !d.mailboxes.length) throw httpError(400, `${name} needs at least one mailbox`);
    if (d.mailboxes.length > config.maxMailboxesPerDomain) throw httpError(400, `Max ${config.maxMailboxesPerDomain} mailboxes per domain`);
    const seenPrefix = new Set();
    const mailboxes = d.mailboxes.map((m) => {
      const emailPrefix = String(m.emailPrefix || '').toLowerCase().trim();
      const firstName = String(m.firstName || '').trim();
      const lastName = String(m.lastName || '').trim();
      if (!firstName || !lastName) throw httpError(400, `First and last name required for ${name}`);
      if (!PREFIX_RE.test(emailPrefix)) throw httpError(400, `Invalid email prefix: ${m.emailPrefix}`);
      if (seenPrefix.has(emailPrefix)) throw httpError(400, `Duplicate mailbox ${emailPrefix}@${name}`);
      seenPrefix.add(emailPrefix);
      return { firstName, lastName, emailPrefix };
    });
    return { name, mailboxes };
  });
  return { provider, plan, domains };
}

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
    return {
      seed,
      exact: { domain: exact.domain, available: exact.available },
      pricePerYear: config.domainPricePerYear,
      domains: available
    };
  },

  'POST /api/quote': async (req) => {
    const cart = validateCart(await readBody(req));
    return quote({ ...cart, mailboxes: cart.domains.flatMap((d) => d.mailboxes) });
  },

  'POST /api/orders': async (req) => {
    const b = await readBody(req);
    const cart = validateCart(b);
    const c = b.contact || {};
    for (const f of ['firstName', 'lastName', 'company', 'address', 'country', 'state', 'city', 'zip', 'phoneCc', 'phone', 'email']) {
      if (!String(c[f] || '').trim()) throw httpError(400, `Contact detail missing: ${f}`);
    }
    // Registrars need an ISO-3166 alpha-2 country code and a deliverable email.
    c.country = String(c.country).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c.country)) throw httpError(400, 'Country must be a 2-letter code (e.g. US, IN)');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw httpError(400, 'Invalid contact email');
    if (!/^\d{1,4}$/.test(String(c.phoneCc).replace(/\D/g, '')) || !/^\d{6,14}$/.test(String(c.phone).replace(/\D/g, ''))) {
      throw httpError(400, 'Invalid phone number');
    }
    if (!b.acceptedTerms) throw httpError(400, 'You must accept the terms');
    let forwardingDomain = null;
    if (b.forwardingDomain) {
      forwardingDomain = String(b.forwardingDomain).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!DOMAIN_RE.test(forwardingDomain)) throw httpError(400, 'Invalid forwarding domain');
    }

    // Idempotency: same key returns the same order instead of double charging.
    const key = b.idempotencyKey ? String(b.idempotencyKey) : null;
    if (key) {
      const existing = Object.values(store.data.orders).find((o) => o.idempotencyKey === key);
      if (existing) return publicOrder(existing);
    }

    // Re-check availability right before charging (names can be taken meanwhile).
    const checks = await providers.registrar.checkAvailability(cart.domains.map((d) => d.name));
    const taken = checks.filter((r) => !r.available).map((r) => r.domain);
    if (taken.length) throw httpError(409, `No longer available: ${taken.join(', ')}`);

    const q = quote({ ...cart, mailboxes: cart.domains.flatMap((d) => d.mailboxes) });
    const charge = await providers.payments.charge({ amount: q.total, currency: q.currency, source: b.paymentToken });
    if (charge.status !== 'succeeded') throw httpError(402, 'Payment failed');

    const order = {
      id: 'ord_' + randomBytes(6).toString('hex'),
      idempotencyKey: key,
      userId: 'demo-user',
      status: 'paid',
      provider: cart.provider,
      plan: cart.plan,
      domains: cart.domains,
      forwardingDomain,
      contact: c,
      quote: q,
      internalMargin: margin(q),
      paymentId: charge.id,
      createdAt: new Date().toISOString()
    };
    initProgress(order);
    store.putOrder(order);
    // Fire and forget; the UI polls GET /api/orders/:id.
    provision(order, { providers, store }).catch((e) => console.error('provision crashed', e));
    return publicOrder(order);
  },

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
    // GET /api/orders/:id
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
          ...publicOrder(o),
          internalMargin: o.internalMargin,
          refunds: o.refunds || [],
          suggestedRefund: o.progress ? suggestedRefund(o) : null
        })));
      }
      const ar = url.pathname.match(/^\/api\/admin\/orders\/(\w+)\/refund$/);
      if (req.method === 'POST' && ar) {
        const o = store.getOrder(ar[1]);
        if (!o) throw httpError(404, 'Order not found');
        if (refundsInFlight.has(o.id)) throw httpError(409, 'A refund for this order is already in progress');
        refundsInFlight.add(o.id);
        try {
          const b = await readBody(req);
          const amount = checkRefundAmount(o, b.amount ?? suggestedRefund(o).amount);
          const re = await providers.payments.refund({ paymentId: o.paymentId, amount });
          o.refunds = [...(o.refunds || []), { id: re.id, amount, reason: String(b.reason || ''), at: new Date().toISOString() }];
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
    send(res, err.status || 500, { error: err.status ? err.message : 'Internal error' });
    if (!err.status) console.error(err);
  }
}).listen(process.env.PORT || 3000, () => {
  console.log(`CloudLead infra purchase prototype on http://localhost:${process.env.PORT || 3000}`);
  console.log(`adapters: registrar=${providers.registrar.name} dns=${providers.dns.name} vendor=${providers.vendor.name} payments=${providers.payments.name}`);
});
