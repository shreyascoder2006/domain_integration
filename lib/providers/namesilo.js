// NameSilo registrar adapter. Request/response shapes taken from NameSilo's
// published API reference (checked 2026-11-10): GET-only, JSON via type=json,
// reply.code 300 = success. Not yet run against the live API: test in their
// sandbox first (credentials come from contacting NameSilo).
//
// Env: NAMESILO_API_KEY        (required)
//      NAMESILO_BASE_URL       (optional, e.g. a sandbox base; default production)
//      NAMESILO_AUTO_RENEW     ('0' default | '1'): registrar-side auto-renew
//
// SECURITY: NameSilo requires the API key in the query string. Never log
// request URLs; errors below deliberately omit them. Calls must also come from
// an IP allowlisted in the NameSilo account (otherwise reply code 113).

import { PendingError } from '../errors.js';

const DEFAULT_BASE = 'https://www.namesilo.com/api';
// "Try again later" codes: not failures. 115 central registry not responding, 268 a previous nameserver change is
// unfinished, 400 an identical request is still processing. The pipeline parks the step and re-checks it.
const RETRY_LATER = { 115: 300_000, 268: 600_000, 400: 60_000 };

const toArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// Codes worth a human-readable explanation (full table is in NameSilo's docs).
const HINTS = {
  110: 'Invalid API key',
  113: 'Server IP is not allowlisted in the NameSilo account',
  119: 'Insufficient NameSilo account funds: top up the balance',
  262: 'Domain is already active in NameSilo (possibly registered by someone else)',
  264: 'Domain cannot be renewed for the requested period',
  267: 'Invalid domain or unsupported TLD',
  268: 'Previous nameserver change still pending: retry later',
  400: 'Request still processing: resubmit'
};

export function createNameSiloRegistrar({ apiKey, baseUrl, autoRenew, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('NAMESILO_API_KEY is required');
  const base = baseUrl || DEFAULT_BASE;
  const autoRenewFlag = (autoRenew ?? '0') === '1' ? '1' : '0';

  async function call(op, params = {}, okCodes = [300]) {
    const qs = new URLSearchParams({ version: '1', type: 'json', key: apiKey, ...params });
    const res = await fetchImpl(`${base}/${op}?${qs}`);
    if (!res.ok) throw new Error(`NameSilo ${op} failed: HTTP ${res.status}`);
    const json = await res.json().catch(() => null);
    const reply = json?.reply;
    if (!reply) throw new Error(`NameSilo ${op} returned an unreadable response`);
    const code = Number(reply.code);
    if (!okCodes.includes(code)) {
      const hint = HINTS[code] ? ` (${HINTS[code]})` : '';
      const message = `NameSilo ${op} error ${code}: ${reply.detail || 'unknown'}${hint}`;
      if (RETRY_LATER[code]) throw Object.assign(new PendingError(message, RETRY_LATER[code]), { nameSiloCode: code });
      throw Object.assign(new Error(message), { nameSiloCode: code });
    }
    return reply;
  }

  return {
    name: 'namesilo',

    /** -> [{domain, available, price?, premium?}] in the same order as the input. */
    async checkAvailability(domains) {
      const out = new Map();
      for (let i = 0; i < domains.length; i += 200) {
        const chunk = domains.slice(i, i + 200);
        const reply = await call('checkRegisterAvailability', { domains: chunk.join(',') });
        // `available` is an array of {domain, price, premium, duration}; a single
        // result may come back as a bare object, so always normalise.
        for (const a of toArray(reply.available)) {
          const premium = Number(a.premium) === 1;
          out.set(String(a.domain).toLowerCase(), { available: !premium, premium, price: Number(a.price) });
        }
        for (const u of toArray(reply.unavailable)) out.set(String(u.domain ?? u).toLowerCase(), { available: false });
        for (const v of toArray(reply.invalid)) out.set(String(v.domain ?? v).toLowerCase(), { available: false, invalid: true });
      }
      return domains.map((d) => ({ domain: d, ...(out.get(d.toLowerCase()) || { available: false }) }));
    },

    /** contact: {firstName,lastName,company,address,city,state,zip,country(ISO-2),email,phoneCc,phone} */
    async register({ domain, contact, years = 1 }) {
      const c = contact || {};
      const params = {
        domain, years: String(years), private: '1', auto_renew: autoRenewFlag,
        fn: c.firstName, ln: c.lastName, ad: c.address, cy: c.city, st: c.state,
        zp: c.zip, ct: c.country, em: c.email, ph: `+${String(c.phoneCc).replace(/\D/g, '')}.${String(c.phone).replace(/\D/g, '')}`
      };
      if (c.company) params.cp = c.company;
      // 301 = registered but our nameservers were used (we change them next anyway).
      // 302 = registered but NameSilo fell back to the account's default contact.
      let reply;
      try {
        reply = await call('registerDomain', params, [300, 301, 302]);
      } catch (e) {
        // 262 = "already active in our system". If it is in OUR account, an earlier attempt succeeded
        // (e.g. we crashed before saving the step): treat as registered. getDomainInfo fails with
        // code 200 for a domain that is not ours, in which case the original error stands.
        if (e.nameSiloCode === 262) {
          try {
            const info = await call('getDomainInfo', { domain });
            return { domain, years, registeredAt: new Date().toISOString(), whoisPrivacy: true, alreadyRegistered: true, expires: info.expires, warnings: [] };
          } catch { /* not ours */ }
        }
        throw e;
      }
      const code = Number(reply.code);
      return {
        domain, years, registeredAt: new Date().toISOString(), whoisPrivacy: true,
        orderAmount: reply.order_amount != null ? Number(reply.order_amount) : undefined,
        warnings: code === 302 ? ['Registrant contact was rejected; the NameSilo account default contact was used'] : []
      };
    },

    /** Renew for N years, charged to the NameSilo account balance. Also restores domains in the restoration period. */
    async renew({ domain, years = 1 }) {
      const reply = await call('renewDomain', { domain, years: String(years) });
      return { domain, years, renewedAt: new Date().toISOString(), orderAmount: reply.order_amount != null ? Number(reply.order_amount) : undefined };
    },

    /** Expiry date (YYYY-MM-DD) and status. Fails with code 200 for a domain that is not in our account. */
    async getDomainInfo(domain) {
      const r = await call('getDomainInfo', { domain });
      return { domain, created: r.created, expires: r.expires, status: r.status, autoRenew: r.auto_renew === 'Yes' };
    },

    /** Read-only credential check. Availability of a throwaway name costs nothing and proves the API key AND this server's IP allowlist. */
    async preflight() {
      try {
        await call('checkRegisterAvailability', { domains: 'cloudlead-preflight-check.com' });
        return { ok: true, detail: "API key accepted and this server's IP is allowlisted" };
      } catch (e) { return { ok: false, detail: e.message }; }
    },

    async setNameservers(domain, nameServers) {
      if (!Array.isArray(nameServers) || nameServers.length < 2) throw new Error('At least 2 nameservers are required');
      const params = { domain };
      nameServers.slice(0, 13).forEach((ns, i) => { params[`ns${i + 1}`] = ns; });
      await call('changeNameServers', params);
      return { domain, nameServers };
    }
  };
}
