// Push "needs attention" to the people who can fix it, without spamming them.
//
// scan() looks at the current problems. A NEW problem alerts at once; a problem that persists alerts again
// only after `repeatMs`; one that clears sends a short "resolved" note. State lives in the store, so a
// restart does not re-alert everything.
import { orderProblems, systemProblems } from './problems.js';
import { log as defaultLog } from './log.js';

export function createSlackSink(webhookUrl, fetchImpl = fetch) {
  return {
    name: 'slack',
    async send(text) {
      const res = await fetchImpl(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error(`Slack webhook HTTP ${res.status}`); // never include the URL: it is a secret
    }
  };
}
export function createEmailSink({ mailer, from, to }) {
  return { name: 'email', async send(text) { await mailer.send({ from, to, subject: 'CloudLead alert', text, html: `<pre style="font:14px monospace">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>` }); } };
}
export const createLogSink = (log = defaultLog) => ({ name: 'log', async send(text) { log.warn(`ALERT ${text}`); } });

export function sinksFromEnv(env = process.env, { mailer, from, log } = {}) {
  const sinks = [createLogSink(log)];
  if (env.ALERT_SLACK_WEBHOOK) sinks.push(createSlackSink(env.ALERT_SLACK_WEBHOOK));
  if (env.ALERT_EMAIL && mailer) sinks.push(createEmailSink({ mailer, from, to: env.ALERT_EMAIL }));
  return sinks;
}

export function createAlerter({ store, sinks, adminUrl = '', repeatMs = 24 * 3_600_000, brand = 'CloudLead', log = defaultLog, now = () => Date.now(), extra = () => [] }) {
  const deliver = async (text) => {
    for (const s of sinks) {
      try { await s.send(text); } catch (e) { log.error('alert sink failed', { sink: s.name }, e); }
    }
  };
  const link = adminUrl ? `\n${adminUrl.replace(/\/$/, '')}/admin.html` : '';

  async function scan() {
    const t = now();
    const current = new Map();
    for (const o of store.listOrders()) for (const pr of orderProblems(o)) current.set(`order:${o.id}:${pr.code}`, { order: o.id, message: pr.message });
    for (const pr of [...systemProblems(store), ...extra()]) current.set(`system:${pr.code}`, { order: null, message: pr.message });

    const fresh = [], repeats = [];
    for (const [key, p] of current) {
      const seen = store.getAlert(key);
      if (!seen) { fresh.push(p); store.putAlert(key, { firstSeenAt: t, lastSentAt: t, message: p.message }); }
      else if (t - seen.lastSentAt >= repeatMs) { repeats.push(p); store.putAlert(key, { ...seen, lastSentAt: t, message: p.message }); }
    }
    const resolved = [];
    for (const [key, seen] of Object.entries(store.listAlerts())) {
      if (!current.has(key)) { resolved.push(seen.message); store.deleteAlert(key); }
    }

    const fmt = (p) => `- ${p.order ? `[${p.order}] ` : ''}${p.message}`;
    const parts = [];
    if (fresh.length) parts.push(`NEW (${fresh.length}):\n${fresh.map(fmt).join('\n')}`);
    if (repeats.length) parts.push(`STILL OPEN (${repeats.length}):\n${repeats.map(fmt).join('\n')}`);
    if (resolved.length) parts.push(`RESOLVED (${resolved.length}):\n${resolved.map((m) => `- ${m}`).join('\n')}`);
    if (parts.length) await deliver(`${brand} needs attention\n${parts.join('\n\n')}${link}`);
    return { fresh: fresh.length, repeats: repeats.length, resolved: resolved.length };
  }
  return { scan };
}
