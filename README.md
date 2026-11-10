# CloudLead infra purchase (prototype)

In-app purchase of domains and mailboxes. Customer picks plan, domains, mailboxes and pays;
the backend registers domains, sets DNS, creates mailboxes via a vendor and connects them.
Vendors are hidden from the customer (white-label).

## Run

    npm start          # http://localhost:3000, mock adapters, no keys needed
    npm test           # 28 tests: pricing, suggester, adapters and a simulated Zapmail account (fake HTTP), crypto, refunds, pipeline

## Pipeline (per domain, after payment)

`register` -> `nameservers` -> `connect_domain` -> `dns_base` -> `mailboxes` -> `mailboxes_ready`
-> `dns_dkim` -> `connect`. Each step is idempotent, retried 3x, and resumable (`POST /api/orders/:id/retry`).

Two vendor models:

- **We run DNS** (mock vendor): a Cloudflare zone is created and the registrar points at it; we publish
  SPF/DMARC/MX/forwarding and the vendor's DKIM.
- **Vendor runs DNS** (Zapmail, `managesDns: true`): the registrar points at the vendor's nameservers, the
  vendor verifies the domain and handles DNS/DMARC/forwarding, and our DNS steps are skipped.

Slow work (DNS propagation, mailbox creation) is not a failure: the adapter throws `PendingError`, the step is
parked as `waiting`, and a timer (`POLL_INTERVAL_MS`, default 15 s) re-checks due steps. The same timer resumes new
orders and recovers orders interrupted by a crash. Steps give up after `WAIT_TIMEOUT_MS` (default 48 h).
Customers only ever see generic messages: vendor names, raw errors and costs are admin-only.

## Layout

- `lib/config.js` pricing and rules (one place)
- `lib/pricing.js` quote maths (matches the Saleshandy reference: 3 mailboxes quarterly = $35.91)
- `lib/domainSuggest.js` prefix/suffix lookalike generator + availability filter
- `lib/provisioner.js` the pipeline above; vendor credentials are sealed before they are saved
- `lib/crypto.js` AES-256-GCM sealing (`CREDENTIALS_KEY`)
- `lib/refunds.js` pro-rata refund suggestion and limits
- `lib/providers/` adapters: `mock.js`, `namesilo.js`, `cloudflare.js`, `zapmail.js` (payments still mock only)
- `lib/errors.js` `PendingError` for "still working, check later"
- `server.js` API; `public/index.html` 5-step wizard + live progress

## Configuration (env)

| Variable | Purpose |
|---|---|
| `REGISTRAR` | `mock` (default) or `namesilo` |
| `DNS_PROVIDER` | `mock` (default) or `cloudflare` |
| `MAILBOX_VENDOR` | `mock` (default) or `zapmail` |
| `PAYMENTS` | `mock` only for now |
| `ZAPMAIL_API_KEY` | required for `zapmail` |
| `ZAPMAIL_WORKSPACE_KEY` | recommended: Zapmail's connection-requests endpoint requires it |
| `ZAPMAIL_NAMESERVERS` | comma list. Zapmail's docs show four conflicting sets; the default is from the current connect-domain page. **Confirm with Zapmail** |
| `ZAPMAIL_BASE_URL` | optional |
| `POLL_INTERVAL_MS`, `WAIT_TIMEOUT_MS`, `RETRY_BASE_MS` | resume timer (0 disables), max wait for a pending step, retry back-off |
| `NAMESILO_API_KEY` | required for `namesilo`. Server IP must be allowlisted in NameSilo (error 113 otherwise) |
| `NAMESILO_BASE_URL` | optional, e.g. NameSilo's sandbox base (they issue sandbox credentials on request) |
| `NAMESILO_AUTO_RENEW` | `0` (default) or `1`: registrar-side auto-renew |
| `CLOUDFLARE_API_TOKEN` | required for `cloudflare`: Zone:Edit, DNS:Edit, Single Redirect:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | optional but recommended |
| `CREDENTIALS_KEY` | 32 random bytes, base64. **Required when `NODE_ENV=production`** |
| `ADMIN_TOKEN` | enables the admin API (sent as `x-admin-token`); admin is disabled if unset |
| `PORT`, `DATA_FILE`, `MOCK_DELAY_MS`, `MOCK_FAIL=registrar\|vendor` | server and mock controls |

Generate a credentials key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

## API

    GET  /api/config
    GET  /api/domains/suggest?seed=acme
    POST /api/quote
    POST /api/orders            (idempotencyKey supported; re-checks availability, charges, starts provisioning)
    GET  /api/orders/:id
    POST /api/orders/:id/retry
    GET  /api/mailboxes         (credentials never returned)

    # admin (x-admin-token)
    GET  /api/admin/orders                 (adds internal margin, refunds, suggested refund)
    POST /api/admin/orders/:id/refund      ({amount?, reason?}; defaults to the suggested pro-rata amount)
    GET  /api/admin/vendor                 (vendor wallet balance and free mailbox slots)

## Verification status of the real adapters

- **NameSilo**: request/response shapes taken from NameSilo's published API reference
  (checkRegisterAvailability, registerDomain, changeNameServers, response codes). Run only against fake HTTP.
- **Cloudflare**: shapes taken from Cloudflare's published docs (zones, dns_records, redirect rulesets).
  Run only against fake HTTP. Check in a scratch account: TXT content quoting, and that Single Redirect
  works on a fresh zone.
- **Zapmail**: shapes taken from docs.zapmail.ai (domains, connection-requests, connect-domain, mailboxes list/assign,
  dmarc, forwarding, wallet). Run only against a simulated account. **Zapmail has no sandbox**: the first live run spends real money.
- None of the three has been run with real keys.

### Zapmail: open questions to settle with them before launch

1. **White-label / resale rights.** Their docs say nothing about reselling. Get it in writing.
2. **Which nameservers?** The docs show four different sets.
3. **Do `password` / `appPassword` from the mailbox list work for SMTP/IMAP** from our sending engine? No SMTP host is
   documented, so Gmail/Office 365 hosts are assumed. Their own recommended path (custom OAuth, exports to other
   sending tools) does not give a hosted sender like CloudLead credentials directly.
4. **Capacity model.** Mailboxes use *subscription slots* (Starter 10 / Growth 30 / Pro 100), not pay-per-mailbox.
   Buying slots and domains returns Stripe payment links, so topping up is currently a human step. `checkCapacity`
   refuses orders before charging when slots run out. Ask whether a fully wallet-funded purchase API exists.
5. **DMARC / forwarding bodies.** The docs mark several filter fields as required (`contains`, `status`, `tagIds`);
   we send them empty. Verify in a live run that this applies the change only to our domain.
6. Mailbox creation fails for domains older than 24 h in their system: a connection that sits waiting for
   nameserver propagation for a day may need a manual fix.

## Before going live (not done yet)

- Stripe/Razorpay adapter, and a second mailbox vendor (Infraforge / Maildoso) as a fallback.
- Zapmail webhooks (`mailbox.updated`, `domain.connection_status_changed`; HMAC-SHA256 `X-Zapmail-Signature`)
  would replace polling for faster updates.
- Replace the JSON store and the hard-coded `demo-user` with CloudLead's DB and auth.
- Domain and mailbox renewals, auto-renew billing, vendor webhooks.
- Rate limiting and abuse checks on domain suggest and order endpoints.
- Provisioning retry delays are short (150 ms x attempt): lengthen for real services (e.g. NameSilo 268 "retry later").
- NameSilo 262 ("domain already active") is treated as an error, so a crash between a successful
  registration and saving the step could make a retry fail: reconcile manually or add a domain-info check.
