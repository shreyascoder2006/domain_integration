# Operations runbook

For whoever is watching the admin dashboard (`/admin.html`). Every item on the "Needs attention" list has a stable code,
the same code appears in alerts (Slack / email / log), and each is explained here. Nothing in this app takes money without
an order, and every step is safe to retry, so when in doubt: **retry first, escalate second**.

## Daily (5 minutes)

1. Open the dashboard. "Needs attention" should be empty or understood.
2. Check **Vendor wallet** and **free slots** (the cards at the top). Slots below 10, or a wallet below $20, raise alerts.
3. Open **Emails**: anything `pending` for hours or `dead` is a customer who did not hear from us.
4. Check the NameSilo account balance (renewals and registrations draw from it; an empty balance shows up as error 119).
5. After a deploy or restart: `curl https://your-host/healthz` and look at the log for `adapters` (it lists which adapters are live).

## What each problem means

| Code | What happened | What to do |
|---|---|---|
| `provisioning_failed` | A pipeline step failed three times (raw error in the order's detail). The customer has been told "setup needs a little longer". | Read the error on the failing step, fix the cause (balance, IP allowlist, vendor outage), then **Retry provisioning**. Done steps are skipped, so a retry never re-buys anything. If it cannot be fixed, **Refund**. |
| `needs_attention` | A billing action needs a human. The text says which: *Domain renewal failed*, *Vendor removal failed*, *Payment received after termination but vendor removal could not be cancelled*. | Do what it says by hand at the vendor or registrar, then confirm in the dashboard. For the termination case, contact the vendor: the customer has paid and their mailboxes should come back. |
| `plan_change_failing` | The gateway refused to switch the subscription's plan for the next cycle (often because the subscription is `pending` after a failed charge). Retried hourly. | Usually clears by itself once the customer's payment succeeds. If it persists past one cycle, check the subscription in the gateway dashboard: the customer may be charged the wrong amount next cycle. |
| `billing_past_due` | A charge failed; the gateway is retrying (about 3 days). Service continues. | Nothing, unless it persists: the customer has been emailed a card-update link. |
| `billing_suspended` | Grace period over (default 7 days after the last retry failed). Mailboxes are paused. | Nothing: paying restores them automatically. After `BILLING_RETENTION_DAYS` (14) the vendor is asked to remove them. |
| `billing_terminated` | Mailboxes scheduled for removal at the vendor's next renewal; domains will not be renewed. | If the customer pays before the vendor's renewal, everything is restored automatically. After that, restoring is manual. |
| `renewal_pending/failed:<domain>:<cycle>` | A yearly domain renewal did not go through. Retried hourly, 5 times. | Check the NameSilo balance, renew the domain by hand if needed, and note it. A lapsed domain takes the customer's mailboxes down. |
| `email_dead:<id>` | A customer email failed 6 times over ~12 hours. | Check the email provider (`NOTIFY_PROVIDER`, API key, sender domain verified). Then contact the customer another way. |
| `vendor_slots_low:<provider>` / `vendor_wallet_low` | The mailbox vendor has few free slots or little money. New checkouts are refused automatically when slots run out (customers are never charged for what we cannot deliver). | Buy slots / top up the wallet at the vendor (this is a manual step at the moment). |

## Incidents

**The server crashed or was restarted.** Do nothing: on start it resumes new, waiting and interrupted orders and recovers the billing timers.
Check the dashboard after a minute. (This is tested: the pipeline is killed at every save point in `test/chaos.test.js`.)

**"Data file is unreadable" at startup.** The server refuses to start rather than begin with an empty database. A copy of the bad file was kept as
`<file>.corrupt-<time>`. Restore the newest backup: stop everything, `node scripts/restore.js backups/<file> --force`, start. The JSON store also keeps `<file>.bak`.

**A customer paid but has no order.** Look the checkout up in the gateway dashboard, then in `GET /api/admin/orders`. If the webhook never arrived, check the
webhook is enabled and pointing at `PUBLIC_URL`; the gateway retries for 24 hours and the order appears on its own. If it was disabled, re-enable it, then replay the event from the gateway dashboard.

**The payment gateway is down.** New checkouts fail with "could not start the payment". Existing subscriptions are unaffected. Nothing to do; customers retry.

**The mailbox vendor is down.** Provisioning steps wait or fail and are retried; check `provisioning_failed` once it recovers and **Retry**. Checkouts keep working but orders will queue.

**NameSilo balance ran out (error 119).** Top up, then **Retry provisioning** on failed orders; failed renewals retry on their own.

**Someone is hammering the site.** Rate limits and the daily domain cap apply automatically (look for `429` in the log and `cl_http_requests_total{class="4xx"}`). If a daily cap alert fires and it is NOT a real sales day, treat it as an incident: rotate the admin token and check the logs for the source address.

**A secret leaked.**
- `ADMIN_TOKEN`, `ENGINE_TOKEN`, `METRICS_TOKEN`: change the variable and restart. Nothing else is needed.
- Gateway or vendor keys: rotate at the provider, update the variable, restart.
- `CREDENTIALS_KEY`: see below. Stored mailbox passwords are encrypted with it.
- A customer's manage link: they can request a new one, but the old one keeps working until the order ends. (Tokens are not yet revocable: see "Known limits".)

## Routine tasks

**Back up** (cron hourly): `node scripts/backup.js` (keeps 14, proves each copy opens). Copy the `backups/` folder off the machine. Test a restore on another machine at least once.

**Rotate `CREDENTIALS_KEY`:**
1. Stop the server. 2. `node scripts/backup.js`.
3. `OLD_CREDENTIALS_KEY=... NEW_CREDENTIALS_KEY=... node scripts/rotate-key.js --dry-run` then again without `--dry-run`. It is safe to re-run if interrupted and changes nothing if the old key is wrong.
4. Set `CREDENTIALS_KEY` to the new key and start. Keep the old key until you are sure.

**Move from the JSON file to SQLite:** stop the server, `node scripts/migrate-to-sqlite.js data/db.json data/db.sqlite` (verifies counts, leaves the JSON untouched), start with `STORE=sqlite SQLITE_FILE=data/db.sqlite`.

**Before the first live run / after changing keys:** `node scripts/preflight.js`. It makes only read-only calls.

**Watch a billing failure play out safely** (demo/staging only): `DEV_TOOLS=1`, then `node scripts/simulate.js halted latest --advance 8` and `... charged latest`.

## Known limits (be aware, plan around them)

- One server process per data file. A second process would overwrite the first one's changes.
- Customer manage links cannot be revoked individually; replace with real login when integrating.
- Mailbox removal at the vendor happens at its next renewal, not immediately.
- The vendor's own subscription and wallet are not paid by this app: keep them funded.
- Nothing here sends money to customers except gateway refunds you trigger.
