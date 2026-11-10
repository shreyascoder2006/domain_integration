// Refuse to boot in a configuration that would lose money or data, and say so plainly.
// Pure function of the environment so it can be tested.
export function checkEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const prod = env.NODE_ENV === 'production';

  if (prod) {
    if (!env.CREDENTIALS_KEY) errors.push('CREDENTIALS_KEY is required in production (mailbox credentials would be encrypted with a dev key)');
    for (const k of ['REGISTRAR', 'DNS_PROVIDER', 'MAILBOX_VENDOR', 'PAYMENTS']) {
      if ((env[k] || 'mock') === 'mock' && env.ALLOW_MOCKS !== '1') {
        errors.push(`${k} is "mock" in production: customers would get fake domains, mailboxes or payments (set ALLOW_MOCKS=1 only for a demo)`);
      }
    }
    for (const t of ['ADMIN_TOKEN', 'ENGINE_TOKEN', 'METRICS_TOKEN']) {
      if (env[t] && env[t].length < 24) errors.push(`${t} must be at least 24 characters in production`);
    }
    if (env.DEV_TOOLS === '1') warnings.push('DEV_TOOLS=1 is ignored in production (the billing clock cannot be moved)');
    if ((env.PAYMENTS || 'mock') === 'mock' && !env.MOCK_WEBHOOK_SECRET) warnings.push('PAYMENTS is "mock" with the default webhook secret: anyone could post fake payment events. Set MOCK_WEBHOOK_SECRET');
    if (!env.ADMIN_TOKEN) warnings.push('ADMIN_TOKEN is not set: the admin API and dashboard are disabled');
    if ((env.NOTIFY_PROVIDER || 'mock') === 'mock') warnings.push('NOTIFY_PROVIDER is "mock": customers will not receive any email (setup done, payment failed, renewals...)');
    if (!env.PUBLIC_URL) warnings.push('PUBLIC_URL is not set: links in customer emails and alerts will be missing');
    if (env.TRUST_PROXY !== '1') warnings.push('TRUST_PROXY is not 1: behind a reverse proxy every visitor shares one rate-limit bucket');
  }
  if (env.PAYMENTS === 'razorpay' && !env.RAZORPAY_WEBHOOK_SECRET) {
    warnings.push('RAZORPAY_WEBHOOK_SECRET is not set: a customer who pays and closes the page will have paid without an order, and renewals will not be recorded');
  }
  if (env.MAILBOX_VENDOR === 'zapmail' && !env.ZAPMAIL_WEBHOOK_SECRET) {
    warnings.push('ZAPMAIL_WEBHOOK_SECRET is not set: provisioning relies on polling only (slower, still correct)');
  }
  if (env.MAILBOX_VENDOR === 'zapmail' && !env.ZAPMAIL_WORKSPACE_KEY) {
    warnings.push('ZAPMAIL_WORKSPACE_KEY is not set: the connection-requests endpoint requires it');
  }
  return { errors, warnings };
}
