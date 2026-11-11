# Capacity and scaling

Measured with `npm run loadtest -- --orders N` on a development laptop (Windows, Node 22). Numbers are for **comparison, not promises**: run it on your own server.
It builds a synthetic database (each order has 3 mailboxes, 3 emails, a checkout and a subscription) and times what the server actually does.

## Which store to use

| Orders | JSON file store | SQLite store |
|---|---|---|
| 300 | 20 ms per write | 0.1 ms per write |
| 2,000 | **80-110 ms per write** | 0.1 ms per write |
| 20,000 | (not worth measuring) | 0.14 ms per write |

The JSON store rewrites the whole file on every change and the server waits while it does. One purchase makes about 40 writes, so at 2,000 orders a single
order freezes the server for several seconds, and a batch of 500 emails took 28 seconds. **Use `STORE=sqlite` for anything real** (production startup warns if you do not).
JSON is for development and demos.

## SQLite at 20,000 orders (60,000 mailboxes, 60,000 emails)

| Operation | Cost |
|---|---|
| Save one order / queue one email | 0.14 ms / 1 ms |
| Any lookup (checkout by key, order by subscription, by email, email de-duplication) | about 0.002-0.007 ms |
| Abuse check on every checkout | about 2 ms |
| Timer: resume orders + billing | 23 ms + 64 ms (every 15 s) |
| Timer: send pending emails (500 queued) | 160 ms; nothing pending: ~0 |
| Timer: alert scan, steady state | 30 ms (the very first scan, which raises every alert, took 0.7 s) |
| `/metrics` scrape | 0.2 s |
| Dashboard page (50 rows plus the cards) / search one order | 76 ms / 87 ms |
| Memory (everything is cached in RAM) | about 250 MB |

## What limits growth

1. **Memory.** The working set lives in RAM (about 12 KB per order with its mailboxes, emails and history). 50,000 orders is around 600 MB; budget accordingly.
   Orders that finished long ago could be archived: not built, because nothing here needs it at this scale.
2. **One process per database.** The cache is per process. Running two servers on one SQLite file would make them disagree. To scale out, replace the store (see `docs/adapters.md`: the same contract test proves a new backend) and the rate limiter (use Redis).
3. **The timers walk all orders every 15 s.** Cheap today (under 100 ms at 20,000). Past ~200,000 orders they would need an index of "orders with work due"; the code marks where.
4. **Startup time** loads everything: about 3 s at 20,000 orders.

## What was fixed because of these measurements

At 2,000 orders, before the work: email de-duplication scanned the whole outbox (35 ms each), the email timer walked every email ever sent (348 ms), every lookup by key,
subscription or email scanned all records (about 1 ms each), the abuse guard scanned all checkouts ever made, and the admin orders endpoint built one
200-300 ms (2 s at 20,000) response containing everything.

Now: the store keeps indexes (so lookups are O(1)), the abuse guard reads only the last 24 hours of checkouts, the email timer looks only at pending items,
and the dashboard asks the server for a page of 50 at a time. `test/scale.test.js` fails if any of these regress (it compares 2,000 against 40,000 records, so it does not depend on how fast the machine is).

## Try it

    npm run loadtest -- --orders 5000 --store sqlite     # or json, or both
    npm run seed-demo                                     # explore the dashboard with realistic sample orders (empty databases only)
