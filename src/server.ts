import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { buildRouter } from './http/routes.ts';
import { consoleSender } from './alerts/outbox.ts';
import { DEV_ADMIN_KEY, seedDemo, generateSpecs, seedReference, startSimulator } from './dev/seed.ts';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? 'data/emptylegs.db';
const ADMIN_KEY = process.env.ADMIN_KEY ?? DEV_ADMIN_KEY;
const SIMULATE = process.env.SIMULATE !== '0';
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const app = createApp({ dbPath: DB_PATH });

const firstRun = app.fleet.listOperators().length === 0;
const seeded = firstRun ? await seedDemo(app) : { ...seedReference(app, app.clock.now()), specs: generateSpecs(app.clock.now()) };
if (firstRun) console.log(`Seeded demo marketplace into ${DB_PATH}`);

const router = buildRouter(app, { adminKey: ADMIN_KEY });

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  if (await router.handle(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(404).end();
    return;
  }
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const file = path === '/' ? 'index.html' : path === '/operator' ? 'operator.html' : path === '/admin' ? 'admin.html' : path.slice(1);
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

// Background work: release lapsed holds, decay/expire unconfirmed supply, deliver notifications.
const timers = [
  setInterval(() => app.bookings.sweep().catch((e) => console.error('[sweep]', e)), 30_000),
  setInterval(() => app.ingest.refresh().catch((e) => console.error('[refresh]', e)), 60_000),
  setInterval(() => app.outbox.drain(consoleSender, app.clock.now()).catch((e) => console.error('[outbox]', e)), 5_000),
];
const stopSim = SIMULATE ? startSimulator(app, seeded.specs, 20_000) : () => {};

server.listen(PORT, () => {
  console.log(`\nEmpty-leg marketplace on http://localhost:${PORT}`);
  console.log(`  traveler site   http://localhost:${PORT}/`);
  console.log(`  operator portal http://localhost:${PORT}/operator   (try key: ${seeded.operatorKeys.op_skyline})`);
  console.log(`  ops review      http://localhost:${PORT}/admin      (key: ${ADMIN_KEY === DEV_ADMIN_KEY ? DEV_ADMIN_KEY : '$ADMIN_KEY'})`);
  console.log(`  feed simulator  ${SIMULATE ? 'on (SIMULATE=0 to disable)' : 'off'}\n`);
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
