#!/usr/bin/env node
// node scripts/gen-openapi.js  ->  docs/openapi.json   (source of truth: lib/apiSpec.js)
import { mkdirSync, writeFileSync } from 'node:fs';
import { spec } from '../lib/apiSpec.js';
mkdirSync('docs', { recursive: true });
writeFileSync('docs/openapi.json', JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote docs/openapi.json (${Object.keys(spec.paths).length} paths)`);
