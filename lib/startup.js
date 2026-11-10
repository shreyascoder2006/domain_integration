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
    if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length < 24) errors.push('ADMIN_TOKEN must be at least 24 characters in production');
    if (!env.ADMIN_TOKEN) warnings.push('ADMIN_TOKEN is not set: the admin API and dashboard are disabled');
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
