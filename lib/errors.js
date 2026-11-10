/**
 * Thrown by an adapter when work is legitimately still in progress (DNS
 * propagating, mailboxes being created, rate limited). The provisioner parks
 * the step as "waiting" and a background loop re-checks it later, instead of
 * counting it as a failure.
 */
export class PendingError extends Error {
  constructor(message, retryAfterMs = 30_000) {
    super(message);
    this.name = 'PendingError';
    this.retryAfterMs = retryAfterMs;
  }
}
