// Gets the most out of a time-limited Aviapages trial: downloads everything useful within your
// monthly budgets into the local database (and a JSON export), so it keeps working afterwards.
//
//   AVIAPAGES_API_KEY=... npm run aviapages:harvest
//   AVIAPAGES_API_KEY=... npm run aviapages:harvest -- --company-pages=50 --aircraft-pages=50 --calc-limit=400
//   npm run aviapages:harvest -- --mock
//
// Steps (each stops early when its endpoint's budget runs low):
//   1. empty legs        full sync of the next --days days (operators, tails, airports learned on the way)
//   2. aircraft types    the whole type catalog: real range, speed and seats replace class defaults
//   3. operators         charter_companies (contacts, response rates) for outreach and RFQs
//   4. fleet             charter_aircraft (tails, bases, photos, amenities)
//   5. calculators       flight time + market price for each distinct route/type in the inventory
//   6. export            data/aviapages-export/<timestamp>/*.json
//
// Every raw response is also archived in the database (table api_archive).

import { mkdirSync, writeFileSync } from 'node:fs';
import { createApp } from '../src/app.ts';
import { registerCharterAircraft, registerCompany, registerTypeRecord, SOURCE_ID } from '../src/integrations/aviapages/mapping.ts';
import { AviapagesError } from '../src/integrations/aviapages/client.ts';
import type { AircraftTypeRecord, CharterAircraft, CharterCompany } from '../src/integrations/aviapages/types.ts';
import { DAY } from '../src/domain/types.ts';

const flags = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const mock = flags.mock === 'true';
const key = process.env.AVIAPAGES_API_KEY ?? '';
if (!mock && !key) {
  console.error('Set AVIAPAGES_API_KEY (or pass --mock).');
  process.exit(2);
}
const num = (k: string, d: number) => (flags[k] ? Number(flags[k]) : d);
const days = num('days', 30);
const typePages = num('type-pages', 100);
const companyPages = num('company-pages', 20);
const aircraftPages = num('aircraft-pages', 20);
const calcLimit = num('calc-limit', 200);
const reserve = num('reserve', 20);

const app = createApp({
  dbPath: process.env.DB_PATH ?? 'data/emptylegs.db',
  aviapages: {
    mode: mock ? 'mock' : 'live', apiKey: key, baseUrl: process.env.AVIAPAGES_BASE_URL,
    budgets: process.env.AVIAPAGES_BUDGETS ? JSON.parse(process.env.AVIAPAGES_BUDGETS) : {},
    defaultBudget: process.env.AVIAPAGES_DEFAULT_BUDGET ? Number(process.env.AVIAPAGES_DEFAULT_BUDGET) : undefined,
    sync: { windowDays: days, reserveCalls: reserve, maxPagesPerRun: 500 },
  },
});
const avp = app.aviapages!;
const client = avp.client;
const r = { fleet: app.fleet, reference: app.reference };
const summary: Record<string, unknown> = {};
const log = (s: string) => console.log(s);

log(`Aviapages harvest — ${mock ? 'MOCK' : 'LIVE'} ${client.config.baseUrl}\n`);

log('1/6 Empty legs');
const sync = await avp.sync.full();
summary.emptyLegs = { received: sync.received, ingested: sync.ingested, skipped: sync.skipped, complete: sync.complete, error: sync.error };
log(`    ${sync.received} listings, ${sync.ingested} ingested${sync.complete ? '' : ' (stopped early)'}${sync.error ? ` — ${sync.error}` : ''}`);

async function harvest<T>(label: string, path: string, query: Record<string, unknown>, maxPages: number, each: (x: T) => boolean | unknown): Promise<void> {
  let seen = 0;
  let kept = 0;
  let pages = 0;
  try {
    for await (const { page } of client.paginate<T>(path, query, { maxPages, reserve })) {
      pages++;
      for (const x of page.results) {
        seen++;
        if (each(x)) kept++;
      }
    }
  } catch (e) {
    log(`    stopped: ${e instanceof AviapagesError ? e.message : String(e)}`);
  }
  summary[label] = { pages, seen, kept };
  log(`    ${pages} pages, ${seen} records, ${kept} kept`);
}

log('2/6 Aircraft type catalog');
await harvest<AircraftTypeRecord>('aircraftTypes', '/v3/aircraft_types/', {}, typePages, (t) => registerTypeRecord(r, t));

log('3/6 Operator directory');
await harvest<CharterCompany>('operators', '/v3/charter_companies/', { is_operator: true }, companyPages, (c) => registerCompany(r, c));

log('4/6 Fleet directory');
await harvest<CharterAircraft>('aircraft', '/v3/charter_aircraft/', {}, aircraftPages, (a) => registerCharterAircraft(r, a));

log('5/6 Flight times and market prices');
const now = Date.now();
const combos = new Map<string, { from: string; to: string; type: string; tail: string }>();
for (const leg of app.legs.listActive(now)) {
  if (!leg.typeCode || leg.departEarliest > now + days * DAY) continue;
  const k = `${leg.fromIcao}:${leg.toIcao}:${leg.typeCode}`;
  if (!combos.has(k)) combos.set(k, { from: leg.fromIcao, to: leg.toIcao, type: leg.typeCode, tail: leg.tail });
}
let warmed = 0;
const errors = new Set<string>();
for (const c of [...combos.values()].slice(0, calcLimit)) {
  const w = await app.calculators.warm(c.from, c.to, c.type, { tail: c.tail });
  if (w.flight || w.price) warmed++;
  w.errors.forEach((e) => errors.add(e.split(':')[0]));
  if (client.remaining('flight_calculator') <= reserve && client.remaining('charter_prices') <= reserve) break;
}
summary.calculators = { routes: combos.size, warmed, ...app.calculators.stats(), errors: [...errors] };
log(`    ${warmed}/${Math.min(combos.size, calcLimit)} routes warmed (${JSON.stringify(app.calculators.stats())})`);

log('6/6 Export');
const dir = `data/aviapages-export/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dir, { recursive: true });
const avpLegs = app.legs.listActive(now).filter((l) => app.legs.linksForSource(SOURCE_ID).some((x) => x.legId === l.id));
const write = (name: string, data: unknown) => writeFileSync(`${dir}/${name}.json`, JSON.stringify(data, null, 1));
write('legs', avpLegs);
write('operators', app.fleet.listOperators().filter((o) => o.source === 'aviapages'));
write('aircraft', app.fleet.listAircraft().filter((a) => a.source === 'aviapages'));
write('airports', app.reference.airports());
write('aircraft-types', app.reference.aircraftTypes());
write('calculations', app.db.all('SELECT key, kind, data, fetched_at FROM calc_cache'));
write('summary', summary);
log(`    written to ${dir}/`);

log('\nAPI usage this month:');
for (const u of client.usage()) log(`    ${u.endpoint.padEnd(26)} ${String(u.calls).padStart(6)} / ${u.budget}${u.errors ? `  (${u.errors} errors)` : ''}`);
log(`\nArchived raw responses: ${app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_archive')?.n ?? 0}`);
