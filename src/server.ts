import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type AviapagesOptions } from './app.ts';
import { buildRouter } from './http/routes.ts';
import { consoleSender } from './alerts/outbox.ts';
import { DEV_ADMIN_KEY, seedDemo, generateSpecs, seedReference, startSimulator } from './dev/seed.ts';
import { AviapagesMock } from './integrations/aviapages/mock.ts';
import { HOUR, MINUTE, systemClock } from './domain/types.ts';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? 'data/emptylegs.db';
const ADMIN_KEY = process.env.ADMIN_KEY ?? DEV_ADMIN_KEY;
const SIMULATE = process.env.SIMULATE !== '0';
const INBOUND_TOKEN = process.env.INBOUND_EMAIL_TOKEN ?? 'dev_inbound_token';
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

// ---------- Aviapages: live with a key, otherwise a mock so every feature can be exercised ----------
const AVP_KEY = process.env.AVIAPAGES_API_KEY ?? '';
const AVP_MODE = (process.env.AVIAPAGES_MODE ?? (AVP_KEY ? 'live' : 'mock')) as AviapagesOptions['mode'];
if (AVP_MODE === 'live' && !AVP_KEY) throw new Error('AVIAPAGES_MODE=live requires AVIAPAGES_API_KEY');
const mock = AVP_MODE === 'mock'
  ? new AviapagesMock({ clock: systemClock, baseUrl: `http://localhost:${PORT}/mock-aviapages`, replyDelayMs: Number(process.env.AVIAPAGES_MOCK_REPLY_SECONDS ?? 90) * 1000 })
  : undefined;
const minutes = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) * MINUTE : fallback);

const app = createApp({
  dbPath: DB_PATH,
  aviapages: {
    mode: AVP_MODE,
    apiKey: AVP_KEY,
    baseUrl: process.env.AVIAPAGES_BASE_URL,
    budgets: process.env.AVIAPAGES_BUDGETS ? JSON.parse(process.env.AVIAPAGES_BUDGETS) : {},
    defaultBudget: process.env.AVIAPAGES_DEFAULT_BUDGET ? Number(process.env.AVIAPAGES_DEFAULT_BUDGET) : undefined,
    mock,
    sync: {
      fullEveryMs: minutes('AVIAPAGES_FULL_SYNC_MINUTES', mock ? 15 * MINUTE : 4 * HOUR),
      incrementalEveryMs: minutes('AVIAPAGES_INCREMENTAL_SYNC_MINUTES', mock ? 1 * MINUTE : 10 * MINUTE),
      listingMaxAgeMs: minutes('AVIAPAGES_LISTING_MAX_AGE_MINUTES', 12 * HOUR),
    },
  },
  comms: {
    pollEveryMs: minutes('AVIAPAGES_POLL_MINUTES', mock ? 1 * MINUTE : 3 * MINUTE),
    replyToAddress: process.env.REPLY_TO_ADDRESS ?? 'ops@emptylegtracker.example',
  },
});

const firstRun = app.fleet.listOperators().length === 0;
const seeded = firstRun ? await seedDemo(app) : { ...seedReference(app, app.clock.now()), specs: generateSpecs(app.clock.now()) };
if (firstRun) console.log(`Seeded demo marketplace into ${DB_PATH}`);
if (app.aviapages) {
  const r = await app.aviapages.sync.tick();
  if (r) console.log(`Aviapages (${AVP_MODE}) ${r.kind} sync: ${r.received} listings, ${r.ingested} ingested${r.error ? `, error: ${r.error}` : ''}`);
}

const router = buildRouter(app, { adminKey: ADMIN_KEY, inboundToken: INBOUND_TOKEN });

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
};

/** Mock mode only: stand-in aircraft photos so the UI shows images the way live data will. */
function mockPhoto(path: string): string {
  const [, id = '0', kind = 'exterior'] = /aircraft\/(\d+)\/(\w+)/.exec(path) ?? [];
  const hue = (Number(id) * 47) % 360;
  const cabin = kind === 'cabin';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,${cabin ? 30 : 72}%)"/><stop offset="1" stop-color="hsl(${hue},35%,${cabin ? 18 : 88}%)"/></linearGradient></defs><rect width="400" height="240" fill="url(#g)"/>${cabin
    ? '<rect x="40" y="70" width="320" height="120" rx="50" fill="#f3efe7" opacity=".9"/><rect x="70" y="120" width="60" height="50" rx="10" fill="#c9b79a"/><rect x="170" y="120" width="60" height="50" rx="10" fill="#c9b79a"/><rect x="270" y="120" width="60" height="50" rx="10" fill="#c9b79a"/>'
    : '<path d="M40 140 Q200 110 340 125 L370 128 Q380 132 370 136 L340 140 Q200 150 40 150 Z" fill="#fff"/><path d="M180 132 L230 95 L250 95 L215 135 Z M185 145 L235 185 L255 185 L220 143 Z M60 138 L50 105 L66 105 L84 136 Z" fill="#e8e8ee"/>'}<text x="16" y="228" font-family="sans-serif" font-size="12" fill="rgba(0,0,0,.45)">Mock photo · ${kind}</text></svg>`;
}

const server = createServer(async (req, res) => {
  if (await router.handle(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(404).end();
    return;
  }
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (mock && path.startsWith('/mock-aviapages/media/')) {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' }).end(mockPhoto(path));
    return;
  }
  const file = path === '/' ? 'index.html' : path === '/operator' ? 'operator.html' : path === '/admin' ? 'admin.html' : path === '/charter' ? 'charter.html' : path.slice(1);
  const full = normalize(join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

// Background work. Each job logs and carries on; one failure never stops the others.
const every = (ms: number, name: string, fn: () => Promise<unknown>) => setInterval(() => fn().catch((e) => console.error(`[${name}]`, e)), ms);
const timers = [
  every(30_000, 'sweep', () => app.bookings.sweep()),
  every(60_000, 'refresh', () => app.ingest.refresh()),
  every(5_000, 'outbox', () => app.outbox.drain(consoleSender, app.clock.now())),
  every(60_000, 'aviapages-sync', async () => {
    const r = await app.aviapages?.sync.tick();
    if (r) console.log(`[aviapages] ${r.kind} sync: ${r.received} listings, ${r.ingested} ingested, ${r.removed} removed${r.error ? `, error: ${r.error}` : ''}`);
  }),
  every(30_000, 'aviapages-comms', async () => {
    const r = await app.comms.tick();
    if (r) console.log('[aviapages] RFQ poll', r);
  }),
];
// Mock mode: the network changes over time like the real one (new legs, price drops, sold legs).
if (mock) {
  timers.push(every(45_000, 'mock-network', async () => {
    const live = mock.activeLegs().filter((l) => l.arr);
    const roll = Math.random();
    if (roll < 0.4 && live.length) {
      const l = live[Math.floor(Math.random() * live.length)];
      if (l.price) mock.updateLeg(l.id, { price: Math.round((l.price * 0.92) / 100) * 100 });
    } else if (roll < 0.6 && live.length > 30) {
      mock.removeLeg(live[Math.floor(Math.random() * live.length)].id);
    } else {
      const ac = [...mock.aircraft.values()][Math.floor(Math.random() * mock.aircraft.size)];
      const pool = [...mock.airports.keys()].filter((k) => k !== ac.base);
      mock.addLeg({ aircraftId: ac.id, dep: ac.base, arr: pool[Math.floor(Math.random() * pool.length)], from: Date.now() + (12 + Math.floor(Math.random() * 200)) * HOUR, price: 4000 + Math.floor(Math.random() * 20) * 500, currency: 'USD' });
    }
  }));
}
const stopSim = SIMULATE ? startSimulator(app, seeded.specs, 20_000) : () => {};

server.listen(PORT, () => {
  console.log(`\nEmpty-leg marketplace on http://localhost:${PORT}`);
  console.log(`  traveler site    http://localhost:${PORT}/`);
  console.log(`  custom charter   http://localhost:${PORT}/charter`);
  console.log(`  operator portal  http://localhost:${PORT}/operator   (try key: ${seeded.operatorKeys.op_skyline})`);
  console.log(`  ops console      http://localhost:${PORT}/admin      (key: ${ADMIN_KEY === DEV_ADMIN_KEY ? DEV_ADMIN_KEY : '$ADMIN_KEY'})`);
  console.log(`  Aviapages        ${AVP_MODE}${AVP_MODE === 'mock' ? ' (set AVIAPAGES_API_KEY to go live)' : ''}`);
  console.log(`  feed simulator   ${SIMULATE ? 'on (SIMULATE=0 to disable)' : 'off'}\n`);
});

const shutdown = () => {
  timers.forEach(clearInterval);
  stopSim();
  server.close(() => {
    app.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
