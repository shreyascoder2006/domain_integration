# CloudLead infra purchase (prototype)

In-app purchase of domains and mailboxes. Customer picks plan, domains, mailboxes and pays;
the backend registers domains, sets DNS, creates mailboxes via a vendor and connects them.
Vendors are hidden from the customer (white-label).

## Run

    npm start          # http://localhost:3000, mock adapters, no keys needed
    npm test           # 19 tests: pricing, suggester, adapters (fake HTTP), crypto, refunds, pipeline

## Pipeline (per domain, after payment)

`register` -> `nameservers` (create Cloudflare zone, point registrar at it) -> `dns_base`
(SPF, DMARC, MX, optional forwarding) -> `mailboxes` (vendor) -> `dns_dkim` -> `connect`.
Each step is idempotent, retried 3x, and resumable (`POST /api/orders/:id/retry`).

## Layout

- `lib/config.js` pricing and rules (one place)
- `lib/pricing.js` quote maths (matches the Saleshandy reference: 3 mailboxes quarterly = $35.91)
- `lib/domainSuggest.js` prefix/suffix lookalike generator + availability filter
- `lib/provisioner.js` the pipeline above; vendor credentials are sealed before they are saved
- `lib/crypto.js` AES-256-GCM sealing (`CREDENTIALS_KEY`)
- `lib/refunds.js` pro-rata refund suggestion and limits
- `lib/providers/` adapters: `mock.js`, `namesilo.js`, `cloudflare.js` (mailbox vendor and payments still mock only)
- `server.js` API; `public/index.html` 5-step wizard + live progress

## Configuration (env)

| Variable | Purpose |
|---|---|
| `REGISTRAR` | `mock` (default) or `namesilo` |
| `DNS_PROVIDER` | `mock` (default) or `cloudflare` |
| `MAILBOX_VENDOR`, `PAYMENTS` | `mock` only for now |
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

## Verification status of the real adapters

- **NameSilo**: request/response shapes taken from NameSilo's published API reference
  (checkRegisterAvailability, registerDomain, changeNameServers, response codes). Run only against fake HTTP.
- **Cloudflare**: shapes taken from Cloudflare's published docs (zones, dns_records, redirect rulesets).
  Run only against fake HTTP. Check in a scratch account: TXT content quoting, and that Single Redirect
  works on a fresh zone.
- Neither has been run with real keys. Do a sandbox/scratch run before any live purchase.

## Before going live (not done yet)

- Mailbox vendor adapter (Zapmail / Infraforge / Maildoso: white-label terms still unconfirmed) and Stripe/Razorpay.
- Replace the JSON store and the hard-coded `demo-user` with CloudLead's DB and auth.
- Domain and mailbox renewals, auto-renew billing, vendor webhooks.
- Rate limiting and abuse checks on domain suggest and order endpoints.
- Provisioning retry delays are short (150 ms x attempt): lengthen for real services (e.g. NameSilo 268 "retry later").
- NameSilo 262 ("domain already active") is treated as an error, so a crash between a successful
  registration and saving the step could make a retry fail: reconcile manually or add a domain-info check.
