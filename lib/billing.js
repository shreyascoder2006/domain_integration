// Recurring billing.
//
// One gateway subscription per order. A gateway plan has ONE fixed amount, but
// mailboxes renew every period (quarterly or yearly) while domains renew
// yearly. So the subscription alternates between two plans:
//
//   renewal plan = mailboxes + the yearly domain fee   (cycle 1, 5, 9, ... when quarterly)
//   base plan    = mailboxes only                      (every other cycle)
//
// After each paid cycle we schedule a plan change "at cycle end" so the NEXT
// charge uses the right plan. Annual plans have one cycle per year, so every
// cycle is a renewal cycle and the plan never changes.
//
// The gateway is the source of truth for charging; webhooks tell us what happened.
// This module turns those events into: domain renewals, plan changes, dunning
// (past due -> grace -> suspended -> removed) and cancellation.
import { config } from './config.js';
import { log as defaultLog } from './log.js';
import { toMinor } from './money.js';

const round = (n) => Math.round(n * 100) / 100;
const DAY = 86_400_000;

/* ------------------------------------------------------------------ */
/* Pure schedule maths                                                 */
/* ------------------------------------------------------------------ */

/** From a priced quote, work out what the subscription must charge. */
export function buildSchedule(quote) {
  const mailboxes = quote.lines.find((l) => l.key === 'mailboxes').amount; // one full billing period
  const domains = quote.lines.find((l) => l.key === 'domains').amount;     // one year
  const periodMonths = quote.billingMonths;
  const cyclesPerYear = Math.max(1, Math.round(12 / periodMonths));
  const baseAmount = round(mailboxes);
  const renewalAmount = round(mailboxes + domains); // equals quote.total: the first payment
  return {
    currency: quote.currency,
    periodMonths,
    cyclesPerYear,
    // Quarterly is sent as "monthly x 3": the gateway docs disagree on whether "quarterly" exists.
    period: periodMonths === 12 ? { unit: 'yearly', interval: 1 } : { unit: 'monthly', interval: periodMonths },
    totalCount: Math.floor((config.billing.maxYears * 12) / periodMonths),
    baseAmount, renewalAmount,
    baseMinor: toMinor(baseAmount, quote.currency),
    renewalMinor: toMinor(renewalAmount, quote.currency)
  };
}

/** Cycle numbers start at 1. Domains are paid for in cycle 1 and every `cyclesPerYear` cycles after. */
export const isDomainCycle = (cycle, s) => (cycle - 1) % s.cyclesPerYear === 0;
export const planForCycle = (cycle, s) => (isDomainCycle(cycle, s) ? 'renewal' : 'base');
export const amountForCycle = (cycle, s) => (isDomainCycle(cycle, s) ? s.renewalAmount : s.baseAmount);

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export function createBillingService({ store, providers, log = defaultLog, now = () => Date.now(), notify = () => {} }) {
  const iso = (ms) => new Date(ms).toISOString();
  const save = (o) => store.putOrder(o);
  const record = (o, event, detail) => {
    o.billing.history = [...(o.billing.history || []), { at: iso(now()), event, detail }].slice(-50);
  };
  const busy = new Set(); // order ids with a plan sync / renewal in flight

  /** Billing state for a brand-new subscription whose first cycle has just been paid. */
  function init({ schedule, subscriptionId, planIds, subscription = {} }) {
    const paid = Number(subscription.paid_count) || 1;
    return {
      gateway: providers.payments.name,
      subscriptionId, planIds, schedule,
      plan: 'renewal',                       // the plan the gateway will use for the next charge
      status: 'active',
      paidCount: paid,
      processedCycles: [paid],               // cycles already handled: makes webhook retries harmless
      currentEnd: subscription.current_end ? subscription.current_end * 1000 : null,
      cancelAtPeriodEnd: false,
      graceEndsAt: null, suspendedAt: null, endsAt: null,
      domainRenewals: [], history: [{ at: iso(now()), event: 'subscribed', detail: `cycle ${paid} paid` }]
    };
  }

  /** What the customer may see. No plan ids, no gateway names. */
  function summary(o) {
    const b = o.billing;
    if (!b) return null;
    const s = b.schedule;
    return {
      status: b.status,
      periodMonths: s.periodMonths,
      nextChargeAt: ['active', 'past_due'].includes(b.status) && b.currentEnd ? iso(b.currentEnd) : null,
      nextChargeAmount: ['active', 'past_due'].includes(b.status) ? amountForCycle(b.paidCount + 1, s) : null,
      currency: s.currency,
      cancelAtPeriodEnd: b.cancelAtPeriodEnd,
      serviceEndsAt: b.endsAt ? iso(b.endsAt) : null,
      paymentFailed: b.status === 'past_due',
      payBy: b.status === 'past_due' && b.graceEndsAt ? iso(b.graceEndsAt) : null
    };
  }

  /* ---------- side effects (all retried by tick) ---------- */

  async function renewDomains(o, cycle) {
    const b = o.billing;
    for (const d of o.domains) {
      let r = b.domainRenewals.find((x) => x.cycle === cycle && x.domain === d.name);
      if (!r) { r = { cycle, domain: d.name, status: 'pending', attempts: 0 }; b.domainRenewals.push(r); }
      if (r.status === 'done' || (r.nextAttemptAt || 0) > now()) continue;
      r.attempts++;
      try {
        const res = await providers.registrar.renew({ domain: d.name, years: 1 });
        Object.assign(r, { status: 'done', at: iso(now()), amount: res.orderAmount });
        delete r.error;
      } catch (e) {
        log.error(`[billing] renewing ${d.name} (cycle ${cycle}) failed: ${e.message}`);
        Object.assign(r, { error: e.message, status: r.attempts >= 5 ? 'failed' : 'pending', nextAttemptAt: now() + r.attempts * 3_600_000 });
        if (r.status === 'failed') b.needsAttention = `Domain renewal failed for ${d.name}`;
      }
      save(o);
    }
  }

  /** Tell the customer once every domain of this cycle has been renewed. */
  function notifyRenewed(o, cycle) {
    const rs = o.billing.domainRenewals.filter((x) => x.cycle === cycle);
    if (rs.length && rs.every((x) => x.status === 'done')) notify('domains_renewed', o, { cycle });
  }

  /** Make sure the gateway will charge the right plan next cycle. */
  async function syncPlan(o) {
    const b = o.billing;
    if (b.cancelAtPeriodEnd || !['active', 'past_due'].includes(b.status)) return;
    if (!providers.payments.changePlan) return;
    const desired = planForCycle(b.paidCount + 1, b.schedule);
    if (b.plan === desired || (b.nextPlanAttemptAt || 0) > now()) return;
    try {
      await providers.payments.changePlan({ subscriptionId: b.subscriptionId, planId: b.planIds[desired] });
      b.plan = desired; delete b.nextPlanAttemptAt; delete b.planError;
      record(o, 'plan_scheduled', `next cycle uses the ${desired} plan`);
    } catch (e) {
      // e.g. the subscription is "pending" (a charge just failed) and cannot be updated: try again later.
      log.error(`[billing] plan change for ${o.id} failed: ${e.message}`);
      b.planError = e.message; b.nextPlanAttemptAt = now() + 3_600_000;
    }
    save(o);
  }

  const guarded = async (o, fn) => {
    if (busy.has(o.id)) return;
    busy.add(o.id);
    try { await fn(); } finally { busy.delete(o.id); }
  };

  /* ---------- gateway events ---------- */

  /**
   * Apply a subscription webhook. State changes happen synchronously so the webhook
   * can be answered within the gateway's time limit; slow work (registrar and gateway
   * calls) is returned as `after()` for the caller to run in the background.
   */
  function handleEvent(ev) {
    const sub = ev.subscription;
    const o = sub && store.findOrderBySubscription(sub.id);
    if (!o) return { handled: false, reason: 'unknown subscription' };
    const b = o.billing;
    const t = now();

    switch (ev.type) {
      case 'subscription.charged': {
        const paid = Number(sub.paid_count);
        if (!(paid >= 1)) return { handled: false, reason: 'no paid cycle' };
        if (b.processedCycles.includes(paid)) return { handled: false, reason: 'duplicate' };
        b.processedCycles.push(paid);
        b.paidCount = Math.max(b.paidCount, paid);
        if (sub.current_end) b.currentEnd = sub.current_end * 1000;
        b.graceEndsAt = null;
        record(o, 'charged', `cycle ${paid}`);
        const wasDown = ['past_due', 'suspended', 'terminated'].includes(b.status);
        const reinstate = reinstateAfterPayment(o);
        if (wasDown && b.status === 'active') notify('reinstated', o);
        save(o);
        return {
          handled: true,
          after: () => guarded(o, async () => {
            await reinstate();
            if (paid > 1 && isDomainCycle(paid, b.schedule)) { await renewDomains(o, paid); notifyRenewed(o, paid); }
            await syncPlan(o);
          })
        };
      }
      case 'subscription.pending':
        if (b.status === 'active') b.status = 'past_due';
        if (sub.short_url) b.updateUrl = sub.short_url; // the gateway's hosted page where the customer can fix their card
        record(o, 'payment_failed', 'a charge failed; the gateway is retrying');
        save(o);
        notify('payment_failed', o, { updateUrl: b.updateUrl });
        return { handled: true };
      case 'subscription.halted':
        // Every retry failed. Service continues for the grace period, then is suspended.
        if (['active', 'past_due'].includes(b.status)) {
          b.status = 'past_due';
          b.graceEndsAt ??= t + config.billing.graceDays * DAY;
        }
        if (sub.short_url) b.updateUrl = sub.short_url;
        record(o, 'halted', `suspension scheduled for ${iso(b.graceEndsAt || t)}`);
        save(o);
        notify('payment_failed', o, { updateUrl: b.updateUrl });
        return { handled: true };
      case 'subscription.cancelled':
      case 'subscription.completed': {
        if (['ended', 'terminated'].includes(b.status)) return { handled: false, reason: 'already ended' };
        const endedAt = sub.ended_at ? sub.ended_at * 1000 : null;
        b.endsAt = endedAt || (b.cancelAtPeriodEnd ? b.currentEnd : t) || t;
        if (!['suspended'].includes(b.status)) b.status = 'cancelling';
        record(o, ev.type === 'subscription.completed' ? 'completed' : 'cancelled', `service ends ${iso(b.endsAt)}`);
        save(o);
        return { handled: true };
      }
      case 'subscription.updated': {
        const which = Object.entries(b.planIds).find(([, id]) => id === sub.plan_id)?.[0];
        if (which) b.plan = which;
        record(o, 'updated', which ? `plan is now ${which}` : 'updated');
        save(o);
        return { handled: true };
      }
      default:
        record(o, ev.type.replace('subscription.', ''), 'noted');
        save(o);
        return { handled: false, reason: 'noted' };
    }
  }

  /** A payment arrived: undo a suspension/termination if there was one. Returns the slow part. */
  function reinstateAfterPayment(o) {
    const b = o.billing;
    if (b.status === 'past_due') { b.status = 'active'; return async () => {}; }
    if (b.status === 'suspended') {
      store.unsuspendMailboxes(o.id);
      b.status = 'active'; b.suspendedAt = null;
      record(o, 'reinstated', 'payment received');
      return async () => {};
    }
    if (b.status === 'terminated') {
      // Removal was scheduled with the vendor: try to cancel it. If that fails a human must step in.
      return async () => {
        try {
          for (const d of o.domains) await providers.vendor.cancelRemoval?.({ domain: d.name, provider: o.provider });
          store.unsuspendMailboxes(o.id);
          b.status = 'active'; b.suspendedAt = null; delete b.needsAttention;
          record(o, 'reinstated', 'payment received; vendor removal cancelled');
          notify('reinstated', o);
        } catch (e) {
          b.needsAttention = 'Payment received after termination but vendor removal could not be cancelled';
          log.error(`[billing] ${o.id}: ${e.message}`);
        }
        save(o);
      };
    }
    return async () => {};
  }

  /* ---------- customer / admin actions ---------- */

  async function cancel(orderId, { atCycleEnd = true } = {}) {
    const o = store.getOrder(orderId);
    const err = (status, message) => Object.assign(new Error(message), { status, expose: true });
    if (!o?.billing) throw err(404, 'No subscription for this order');
    const b = o.billing;
    if (['ended', 'terminated', 'cancelling'].includes(b.status) && b.cancelAtPeriodEnd) throw err(409, 'This subscription is already cancelled');
    if (['ended', 'terminated'].includes(b.status)) throw err(409, 'This subscription has already ended');
    try {
      await providers.payments.cancelSubscription({ subscriptionId: b.subscriptionId, atCycleEnd });
    } catch (e) {
      log.error(`[billing] cancel ${o.id} failed: ${e.message}`);
      throw err(502, 'We could not cancel the subscription right now. Please try again.');
    }
    b.cancelAtPeriodEnd = atCycleEnd;
    b.status = 'cancelling';
    b.endsAt = atCycleEnd ? (b.currentEnd || now()) : now();
    record(o, 'cancel_requested', atCycleEnd ? 'at the end of the current period' : 'immediately');
    save(o);
    notify('cancelled', o);
    return summary(o);
  }

  async function suspend(o, reason) {
    const b = o.billing;
    store.suspendMailboxes(o.id, reason);
    b.status = reason === 'cancelled' ? 'ended' : 'suspended';
    b.suspendedAt = now();
    record(o, 'suspended', reason);
    save(o);
    notify(reason === 'cancelled' ? 'ended' : 'suspended', o, { updateUrl: b.updateUrl });
  }

  async function terminate(o) {
    const b = o.billing;
    try {
      for (const d of o.domains) await providers.vendor.scheduleRemoval?.({ domain: d.name, provider: o.provider });
    } catch (e) {
      log.error(`[billing] removal for ${o.id} failed: ${e.message}`);
      b.needsAttention = 'Vendor mailbox removal failed';
      b.nextTerminateAttemptAt = now() + 3_600_000;
      save(o);
      return;
    }
    delete b.needsAttention;
    b.status = 'terminated';
    record(o, 'terminated', 'mailboxes scheduled for removal; domains will not be renewed');
    save(o);
  }

  /** The timer. Safe to call as often as you like. */
  async function tick() {
    const t = now();
    const retentionMs = config.billing.retentionDays * DAY;
    for (const o of store.listOrders()) {
      const b = o.billing;
      if (!b) continue;
      try {
        if (b.status === 'past_due' && b.graceEndsAt && t < b.graceEndsAt && b.graceEndsAt - t <= 2 * DAY) notify('suspension_warning', o, { updateUrl: b.updateUrl });
        if (b.status === 'active' && !b.cancelAtPeriodEnd && b.currentEnd && b.currentEnd > t && b.currentEnd - t <= 7 * DAY) notify('renewal_reminder', o);
        if (b.status === 'past_due' && b.graceEndsAt && t >= b.graceEndsAt) await suspend(o, 'non_payment');
        else if (b.status === 'cancelling' && b.endsAt && t >= b.endsAt) await suspend(o, 'cancelled');
        else if (['suspended', 'ended'].includes(b.status) && t >= b.suspendedAt + retentionMs && (b.nextTerminateAttemptAt || 0) <= t) await terminate(o);

        if (['active', 'past_due'].includes(b.status)) {
          await guarded(o, async () => {
            await syncPlan(o);
            for (const r of b.domainRenewals.filter((x) => x.status === 'pending' && (x.nextAttemptAt || 0) <= t)) { await renewDomains(o, r.cycle); notifyRenewed(o, r.cycle); }
          });
        }
      } catch (e) {
        log.error(`[billing] tick failed for ${o.id}: ${e.message}`);
      }
    }
  }

  return { init, summary, handleEvent, cancel, tick, syncPlan: (o) => guarded(o, () => syncPlan(o)) };
}
