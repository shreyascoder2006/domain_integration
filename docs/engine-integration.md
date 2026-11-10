# Integrating your sending / warm-up engine

The engine is the part of CloudLead that actually sends email. This app creates the mailboxes; the engine uses them.
The contract is small and works whatever language or database the engine uses. There are two ways to use it.

## Rules the engine must follow

1. **Send only from mailboxes where `sendable` is `true`.** Billing can suspend a mailbox at any time (failed payment,
   cancellation). Re-check before every sending run, not just at startup.
2. **Never cache credentials longer than a run.** Ask for them when you need them. Credentials are refused (HTTP 409)
   for a suspended mailbox, which is your signal to stop.
3. **Report your state back** (`warmup`) so the dashboard and the customer see what is happening.
4. Treat `warmup: queued` as "not started", and ramp volume gradually: new mailboxes are not ready for heavy sending.

## Option A: over HTTP (any language)

Set `ENGINE_TOKEN` (24+ characters in production) and call `/api/engine/*` with `x-engine-token`. Keep this on a private network or
behind TLS: the credentials endpoint returns decrypted logins. Ten wrong tokens lock the caller out for 15 minutes.

```bash
T='x-engine-token: <ENGINE_TOKEN>'
# what may send right now
curl -s -H "$T" 'https://app/api/engine/mailboxes?sendable=1'
# the login for one mailbox (409 if suspended)
curl -s -H "$T" https://app/api/engine/mailboxes/mbx_ab12cd34ef56/credentials
# tell us how warm-up is going
curl -s -X POST -H "$T" -H 'content-type: application/json' -d '{"warmup":"warming","note":"day 3"}' https://app/api/engine/mailboxes/mbx_ab12cd34ef56/state
```

```jsonc
// GET /api/engine/mailboxes
[{ "id": "mbx_ab12cd34ef56", "email": "asha@getacme.com", "provider": "google", "orderId": "ord_...", "userId": "u1",
   "status": "ready_for_warmup", "sendable": true, "suspended": false, "suspendedReason": null,
   "warmup": "queued", "smtp": { "host": "smtp.gmail.com", "port": 587 } }]

// GET .../credentials  (the shape of `credentials` depends on the vendor: use whichever fields are present)
{ "id": "mbx_ab12cd34ef56", "email": "asha@getacme.com", "smtp": { "host": "smtp.gmail.com", "port": 587 },
  "credentials": { "username": "asha@getacme.com", "appPassword": "abcd efgh ijkl mnop", "password": null } }
```

A sketch of an engine loop in Node:

```js
const H = { 'x-engine-token': process.env.ENGINE_TOKEN };
const get = (p) => fetch(APP + p, { headers: H }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
for (const m of await get('/api/engine/mailboxes?sendable=1')) {
  let c;
  try { c = await get(`/api/engine/mailboxes/${m.id}/credentials`); } catch (s) { if (s === 409) continue; throw s; } // suspended since the list
  await sendBatch({ host: c.smtp.host, port: c.smtp.port, user: c.credentials.username, pass: c.credentials.appPassword ?? c.credentials.password });
}
```

## Option B: in-process (the engine shares this codebase or database)

```js
import { createStore } from './lib/store.js';
import { createEngineApi } from './lib/engine.js';
const engine = createEngineApi({ store: await createStore(process.env) });
engine.listMailboxes({ sendable: true });
engine.getCredentials(id);               // throws { status: 409 } if suspended
engine.setState(id, { warmup: 'ready' });
```

Only one process may open the same store at a time, so use this only if the engine runs inside the same process.

## What the credentials are

The mailbox vendor decides. With the vendor wired today the list contains `username`, `password`, `appPassword` and a `secret`; **whether those work for
SMTP/IMAP from your engine is still an open question for the vendor** (see `docs/vendor-emails.md`). If they do not, the engine needs OAuth instead, which
is a larger change on both sides. Test with one real mailbox before building anything on top.

## When your engine has its own mailbox table

Keep this app's `id` (`mbx_...`) as the foreign key. To mirror state, poll `/api/engine/mailboxes` and upsert by `id`; the `sendable` flag and `suspendedReason`
are the only billing facts you need. Do not copy `credentials` into your own database: ask for them when needed.
