// Cloudflare DNS adapter. Request shapes follow Cloudflare's published API docs
// (zones create, dns_records create, rulesets phases entrypoint). Not yet run
// against the live API: test with a real token in a scratch account first.
//
// Env: CLOUDFLARE_API_TOKEN (permissions: Zone:Edit, DNS:Edit, Single Redirect:Edit)
//      CLOUDFLARE_ACCOUNT_ID (optional but recommended)
const BASE = 'https://api.cloudflare.com/client/v4';

export function createCloudflareDns({ token, accountId, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  const zones = new Map(); // domain -> { id, nameServers }

  async function cf(method, path, body) {
    const res = await fetchImpl(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const msg = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
      throw Object.assign(new Error(`Cloudflare ${method} ${path} failed: ${msg}`), { cfErrors: json.errors || [] });
    }
    return json.result;
  }

  async function findZone(domain) {
    const list = await cf('GET', `/zones?name=${encodeURIComponent(domain)}`);
    return list && list[0] ? { id: list[0].id, nameServers: list[0].name_servers } : null;
  }

  async function getZone(domain) {
    if (zones.has(domain)) return zones.get(domain);
    // Idempotent: reuse an existing zone so retries never create duplicates.
    let z = await findZone(domain);
    if (!z) {
      const r = await cf('POST', '/zones', { name: domain, type: 'full', ...(accountId ? { account: { id: accountId } } : {}) });
      z = { id: r.id, nameServers: r.name_servers };
    }
    zones.set(domain, z);
    return z;
  }

  const isDuplicate = (err) => /already exists|identical record/i.test(err.message);

  async function addRecord(zoneId, rec) {
    const body = { type: rec.type, name: rec.name, content: rec.value ?? rec.content, ttl: 1 };
    if (rec.type === 'MX') body.priority = rec.priority ?? 10;
    if (rec.proxied) body.proxied = true;
    try { return await cf('POST', `/zones/${zoneId}/dns_records`, body); }
    catch (e) { if (isDuplicate(e)) return null; throw e; }
  }

  return {
    name: 'cloudflare-dns',

    /** Create (or reuse) the zone and return the nameservers the registrar must use. */
    async prepareZone(domain) {
      const z = await getZone(domain);
      return { zoneId: z.id, nameServers: z.nameServers };
    },

    async applyRecords(domain, records) {
      const z = await getZone(domain);
      let applied = 0;
      for (const r of records) { await addRecord(z.id, r); applied++; }
      return { domain, applied };
    },

    /**
     * Redirect domain -> url using a Single Redirect rule. Cloudflare only runs
     * redirect rules on PROXIED hostnames, so we add proxied placeholder A
     * records (192.0.2.1 is a reserved documentation address) for @ and www.
     */
    async setForwarding(domain, url) {
      const z = await getZone(domain);
      await addRecord(z.id, { type: 'A', name: domain, value: '192.0.2.1', proxied: true });
      await addRecord(z.id, { type: 'A', name: `www.${domain}`, value: '192.0.2.1', proxied: true });
      // PUT replaces the whole entrypoint ruleset: fine for zones we just created.
      await cf('PUT', `/zones/${z.id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, {
        rules: [{
          ref: 'forward_all',
          description: 'Forward all requests to the customer main site',
          expression: 'true',
          action: 'redirect',
          action_parameters: { from_value: { target_url: { value: url }, status_code: 301, preserve_query_string: true } }
        }]
      });
      return { domain, forwardsTo: url };
    }
  };
}
