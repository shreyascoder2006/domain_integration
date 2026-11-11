// Abuse and spend protection for the checkout. No card data is involved: it works from what we already
// know (email, address, domain names, recent orders). Everything is conservative and overridable by env.
import { createHmac } from 'node:crypto';
import { httpError } from './validate.js';

// A starter list of throwaway-mailbox domains. Extend with ABUSE_DISPOSABLE_DOMAINS (comma list).
const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
  'temp-mail.io', 'throwawaymail.com', 'yopmail.com', 'yopmail.net', 'trashmail.com', 'trashmail.net', 'getnada.com', 'nada.email', 'maildrop.cc', 'sharklasers.com',
  'grr.la', 'dispostable.com', 'fakeinbox.com', 'mintemail.com', 'spamgourmet.com', 'mailnesia.com', 'mohmal.com', 'emailondeck.com', 'tempail.com', 'tempinbox.com',
  'burnermail.io', 'mytemp.email', 'moakt.com', 'discard.email', 'spambox.us', 'trbvm.com', 'mailcatch.com', 'inboxbear.com', 'tmpmail.org', 'tmpmail.net',
  'dropmail.me', 'fexpost.com', 'tmail.ws', 'harakirimail.com', 'mail.tm', 'internxt.com'];

// Brands most used in phishing. Matching is a substring test on the name (before the TLD), so a few legitimate
// names will be caught: allow them one by one with ABUSE_ALLOW_DOMAINS, extend the list with ABUSE_BLOCK_TERMS.
const BLOCK_TERMS = ['paypal', 'paypa1', 'google', 'gmail', 'microsoft', 'outlook', 'office365', 'icloud', 'amazon', 'facebook', 'instagram', 'whatsapp',
  'netflix', 'linkedin', 'binance', 'coinbase', 'metamask', 'wellsfargo', 'bankofamerica', 'chase-', 'citibank', 'hsbc', 'barclays', 'hdfcbank', 'icicibank',
  'sbi-', 'dhl-', 'fedex', 'usps-', 'docusign', 'dropbox', 'adobe-', 'stripe', 'razorpay', 'zapmail', 'namesilo', 'cloudflare'];

const list = (env, extra) => new Set([...extra, ...String(env || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)]);
const label = (domain) => String(domain).toLowerCase().replace(/\.[a-z.]+$/, '');

export function createAbuseGuard({ store, env = process.env, now = () => Date.now() }) {
  const disposable = list(env.ABUSE_DISPOSABLE_DOMAINS, DISPOSABLE);
  const terms = [...list(env.ABUSE_BLOCK_TERMS, BLOCK_TERMS)];
  const allow = list(env.ABUSE_ALLOW_DOMAINS, []);
  const cap = Number(env.DAILY_DOMAIN_CAP ?? 200);          // domains per rolling 24 h: protects your registrar balance
  const maxDomains = Number(env.MAX_DOMAINS_PER_ORDER ?? 20);
  const H = 3_600_000, D = 86_400_000;
  // Keyed, not a bare hash: an unsalted hash of an IPv4 address can be reversed by trying all 4 billion of them.
  const salt = env.ABUSE_SALT || env.CREDENTIALS_KEY || 'cloudlead-dev-salt';
  const sha = (s) => createHmac('sha256', salt).update(String(s)).digest('hex').slice(0, 24);

  const blockedName = (domain) => {
    const d = String(domain).toLowerCase();
    if (allow.has(d)) return false;
    const l = label(d);
    return terms.some((t) => l.includes(t));
  };

  return {
    isBlockedName: blockedName,
    ipHash: (ip) => sha(ip),

    /** Throws an `expose`-able httpError when the checkout looks abusive. Never reveals which rule fired in detail. */
    check({ email, ip, domains }) {
      const t = now();
      const mail = String(email || '').toLowerCase();
      const mailDomain = mail.split('@')[1] || '';
      if (disposable.has(mailDomain)) throw httpError(400, 'Please use a permanent email address (temporary mailboxes are not accepted).');
      if (domains.length > maxDomains) throw httpError(400, `A single order can include at most ${maxDomains} domains. Please split it.`);
      if (domains.some((d) => blockedName(d))) throw httpError(400, "One of these domain names can't be registered. Please choose a different name.");

      const checkouts = store.recentCheckouts(t - D); // only the last 24 hours matter to every rule below
      const ipH = ip ? sha(ip) : null;
      const byMail = checkouts.filter((c) => String(c.contact?.email || '').toLowerCase() === mail);
      if (byMail.filter((c) => c.status === 'awaiting_payment' && t - Date.parse(c.createdAt) < H).length >= 3) {
        throw Object.assign(httpError(429, 'You have several unfinished checkouts. Please complete or wait a little before starting another.'), { retryAfter: 600 });
      }
      if (byMail.filter((c) => t - Date.parse(c.createdAt) < D).length >= 8) throw httpError(429, 'Order limit reached for today. Contact support if you need more.');
      if (ipH && checkouts.filter((c) => c.ipHash === ipH && t - Date.parse(c.createdAt) < H).length >= 20) {
        throw Object.assign(httpError(429, 'Too many checkouts from your network. Please try again later.'), { retryAfter: 900 });
      }

      // Spend cap across everyone: stops a runaway script or a bug from emptying the registrar balance.
      const recent = checkouts.filter((c) => t - Date.parse(c.createdAt) < D && c.status !== 'abandoned');
      const reserved = recent.reduce((n, c) => n + (c.cart?.domains?.length || 0), 0) + domains.length;
      if (reserved > cap) {
        const e = httpError(503, 'We are temporarily at capacity for new domains. Please try again later.');
        e.capacity = { reserved, cap };
        throw e;
      }
    }
  };
}
