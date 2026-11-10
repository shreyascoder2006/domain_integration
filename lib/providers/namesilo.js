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

const DEFAULT_BASE = 'https://www.namesilo.com/api';

const toArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// Codes worth a human-readable explanation (full table is in NameSilo's docs).
const HINTS = {
  110: 'Invalid API key',
  113: 'Server IP is not allowlisted in the NameSilo account',
  119: 'Insufficient NameSilo account funds: top up the balance',
  262: 'Domain is already active in NameSilo (possibly registered by someone else)',
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
      throw Object.assign(new Error(`NameSilo ${op} error ${code}: ${reply.detail || 'unknown'}${hint}`), { nameSiloCode: code });
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
      const reply = await call('registerDomain', params, [300, 301, 302]);
      const code = Number(reply.code);
      return {
        domain, years, registeredAt: new Date().toISOString(), whoisPrivacy: true,
        orderAmount: reply.order_amount != null ? Number(reply.order_amount) : undefined,
        warnings: code === 302 ? ['Registrant contact was rejected; the NameSilo account default contact was used'] : []
      };
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
