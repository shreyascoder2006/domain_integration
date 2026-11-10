#!/usr/bin/env node
// node scripts/preflight.js          (reads the same environment as the server)
// Read-only: nothing is bought, charged, created or emailed. Exit code 1 if anything failed.
import { loadProviders } from '../lib/providers/index.js';
import { createMailer } from '../lib/mailers.js';
import { runPreflight } from '../lib/preflight.js';

const ICON = { ok: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'skip' };
try {
  const { checks, ok } = await runPreflight({ providers: loadProviders(), mailer: createMailer() });
  const w = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${ICON[c.status]}  ${c.name.padEnd(w)}  ${c.detail}`);
    if (c.hint && c.status !== 'ok') console.log(`      ${' '.repeat(w)}  -> ${c.hint}`);
  }
  console.log(`\n${ok ? 'All checks passed.' : 'Some checks FAILED: fix them before taking real orders.'}`);
  process.exit(ok ? 0 : 1);
} catch (e) { console.error(`Preflight could not start: ${e.message}`); process.exit(1); }
