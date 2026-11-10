import { config } from './config.js';

export const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const PREFIX_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

/** An error whose message is safe to show to the customer. */
export const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

/** Validate + normalise the cart. Returns clean { provider, plan, domains[] }. */
export function validateCart(b) {
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
      // No consecutive separators: mailbox vendors (e.g. Zapmail) reject "a..b", "a__b".
      if (!PREFIX_RE.test(emailPrefix) || /[._-]{2}/.test(emailPrefix)) throw httpError(400, `Invalid email prefix: ${m.emailPrefix}`);
      if (seenPrefix.has(emailPrefix)) throw httpError(400, `Duplicate mailbox ${emailPrefix}@${name}`);
      seenPrefix.add(emailPrefix);
      return { firstName, lastName, emailPrefix };
    });
    return { name, mailboxes };
  });
  return { provider, plan, domains };
}

/** Contact details, forwarding domain and terms. Returns { contact, forwardingDomain }. */
export function validateCheckoutExtras(b) {
  const c = { ...(b.contact || {}) };
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
  return { contact: c, forwardingDomain };
}
