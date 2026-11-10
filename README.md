# CloudLead infra purchase (prototype)

In-app purchase of domains and mailboxes. Customer picks plan, domains, mailboxes and pays;
the backend registers domains, sets DNS, creates mailboxes via a vendor and connects them.
Vendors are hidden from the customer (white-label).

## Run

    npm start          # http://localhost:3000, mock adapters, no keys needed
    npm test           # 46 tests: pricing, adapters against simulated accounts (fake HTTP), crypto, refunds, pipeline, payments

## Payment flow (Razorpay)

The server owns the price; the browser only carries payment proof.

1. `POST /api/checkout`: validate, re-check domain availability and vendor capacity, **price the cart on the
   server**, create the gateway order (Razorpay `receipt` = checkout id). The browser never sends an amount.
2. The browser opens Razorpay Standard Checkout for that `order_id`. On success it gets
   `razorpay_payment_id` + `razorpay_signature`.
3. `POST /api/checkout/:id/confirm`: we verify `HMAC-SHA256(order_id|payment_id, key_secret)` using **our stored**
   order id, then fetch the payment and check status, amount, currency and order. Only then is the order created
   (capturing it first if the account is not on auto-capture).
4. `POST /api/webhooks/razorpay` is the safety net if the browser closes before step 3: `payment.captured` and
   `order.paid` create the same order. Signature = HMAC-SHA256 of the **raw** body with the webhook secret;
   `x-razorpay-event-id` de-duplicates retries. Confirm and webhook can race: only one order is ever created.
5. If confirm fails after money left the card, the wizard retries, then polls `GET /api/checkout/:id` until the
   webhook has created the order.

Webhooks need a public HTTPS URL (Razorpay rejects localhost); use a tunnel such as zrok while developing, and
answer within 5 s (Razorpay retries for 24 h, then disables the webhook).

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
- `lib/checkout.js` checkout service: create / confirm / webhook, the only place an order is created
- `lib/validate.js` cart and contact validation; `lib/money.js` minor-unit conversion
- `lib/providers/` adapters: `mock.js`, `namesilo.js`, `cloudflare.js`, `zapmail.js`, `razorpay.js`
- `lib/errors.js` `PendingError` for "still working, check later"
- `server.js` API; `public/index.html` 5-step wizard + live progress

## Configuration (env)

| Variable | Purpose |
|---|---|
| `REGISTRAR` | `mock` (default) or `namesilo` |
| `DNS_PROVIDER` | `mock` (default) or `cloudflare` |
| `MAILBOX_VENDOR` | `mock` (default) or `zapmail` |
| `PAYMENTS` | `mock` (default, no popup) or `razorpay` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | required for `razorpay`. **Use test-mode keys first** |
| `RAZORPAY_WEBHOOK_SECRET` | set when creating the webhook in the Dashboard. A separate secret from the key secret |
| `PAYMENT_MERCHANT_NAME` | name shown in the checkout popup (default `CloudLead`) |
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
    POST /api/checkout          (idempotencyKey supported; server-side price; returns the gateway order for the popup)
    POST /api/checkout/:id/confirm   ({paymentId, signature}; idempotent, creates the order)
    GET  /api/checkout/:id           (status, and the order once a webhook has created it)
    POST /api/webhooks/razorpay      (raw body + X-Razorpay-Signature)
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
- **Razorpay**: Orders, Standard Checkout options, both signature schemes, refunds (with `X-Refund-Idempotency`),
  webhook headers and test cards were all taken from razorpay.com/docs. Run only against a simulated account;
  **the checkout popup itself has not been opened** (needs real test keys).
- None of the four has been run with real keys.

### Razorpay: things to do and check before launch

1. **Activate International payments** (Dashboard > Account & Settings). Prices are in USD, and a currency that is
   not enabled fails with `BAD_REQUEST_INVALID_CURRENCY`. Their docs list USD as supported but do not state
   USD minimums, purpose-code rules for exporters, or eligibility details: confirm with Razorpay. Settlement for an
   Indian business is in INR. Alternatively charge in INR (change `config.currency`).
2. **Auto-capture** is a Dashboard setting; if it is off we capture on confirm. Uncaptured payments are
   auto-refunded by Razorpay, so make sure one of the two is in place.
3. **Create the webhook** (Dashboard > Webhooks) for `payment.captured` and `order.paid`, plus `refund.*` for logging,
   with a secret and a public HTTPS URL. Test mode webhook OTP is in their docs.
4. Refunds are paid from your Razorpay balance, may be `pending` (5-7 days for `normal` speed), and `refund.*`
   webhook payloads were not read: we only log them. Failed refunds are rejected, not recorded.
5. Rate limits are not documented.
6. **Recurring billing is not built.** "Auto-renews quarterly" is in the terms, but nothing charges customers again
   yet. That needs Razorpay Subscriptions or saved-card tokens, plus the matching vendor renewals.

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

- A second mailbox vendor (Infraforge / Maildoso) as a fallback.
- Checkouts never expire: a payment that lands hours later is still honoured, and if a domain was taken meanwhile
  the order ends as `partial_failure` for an admin refund. Add an expiry and an availability re-check if that is not acceptable.
- Zapmail webhooks (`mailbox.updated`, `domain.connection_status_changed`; HMAC-SHA256 `X-Zapmail-Signature`)
  would replace polling for faster updates.
- Replace the JSON store and the hard-coded `demo-user` with CloudLead's DB and auth.
- Domain and mailbox renewals, auto-renew billing, vendor webhooks.
- Rate limiting and abuse checks on domain suggest and order endpoints.
- Provisioning retry delays are short (150 ms x attempt): lengthen for real services (e.g. NameSilo 268 "retry later").
- NameSilo 262 ("domain already active") is treated as an error, so a crash between a successful
  registration and saving the step could make a retry fail: reconcile manually or add a domain-info check.
