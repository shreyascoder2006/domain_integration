// Re-encrypt every sealed credential from an old CREDENTIALS_KEY to a new one.
//
// Sealed values live in two places: mailbox records, and the saved results of pipeline steps on orders.
// The walk finds every "enc:v1:" string anywhere in those records, so a new place that stores one is covered too.
//
// Safe to re-run: a value that already opens with the NEW key is left alone, so an interrupted run can simply be repeated.
// Nothing is written until EVERY value has been checked, so a wrong old key changes nothing.
import { PREFIX, openWith, sealWith, keyFromBase64 } from './crypto.js';

const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);

/** Visit every sealed string in `value`; `fn(sealed)` returns the replacement. Returns whether anything changed. */
function walk(value, fn) {
  let changed = false;
  const visit = (node) => {
    if (Array.isArray(node)) node.forEach((v, i) => { if (isSealed(v)) { const r = fn(v); if (r !== v) { node[i] = r; changed = true; } } else if (v && typeof v === 'object') visit(v); });
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (isSealed(v)) { const r = fn(v); if (r !== v) { node[k] = r; changed = true; } } else if (v && typeof v === 'object') visit(v); }
  };
  visit(value);
  return changed;
}

export function rotateKeys({ store, oldKeyB64, newKeyB64, dryRun = false }) {
  const oldKey = keyFromBase64(oldKeyB64), newKey = keyFromBase64(newKeyB64);
  if (oldKey.equals(newKey)) throw new Error('The old and new keys are the same');
  const records = [...store.listOrders().map((o) => ({ kind: 'order', rec: o })), ...store.listMailboxes().map((m) => ({ kind: 'mailbox', rec: m }))];

  // Pass 1: classify every sealed value without changing anything.
  let toRotate = 0, already = 0;
  const bad = [];
  for (const { kind, rec } of records) {
    walk(structuredClone(rec), (s) => {
      try { openWith(s, oldKey); toRotate++; }
      catch { try { openWith(s, newKey); already++; } catch { bad.push(`${kind} ${rec.id}`); } }
      return s;
    });
  }
  if (bad.length) throw new Error(`${bad.length} sealed value(s) open with NEITHER key (first: ${bad[0]}). Nothing was changed: check OLD_CREDENTIALS_KEY.`);
  if (dryRun) return { rotated: 0, wouldRotate: toRotate, alreadyRotated: already };

  // Pass 2: rewrite.
  let rotated = 0;
  for (const { kind, rec } of records) {
    const changed = walk(rec, (s) => {
      try { const plain = openWith(s, oldKey); rotated++; return sealWith(plain, newKey); }
      catch { return s; } // already on the new key
    });
    if (changed) (kind === 'order' ? store.putOrder(rec) : store.putMailbox(rec));
  }
  return { rotated, alreadyRotated: already };
}
