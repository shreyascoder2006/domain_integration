import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { BaseStore } from '../lib/store.js';
import { sealWith, openWith, keyFromBase64, seal, open } from '../lib/crypto.js';
import { rotateKeys } from '../lib/rotate.js';

class MemStore extends BaseStore {}
const newKey = () => randomBytes(32).toString('base64');

function world(oldB64) {
  const k = keyFromBase64(oldB64);
  const store = new MemStore();
  const creds = (u) => sealWith({ username: u, password: 'pw-' + u }, k);
  store.addMailboxes([{ email: 'a@x.com', orderId: 'o1', credentialsEnc: creds('a@x.com') }, { email: 'b@x.com', orderId: 'o1', credentialsEnc: creds('b@x.com') }]);
  store.putOrder({
    id: 'o1', status: 'completed',
    progress: [{ domain: 'x.com', steps: {
      mailboxes: { status: 'done', result: { mailboxes: [{ email: 'a@x.com', credentialsEnc: creds('a@x.com') }] } },
      mailboxes_ready: { status: 'done', result: { mailboxes: [{ email: 'a@x.com', credentialsEnc: creds('a@x.com') }, { email: 'b@x.com', credentialsEnc: creds('b@x.com') }] } }
    } }]
  });
  return store;
}
const sealedOf = (store) => [...store.listMailboxes().map((m) => m.credentialsEnc), ...store.getOrder('o1').progress[0].steps.mailboxes_ready.result.mailboxes.map((m) => m.credentialsEnc), store.getOrder('o1').progress[0].steps.mailboxes.result.mailboxes[0].credentialsEnc];

test('rotation: every sealed value, in mailboxes and in saved pipeline results, moves to the new key', () => {
  const oldB64 = newKey(), newB64 = newKey();
  const store = world(oldB64);
  const before = sealedOf(store);
  const r = rotateKeys({ store, oldKeyB64: oldB64, newKeyB64: newB64 });
  assert.deepEqual(r, { rotated: 5, alreadyRotated: 0 });
  const after = sealedOf(store);
  after.forEach((s, i) => {
    assert.notEqual(s, before[i], 'ciphertext changed');
    assert.equal(openWith(s, keyFromBase64(newB64)).username.includes('@'), true, 'opens with the new key');
    assert.throws(() => openWith(s, keyFromBase64(oldB64)), 'the old key no longer opens it');
  });
  assert.equal(openWith(store.listMailboxes()[0].credentialsEnc, keyFromBase64(newB64)).password, 'pw-a@x.com', 'the plaintext is preserved');
});

test('rotation: a dry run changes nothing; an interrupted run can simply be repeated', () => {
  const oldB64 = newKey(), newB64 = newKey();
  const store = world(oldB64);
  const before = JSON.stringify(sealedOf(store));
  assert.deepEqual(rotateKeys({ store, oldKeyB64: oldB64, newKeyB64: newB64, dryRun: true }), { rotated: 0, wouldRotate: 5, alreadyRotated: 0 });
  assert.equal(JSON.stringify(sealedOf(store)), before);

  // Simulate an interrupted run: rotate only the mailboxes by hand, then run the tool.
  const m = store.listMailboxes()[0];
  m.credentialsEnc = sealWith(openWith(m.credentialsEnc, keyFromBase64(oldB64)), keyFromBase64(newB64));
  const r = rotateKeys({ store, oldKeyB64: oldB64, newKeyB64: newB64 });
  assert.equal(r.alreadyRotated, 1);
  assert.equal(r.rotated, 4);
  assert.deepEqual(rotateKeys({ store, oldKeyB64: oldB64, newKeyB64: newB64 }), { rotated: 0, alreadyRotated: 5 }, 'running it again is a no-op');
});

test('rotation: a wrong old key aborts BEFORE writing anything; identical keys are refused', () => {
  const oldB64 = newKey(), newB64 = newKey();
  const store = world(oldB64);
  const before = JSON.stringify(sealedOf(store));
  assert.throws(() => rotateKeys({ store, oldKeyB64: newKey(), newKeyB64: newB64 }), /open with NEITHER key/);
  assert.equal(JSON.stringify(sealedOf(store)), before, 'nothing was changed');
  assert.throws(() => rotateKeys({ store, oldKeyB64: oldB64, newKeyB64: oldB64 }), /same/);
  assert.throws(() => rotateKeys({ store, oldKeyB64: 'short', newKeyB64: newB64 }), /32 bytes/);
});

test('seal/open with the process key still round-trips and rejects tampering', () => {
  const s = seal({ t: 'secret' });
  assert.deepEqual(open(s), { t: 'secret' });
  assert.throws(() => open(s.slice(0, -4) + (s.endsWith('AAAA') ? 'BBBB' : 'AAAA')));
});
