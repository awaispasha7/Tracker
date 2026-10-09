import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { testApp, nativeLeg, bookingInput, T0 } from './helpers.ts';
import { DAY, HOUR, type AppError } from '../src/domain/types.ts';
import { classifyModel, parseFaaRows } from '../src/onboarding/onboarding.ts';
import { readCsv, readXlsx } from '../src/onboarding/xlsx.ts';
import { parseEcb, refreshFx } from '../src/pricing/market-data.ts';
import { MarketRepo } from '../src/db/repos.ts';
import { Database } from '../src/db/database.ts';

const code = (c: string) => (e: AppError) => {
  assert.equal(e.code, c);
  return true;
};

// Same layout as the FAA "Part 135 Operators and Aircraft" export.
const FAA_CSV = `Part 135 Operators and Aircraft,,,,,
Part 135 Certificate Holder Name,Certificate Designator,FAA Certificate Holding District Office,Aircraft Registration Number,Aircraft Serial Number,Aircraft Make/Model/Series
"Summit Air Charter, LLC",SUMA123B,EA03,N510SA,560-6011,CE-560XL
,,,N511SA,560-6012,CE-560XL
"Summit Air Charter, LLC",SUMA123B,EA03,N512SA,0081,PC-12/47E
Harbor Jets Inc,HBRA456C,SO15,N900HJ,5111,BD-100-1A10
Harbor Jets Inc,HBRA456C,SO15,901HJ,5112,CL-600-2B16
Rotor Tours,RTRA789D,WP05,N44RT,1234,R44
`;

/** A minimal .xlsx: [Content_Types], shared strings and one sheet, deflated like Excel does. */
function makeXlsx(rows: string[][]): Buffer {
  const strings: string[] = [];
  const idx = (s: string) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1);
  const col = (i: number) => String.fromCharCode(65 + i);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === '' ? '' : /^\d+$/.test(v)
    ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const sst = `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  return zip({ '[Content_Types].xml': '<Types/>', 'xl/sharedStrings.xml': sst, 'xl/worksheets/sheet1.xml': sheet });
}

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(text.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('market data: parses ECB daily rates and stores USD per unit', async () => {
  // Shape of the real eurofxref-daily.xml (trimmed).
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<Cube>
		<Cube time='2026-10-08'>
			<Cube currency='USD' rate='1.1000'/>
			<Cube currency='JPY' rate='177.34'/>
			<Cube currency='GBP' rate='0.8800'/>
			<Cube currency='CHF' rate='0.9400'/>
		</Cube>
	</Cube>
</gesmes:Envelope>`;
  const p = parseEcb(xml)!;
  assert.equal(p.date, '2026-10-08');
  assert.equal(p.perEur.GBP, 0.88);
  assert.equal(parseEcb('<html>maintenance</html>'), null);

  const market = new MarketRepo(new Database(':memory:'));
  const clock = { now: () => T0 };
  const ok = await refreshFx(market, clock, async () => ({ ok: true, status: 200, text: async () => xml }));
  assert.deepEqual(ok.updated.sort(), ['AED', 'CHF', 'EUR', 'GBP']);
  assert.equal(Math.round(market.get('fx_usd_per_AED')!.value * 1e4) / 1e4, 0.2723, 'AED is not published by the ECB; it is pegged to USD');
  assert.equal(market.get('fx_usd_per_EUR')!.value, 1.1);
  assert.equal(market.get('fx_usd_per_GBP')!.value, 1.25);
  const down = await refreshFx(market, clock, async () => ({ ok: false, status: 503, text: async () => '' }));
  assert.equal(down.ok, false, 'a failed refresh keeps the last rates (FX_AVAILABLE decides when they are too old)');
  assert.equal(market.get('fx_usd_per_GBP')!.value, 1.25);
});

test('spreadsheets: CSV with quotes and a real .xlsx read to the same rows', () => {
  const csv = readCsv(FAA_CSV);
  assert.equal(csv[2][0], 'Summit Air Charter, LLC');
  const xlsx = readXlsx(makeXlsx(csv));
  assert.deepEqual(xlsx.slice(1), csv.slice(1).map((r) => r.map((c) => c.trim())));
  assert.throws(() => readXlsx(Buffer.from('not a zip at all, not even close to one.')));
});

test('FAA model strings map to categories and our curated types', () => {
  assert.deepEqual(classifyModel('CE-560XL'), { category: 'midsize', suggestedType: 'C56X' });
  assert.deepEqual(classifyModel('BD-100-1A10'), { category: 'super-midsize', suggestedType: 'CL35' });
  assert.equal(classifyModel('BE-200').category, 'turboprop');
  assert.equal(classifyModel('C90').category, 'turboprop');
  assert.equal(classifyModel('GV-SP').category, 'ultra-long');
  assert.equal(classifyModel('LJ-45').category, 'light');
  assert.equal(classifyModel('R44').category, null, 'helicopters are not empty-leg inventory');
  assert.equal(classifyModel('PA-31').category, null, 'piston twins are not either');
});

test('FAA parsing: finds the header row, carries grouped rows forward, normalizes tails', () => {
  const { records, skipped, columns } = parseFaaRows(readCsv(FAA_CSV));
  assert.equal(columns.designator, 'Certificate Designator');
  assert.equal(records.length, 6);
  assert.equal(skipped, 0);
  assert.deepEqual(records[1], { designator: 'SUMA123B', name: 'Summit Air Charter, LLC', office: 'EA03', tail: 'N511SA', serial: '560-6012', model: 'CE-560XL' });
  assert.equal(records[4].tail, 'N901HJ', 'N-number without the N');
  assert.throws(() => parseFaaRows([['a', 'b'], ['1', '2']]), code('bad_faa_file'));
});

test('FAA import builds the prospect list; statuses survive a re-import', () => {
  const { app } = testApp();
  const r = app.onboarding.importFaa(makeXlsx(readCsv(FAA_CSV)), 'part135.xlsx');
  assert.deepEqual({ operators: r.operators, aircraft: r.aircraft, jetOperators: r.jetOperators }, { operators: 3, aircraft: 6, jetOperators: 2 });

  const jets = app.onboarding.prospects({ minJets: 1 });
  assert.deepEqual(jets.map((p) => p.designator).sort(), ['HBRA456C', 'SUMA123B'], 'helicopter-only operator filtered out');
  assert.deepEqual(app.onboarding.prospects({ category: 'heavy' }).map((p) => p.designator), ['HBRA456C']);
  assert.equal(app.onboarding.prospects({ q: 'summit' })[0].categories!.midsize, 2);

  const p = app.onboarding.updateProspect('faa:SUMA123B', { status: 'contacted', notes: 'Posts legs on their site weekly', contactEmail: 'ops@summit.example' });
  assert.equal(p.status, 'contacted');
  assert.equal(p.aircraft.length, 3);
  assert.throws(() => app.onboarding.updateProspect(p.id, { status: 'maybe' }), code('bad_status'));

  app.onboarding.importFaa(FAA_CSV);
  const again = app.onboarding.prospect('faa:SUMA123B');
  assert.equal(again.status, 'contacted');
  assert.equal(again.notes, 'Posts legs on their site weekly');
});

test('operator application: FAA-verified, lands in prospects, ops and applicant emailed; bots ignored', () => {
  const { app } = testApp();
  app.onboarding.importFaa(FAA_CSV);
  assert.throws(() => app.onboarding.apply({ company: 'X', name: 'Y', email: 'nope' }), code('bad_application'));
  assert.deepEqual(app.onboarding.apply({ company: 'Spam', name: 'Bot', email: 'b@b.co', honeypot: 'http://spam' }), { ok: true });

  const out = app.onboarding.apply({ company: 'Harbor Jets', name: 'Dana Reyes', email: 'Dana@HarborJets.example', certificateNumber: 'hbra456c', fleet: 'Challenger 300, 604' });
  assert.equal(out.faaVerified, true);
  const p = app.onboarding.prospect('faa:HBRA456C');
  assert.equal(p.status, 'applied');
  assert.equal(p.contact.email, 'dana@harborjets.example');
  assert.equal(p.application.fleet, 'Challenger 300, 604');
  const unknown = app.onboarding.apply({ company: 'New Air', name: 'Sam', email: 'sam@new.example', certificateNumber: 'ZZZZ999Z' });
  assert.equal(unknown.faaVerified, false);
  assert.ok(app.onboarding.prospects({ q: 'new air' }).length === 1, 'non-FAA applicants are prospects too');
  assert.equal(app.onboarding.prospects({ q: 'spam' }).length, 0);

  const mail = app.outbox.list() as Array<{ recipient: string; subject: string }>;
  assert.ok(mail.some((m) => m.subject.includes('Harbor Jets (FAA Part 135 verified)')));
  assert.ok(mail.some((m) => m.recipient === 'dana@harborjets.example'));
});

test('onboarding an operator: keys work once issued, fleet checked against the FAA certificate', async () => {
  const { app } = testApp();
  app.onboarding.importFaa(FAA_CSV);
  assert.throws(() => app.onboarding.createOperator({ name: 'Ghost', email: 'g@g.example', certificateNumber: 'NOPE000X' }), code('certificate_not_found'));

  const { operator, keys } = app.onboarding.createOperator({ name: 'Summit Air Charter', email: 'ops@summit.example', certificateNumber: 'suma123b', contactName: 'Lee' }, 'faa:SUMA123B');
  assert.equal(operator.id, 'op_summit_air_charter');
  assert.equal(app.fleet.operatorByApiKey(keys.portalKey)?.id, operator.id);
  assert.equal(app.fleet.sourceByApiKey(keys.feedKey)?.id, 'api:op_summit_air_charter');
  assert.equal(app.onboarding.prospect('faa:SUMA123B').status, 'signed');
  assert.equal(app.onboarding.createOperator({ name: 'Summit Air Charter', email: 'x@y.example' }).operator.id, 'op_summit_air_charter_2', 'ids never collide');

  // Tail on their certificate: fine. Someone else's tail: refused unless overridden.
  const added = app.onboarding.addAircraft(operator.id, { tail: 'N510SA', typeCode: 'C56X', seats: 8, homeBase: 'TEB', year: 2015 });
  assert.deepEqual([added.added, added.warnings], [true, []]);
  assert.equal(added.operator.fleet[0].onCertificate, true);
  const refused = app.onboarding.addAircraft(operator.id, { tail: 'N900HJ', typeCode: 'CL35', seats: 9, homeBase: 'TEB' });
  assert.equal(refused.added, false);
  assert.match(refused.warnings[0], /on certificate HBRA456C, not SUMA123B/);
  assert.equal(app.fleet.getAircraft('N900HJ'), undefined);
  const forced = app.onboarding.addAircraft(operator.id, { tail: 'N777ZZ', newType: { name: 'Citation Sovereign', category: 'midsize' }, seats: 9, homeBase: 'KHPN', override: true });
  assert.match(forced.warnings[0], /not on any FAA Part 135 certificate/);
  assert.equal(forced.operator.fleet.find((a) => a.tail === 'N777ZZ')!.typeName, 'Citation Sovereign');
  assert.throws(() => app.onboarding.addAircraft(operator.id, { tail: 'N100A', typeCode: 'CL35', seats: 9, homeBase: 'TEB', override: true }), code('tail_taken'));
  assert.throws(() => app.onboarding.addAircraft(operator.id, { tail: 'N511SA', typeCode: 'C56X', seats: 8, homeBase: 'XXXX' }), code('bad_base'));
  assert.equal(app.onboarding.operatorDetail(operator.id).faa!.aircraft.filter((a) => !a.onOurPlatform).length, 2, 'the rest of their certificate is suggested');

  // Rotating a key retires the old one.
  const { key } = app.onboarding.rotateKey(operator.id, 'portal');
  assert.equal(app.fleet.operatorByApiKey(keys.portalKey), undefined);
  assert.equal(app.fleet.operatorByApiKey(key)?.id, operator.id);
  const feed = app.onboarding.rotateKey(operator.id, 'feed');
  assert.equal(app.fleet.sourceByApiKey(keys.feedKey), undefined);
  assert.equal(app.fleet.sourceByApiKey(feed.key)?.id, `api:${operator.id}`);

  // Suspension takes their legs out of search.
  await app.ingest.ingest(`portal:${operator.id}`, [nativeLeg({ tailNumber: 'N510SA', price: { amount: 7_500_00, currency: 'USD' } })]);
  assert.equal(app.search.search({ from: 'TEB' }, T0).results.length, 1);
  app.onboarding.updateOperator(operator.id, { status: 'suspended' });
  await app.ingest.refresh();
  app.search.invalidate();
  assert.equal(app.search.search({ from: 'TEB' }, T0).results.length, 0);
});

test('signed operator, end to end: post in portal -> traveler books -> operator confirms; listings need weekly reconfirmation', async () => {
  const { app, clock } = testApp();
  const { operator } = app.onboarding.createOperator({ name: 'Coastline Aviation', email: 'charter@coastline.example' });
  app.onboarding.addAircraft(operator.id, { tail: 'N55CL', typeCode: 'E55P', seats: 7, homeBase: 'KTEB' });
  const dep = T0 + 20 * DAY;
  await app.ingest.ingest(`portal:${operator.id}`, [nativeLeg({ externalId: 'p1', tailNumber: 'N55CL', departureEarliest: new Date(dep).toISOString(), departureLatest: new Date(dep + 2 * HOUR).toISOString() })]);

  // Six days later the leg is still for sale (a portal listing is good for 7 days)…
  clock.advance(6 * DAY);
  await app.ingest.refresh();
  app.search.invalidate();
  assert.equal(app.search.search({ from: 'TEB'}, clock.now()).results.length, 1, 'portal listing still on sale after 6 days');
  // …the operator gets a reminder, once a week…
  assert.equal(app.onboarding.reconfirmReminders('https://example.com'), 1);
  assert.equal(app.onboarding.reconfirmReminders('https://example.com'), 0);
  assert.ok((app.outbox.list('charter@coastline.example') as Array<{ subject: string }>).some((m) => m.subject.includes('still available')));
  // …and one click keeps it listed past the 7-day mark.
  assert.deepEqual(await app.ingest.reconfirm(operator.id), { reconfirmed: 1 });
  clock.advance(3 * DAY);
  await app.ingest.refresh();
  app.search.invalidate();
  const hits = app.search.search({ from: 'TEB'}, clock.now()).results;
  assert.equal(hits.length, 1);

  const quote = app.bookings.createQuote(hits[0].legId, 2);
  const b = await app.bookings.createBooking(bookingInput(quote.quoteId, 2), 'idem-onboard-1');
  assert.equal(b.status, 'authorized');
  const toOperator = app.outbox.list('charter@coastline.example') as Array<{ subject: string }>;
  assert.ok(toOperator.some((m) => m.subject.startsWith('Confirm booking')), 'booking request emailed to the operator contact');
  assert.equal((await app.bookings.operatorConfirm(b.id, operator.id)).status, 'confirmed');
  assert.equal(app.onboarding.listOperators().find((o) => o.id === operator.id)!.confirmedBookings, 1);

  // Without reconfirming, a listing leaves search after 7 days.
  await app.ingest.ingest(`portal:${operator.id}`, [nativeLeg({ externalId: 'p2', tailNumber: 'N55CL', from: 'KPBI', to: 'KTEB', departureEarliest: new Date(dep + 5 * DAY).toISOString(), departureLatest: new Date(dep + 5 * DAY + HOUR).toISOString() })]);
  app.search.invalidate();
  assert.equal(app.search.search({ from: 'PBI' }, clock.now()).results.length, 1);
  clock.advance(7 * DAY + HOUR);
  await app.ingest.refresh();
  app.search.invalidate();
  assert.equal(app.search.search({ from: 'PBI'}, clock.now()).results.length, 0);
});

test('an application sent before the FAA list is imported is matched to it afterwards', () => {
  const { app } = testApp();
  assert.equal(app.onboarding.apply({ company: 'Summit Air Charter', name: 'Lee', email: 'lee@summit.example', certificateNumber: 'SUMA123B' }).faaVerified, false);
  app.onboarding.importFaa(FAA_CSV);
  const rows = app.onboarding.prospects({ q: 'summit' });
  assert.equal(rows.length, 1, 'one prospect, not a duplicate');
  assert.equal(rows[0].status, 'applied');
  assert.equal(rows[0].jetCount, 2);
  assert.equal(app.onboarding.prospect(rows[0].id).faaVerified, true);
});
