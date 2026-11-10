// Customer email templates. Pure: (type, context) -> { subject, text, html }.
// Rules: never name an internal vendor, never include credentials, escape everything that came from a customer.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur = 'USD') => `${cur === 'USD' ? '$' : cur + ' '}${Number(n).toFixed(2)}`;
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

const wrap = (brand, title, bodyHtml, cta) => `<!doctype html><html><body style="margin:0;background:#f7f7fb;font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;color:#1b1b2f">
<div style="max-width:560px;margin:0 auto;padding:24px"><div style="font-weight:700;color:#6a4df0;margin-bottom:16px">${esc(brand)}</div>
<div style="background:#fff;border:1px solid #e4e4ee;border-radius:12px;padding:24px"><h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>${bodyHtml}
${cta ? `<p style="margin:20px 0 0"><a href="${esc(cta.url)}" style="background:#6a4df0;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">${esc(cta.label)}</a></p>` : ''}</div>
<p style="color:#6b6b80;font-size:12px;margin-top:16px">You are receiving this because of your ${esc(brand)} order. Reply to this email if something looks wrong.</p></div></body></html>`;

const lines = (items) => `<ul style="padding-left:18px;margin:8px 0">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
const p = (t) => `<p style="margin:8px 0">${esc(t)}</p>`;

export const TEMPLATE_TYPES = ['order_ready', 'order_delayed', 'payment_failed', 'suspension_warning', 'suspended', 'reinstated',
  'renewal_reminder', 'domains_renewed', 'cancelled', 'ended', 'manage_link'];

export function render(type, { order, summary, extra = {}, manageUrl, brand = 'CloudLead' }) {
  const name = order?.contact?.firstName || 'there';
  const domains = (order?.domains || []).map((d) => d.name);
  const emails = (order?.domains || []).flatMap((d) => d.mailboxes.map((m) => `${m.emailPrefix}@${d.name}`));
  const cur = summary?.currency || order?.quote?.currency || 'USD';
  const manage = manageUrl ? { url: manageUrl, label: 'Manage your plan' } : null;
  const manageText = manageUrl ? `\n\nManage your plan: ${manageUrl}` : '';
  const hi = `Hi ${name},`;
  const make = (subject, title, paras, items, cta = manage, textTail = manageText) => ({
    subject,
    text: `${hi}\n\n${paras.join('\n\n')}${items?.length ? '\n\n' + items.map((i) => `- ${i}`).join('\n') : ''}${cta && cta !== manage ? `\n\n${cta.label}: ${cta.url}` : textTail}\n\n- ${brand}`,
    html: wrap(brand, title, p(hi) + paras.map(p).join('') + (items?.length ? lines(items) : ''), cta)
  });

  switch (type) {
    case 'order_ready':
      return make('Your mailboxes are ready', 'Your mailboxes are ready',
        [`Your ${domains.length} domain${domains.length === 1 ? '' : 's'} and ${emails.length} mailbox${emails.length === 1 ? ' is' : 'es are'} set up and connected to your account.`,
          'New mailboxes need a warm-up period before heavy sending, so ramp up volume gradually.'], emails);
    case 'order_delayed':
      return make('Your setup needs a little longer', 'Your setup is taking longer than usual',
        ['Part of your setup did not finish on the first attempt. Our team has been notified and is working on it; you do not need to do anything, and you will not be charged twice.'], null);
    case 'payment_failed': {
      const pay = extra.updateUrl ? { url: extra.updateUrl, label: 'Update payment method' } : manage;
      return make('Your payment did not go through', 'We could not collect your payment',
        [`We could not charge your card for your next billing period${summary?.nextChargeAmount ? ` (${money(summary.nextChargeAmount, cur)})` : ''}. We will try again automatically.`,
          summary?.payBy ? `Please update your payment method by ${day(summary.payBy)} to keep your mailboxes working.` : 'Please update your payment method to keep your mailboxes working.'], null, pay);
    }
    case 'suspension_warning':
      return make('Your mailboxes will be paused soon', 'Your mailboxes will be paused soon',
        [`Your payment is still outstanding. Unless it is resolved by ${summary?.payBy ? day(summary.payBy) : 'the end of your grace period'}, your mailboxes will be paused and stop sending.`], null,
        extra.updateUrl ? { url: extra.updateUrl, label: 'Update payment method' } : manage);
    case 'suspended':
      return make('Your mailboxes have been paused', 'Your mailboxes have been paused',
        ['Because we could not collect payment, your mailboxes have been paused and will not send. Pay the outstanding amount and they are restored automatically.',
          'Paused mailboxes are kept for a limited time and are then removed.'], null,
        extra.updateUrl ? { url: extra.updateUrl, label: 'Update payment method' } : manage);
    case 'reinstated':
      return make('Payment received: your mailboxes are active', 'Your mailboxes are active again', ['Thank you. Your payment was received and your mailboxes are working again.'], null);
    case 'renewal_reminder':
      return make('Your plan renews soon', 'Your plan renews soon',
        [`Your plan renews on ${summary?.nextChargeAt ? day(summary.nextChargeAt) : 'your next billing date'} for ${summary ? money(summary.nextChargeAmount, cur) : 'the usual amount'}. No action is needed.`,
          'You can cancel auto-renewal at any time before then.'], null);
    case 'domains_renewed':
      return make('Your domains were renewed', 'Your domains were renewed', [`We renewed your domain${domains.length === 1 ? '' : 's'} for another year:`], domains, null);
    case 'cancelled':
      return make('Auto-renewal cancelled', 'Auto-renewal cancelled',
        [`Your plan will not renew. Your mailboxes keep working until ${summary?.serviceEndsAt ? day(summary.serviceEndsAt) : 'the end of your paid period'}.`], null);
    case 'ended':
      return make('Your service has ended', 'Your service has ended', ['Your plan has ended and your mailboxes have been paused. They are kept for a short time and then removed.'], null);
    case 'manage_link':
      return make('Your link to manage your plan', 'Manage your plan',
        ['Use the button below to see your mailboxes, receipts and next charge, or to cancel auto-renewal. Keep this link private: anyone with it can manage this plan.'], null);
    default:
      throw new Error(`Unknown email template: ${type}`);
  }
}
