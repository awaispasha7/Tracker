// Loads the FAA Part 135 certificate holders + aircraft list into the database, building the
// prospect list for operator sales and the registry used to verify fleets at onboarding.
//
//   npm run faa:import -- path/to/part135.xlsx      (or a .csv saved from it)
//
// Same as Ops console → Prospects → Import. Re-importing replaces the FAA tables; prospect
// statuses and notes are kept.

import { mkdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createApp } from '../src/app.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run faa:import -- <part135.xlsx|csv>');
  process.exit(1);
}
mkdirSync('data', { recursive: true });
const app = createApp({ dbPath: process.env.DB_PATH ?? 'data/emptylegs.db' });
const r = app.onboarding.importFaa(readFileSync(file), basename(file));
console.log(`Imported ${r.operators} certificate holders (${r.jetOperators} operate jets), ${r.aircraft} aircraft; ${r.skippedRows} rows skipped.`);
console.log('Columns used:', r.columns);
