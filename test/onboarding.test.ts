import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, nativeLeg, T0 } from './helpers.ts';
import type { AppError } from '../src/domain/types.ts';
import { HOUR } from '../src/domain/types.ts';
import type { ApplicationInput } from '../src/operators/onboarding.ts';

const application = (over: Partial<ApplicationInput> = {}): ApplicationInput => ({
  company: 'Harbor Jet Charter', certificate: 'FAA Part 135', certificateNumber: 'H7JA123K',
  contactName: 'Sam Rivera', email: 'Sam@HarborJet.example', phone: '+1 212 555 0100', website: 'https://harborjet.example',
  fleet: [
    { tail: 'n-777hj', model: 'Citation XLS+', seats: 8, homeBase: 'TEB', year: 2019 },
    { tail: 'N88HJ', model: 'Embraer Praetor 600', category: 'super-midsize', seats: 9, homeBase: 'KHPN', year: 2022 },
  ],
  ...over,
});

test('apply -> approve creates an active operator, verified fleet and working portal key', async () => {
  const { app } = testApp();
  const { id, status } = app.onboarding.apply(application(), { opsEmail: 'ops@brand.example' });
  assert.equal(status, 'pending');
  assert.equal(app.fleet.getAircraft('N777HJ'), undefined, 'nothing is registered before approval');
  assert.ok((app.outbox.list('ops@brand.example') as unknown[]).length === 1, 'ops is told');

  const out = app.onboarding.approve(id);
  assert.equal(out.aircraft, 2);
  const op = app.fleet.operatorByApiKey(out.portalKey)!;
  assert.equal(op.name, 'Harbor Jet Charter');
  assert.equal(op.status, 'active');
  assert.equal(op.contact?.email, 'sam@harborjet.example');
  assert.equal(app.fleet.getAircraft('N777HJ')?.typeCode, 'C56X');
  assert.equal(app.fleet.getAircraft('N88HJ')?.homeBase, 'KHPN');
  const approved = (app.outbox.list('sam@harborjet.example') as Array<{ subject: string; body: string }>).find((m) => m.subject.startsWith("You're approved"))!;
  assert.match(approved.body, new RegExp(out.portalKey));

  // The new operator can publish through its own API source, and the leg is sellable.
  const r = await app.ingest.ingest(`api:${out.operatorId}`, [nativeLeg({ externalId: 'h1', tailNumber: 'N777HJ' })]);
  assert.equal(r.accepted, 1);
  assert.equal(app.search.search({ from: 'TEB' }, T0).results.length, 1);
});

test('suspending an operator takes its legs out of search', async () => {
  const { app } = testApp();
  const { operatorId } = app.onboarding.approve(app.onboarding.apply(application()).id);
  await app.ingest.ingest(`api:${operatorId}`, [nativeLeg({ externalId: 'h1', tailNumber: 'N777HJ' })]);
  app.fleet.upsertOperator({ ...app.fleet.getOperator(operatorId)!, status: 'suspended' });
  await app.ingest.refresh();
  app.search.invalidate();
  assert.equal(app.search.search({ from: 'TEB' }, T0).results.length, 0);
});

test('validation: unknown model needs a category, bad airport and tail are reported, honeypot rejected', () => {
  const { app } = testApp();
  assert.throws(() => app.onboarding.apply(application({
    fleet: [{ tail: '!', model: 'Mystery Jet', seats: 8, homeBase: 'ZZZZ', year: 2019 }],
  })), (e: AppError) => /tail number/.test(e.message) && /choose its category/.test(e.message) && /unknown home base/.test(e.message));
  assert.throws(() => app.onboarding.apply(application({ email: 'nope', fleet: [] })), (e: AppError) => /valid email/.test(e.message) && /at least one aircraft/.test(e.message));
  assert.throws(() => app.onboarding.apply(application({ company_url: 'http://spam' })), (e: AppError) => e.code === 'bad_request');
});

test('a tail already registered to another operator blocks approval', () => {
  const { app } = testApp();
  const { id } = app.onboarding.apply(application({ fleet: [{ tail: 'N100A', model: 'CL35', seats: 9, homeBase: 'TEB', year: 2020 }] }));
  assert.throws(() => app.onboarding.approve(id), (e: AppError) => e.code === 'tail_taken');
});

test('reject emails the applicant; decided applications cannot be decided again; repeat applications are throttled', () => {
  const { app, clock } = testApp();
  const { id } = app.onboarding.apply(application());
  const v = app.onboarding.reject(id, 'certificate number not found on the FAA list');
  assert.equal(v.status, 'rejected');
  assert.ok((app.outbox.list('sam@harborjet.example') as Array<{ subject: string }>).some((m) => m.subject === 'About your operator application'));
  assert.throws(() => app.onboarding.approve(id), (e: AppError) => e.code === 'already_decided');
  app.onboarding.apply(application());
  app.onboarding.apply(application());
  assert.throws(() => app.onboarding.apply(application()), (e: AppError) => e.status === 429);
  clock.advance(25 * HOUR);
  assert.equal(app.onboarding.apply(application()).status, 'pending');
});
