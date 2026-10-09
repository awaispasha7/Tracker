// Browser end-to-end check of the whole site, against a fresh server in Aviapages mock mode.
//
//   npm run e2e            (needs a Chromium: set CHROMIUM_PATH, or run `npx playwright install chromium` once)
//
// Drives every page the way a person would and fails on any broken flow or browser console error.
// Screenshots land in e2e-artifacts/.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const PORT = 3000 + Math.floor(Math.random() * 1000) + 3000;
const BASE = `http://localhost:${PORT}`;
const ADMIN = 'dev_admin_key';
const OUT = 'e2e-artifacts';
const DB = join(tmpdir(), `e2e-${PORT}.db`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
rmSync(DB, { force: true });

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, SIMULATE: '0', AVIAPAGES_MODE: 'mock', AVIAPAGES_MOCK_REPLY_SECONDS: '2', AVIAPAGES_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function api(path: string, init: { method?: string; body?: unknown; admin?: boolean } = {}) {
  const res = await fetch(BASE + path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.admin ? { authorization: `Bearer ${ADMIN}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(data)}`);
  return data;
}

for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}

const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath });
const consoleErrors: string[] = [];
async function newPage(width = 1280, height = 900): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => consoleErrors.push(`${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${page.url()}: ${m.text()}`); });
  page.setDefaultTimeout(15_000);
  current = page;
  return page;
}

/** Each test page is its own browser context, so it signs in itself. */
async function adminPage(): Promise<Page> {
  const a = await newPage();
  await a.goto(`${BASE}/admin`);
  await a.fill('#key', ADMIN);
  await a.click('#login-form button');
  await a.waitForSelector('#ops:not([hidden])');
  return a;
}

async function operatorPage(operatorId: string): Promise<Page> {
  const op = await newPage();
  await op.goto(`${BASE}/operator`);
  await op.fill('#key', `dev_${operatorId}`);
  await op.click('#login-form button');
  await op.waitForSelector('#op-name');
  return op;
}

const results: Array<{ name: string; ok: boolean; ms: number; error?: string }> = [];
let current: Page | null = null;
async function step(name: string, fn: () => Promise<void>) {
  const t = performance.now();
  current = null;
  try {
    await fn();
    results.push({ name, ok: true, ms: Math.round(performance.now() - t) });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Math.round(performance.now() - t), error: (e as Error).message.split('\n')[0] });
    await (current as Page | null)?.screenshot({ path: `${OUT}/FAIL-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.png`, fullPage: true }).catch(() => {});
    console.log(`  ✗ ${name}: ${(e as Error).message.split('\n')[0]}`);
  }
}

async function fillBooking(page: Page, name: string, email: string) {
  await page.waitForSelector('#book');
  await page.fill('input[name=cname]', name);
  await page.fill('input[name=email]', email);
  for (const el of await page.$$('input[name^=p]')) await el.fill(name);
  await page.check('input[name=accept]');
  await page.fill('input[name=sig]', name);
  await page.click('#book button[type=submit]');
  await page.waitForSelector('.timeline');
}

const bookingFromUrl = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('booking')!;

console.log(`E2E against ${BASE}`);
const traveler = await newPage();

await step('Home page loads with live inventory indicator', async () => {
  await traveler.goto(BASE);
  await traveler.waitForSelector('#live:not(.off)');
});

let directBooking = '';
await step('Search New York and book a direct operator leg', async () => {
  await traveler.click('[data-try=TEB]');
  await traveler.waitForSelector('.leg');
  await traveler.screenshot({ path: `${OUT}/01-search.png` });
  await traveler.locator('.leg', { hasText: 'Direct operator' }).first().click();
  await traveler.click('#get-quote');
  await fillBooking(traveler, 'Ada Lovelace', 'ada@example.com');
  await traveler.waitForSelector('text=waiting for the operator');
  directBooking = bookingFromUrl(traveler.url());
});

await step('Operator confirms in the portal; traveler sees confirmation', async () => {
  const [b] = (await api('/api/admin/bookings', { admin: true })).filter((x: { id: string }) => x.id === directBooking);
  const op = await newPage();
  await op.goto(`${BASE}/operator`);
  await op.fill('#key', `dev_${b.operatorId}`);
  await op.click('#login-form button');
  await op.waitForSelector(`[data-confirm="${directBooking}"]`);
  await op.click(`[data-confirm="${directBooking}"]`);
  await op.waitForSelector('text=Confirmed — traveler charged.');
  await op.screenshot({ path: `${OUT}/02-operator.png` });
  await traveler.reload();
  await traveler.waitForSelector('text=Confirmed. You');
  await op.close();
});

await step('Operator portal: reply in Messages', async () => {
  const [b] = (await api('/api/admin/bookings', { admin: true })).filter((x: { id: string }) => x.id === directBooking);
  const op = await operatorPage(b.operatorId);
  await op.click('[data-tab=messages]');
  await op.click('[data-thread]');
  await op.fill('#reply textarea', 'Crew and catering arranged.');
  await op.click('#reply button');
  await op.waitForSelector('.msg >> text=Crew and catering arranged.');
  await op.close();
});

let avpBooking = '';
await step('Aviapages leg: photos, wind-adjusted flight time, request-to-book', async () => {
  await traveler.goto(BASE);
  await traveler.click('[data-try=GVA]');
  await traveler.waitForSelector('.leg');
  await traveler.locator('.leg', { hasText: 'Operator confirms on request' }).first().click();
  await traveler.waitForSelector('#get-quote');
  if ((await traveler.$$('.gallery img')).length === 0) throw new Error('no aircraft photos');
  await traveler.waitForSelector('text=airway route with typical winds');
  await traveler.screenshot({ path: `${OUT}/03-aviapages-leg.png` });
  await traveler.click('#get-quote');
  await fillBooking(traveler, 'Grace Hopper', 'grace@example.com');
  avpBooking = bookingFromUrl(traveler.url());
  await traveler.waitForSelector('text=Request sent to the operator');
});

await step('Operator offer arrives via Aviapages and auto-confirms the booking', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  await api('/api/admin/integrations/aviapages/poll', { method: 'POST', admin: true });
  await traveler.reload();
  await traveler.waitForSelector('text=Operator replied: available');
  await traveler.waitForSelector('text=Confirmed. You');
  await traveler.screenshot({ path: `${OUT}/04-aviapages-confirmed.png` });
});

let charterBooking = '';
await step('Custom charter: search aircraft, request quotes from two operators', async () => {
  const p = await newPage();
  await p.goto(`${BASE}/charter`);
  await p.waitForSelector('#request:not([hidden])');
  for (const [sel, code] of [['#from', 'TEB'], ['#to', 'PBI']]) {
    await p.fill(sel, code);
    await p.waitForSelector(`label:has(${sel}) .ac-list div`);
    await p.keyboard.press('Enter');
  }
  await p.fill('#pax', '3');
  await p.fill('#name', 'Katherine Johnson');
  await p.fill('#email', 'kj@example.com');
  await p.click('#request button[type=submit]');
  await p.waitForSelector('.option');
  await p.screenshot({ path: `${OUT}/05-charter-options.png` });
  const boxes = await p.$$('.option input');
  await boxes[0].check();
  await boxes[1].check();
  await p.click('#send');
  await p.waitForSelector('text=Bookmark this page');
  await new Promise((r) => setTimeout(r, 2500));
  await api('/api/admin/integrations/aviapages/poll', { method: 'POST', admin: true });
  await p.reload();
  await p.waitForSelector('text=Book this offer');
  await p.screenshot({ path: `${OUT}/06-charter-offers.png` });
  await p.click('text=Book this offer');
  await p.waitForSelector('#get-quote');
  await p.click('#get-quote');
  await fillBooking(p, 'Katherine Johnson', 'kj@example.com');
  charterBooking = bookingFromUrl(p.url());
  await p.close();
});

await step('Ops console: integrations dashboard and live contract check', async () => {
  const a = await adminPage();
  await a.click('[data-tab=integrations]');
  await a.waitForSelector('text=Operators learned');
  await a.click('[data-act=check]');
  await a.waitForSelector('text=passed');
  const failed = await a.$$('.tag.bad');
  if (failed.length) throw new Error(`${failed.length} failing probes in contract check`);
  await a.screenshot({ path: `${OUT}/07-admin-integrations.png`, fullPage: true });
  await a.close();
});

await step('Ops console: confirm the charter booking on the operator\'s behalf', async () => {
  const a = await adminPage();
  await a.click('[data-tab=bookings]');
  await a.click(`[data-confirm="${charterBooking}"]`);
  await a.waitForSelector('text=Confirmed — card captured');
  const status = (await api('/api/admin/bookings', { admin: true })).find((b: { id: string }) => b.id === charterBooking).status;
  if (status !== 'confirmed') throw new Error(`charter booking is ${status}`);
  await a.screenshot({ path: `${OUT}/08-admin-bookings.png` });
  await a.close();
});

await step('Ops console: inbox thread, write to operator', async () => {
  const a = await adminPage();
  await a.click('[data-tab=inbox]');
  await a.click('[data-thread]');
  await a.fill('#compose textarea', 'Please confirm tail number and crew names.');
  await a.click('#compose button');
  await a.waitForSelector('text=Sent.');
  await a.screenshot({ path: `${OUT}/09-admin-inbox.png` });
  await a.close();
});

await step('Inbound operator email is threaded by reference', async () => {
  const threads = await api('/api/admin/threads', { admin: true });
  const t = threads[0];
  const r = await fetch(`${BASE}/api/inbound/email?token=dev_inbound_token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'ops@operator.example', subject: `Re: [ref:${t.id}] ${t.subject}`, text: 'Tail N123AB, crew Smith/Jones.' }),
  });
  const body = await r.json();
  if (body.matched !== 'ref' || body.threadId !== t.id) throw new Error(JSON.stringify(body));
});

await step('Route alert signup', async () => {
  await traveler.goto(BASE);
  await traveler.fill('#a-email', 'alerts@example.com');
  await traveler.fill('#a-from', 'TEB');
  await traveler.waitForSelector('.ac-list div');
  await traveler.keyboard.press('Enter');
  await traveler.click('#alert-form button');
  await traveler.waitForSelector('text=Alert created');
});

await step('Operator applies to list empty legs', async () => {
  const p = await newPage();
  await p.goto(`${BASE}/operator`);
  const f = '#apply-form';
  await p.fill(`${f} [name=company]`, 'Summit Air Charter');
  await p.fill(`${f} [name=certificateNumber]`, 'SUMA123B');
  await p.fill(`${f} [name=name]`, 'Lee Park');
  await p.fill(`${f} [name=email]`, 'lee@summit.example');
  await p.fill(`${f} [name=fleet]`, '2x Citation XLS');
  await p.click(`${f} button`);
  await p.waitForSelector('#apply-done:not([hidden])');
  if (await p.isVisible('#demo-keys') !== true) throw new Error('demo key hint hidden in demo mode');
  await p.screenshot({ path: `${OUT}/11-operator-apply.png` });
  await p.close();
});

const FAA_CSV = `Part 135 Certificate Holder Name,Certificate Designator,FAA Certificate Holding District Office,Aircraft Registration Number,Aircraft Serial Number,Aircraft Make/Model/Series
"Summit Air Charter, LLC",SUMA123B,EA03,N510SA,560-6011,CE-560XL
"Summit Air Charter, LLC",SUMA123B,EA03,N511SA,560-6012,CE-560XL
Harbor Jets Inc,HBRA456C,SO15,N900HJ,5111,BD-100-1A10
`;
let newOperatorKey = '';
await step('Ops: import FAA Part 135 list, work the prospect, onboard operator and fleet', async () => {
  const a = await adminPage();
  await a.click('[data-tab=prospects]');
  await a.waitForSelector('#faa-file');
  await a.setInputFiles('#faa-file', { name: 'part135.csv', mimeType: 'text/csv', buffer: Buffer.from(FAA_CSV) });
  await a.waitForSelector('text=2 certificate holders, 3 aircraft loaded');
  await a.fill('#pf [name=q]', 'summit');
  await a.click('#pf button');
  await a.waitForFunction(() => document.querySelectorAll('[data-ob=open-prospect]').length === 1);
  await a.click('[data-ob=open-prospect]');
  await a.waitForSelector('#prospect');
  if (!(await a.isVisible('text=certificate matches the FAA list'))) throw new Error('application not attached to the FAA prospect');
  await a.fill('#prospect-form [name=notes]', 'Posts legs on their website weekly');
  await a.click('#prospect-form button');
  await a.waitForSelector('text=Saved.');
  await a.screenshot({ path: `${OUT}/12-admin-prospects.png`, fullPage: true });
  await a.click('[data-ob=onboard]');
  await a.waitForSelector('#op-create');
  if ((await a.inputValue('#op-create [name=email]')) !== 'lee@summit.example') throw new Error('prospect contact not carried over');
  await a.click('#op-create button:not([type=button])');
  await a.waitForSelector('#keys-box');
  newOperatorKey = (await a.textContent('#keys-box code.copy'))!.trim();
  await a.click('[data-ob=dismiss-keys]');
  await a.waitForSelector('#op-detail');
  await a.click('[data-ob=prefill-ac][data-tail=N510SA]');
  await a.waitForFunction(() => (document.querySelector('#ac-add [name=tail]') as HTMLInputElement | null)?.value === 'N510SA');
  await a.fill('#ac-add [name=homeBase]', 'TEB');
  await a.click('#ac-add button');
  await a.waitForSelector('text=N510SA added.');
  await a.waitForSelector('text=on certificate');
  await a.fill('#ac-add [name=tail]', 'N900HJ');
  await a.selectOption('#ac-add [name=typeCode]', 'CL35');
  await a.fill('#ac-add [name=seats]', '9');
  await a.fill('#ac-add [name=homeBase]', 'TEB');
  await a.click('#ac-add button');
  await a.waitForSelector('#ac-warning >> text=is on certificate HBRA456C, not SUMA123B');
  if ((await a.inputValue('#ac-add [name=tail]')) !== 'N900HJ') throw new Error('form not kept after the warning');
  await a.screenshot({ path: `${OUT}/13-admin-operator.png`, fullPage: true });
  await a.click('[data-tab=market]');
  await a.waitForSelector('#fuel-form');
  await a.fill('#fuel-form [name=fuel]', '6.25');
  await a.click('#fuel-form button');
  await a.waitForSelector('text=Fuel index updated.');
  await a.close();
});

await step('New operator signs in, posts a leg; traveler books it; operator confirms', async () => {
  if (!newOperatorKey.startsWith('opk_')) throw new Error(`no portal key captured (${newOperatorKey})`);
  const op = await newPage();
  await op.goto(`${BASE}/operator`);
  await op.fill('#key', newOperatorKey);
  await op.click('#login-form button');
  await op.waitForSelector('text=Summit Air Charter');
  await op.click('[data-tab=post]');
  const dep = new Date(Date.now() + 9 * 86_400_000);
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await op.fill('#p-from', 'TEB');
  await op.fill('#p-to', 'ASE');
  await op.fill('#p-early', local(dep));
  await op.fill('#p-late', local(new Date(dep.getTime() + 3 * 3_600_000)));
  await op.fill('#p-price', '9800');
  await op.click('#post-one button');
  await op.waitForSelector('text=Accepted 1, rejected 0');
  await op.click('[data-tab=legs]');
  await op.waitForSelector('text=listed');
  await op.click('#reconfirm');
  await op.waitForSelector('text=confirmed for another 7 days');

  const hits = (await api('/api/search?from=TEB&to=ASE')).results.filter((h: { operator: { name: string } }) => h.operator.name === 'Summit Air Charter');
  if (hits.length !== 1) throw new Error(`expected the new leg in search, got ${hits.length}`);
  const agreement = await api('/api/agreement');
  const quote = await api('/api/quotes', { method: 'POST', body: { legId: hits[0].legId, pax: 2 } });
  const res = await fetch(`${BASE}/api/bookings`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `e2e-${Date.now()}` },
    body: JSON.stringify({ quoteId: quote.quoteId, contact: { name: 'Kit Traveler', email: 'kit@example.com' }, passengers: [{ name: 'Kit' }, { name: 'Sam' }],
      paymentToken: 'tok_visa', agreement: { accepted: true, signedName: 'Kit Traveler', version: agreement.version } }),
  });
  const booking = await res.json();
  if (booking.status !== 'authorized') throw new Error(JSON.stringify(booking));
  await op.click('[data-tab=bookings]');
  await op.click(`[data-confirm="${booking.id}"]`);
  await op.waitForSelector('text=Confirmed — traveler charged.');
  await op.screenshot({ path: `${OUT}/14-new-operator.png`, fullPage: true });
  const after = await api(`/api/bookings/${booking.id}?email=kit@example.com`);
  if (after.status !== 'confirmed') throw new Error(`booking is ${after.status}`);
  await op.close();
});

await step('Every page fits a phone screen (no horizontal scroll)', async () => {
  const m = await newPage(390, 844);
  await m.goto(`${BASE}/admin`);
  await m.fill('#key', ADMIN);
  await m.click('#login-form button');
  await m.waitForSelector('#ops:not([hidden])');
  for (const path of ['/', '/charter', '/operator', '/operator-guide.html', '/admin']) {
    await m.goto(BASE + path);
    await m.waitForLoadState('load');
    await m.waitForTimeout(300);
    const w = await m.evaluate(() => document.documentElement.scrollWidth);
    if (w > 390) throw new Error(`${path} is ${w}px wide`);
  }
  await m.goto(BASE);
  await m.click('[data-try=VNY]');
  await m.waitForSelector('.leg');
  await m.screenshot({ path: `${OUT}/10-mobile.png` });
  await m.close();
});

await step('Production mode: refuses a weak admin key; no demo data, hints or Aviapages', async () => {
  const run = (env: Record<string, string>, port: number) => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts', '--production'], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(tmpdir(), `e2e-prod-${port}.db`), AVIAPAGES_API_KEY: '', AVIAPAGES_MODE: '', DEMO: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const weak = run({ ADMIN_KEY: 'dev_admin_key' }, PORT + 1);
  const code = await new Promise<number | null>((r) => weak.on('exit', r));
  if (code === 0) throw new Error('production server started with the dev admin key');

  const port = PORT + 2;
  const prod = run({ ADMIN_KEY: 'e2e_production_admin_key' }, port);
  try {
    const base = `http://localhost:${port}`;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const cfg = await (await fetch(`${base}/api/config`)).json();
    if (cfg.demo || cfg.aviapages.enabled || cfg.charterQuotes) throw new Error(JSON.stringify(cfg));
    if ((await (await fetch(`${base}/api/search?from=TEB`)).json()).results.length) throw new Error('demo legs in production');
    if ((await fetch(`${base}/api/admin/operators`, { headers: { authorization: 'Bearer dev_admin_key' } })).status !== 401) throw new Error('dev admin key accepted');
    if (cfg.bookingsOpen) throw new Error('bookings open on simulated payments');
    const b = await fetch(`${base}/api/bookings`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-prod-0001' }, body: '{}' });
    if (b.status !== 503) throw new Error(`booking on simulated payments returned ${b.status}`);
    const p = await newPage();
    await p.goto(`${base}/operator`);
    await p.waitForLoadState('load');
    await p.waitForTimeout(300);
    if (await p.isVisible('#demo-keys')) throw new Error('demo keys shown in production');
    await p.goto(base);
    await p.waitForTimeout(300);
    if (await p.isVisible('header [data-charter]')) throw new Error('custom charter link shown without Aviapages');
    await p.close();
  } finally {
    prod.kill();
    rmSync(join(tmpdir(), `e2e-prod-${port}.db`), { force: true });
  }
});

await step('No browser console errors on any page', async () => {
  if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(' | '));
});

await browser.close();
server.kill();
rmSync(DB, { force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots in ${OUT}/`);
if (failed.length) {
  console.log('\nServer log tail:\n' + serverLog.split('\n').slice(-20).join('\n'));
  process.exit(1);
}
