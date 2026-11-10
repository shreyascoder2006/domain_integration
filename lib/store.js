import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Tiny JSON-file store. Replace with Postgres/Mongo when integrating with CloudLead.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { orders: {}, mailboxes: [] };
    if (existsSync(file)) {
      try { this.data = JSON.parse(readFileSync(file, 'utf8')); } catch { /* start fresh */ }
    }
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  getOrder(id) { return this.data.orders[id]; }
  putOrder(order) { this.data.orders[order.id] = order; this.save(); return order; }
  addMailboxes(list) { this.data.mailboxes.push(...list); this.save(); }
  listMailboxes() { return this.data.mailboxes; }
}
