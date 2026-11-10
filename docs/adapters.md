# Writing an adapter (or a storage backend)

The app talks to every outside service through a small adapter object. A new vendor, registrar, payment gateway or email provider is one file plus one
line in `lib/providers/index.js` (or `lib/mailers.js`). Nothing else changes. Read an existing adapter first: they are short, and each has a test
file that shows the pattern.

## Ground rules (every adapter)

- **Take `fetchImpl` as a parameter** (default `fetch`). Tests then run against a fake server and never touch the network.
- **Never put a secret in an error message, a log line or a URL you print.** Some APIs require the key in the query string (NameSilo): build errors without the URL.
- **Errors**: throw a normal `Error` for failures. Throw `new PendingError(message, retryAfterMs)` (`lib/errors.js`) for "still working, check later" (DNS propagating,
  rate limited, "try again later" codes): the step is parked and the timer re-checks it. Add `expose: true` and a `status` **only** to errors whose message is safe
  to show a customer; everything else becomes a generic 500.
- **Be idempotent.** The pipeline retries and resumes after crashes, so calling `register`/`createMailboxes`/`applyRecords` twice must not buy or create twice
  (look up what already exists first; treat "already exists" as success when it is yours).
- **Add `preflight()`** returning `{ ok, detail }` using read-only calls. `npm run preflight` runs it.
- **Never trust the browser or the payload.** Verify signatures with constant-time compares, on the raw body.

## The contracts

```text
registrar      checkAvailability(domains[]) -> [{ domain, available, price? }]
               register({ domain, contact, years }) -> { registeredAt, ... }
               setNameservers(domain, nameServers[])
               renew({ domain, years }) -> { orderAmount? }
               preflight()
dns            prepareZone(domain) -> { zoneId, nameServers }
               applyRecords(domain, records[]) ; setForwarding(domain, url)        (not used when the vendor runs DNS)
mailboxVendor  createMailboxes({ domain, provider, accounts[] }) -> { mailboxes[], dkim? }
               managesDns, nameServers, connectDomain(domain), configureDomain({ domain, forwardingUrl, dmarcEmail })     (vendors that run DNS)
               collectMailboxes({ domain, provider, emails[] }) -> { mailboxes[] }   (async vendors: throw PendingError until ready)
               checkCapacity({ provider, mailboxCount }) -> { ok }       called BEFORE charging: never take money we cannot fulfil
               scheduleRemoval / cancelRemoval({ domain, provider }) ; getCapacity() ; verifyWebhook(raw, headers) -> { id, type, data }
payments       createCheckout / createSubscriptionCheckout -> { mode, gatewayOrderId | gatewaySubscriptionId, amountMinor, client }
               confirm / confirmSubscription -> { paymentId, status: 'succeeded' }   (verify the signature AND fetch the payment)
               changePlan / cancelSubscription / refund({ paymentId, amount, currency, idempotencyKey })
               verifyWebhook(raw, headers) -> { id, type, payment?, subscription?, order?, refund? }
mailer         send({ from, to, subject, text, html }) -> { id }
```

Mailbox records returned by a vendor carry `credentials` (plain, in memory only). The pipeline seals them (`lib/crypto.js`) before anything is saved,
so **an adapter must never persist credentials itself**.

## Registering it

```js
// lib/providers/index.js
const vendors = { mock: ..., zapmail: ..., acme: () => createAcmeVendor({ apiKey: process.env.ACME_API_KEY }) };
// then: MAILBOX_VENDOR=acme
```

## Testing it

Copy the pattern in `test/vendor.test.js` (a simulated Zapmail account behind a fake `fetch`) and `test/payments.test.js`: assert the exact requests sent
(path, headers, body), the parsing of both array and single-object responses, each error code you care about, retry behaviour, and that no secret appears in any error.
Then run the whole pipeline against your adapter with the mock registrar/DNS, as `test/vendor.test.js` does.

## Writing a storage backend

Everything goes through `BaseStore` (`lib/store.js`). Subclass it and implement the persistence hooks; the in-memory working set and all lookups come for free:

```js
class PostgresStore extends BaseStore {
  persistOrder(o) { /* UPSERT */ }  persistMailbox(m) {}  persistCheckout(c) {}  deleteCheckout(id) {}
  persistPlan(key, id) {}  persistOutbox(item /* null = list replaced */) {}  persistAlert(key, valueOrNull) {}
  seenEvent(id) { /* query the DB so de-duplication survives restarts and multiple processes */ }  markEvent(id) {}
}
```

Writes must be **synchronous and durable before they return** (a payment webhook is acknowledged right after the order is saved and is not re-sent). If your driver is
async, keep the in-memory cache authoritative and make `persist*` block, or change `BaseStore` to async: the contract test will show you everything that breaks.

**Prove it with the contract**: add one line to `test/store.test.js` (`contract('postgres', () => ({ store, reopen }))`). If every test passes, the rest of the app works unchanged.
The working set is cached in memory, so one server process per database, unless you also replace the cache.
