// Zapmail mailbox vendor adapter (Google Workspace + Microsoft 365).
//
// Built from Zapmail's published API docs (docs.zapmail.ai, read 2026-11-10) and
// tested only against fake HTTP. NOT yet run against the live API, and Zapmail
// has no sandbox: first live runs spend real money.
//
// How Zapmail differs from a "just give me an SMTP box" vendor:
//  * Zapmail runs DNS itself: the registrar's nameservers must point at
//    Zapmail, then /v2/domains/connect-domain verifies the domain (async,
//    can take hours while nameservers propagate).
//  * Mailboxes are created asynchronously and consume slots from a
//    subscription Zapmail account (not pay-per-mailbox). Run low and creation
//    fails, so checkCapacity() is called BEFORE charging customers.
//  * Credentials: the mailbox list returns password / appPassword / secret per
//    mailbox. No SMTP host is documented, so standard Gmail/Office 365 hosts
//    are used. CONFIRM with Zapmail that these credentials work for SMTP/IMAP.
//
// Env: ZAPMAIL_API_KEY (required)
//      ZAPMAIL_WORKSPACE_KEY (recommended; the connection-requests endpoint requires it)
//      ZAPMAIL_NAMESERVERS (comma list). Their docs show FOUR conflicting sets;
//        the default is the one on the current connect-domain page. Confirm with Zapmail.
//      ZAPMAIL_BASE_URL (optional)
import { PendingError } from '../errors.js';

const DEFAULT_BASE = 'https://api.zapmail.ai/api';
const DEFAULT_NAMESERVERS = ['pns61.cloudns.net', 'pns62.cloudns.com', 'pns63.cloudns.net', 'pns64.cloudns.uk'];
const SERVICE_PROVIDER = { google: 'GOOGLE', microsoft: 'MICROSOFT' };
const SMTP = { google: { host: 'smtp.gmail.com', port: 587 }, microsoft: { host: 'smtp.office365.com', port: 587 } };
// Connection-request statuses that will never recover on their own.
const CONNECT_FATAL = new Set(['FAILED', 'DOMAIN_NOT_REGISTERED', 'WORKSPACE_ALREADY_EXISTS', 'PERMISSION_REQUIRED']);
const MAILBOX_FATAL = new Set(['FAILED', 'EXPIRED']);
// Zapmail's own rule for usernames.
const USERNAME_OK = /^(?![._-])(?!.*[._-]{2})(?!.*[._-]$)[a-z0-9._-]+$/i;

export function createZapmailVendor({ apiKey, workspaceKey, nameServers, baseUrl, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('ZAPMAIL_API_KEY is required');
  const base = baseUrl || DEFAULT_BASE;
  const ns = nameServers?.length ? nameServers : DEFAULT_NAMESERVERS;

  async function zm(method, path, { query, body, provider } = {}) {
    const qs = query ? '?' + new URLSearchParams(query) : '';
    const headers = { 'x-auth-zapmail': apiKey, 'Content-Type': 'application/json' };
    if (workspaceKey) headers['x-workspace-key'] = workspaceKey;
    if (provider) headers['x-service-provider'] = SERVICE_PROVIDER[provider];
    const res = await fetchImpl(base + path + qs, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) throw new PendingError('Vendor rate limit reached', 60_000);
    if (!res.ok) {
      const id = json.errorId ? ` [errorId ${json.errorId}]` : '';
      throw Object.assign(new Error(`Vendor ${method} ${path} failed (${res.status}): ${json.message || 'no message'}${id}`), { status: res.status });
    }
    return json;
  }

  const providerOf = (p) => {
    if (!SERVICE_PROVIDER[p]) throw new Error(`Provider "${p}" is not supported by this vendor`);
    return p;
  };

  async function findDomain(domain) {
    const j = await zm('GET', '/v2/domains', { query: { contains: domain, limit: '50' } });
    return (j.data?.domains ?? []).find((d) => String(d.domain).toLowerCase() === domain.toLowerCase());
  }

  /** The list response carries counters plus domains[].mailboxes[]. */
  async function listForDomain(domain, provider) {
    const j = await zm('GET', '/v2/mailboxes/list', { query: { contains: domain, limit: '100', page: '1' }, provider });
    const d = (j.data?.domains ?? []).find((x) => String(x.domain).toLowerCase() === domain.toLowerCase());
    return { data: j.data ?? {}, mailboxes: d?.mailboxes ?? [] };
  }

  return {
    name: 'zapmail',
    managesDns: true,
    nameServers: ns,

    /** Called BEFORE charging: do we have free mailbox slots? */
    async checkCapacity({ provider, mailboxCount }) {
      if (!SERVICE_PROVIDER[provider]) return { ok: false, reason: `provider ${provider} unsupported` };
      const j = await zm('GET', '/v2/mailboxes/list', { query: { limit: '1', page: '1' }, provider });
      const available = Number(j.data?.availableMailboxes ?? 0);
      return { ok: available >= mailboxCount, available, reason: available >= mailboxCount ? undefined : `only ${available} free slots, need ${mailboxCount}` };
    },

    /** Admin view: wallet and free slots. */
    async getCapacity() {
      const wallet = await zm('GET', '/v2/wallet/balance');
      const out = { walletBalanceUsd: wallet.walletBalance, autoRecharge: wallet.autoRechargeEnabled, providers: {} };
      for (const p of Object.keys(SERVICE_PROVIDER)) {
        const j = await zm('GET', '/v2/mailboxes/list', { query: { limit: '1', page: '1' }, provider: p });
        out.providers[p] = { availableMailboxes: j.data?.availableMailboxes, totalActive: j.data?.totalActiveMailboxes };
      }
      return out;
    },

    /** Verify the domain with Zapmail once nameservers point at it. Pending until SUCCESS. */
    async connectDomain(domain) {
      const j = await zm('GET', '/v2/domains/connection-requests', { query: { contains: domain, limit: '10' } });
      const item = (j.data?.data ?? []).find((r) => String(r.domainName).toLowerCase() === domain.toLowerCase());
      if (!item) {
        await zm('POST', '/v2/domains/connect-domain', { body: { domainNames: [domain] } });
        throw new PendingError('Domain connection requested', 30_000);
      }
      if (item.status === 'SUCCESS') return { ready: true };
      if (CONNECT_FATAL.has(item.status)) throw new Error(`Domain connection failed: ${item.status}`);
      // NS_NOT_CHANGED means propagation has not reached them yet: check less often.
      throw new PendingError(`Domain connection ${item.status}`, item.status === 'NS_NOT_CHANGED' ? 300_000 : 30_000);
    },

    /** DMARC + optional forwarding, done by Zapmail (both are async on their side). */
    async configureDomain({ domain, forwardingUrl, dmarcEmail }) {
      const d = await findDomain(domain);
      if (!d) throw new PendingError('Domain not listed yet', 30_000);
      // The docs mark contains/status/tagIds as required filters: sent empty so only domainIds applies.
      await zm('POST', '/v2/domains/dmarc', { body: { domainIds: [d.id], email: dmarcEmail, contains: domain, status: [], tagIds: [] } });
      if (forwardingUrl) {
        await zm('POST', '/v2/domains/forwarding', { body: { domainIds: [d.id], forwardTo: new URL(forwardingUrl).hostname, contains: domain, tagIds: [] } });
      }
      return { domainId: d.id };
    },

    /** Assign mailboxes. Safe to re-run: only missing mailboxes are requested. */
    async createMailboxes({ domain, provider, accounts }) {
      providerOf(provider);
      for (const a of accounts) {
        if (!USERNAME_OK.test(a.emailPrefix)) throw new Error(`Invalid mailbox username: ${a.emailPrefix}`);
      }
      const d = await findDomain(domain);
      if (!d) throw new PendingError('Domain not listed yet', 30_000);

      const { data, mailboxes: existing } = await listForDomain(domain, provider);
      const have = new Set(existing.map((m) => String(m.email).toLowerCase()));
      const missing = accounts.filter((a) => !have.has(`${a.emailPrefix}@${domain}`.toLowerCase()));

      if (missing.length) {
        const free = Number(data.availableMailboxes ?? 0);
        if (free < missing.length) {
          throw Object.assign(new Error(`Out of vendor mailbox slots: ${free} free, ${missing.length} needed`), { code: 'CAPACITY' });
        }
        await zm('POST', '/v2/mailboxes', {
          query: { serviceProvider: SERVICE_PROVIDER[provider] }, provider,
          body: { [d.id]: missing.map((a) => ({ firstName: a.firstName, lastName: a.lastName, mailboxUsername: a.emailPrefix, domainName: domain })) }
        });
      }
      return { mailboxes: accounts.map((a) => ({ email: `${a.emailPrefix}@${domain}`, firstName: a.firstName, lastName: a.lastName, provider, status: 'creating' })) };
    },

    /** Poll until every mailbox is ACTIVE with usable credentials. */
    async collectMailboxes({ domain, provider, emails }) {
      providerOf(provider);
      const { mailboxes } = await listForDomain(domain, provider);
      const byEmail = new Map(mailboxes.map((m) => [String(m.email).toLowerCase(), m]));
      const out = [];
      for (const email of emails) {
        const m = byEmail.get(email.toLowerCase());
        if (!m) throw new PendingError(`Mailbox ${email} not listed yet`, 30_000);
        if (MAILBOX_FATAL.has(m.status)) throw new Error(`Mailbox ${email} ended in status ${m.status}`);
        const hasSecret = m.appPassword || m.password;
        if (m.status !== 'ACTIVE' || !hasSecret) throw new PendingError(`Mailbox ${email} is ${m.status}`, 30_000);
        out.push({
          email, firstName: m.firstName, lastName: m.lastName, provider, status: 'ready_for_warmup',
          smtp: SMTP[provider],
          credentials: { username: email, password: m.password ?? null, appPassword: m.appPassword ?? null, secret: m.secret ?? null }
        });
      }
      return { mailboxes: out };
    }
  };
}
