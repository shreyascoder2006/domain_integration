// Preflight: before the first real run, prove every credential and setting works using READ-ONLY calls
// (nothing is bought, charged, created or emailed). Returns a list of checks; the CLI prints it.
//
//   status: 'ok' | 'fail' | 'warn' | 'skip'
import { checkEnv } from './startup.js';

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

export async function runPreflight({ env = process.env, providers, mailer, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const checks = [];
  const add = (name, status, detail, hint = '') => checks.push({ name, status, detail, hint });

  // ---- configuration ----
  const { errors, warnings } = checkEnv(env);
  for (const e of errors) add('config', 'fail', e);
  for (const w of warnings) add('config', 'warn', w);
  if (!errors.length && !warnings.length) add('config', 'ok', 'environment looks consistent');

  if (env.CREDENTIALS_KEY) {
    const len = Buffer.from(env.CREDENTIALS_KEY, 'base64').length;
    add('CREDENTIALS_KEY', len === 32 ? 'ok' : 'fail', len === 32 ? '32 bytes' : `decodes to ${len} bytes, must be 32`, 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  } else add('CREDENTIALS_KEY', env.NODE_ENV === 'production' ? 'fail' : 'warn', 'not set: a built-in development key is used', 'Set it before real customers: losing or changing it makes stored credentials unreadable');

  // ---- is this server reachable from the internet? (webhooks and email links depend on it) ----
  const pub = (env.PUBLIC_URL || '').replace(/\/$/, '');
  if (!pub) add('PUBLIC_URL', 'warn', 'not set: email links and alert links will be missing', 'e.g. https://app.yourdomain.com');
  else {
    if (env.NODE_ENV === 'production' && !/^https:\/\//.test(pub)) add('PUBLIC_URL', 'fail', 'must be https in production');
    try {
      const r = await withTimeout(fetchImpl(`${pub}/healthz`), timeoutMs, 'health check');
      const j = await r.json().catch(() => ({}));
      add('PUBLIC_URL reachable', r.ok && j.ok ? 'ok' : 'fail', r.ok && j.ok ? `${pub}/healthz answers` : `${pub}/healthz returned HTTP ${r.status}`, 'Gateways and vendors call your webhooks here, so it must be public HTTPS (no localhost)');
    } catch (e) { add('PUBLIC_URL reachable', 'fail', e.message, 'Start the server first, and expose it (reverse proxy or tunnel)'); }
  }

  // ---- each external service ----
  const probes = [['registrar', providers?.registrar], ['dns', providers?.vendor?.managesDns ? null : providers?.dns], ['mailbox vendor', providers?.vendor], ['payments', providers?.payments], ['email', mailer]];
  for (const [label, adapter] of probes) {
    if (!adapter) { add(label, 'skip', label === 'dns' ? 'the mailbox vendor runs DNS, so Cloudflare is not used' : 'not configured'); continue; }
    if (typeof adapter.preflight !== 'function') { add(`${label} (${adapter.name})`, 'skip', 'mock or no read-only check available'); continue; }
    try {
      const r = await withTimeout(adapter.preflight(), timeoutMs, `${label} check`);
      add(`${label} (${adapter.name})`, r.ok ? 'ok' : 'fail', r.detail);
    } catch (e) { add(`${label} (${adapter.name})`, 'fail', e.message); }
  }

  // ---- what to register where (a reminder, not a check) ----
  if (pub) {
    if (providers?.payments?.verifyWebhook) add('webhook: payments', 'warn', `register ${pub}/api/webhooks/razorpay in the gateway dashboard`, 'Events: payment.captured, order.paid, subscription.charged / pending / halted / cancelled / completed / updated, refund.processed, refund.failed. Use the same secret as RAZORPAY_WEBHOOK_SECRET');
    if (providers?.vendor?.verifyWebhook) add('webhook: mailbox vendor', 'warn', `register ${pub}/api/webhooks/zapmail with the vendor`, 'Optional (speeds up provisioning). Put the endpoint secret in ZAPMAIL_WEBHOOK_SECRET');
  }
  add('registrar IP allowlist', 'warn', "the registrar only accepts calls from allowlisted IPs: this server's outbound IP must be added in its dashboard", 'A passing credential check above already proves it for THIS machine');

  return { checks, ok: !checks.some((c) => c.status === 'fail') };
}
