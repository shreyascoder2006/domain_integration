// Email transports. A mailer has send({ from, to, subject, text, html }) -> { id }.
//   mock    keeps messages in memory (and the admin outbox view); the default, nothing leaves the machine
//   resend  Resend's HTTP API (https://resend.com). Written from memory of their API and NOT verified
//           against the live service: check the request/response shape with a test key first.
import { randomBytes } from 'node:crypto';

export function createMockMailer() {
  const sent = [];
  return { name: 'mock-mailer', sent, async send(msg) { sent.push({ ...msg, at: new Date().toISOString() }); return { id: 'mock_' + randomBytes(4).toString('hex') }; } };
}

export function createResendMailer({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('RESEND_API_KEY is required for NOTIFY_PROVIDER=resend');
  return {
    name: 'resend',
    async send({ from, to, subject, text, html }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Email provider error ${res.status}: ${json.message || json.name || 'unknown'}`); // never includes the key
      return { id: json.id };
    },
    /** Read-only credential check for the preflight script. */
    async preflight() {
      const res = await fetchImpl('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${apiKey}` } });
      return { ok: res.ok, detail: res.ok ? 'API key accepted' : `HTTP ${res.status}` };
    }
  };
}

export function createMailer(env = process.env) {
  const provider = env.NOTIFY_PROVIDER || 'mock';
  if (provider === 'resend') return createResendMailer({ apiKey: env.RESEND_API_KEY });
  if (provider === 'mock') return createMockMailer();
  throw new Error(`NOTIFY_PROVIDER=${provider} is not a known mailer (mock, resend)`);
}
