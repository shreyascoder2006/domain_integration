import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote } from '../lib/pricing.js';
import { generateCandidates, normalizeSeed } from '../lib/domainSuggest.js';

const box = (n) => Array.from({ length: n }, (_, i) => ({ firstName: 'A', lastName: 'B', emailPrefix: 'a' + i }));

test('quarterly quote matches Saleshandy reference (1 domain, 3 mailboxes = $14 + $35.91)', () => {
  const q = quote({ provider: 'google', plan: 'quarterly', domains: ['x.com'], mailboxes: box(3) });
  assert.equal(q.lines[0].amount, 14);
  assert.equal(q.lines[1].amount, 35.91);
  assert.equal(q.total, 49.91);
});

test('single mailbox quarterly = $11.97', () => {
  const q = quote({ provider: 'google', plan: 'quarterly', domains: ['x.com'], mailboxes: box(1) });
  assert.equal(q.lines[1].amount, 11.97);
});

test('annual flexi enforces 25 mailbox minimum', () => {
  assert.throws(() => quote({ provider: 'google', plan: 'annual_flexi', domains: ['x.com'], mailboxes: box(4) }), /at least 25/);
});

test('azure prices per tenant of 50 mailboxes', () => {
  const q = quote({ provider: 'azure', domains: ['x.com'], mailboxes: box(5) });
  assert.equal(q.lines[1].amount, 60);
});

test('seed normalisation strips protocol, www and tld', () => {
  assert.equal(normalizeSeed('https://www.CareerBricks.com/path'), 'careerbricks');
});

test('candidate generator makes unique .com names', () => {
  const c = generateCandidates('acme');
  assert.ok(c.includes('getacme.com') && c.includes('acmehq.com'));
  assert.equal(new Set(c).size, c.length);
});
