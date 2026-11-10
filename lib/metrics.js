// Prometheus text-format metrics, computed on scrape from the store plus a few in-process counters.
import { orderProblems, systemProblems } from './problems.js';
import { STEPS } from './provisioner.js';

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const tally = (items, key) => items.reduce((m, i) => { const k = key(i); m.set(k, (m.get(k) || 0) + 1); return m; }, new Map());

export function createHttpCounters() {
  const byClass = new Map();
  return {
    observe(status) { const c = `${Math.floor(status / 100)}xx`; byClass.set(c, (byClass.get(c) || 0) + 1); },
    all: () => byClass,
    startedAt: Date.now()
  };
}

export function renderMetrics({ store, http, storeName = 'json', now = Date.now() }) {
  const out = [];
  const gauge = (name, help, rows) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of rows) out.push(`${name}${labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : ''} ${value}`);
  };
  const byLabel = (label, m) => [...m].map(([k, v]) => [{ [label]: k }, v]);

  const orders = store.listOrders();
  gauge('cl_orders', 'Orders by status', byLabel('status', tally(orders, (o) => o.status)));
  gauge('cl_billing', 'Subscriptions by billing status', byLabel('status', tally(orders.filter((o) => o.billing), (o) => o.billing.status)));
  const steps = orders.flatMap((o) => (o.progress || []).flatMap((p) => Object.entries(p.steps).map(([name, s]) => ({ name, status: s.status }))));
  gauge('cl_pipeline_steps', 'Pipeline steps that are waiting, running or failed', [...tally(steps.filter((s) => ['waiting', 'running', 'failed'].includes(s.status)), (s) => `${s.status}|${s.name}`)]
    .map(([k, v]) => { const [status, step] = k.split('|'); return [{ status, step }, v]; }));
  gauge('cl_mailboxes', 'Mailboxes by status', byLabel('status', tally(store.listMailboxes(), (m) => m.status || 'unknown')));
  gauge('cl_outbox', 'Customer emails by status', byLabel('status', tally(store.listOutbox(), (i) => i.status)));
  gauge('cl_checkouts_awaiting', 'Checkouts waiting for payment', [[null, store.listCheckouts().filter((c) => c.status === 'awaiting_payment').length]]);
  gauge('cl_open_problems', 'Things that need a human', [[null, orders.reduce((n, o) => n + orderProblems(o).length, 0) + systemProblems(store).length]]);
  gauge('cl_pipeline_step_kinds', 'Number of pipeline step kinds (for dashboards)', [[null, STEPS.length]]);

  out.push('# HELP cl_http_requests_total HTTP responses by status class', '# TYPE cl_http_requests_total counter');
  for (const [c, n] of http.all()) out.push(`cl_http_requests_total{class="${c}"} ${n}`);
  gauge('cl_uptime_seconds', 'Seconds since the server started', [[null, Math.round((now - http.startedAt) / 1000)]]);
  gauge('cl_info', 'Build info', [[{ store: storeName }, 1]]);
  return out.join('\n') + '\n';
}
