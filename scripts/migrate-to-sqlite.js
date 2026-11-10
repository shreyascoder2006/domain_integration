#!/usr/bin/env node
// node scripts/migrate-to-sqlite.js <data.json> <new.sqlite>
// Copies everything, verifies the counts, and refuses to merge into a database that already has data.
// Then run the server with STORE=sqlite SQLITE_FILE=<new.sqlite>.  The JSON file is left untouched.
import { migrateJsonToSqlite } from '../lib/backup.js';
const [jsonFile, sqliteFile] = process.argv.slice(2);
if (!jsonFile || !sqliteFile) { console.error('Usage: node scripts/migrate-to-sqlite.js <data.json> <new.sqlite>'); process.exit(2); }
migrateJsonToSqlite({ jsonFile, sqliteFile })
  .then((r) => console.log(`migrated ${JSON.stringify(r.migrated)} -> ${r.sqliteFile}`))
  .catch((e) => { console.error(`migration FAILED: ${e.message}`); process.exit(1); });
