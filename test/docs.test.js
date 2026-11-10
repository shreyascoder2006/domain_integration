import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spec } from '../lib/apiSpec.js';
import { checkEnv } from '../lib/startup.js';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

test('openapi: structurally valid (every path has operations with responses and known security schemes)', () => {
  assert.equal(spec.openapi, '3.0.3');
  const schemes = new Set(Object.keys(spec.components.securitySchemes));
  const schemas = new Set(Object.keys(spec.components.schemas));
  const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 20);
  for (const r of refs) assert.ok(schemas.has(r), `dangling $ref ${r}`);
  for (const [path, item] of Object.entries(spec.paths)) {
    const ops = Object.keys(item);
    assert.ok(ops.length && ops.every((m) => METHODS.includes(m)), `${path}: bad methods ${ops}`);
    for (const m of ops) {
      const op = item[m];
      assert.ok(op.summary && op.responses && Object.keys(op.responses).length, `${m} ${path}: needs a summary and responses`);
      for (const s of op.security || []) for (const n of Object.keys(s)) assert.ok(schemes.has(n), `${path}: unknown scheme ${n}`);
      for (const p of op.parameters || []) assert.ok(p.name && p.in && p.schema, `${path}: parameter needs name, in, schema`);
      const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
      for (const n of pathParams) assert.ok((op.parameters || []).some((p) => p.in === 'path' && p.name === n), `${m} ${path}: missing path parameter ${n}`);
    }
  }
  JSON.parse(JSON.stringify(spec)); // plain JSON, no functions or cycles
});

test('openapi: server.js and the spec describe the same routes (documentation cannot silently drift)', () => {
  // Every literal "/api/..." (or /healthz, /metrics) the server handles must be documented.
  const literals = new Set([...server.matchAll(/['"`](?:GET |POST )?(\/(?:api\/[A-Za-z0-9/_-]+|healthz|metrics))['"`]/g)].map((m) => m[1]));
  const documented = Object.keys(spec.paths).map((p) => p.replace(/\{\w+\}/g, ':'));
  // A literal with a trailing slash ("/api/engine/") means "everything under this prefix".
  const matches = (raw) => { const lit = raw.replace(/\/$/, ''); return documented.some((d) => d === lit || d.startsWith(lit + '/') || d.startsWith(lit + ':')); };
  for (const lit of literals) assert.ok(matches(lit), `server.js handles ${lit} but it is not in lib/apiSpec.js`);

  // Regex routes: every static segment of a documented path must appear in server.js, so a deleted route is noticed.
  for (const path of Object.keys(spec.paths)) {
    for (const seg of path.split('/').filter((s) => s && !s.startsWith('{'))) {
      assert.ok(server.includes(seg), `lib/apiSpec.js documents ${path} but server.js never mentions "${seg}"`);
    }
  }
  assert.ok(literals.size >= 15, `found only ${literals.size} routes in server.js: has its structure changed?`);
});

test('docs: the generated openapi.json is committed and up to date', () => {
  assert.ok(existsSync(new URL('../docs/openapi.json', import.meta.url)), 'run: npm run docs:openapi');
  const onDisk = JSON.parse(readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(spec)), 'docs/openapi.json is stale: run npm run docs:openapi');
});

test('startup: production checks the new tokens and warns about the demo webhook secret', () => {
  const prod = { NODE_ENV: 'production', CREDENTIALS_KEY: 'k', ADMIN_TOKEN: 'x'.repeat(30), TRUST_PROXY: '1', REGISTRAR: 'namesilo', DNS_PROVIDER: 'cloudflare', MAILBOX_VENDOR: 'zapmail', PAYMENTS: 'razorpay', RAZORPAY_WEBHOOK_SECRET: 's', ZAPMAIL_WEBHOOK_SECRET: 's', ZAPMAIL_WORKSPACE_KEY: 'w', NOTIFY_PROVIDER: 'resend', PUBLIC_URL: 'https://x.test' };
  assert.deepEqual(checkEnv(prod), { errors: [], warnings: [] });
  assert.ok(checkEnv({ ...prod, ENGINE_TOKEN: 'short' }).errors.some((e) => /ENGINE_TOKEN/.test(e)));
  assert.ok(checkEnv({ ...prod, METRICS_TOKEN: 'short' }).errors.some((e) => /METRICS_TOKEN/.test(e)));
  assert.ok(checkEnv({ ...prod, DEV_TOOLS: '1' }).warnings.some((w) => /DEV_TOOLS/.test(w)));
  const demo = checkEnv({ ...prod, PAYMENTS: 'mock', ALLOW_MOCKS: '1' });
  assert.ok(demo.warnings.some((w) => /default webhook secret/.test(w)));
  assert.deepEqual(checkEnv({ ...prod, PAYMENTS: 'mock', ALLOW_MOCKS: '1', MOCK_WEBHOOK_SECRET: 's' }).warnings, []);
});
