// The contract between this app and the sending/warm-up engine, independent of either side's stack.
//
// Use it in-process (import createEngineApi) or over HTTP (/api/engine/*, guarded by ENGINE_TOKEN).
//   listMailboxes({ sendable, orderId, userId })  what exists and what may send
//   getCredentials(id)                            decrypted login for ONE mailbox, refused while suspended
//   setState(id, { warmup, note })                the engine reports its own progress back
//
// Rules the engine must follow: send only from mailboxes with `sendable: true`; never cache credentials
// longer than needed; re-check `sendable` before every send run, because billing can suspend a mailbox at any time.
import { open } from './crypto.js';
import { httpError } from './validate.js';

export const WARMUP_STATES = ['queued', 'warming', 'ready', 'paused', 'error'];

export function createEngineApi({ store }) {
  const view = (m) => ({
    id: m.id, email: m.email, provider: m.provider, orderId: m.orderId, userId: m.userId,
    status: m.status, sendable: !m.suspended, suspended: !!m.suspended, suspendedReason: m.suspendedReason ?? null,
    warmup: m.warmup ?? 'queued', smtp: m.smtp ?? null, createdAt: m.createdAt
  });
  const find = (id) => store.getMailbox(id) || (() => { throw httpError(404, 'Mailbox not found'); })();

  return {
    listMailboxes({ sendable, orderId, userId } = {}) {
      return store.listMailboxes()
        .filter((m) => (orderId ? m.orderId === orderId : true) && (userId ? m.userId === userId : true) && (sendable ? !m.suspended : true))
        .map(view);
    },
    getMailbox: (id) => view(find(id)),

    getCredentials(id) {
      const m = find(id);
      if (m.suspended) throw httpError(409, 'This mailbox is suspended and must not send');
      if (!m.credentialsEnc) throw httpError(409, 'This mailbox has no stored credentials yet');
      return { id: m.id, email: m.email, smtp: m.smtp ?? null, credentials: open(m.credentialsEnc) };
    },

    setState(id, { warmup, note } = {}) {
      const m = find(id);
      if (warmup !== undefined) {
        if (!WARMUP_STATES.includes(warmup)) throw httpError(400, `warmup must be one of: ${WARMUP_STATES.join(', ')}`);
        m.warmup = warmup;
      }
      if (note !== undefined) m.engineNote = String(note).slice(0, 200);
      m.engineUpdatedAt = new Date().toISOString();
      store.putMailbox(m);
      return view(m);
    }
  };
}
