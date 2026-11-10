# CloudLead infra purchase

In-app purchase of domains and mailboxes. A customer picks a plan, domains and mailboxes and pays; the backend registers the
domains, sets DNS, creates the mailboxes through a vendor, connects them, then keeps the whole thing running: recurring billing,
yearly domain renewals, failed-payment handling, customer emails, receipts, and a contract for your sending engine.
Vendors are hidden from the customer (white-label). It uses only Node's standard library (Node 22.5+): nothing to install.

**Status:** complete and tested against simulated vendors and gateways (see "What is verified"). It has **not** been run with
real accounts yet, and your own database and login still have to be plugged in.

## Run

    npm start            # http://localhost:3000, everything mocked, no keys needed
    npm test             # 153 tests (~1 min): pricing, adapters (fake HTTP), billing lifecycle, chaos, storage contract, ...

Open `/` for the purchase wizard, `/admin.html` (needs `ADMIN_TOKEN`) for operations, `/manage.html#o=...&t=...` for a customer's private page.

## Scripts

| Command | What it does |
|---|---|
| `npm run preflight` | Before the first real run: proves every credential and setting works using **read-only** calls |
| `npm run simulate -- <event> latest [--advance N]` | Drives a subscription through failed payment, grace, suspension and recovery on a running dev server (`DEV_TOOLS=1`) |
| `npm run backup` / `npm run restore -- <file> --force` | Consistent snapshot (proves it opens, keeps the newest 14) and restore (keeps the previous data) |
| `npm run rotate-key` | Re-encrypt every stored credential under a new `CREDENTIALS_KEY` (safe to re-run) |
| `npm run migrate:sqlite -- data/db.json data/db.sqlite` | Move from the JSON file to SQLite (verified copy, source untouched) |
| `npm run docs:openapi` | Regenerate `docs/openapi.json` from `lib/apiSpec.js` (a test fails if it drifts from `server.js`) |

## Documentation

- [docs/runbook.md](docs/runbook.md): what every "needs attention" item means and what to do; incidents; routine tasks
- [docs/engine-integration.md](docs/engine-integration.md): how your sending/warm-up engine uses the mailboxes this app creates
- [docs/adapters.md](docs/adapters.md): writing a new vendor, registrar, gateway, email provider or storage backend
- [docs/openapi.json](docs/openapi.json): the HTTP API

## Running it for real

0. **`npm run preflight`** with your real environment first. It makes only read-only calls (nothing is bought, charged, created or emailed).
1. Copy `.env.example` to `.env` and fill it in (comments sit on their own lines because Docker's env-file parser would otherwise keep them in the value).
   Run with `node --env-file=.env server.js`, or `docker build -t cl . && docker run --env-file .env -v cl-data:/app/data -p 3000:3000 cl`.
2. **Startup refuses unsafe configs.** With `NODE_ENV=production` it will not start with a missing `CREDENTIALS_KEY`, an admin/engine/metrics token under 24 characters,
   or any `mock` adapter (`ALLOW_MOCKS=1` overrides, for demos). It warns about missing webhook secrets, `NOTIFY_PROVIDER=mock` (customers would get no email) and `PUBLIC_URL`.
3. `GET /healthz` for load balancers; `GET /metrics` (Prometheus, needs a token) for dashboards. `SIGTERM`/`SIGINT` stop the server cleanly; half-done work resumes on the next start.
4. Put it behind HTTPS and set `TRUST_PROXY=1`, otherwise every visitor shares one rate-limit bucket. Webhooks need a public HTTPS URL (`PUBLIC_URL`).
5. **Data**: one JSON file (default) or SQLite (`STORE=sqlite`). Both write through on every change and are covered by the same contract test. JSON writes are atomic with a `.bak` copy; if the file is ever
   unreadable the server **refuses to start** and keeps a copy instead of starting empty. **Back it up** (`npm run backup`, hourly): it holds orders, billing state and encrypted credentials.
   One server process per data file.
6. **Protection**: per-IP rate limits, lockout after 10 wrong admin/engine tokens, security headers, constant-time token checks, secrets redacted from logs, buyers' contact details never in the public order view,
   mailbox lists and receipts behind the buyer's private token, and an abuse guard (disposable emails, phishing-brand names, per-email and per-network velocity, and a **daily domain cap** that protects your registrar balance).
7. **Monitoring**: structured JSON logs with request ids; alerts to Slack/email/log when something needs a human (new problem alerts at once, repeats daily, "resolved" is announced).

## Payment flow (Razorpay)

The server owns the price; the browser only carries payment proof. By default a purchase is a **recurring
subscription** (see "Recurring billing"); `BILLING_MODE=one_time` makes it a single payment. Steps 1-5 below
describe the one-off order flow; the subscription flow is the same shape with the differences listed after.

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

## Recurring billing

One Razorpay subscription per order. A gateway plan has a single fixed amount, but mailboxes renew every
period (quarterly or yearly) while **domains renew yearly**, so the subscription alternates between two plans:

| Plan | Amount | Used for cycles |
|---|---|---|
| renewal | mailboxes + yearly domain fee | 1, 5, 9, ... (quarterly) or every cycle (annual) |
| base | mailboxes only | all other cycles |

The first payment (the authorisation) is the full first-period amount, the same total the wizard shows. After each
paid cycle `lib/billing.js` schedules a plan change **at cycle end** so the next charge uses the right plan. Plans
are permanent at the gateway, so they are reused per (period, amount, currency). Quarterly is sent as "monthly x 3".

Subscription differences from the one-off flow: the browser opens checkout with `subscription_id`; the checkout
signature is `HMAC-SHA256(payment_id|subscription_id, key_secret)` (field order differs from orders); confirm also
checks the subscription's plan and that `paid_count >= 1`; the webhook that creates the order is `subscription.charged`.

What the webhooks drive (`subscription.*`, each handled idempotently by cycle number):

- **charged**: records the cycle; if it is a domain cycle after the first, **renews every domain at the registrar**
  (retried hourly, flagged for an admin after 5 failures); reinstates a past-due or suspended order; schedules the next plan.
- **pending / halted** (charge failed, then every retry failed): `past_due`, then a **grace period**
  (`BILLING_GRACE_DAYS`, default 7) with service intact.
- After grace: mailboxes are **suspended** (flagged `suspended: true`, `status: "suspended"` in the store: CloudLead's
  sending and warm-up engine must skip them). After `BILLING_RETENTION_DAYS` (default 14) the vendor is asked to
  **remove the mailboxes** and domains are no longer renewed. A payment at any point before the vendor's next renewal
  brings everything back; after that an admin must step in (`needsAttention`).
- **cancelled / completed**: service runs to the end of the paid period, then follows the same suspend/remove path.

The customer sees only a summary on `GET /api/orders/:id` (next charge date and amount, payment failed + pay-by date,
service end date). Customers cancel with `POST /api/orders/:id/cancel` and the **manage token** returned once at
purchase (a stand-in for real account auth). Admins see full billing state and history.
Everything slow is retried by the same timer as the pipeline (`POLL_INTERVAL_MS`).

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

- `lib/config.js` pricing and rules (one place); `lib/pricing.js` quote maths; `lib/money.js` minor-unit conversion
- `lib/validate.js` cart and contact validation; `lib/domainSuggest.js` lookalike generator + availability filter
- `lib/checkout.js` create / confirm / webhook: the only place an order is created
- `lib/provisioner.js` the pipeline above (idempotent, resumable, crash-safe); `lib/vendorHooks.js` vendor webhooks wake waiting steps early
- `lib/billing.js` subscription schedule maths and lifecycle (renewals, plan changes, dunning, suspension, cancel)
- `lib/notify.js` + `lib/templates.js` + `lib/mailers.js` customer email: outbox with de-duplication and retries
- `lib/alerts.js` + `lib/problems.js` "needs a human" detection and Slack/email/log alerts
- `lib/engine.js` the contract with your sending engine; `lib/receipts.js` per-cycle receipts
- `lib/store.js` the storage seam (`BaseStore`, JSON backend); `lib/store/sqlite.js` SQLite backend
- `lib/abuse.js`, `lib/ratelimit.js`, `lib/startup.js` abuse guard, rate limits, refuse-to-boot checks
- `lib/log.js` structured logging with redaction; `lib/metrics.js` Prometheus text
- `lib/crypto.js` + `lib/rotate.js` AES-256-GCM sealing and key rotation; `lib/backup.js` backup, restore, migration
- `lib/preflight.js` read-only credential checks; `lib/apiSpec.js` the OpenAPI source
- `lib/providers/` adapters: `mock.js`, `namesilo.js`, `cloudflare.js`, `zapmail.js`, `razorpay.js`; `lib/errors.js` `PendingError`
- `server.js` HTTP API and timers; `public/` the wizard (`index.html`), `manage.html`, `admin.html`; `scripts/` the CLI tools

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
| `BILLING_MODE` | `subscription` (default when the gateway supports it) or `one_time` |
| `BILLING_GRACE_DAYS`, `BILLING_RETENTION_DAYS` | days of service after all charge retries fail (7), then days before mailboxes are removed (14) |
| `ZAPMAIL_API_KEY` | required for `zapmail` |
| `ZAPMAIL_WORKSPACE_KEY` | recommended: Zapmail's connection-requests endpoint requires it |
| `ZAPMAIL_NAMESERVERS` | comma list. Zapmail's docs show four conflicting sets; the default is from the current connect-domain page. **Confirm with Zapmail** |
| `ZAPMAIL_BASE_URL` | optional |
| `ZAPMAIL_WEBHOOK_SECRET` | optional: endpoint secret for `POST /api/webhooks/zapmail`; makes provisioning finish in seconds instead of waiting for the next poll |
| `POLL_INTERVAL_MS`, `WAIT_TIMEOUT_MS`, `RETRY_BASE_MS` | resume timer (0 disables), max wait for a pending step, quick-retry back-off (default 1 s) |
| `TRUST_PROXY` | `1` behind a reverse proxy so rate limits use the real client address |
| `ALLOW_MOCKS` | `1` lets `NODE_ENV=production` run with mock adapters (demo only) |
| `RATE_LIMIT` | `off` disables rate limits (tests only) |
| `NAMESILO_API_KEY` | required for `namesilo`. Server IP must be allowlisted in NameSilo (error 113 otherwise) |
| `NAMESILO_BASE_URL` | optional, e.g. NameSilo's sandbox base (they issue sandbox credentials on request) |
| `NAMESILO_AUTO_RENEW` | `0` (default) or `1`: registrar-side auto-renew |
| `CLOUDFLARE_API_TOKEN` | required for `cloudflare`: Zone:Edit, DNS:Edit, Single Redirect:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | optional but recommended |
| `CREDENTIALS_KEY` | 32 random bytes, base64. **Required when `NODE_ENV=production`** |
| `ADMIN_TOKEN` | enables the admin API (sent as `x-admin-token`); admin is disabled if unset |
| `PORT`, `DATA_FILE`, `MOCK_DELAY_MS`, `MOCK_FAIL=registrar\|vendor` | server and mock controls |
| `STORE`, `SQLITE_FILE` | `json` (default, `DATA_FILE`) or `sqlite` |
| `PUBLIC_URL` | this server's public https address: used in emails, alerts and the preflight |
| `NOTIFY_PROVIDER`, `RESEND_API_KEY`, `NOTIFY_FROM` | customer email: `mock` (default, nothing sent) or `resend` |
| `ALERT_SLACK_WEBHOOK`, `ALERT_EMAIL`, `ALERT_MIN_SLOTS`, `ALERT_MIN_WALLET` | where "needs attention" alerts go, and the vendor capacity thresholds |
| `ENGINE_TOKEN`, `METRICS_TOKEN` | enable `/api/engine/*` and `/metrics` (24+ chars in production) |
| `INVOICE_*`, `TERMS_URL`, `PRIVACY_URL`, `REFUND_URL` | receipt seller details; links shown beside the terms checkbox |
| `DAILY_DOMAIN_CAP`, `MAX_DOMAINS_PER_ORDER`, `ABUSE_*` | abuse and spend protection |
| `LOG_LEVEL`, `LOG_FORMAT` | logging |
| `DEV_TOOLS`, `MOCK_WEBHOOK_SECRET` | demo only: billing clock + simulator (never honoured in production) |
| `WAIT_TIMEOUT_CONNECT_MS` | give up on domain verification after this long (default 20 h, below the vendor's 24 h limit) |


Generate a credentials key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

## API

Full reference: [docs/openapi.json](docs/openapi.json).

    # customers
    GET  /api/config  /api/domains/suggest?seed=&want=  POST /api/quote
    POST /api/checkout                         server-side price; creates the gateway payment (idempotencyKey supported)
    POST /api/checkout/:id/confirm             {paymentId, signature}: verifies with the gateway, creates the order (idempotent)
    GET  /api/checkout/:id                     status, and the order once a webhook created it
    GET  /api/orders/:id                       progress + a safe billing summary
    GET  /api/orders/:id/mailboxes|receipts    x-manage-token
    POST /api/orders/:id/cancel                x-manage-token: cancel at the end of the paid period
    POST /api/manage/resend                    {email}: email me my link (identical answer whether or not the address has an order)

    # gateways and vendors
    POST /api/webhooks/razorpay                raw body + X-Razorpay-Signature
    POST /api/webhooks/zapmail                 raw body + X-Zapmail-Signature (only wakes waiting steps)

    # your sending engine (x-engine-token = ENGINE_TOKEN)
    GET  /api/engine/mailboxes?sendable=1      what may send right now
    GET  /api/engine/mailboxes/:id/credentials decrypted login; 409 while suspended
    POST /api/engine/mailboxes/:id/state       {warmup, note}

    # operations
    GET  /healthz     GET /metrics (Bearer METRICS_TOKEN)
    GET  /api/admin/orders|mailboxes|outbox|vendor            x-admin-token
    POST /api/admin/orders/:id/retry|cancel|refund            ({amount?, reason?} defaults to the suggested pro-rata refund)
    POST /api/admin/billing/tick                              run the billing, email and alert timers now
    POST /api/admin/dev/advance                               demo only (DEV_TOOLS=1)

## Verification status of the real adapters

- **NameSilo**: request/response shapes taken from NameSilo's published API reference
  (checkRegisterAvailability, registerDomain, renewDomain, getDomainInfo, changeNameServers, response codes).
  Run only against fake HTTP. Renewals are paid from the NameSilo account balance: keep it funded.
- **Cloudflare**: shapes taken from Cloudflare's published docs (zones, dns_records, redirect rulesets).
  Run only against fake HTTP. Check in a scratch account: TXT content quoting, and that Single Redirect
  works on a fresh zone.
- **Zapmail**: shapes taken from docs.zapmail.ai (domains, connection-requests, connect-domain, mailboxes list/assign,
  dmarc, forwarding, wallet). Run only against a simulated account. **Zapmail has no sandbox**: the first live run spends real money.
- **Razorpay**: Orders, Subscriptions (plans, create, update, cancel), Standard Checkout options, both signature
  schemes, refunds (with `X-Refund-Idempotency`), webhook headers and test cards were all taken from
  razorpay.com/docs. Run only against a simulated account; **the checkout popup itself has not been opened**
  (needs real test keys).
- **Zapmail webhooks**: signature scheme (`t=<unix>,v1=HMAC-SHA256("<t>.<body>")`, 5-minute window) taken from their
  docs; whether the `whsec_` prefix is part of the key is not stated, and the event names conflict between pages. Safe
  either way: events only make waiting steps re-check sooner, so a wrong guess costs one poll, never an order.
- None of the four has been run with real keys. The Dockerfile and the CI workflow have not been run either (no Docker
  here; the workflow runs on GitHub), and `SIGTERM` handling is untested on Windows, where Node cannot catch it.

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
6. **Subscriptions: verify these in test mode before trusting recurring billing.**
   - *First payment amount.* Razorpay's docs mention a small refunded "authorisation" amount for some flows. We assume
     the authorisation transaction **is** the first full cycle charge. If it is only a token, the first
     `subscription.charged` arrives later: the webhook path still creates the order, but check it.
   - *Plan changes at cycle end* (`PATCH` with `schedule_change_at: "cycle_end"`). The docs do not say which amount is
     charged in the interim, whether the new plan's currency must match (ours always do), or that a pending change
     cannot be applied while the subscription is `pending`. We retry hourly. Watch `billing.planError` in the admin view.
   - *USD recurring needs international cards only.* UPI and eMandate are INR-only and cannot be used with USD plans.
     Plan changes are not allowed for UPI or eMandate subscriptions either.
   - *Subscription length.* Razorpay charges a subscription for at most 10 years: `totalCount` is capped accordingly
     (40 quarters, 10 years). After that the customer must re-subscribe.
   - *Cancel at cycle end* is rejected in the final cycle and before the first charge; we surface a generic error.
   - Events handled: `subscription.charged / pending / halted / cancelled / completed / updated`. Enable them on the webhook.
   - Razorpay's docs on subscription refunds were not found; refunds use the normal payment refund API.
7. **Domain renewal timing.** Domains renew when the renewal-cycle charge is confirmed, i.e. around the registration
   anniversary. NameSilo has a post-expiry grace/restoration period (`renewDomain` also restores), but a domain can be
   briefly dark if a webhook is late. Consider registering with a few days of slack or renewing earlier.

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

## What is verified, and what is not

**Verified here** (by the test suite, the chaos tests and end-to-end runs through the real server and browser): pricing and the billing schedule, the whole
purchase flow, crash recovery at every save point, webhook handling (including fuzzing), the dunning lifecycle, emails, alerts, the engine contract, receipts, backups,
key rotation, both storage backends, accessibility properties of the wizard, rate limits and lockouts.

**Not verified** because it needs real accounts: every call to NameSilo, Cloudflare, Zapmail, Razorpay and the email provider (shapes come from their docs; see above and
the open questions), the Razorpay checkout popup, the Docker image, and the CI workflow. `npm run preflight` is the first thing to run once you have keys.

## Before going live

1. Answers to the open vendor questions above, and `npm run preflight` passing with real keys.
2. **Plug in your database and login.** `lib/store.js` is the seam (`docs/adapters.md`); the contract test proves a new backend. Replace the hard-coded `demo-user` and the one-time manage token with real accounts.
3. Make your sending engine follow `docs/engine-integration.md` (most importantly: skip mailboxes with `sendable: false`).
4. Legal text and links (`TERMS_URL`, `PRIVACY_URL`, `REFUND_URL`), receipt/tax details (`INVOICE_*`), and a real email provider (`NOTIFY_PROVIDER`).
5. A second mailbox vendor as a fallback (Infraforge / Maildoso), once you know their terms.

### Known limits

- One server process per data file; rate-limit counters are per process (use Redis if you scale out).
- Mailbox removal happens at the vendor's next renewal (no immediate delete); the vendor's own subscription and wallet are outside this app: keep them funded.
- Manage links cannot be revoked individually. Customers cannot change payment method or upgrade in-app (the gateway's hosted page handles card changes for failed charges); adding mailboxes to an existing domain is blocked by the terms.
- A payment that lands after the customer left is still honoured; if a domain was taken meanwhile the order ends as `partial_failure` for an admin refund. Unpaid checkouts are purged after 14 days.
- No Content-Security-Policy: Razorpay's checkout loads scripts and frames from several of its own domains, and a wrong policy would silently break payment. Add one once the popup can be tested with real test keys.
- The brand-abuse list matches substrings and will catch a few legitimate names: use `ABUSE_ALLOW_DOMAINS`. Card-testing and chargeback fraud need the gateway's own tools.
