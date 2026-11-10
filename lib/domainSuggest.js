// Rule-based lookalike generator (prefix/suffix variants), then a registrar
// availability check. Mirrors how Saleshandy/Smartlead appear to do it.
const PREFIXES = ['the', 'get', 'try', 'use', 'join', 'go', 'meet', 'hello', 'my', 'hey', 'team', 'with', 'by'];
const SUFFIXES = ['hq', 'team', 'group', 'app', 'inc', 'co', 'online', 'labs', 'mail', 'works', 'io', 'global', 'pro', 'direct', 'hub', 'now'];

export function normalizeSeed(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/\.[a-z.]{2,}$/, '')     // strip TLD
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

/** Ordered, de-duplicated candidates: simple prefix/suffix variants first, then combinations. */
export function generateCandidates(seed, tld = 'com', limit = 120) {
  const base = normalizeSeed(seed);
  if (base.length < 2) return [];
  const names = [];
  for (const p of PREFIXES) names.push(p + base);
  for (const s of SUFFIXES) names.push(base + s);
  for (const p of PREFIXES.slice(0, 6)) for (const s of SUFFIXES.slice(0, 8)) names.push(p + base + s);
  const seen = new Set();
  return names
    .filter((n) => n.length <= 40 && !seen.has(n) && seen.add(n))
    .slice(0, limit)
    .map((n) => `${n}.${tld}`);
}

/**
 * Suggest available domains. registrar: { checkAvailability(domains) }.
 * isAllowed(domain) lets the caller drop names it will not sell (brand-abuse rules) BEFORE we spend registrar calls.
 */
export async function suggestDomains(registrar, seed, { tld = 'com', want = 12, isAllowed = () => true } = {}) {
  const candidates = generateCandidates(seed, tld).filter(isAllowed);
  const results = [];
  for (let i = 0; i < candidates.length && results.length < want; i += 20) {
    const checked = await registrar.checkAvailability(candidates.slice(i, i + 20));
    results.push(...checked.filter((r) => r.available));
  }
  return results.slice(0, want).map((r) => r.domain);
}
