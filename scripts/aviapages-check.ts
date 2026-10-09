// Day-1 check of your Aviapages key: one call per endpoint the site uses, each response validated
// against Aviapages' published OpenAPI spec.
//
//   AVIAPAGES_API_KEY=... npm run aviapages:check                 read-only (about 20 calls)
//   AVIAPAGES_API_KEY=... npm run aviapages:check -- --with-writes   also creates one RFQ to yourself, then archives it
//   npm run aviapages:check -- --mock                              against the built-in mock
//
// Usage counts toward the same budget ledger as the server (DB_PATH, default data/emptylegs.db).

import { mkdirSync, writeFileSync } from 'node:fs';
import { createApp } from '../src/app.ts';
import { runContractCheck } from '../src/integrations/aviapages/contract-check.ts';

const args = new Set(process.argv.slice(2));
const mock = args.has('--mock');
const key = process.env.AVIAPAGES_API_KEY ?? '';
if (!mock && !key) {
  console.error('Set AVIAPAGES_API_KEY (or pass --mock).');
  process.exit(2);
}
const dbPath = process.env.DB_PATH ?? 'data/emptylegs.db';
const app = createApp({ dbPath, aviapages: { mode: mock ? 'mock' : 'live', apiKey: key, baseUrl: process.env.AVIAPAGES_BASE_URL } });
const client = app.aviapages!.client;
console.log(`Aviapages contract check — ${mock ? 'MOCK' : 'LIVE'} ${client.config.baseUrl}\n`);

const { results, summary } = await runContractCheck(client, { includeWrites: args.has('--with-writes') });
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
for (const r of results) {
  const mark = r.ok ? 'PASS' : r.note.startsWith('skipped') ? 'SKIP' : 'FAIL';
  console.log(`${mark}  ${pad(r.name, 34)} ${pad(r.feature, 40)} ${String(r.status ?? '-').padStart(3)} ${String(r.ms).padStart(5)}ms  ${r.ok ? '' : r.note}`);
  for (const e of r.schemaErrors.slice(0, 5)) console.log(`        ${e}`);
}
console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);

const failedFeatures = [...new Set(results.filter((r) => !r.ok && !r.note.startsWith('skipped')).map((r) => r.feature))];
if (failedFeatures.length) {
  console.log('\nFeatures affected:');
  for (const f of failedFeatures) console.log(`  - ${f}`);
  console.log('\nAuth errors (401/403) on some endpoints usually mean your plan does not include them: ask Aviapages to enable them for the trial.');
}

mkdirSync('data', { recursive: true });
const file = `data/aviapages-check-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), mode: mock ? 'mock' : 'live', baseUrl: client.config.baseUrl, summary, results }, null, 2));
app.kv.set('aviapages:last-check', { at: new Date().toISOString(), mode: mock ? 'mock' : 'live', summary, results }, Date.now());
console.log(`\nReport saved to ${file} (also shown in the ops console).`);
process.exit(summary.failed ? 1 : 0);
