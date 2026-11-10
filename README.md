# CloudLead infra purchase (prototype)

In-app purchase of domains and mailboxes. Customer picks plan, domains, mailboxes and pays;
the backend registers domains, sets DNS, creates mailboxes via a vendor and connects them.
Vendors are hidden from the customer (white-label).

## Run

    npm start          # http://localhost:3000, mock adapters, no keys needed
    npm test           # pricing + domain suggester unit tests

Env: `PORT`, `DATA_FILE`, `MOCK_DELAY_MS`, `MOCK_FAIL=registrar|vendor` (simulate failures).

## Layout

- `lib/config.js` pricing and rules (one place)
- `lib/pricing.js` quote maths (matches the Saleshandy reference: 3 mailboxes quarterly = $35.91)
- `lib/domainSuggest.js` prefix/suffix lookalike generator + availability filter
- `lib/provisioner.js` per-domain pipeline: register -> SPF/DMARC/MX -> mailboxes -> DKIM -> connect.
  Steps are idempotent, retried 3x, and resumable (`POST /api/orders/:id/retry`).
- `lib/providers/` adapters. Real vendors implement the same method shapes as `mock.js`
  and are selected with env vars `REGISTRAR`, `DNS_PROVIDER`, `MAILBOX_VENDOR`, `PAYMENTS`.
- `server.js` API; `public/index.html` 5-step wizard + live progress.

## API

    GET  /api/config
    GET  /api/domains/suggest?seed=acme
    POST /api/quote
    POST /api/orders            (idempotencyKey supported; re-checks availability, charges, starts provisioning)
    GET  /api/orders/:id
    POST /api/orders/:id/retry
    GET  /api/mailboxes         (credentials never returned)

## Before going live (not done yet)

- Real adapters: NameSilo, Cloudflare DNS, a mailbox vendor, Stripe/Razorpay.
- Replace the JSON store and the hard-coded `demo-user` with CloudLead's DB and auth.
- Vendor credentials are stored in `data/db.json`; encrypt or move to a secrets store.
- Refund/compensation path when payment succeeds but provisioning fails.
- Webhooks from vendors (renewals, re-auth), auto-renew billing, admin view of margins.
- Rate limiting and abuse checks on domain suggest and order endpoints.
