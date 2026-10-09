// Operator onboarding: certificated operators apply, ops verifies and approves.
//
//   apply     public form: company, certificate, contact, fleet. Nothing goes live.
//   review    ops checks the certificate (FAA: Part 135 certificate on the FAA's operator list)
//   approve   creates the operator, its verified fleet, a portal source and an API feed source,
//             and issues portal/feed keys (shown once to ops and emailed to the operator)
//   reject    with a reason, emailed to the applicant
//
// The verified fleet registry is what makes reconciliation trust a listing, so aircraft are only
// registered on approval, never straight from the public form.

import { randomBytes } from 'node:crypto';
import type { Database } from '../db/database.ts';
import type { FleetRepo, ReferenceRepo } from '../db/repos.ts';
import type { Outbox } from '../alerts/outbox.ts';
import type { AircraftCategory, Clock } from '../domain/types.ts';
import { AppError, CATEGORIES, HOUR } from '../domain/types.ts';
import { newId, normalizeTail } from '../domain/ids.ts';
import { findAirport } from '../reference/airports.ts';
import { findAircraftType, matchTypeHint, registerAircraftType, typeCodeFor } from '../reference/aircraft-types.ts';

export interface AircraftInput {
  tail: string;
  /** Model as the operator writes it, e.g. "Citation XLS+", or a type code like C56X. */
  model: string;
  /** Needed only when we don't recognise the model. */
  category?: AircraftCategory;
  seats: number;
  homeBase: string;
  year: number;
}

export interface ApplicationInput {
  company: string;
  certificate: 'FAA Part 135' | 'EASA AOC' | 'Other AOC';
  certificateNumber: string;
  contactName: string;
  email: string;
  phone: string;
  website?: string;
  fleet: AircraftInput[];
  notes?: string;
  /** Honeypot: real users never fill it. */
  company_url?: string;
}

export interface ResolvedAircraft {
  tail: string;
  model: string;
  typeCode: string | null;
  typeName: string | null;
  category: AircraftCategory | null;
  seats: number;
  homeBase: string;
  year: number;
  problems: string[];
}

interface Row {
  id: string; company: string; certificate: string; certificate_number: string; contact_name: string; email: string; phone: string;
  website: string | null; fleet: string; notes: string | null; status: 'pending' | 'approved' | 'rejected'; operator_id: string | null;
  decision_note: string | null; created_at: number; decided_at: number | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CERTS = ['FAA Part 135', 'EASA AOC', 'Other AOC'];
const MAX_AIRCRAFT = 40;

export class OnboardingService {
  private db: Database;
  private fleet: FleetRepo;
  private reference: ReferenceRepo;
  private outbox: Outbox;
  private clock: Clock;
  private portalUrl: string;

  constructor(deps: { db: Database; fleet: FleetRepo; reference: ReferenceRepo; outbox: Outbox; clock: Clock; portalUrl?: string }) {
    this.db = deps.db;
    this.fleet = deps.fleet;
    this.reference = deps.reference;
    this.outbox = deps.outbox;
    this.clock = deps.clock;
    this.portalUrl = deps.portalUrl ?? '/operator';
  }

  apply(input: ApplicationInput, meta: { opsEmail?: string | null } = {}) {
    const s = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    if (s(input?.company_url)) throw new AppError(400, 'bad_request', 'Invalid submission');
    const app = {
      company: s(input?.company), certificate: s(input?.certificate), certificateNumber: s(input?.certificateNumber, 60),
      contactName: s(input?.contactName), email: s(input?.email).toLowerCase(), phone: s(input?.phone, 40),
      website: s(input?.website) || null, notes: s(input?.notes, 2000) || null,
    };
    const problems: string[] = [];
    if (app.company.length < 2) problems.push('company name is required');
    if (!CERTS.includes(app.certificate)) problems.push(`certificate must be one of ${CERTS.join(', ')}`);
    if (app.certificateNumber.length < 3) problems.push('certificate number is required');
    if (app.contactName.length < 2) problems.push('contact name is required');
    if (!EMAIL_RE.test(app.email)) problems.push('a valid email is required');
    if (app.phone.replace(/\D/g, '').length < 7) problems.push('a phone number is required');
    if (!Array.isArray(input?.fleet) || input.fleet.length === 0) problems.push('add at least one aircraft');
    else if (input.fleet.length > MAX_AIRCRAFT) problems.push(`at most ${MAX_AIRCRAFT} aircraft per application`);
    const fleet = Array.isArray(input?.fleet) ? input.fleet.slice(0, MAX_AIRCRAFT).map((a) => this.resolve(a)) : [];
    fleet.forEach((a, i) => a.problems.filter((p) => !p.startsWith('note:')).forEach((p) => problems.push(`aircraft ${i + 1} (${a.tail || 'no tail'}): ${p}`)));
    const tails = fleet.map((a) => a.tail);
    if (new Set(tails).size !== tails.length) problems.push('the same tail number appears twice');
    if (problems.length) throw new AppError(400, 'bad_application', problems.join('; '), { problems });

    const recent = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM operator_applications WHERE email = ? AND created_at > ?', app.email, this.clock.now() - 24 * HOUR);
    if ((recent?.n ?? 0) >= 3) throw new AppError(429, 'too_many_applications', 'We already have your application; our team will be in touch.');

    const id = newId('opa');
    const now = this.clock.now();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO operator_applications (id, company, certificate, certificate_number, contact_name, email, phone, website, fleet, notes, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        id, app.company, app.certificate, app.certificateNumber, app.contactName, app.email, app.phone, app.website, JSON.stringify(fleet), app.notes, now,
      );
      this.outbox.enqueue({
        dedupeKey: `opa:${id}:received`, recipient: app.email, subject: 'We received your operator application',
        body: `Hi ${app.contactName},\n\nThanks for applying to list ${app.company}'s empty legs. We verify every operator's certificate before anything goes live, usually within one business day. We'll email you your portal access once approved.`,
      }, now);
      if (meta.opsEmail) {
        this.outbox.enqueue({
          dedupeKey: `opa:${id}:ops`, recipient: meta.opsEmail, subject: `New operator application: ${app.company}`,
          body: `${app.company} (${app.certificate} ${app.certificateNumber}) applied with ${fleet.length} aircraft.\nContact: ${app.contactName}, ${app.email}, ${app.phone}\nReview it in the ops console under Operators.`,
        }, now);
      }
    });
    return { id, status: 'pending' as const };
  }

  list(status?: string) {
    const rows = status
      ? this.db.all<Row>('SELECT * FROM operator_applications WHERE status = ? ORDER BY created_at DESC', status)
      : this.db.all<Row>('SELECT * FROM operator_applications ORDER BY created_at DESC LIMIT 200');
    return rows.map((r) => this.view(r));
  }

  approve(id: string, opts: { note?: string } = {}) {
    const r = this.row(id);
    if (r.status !== 'pending') throw new AppError(409, 'already_decided', `Application is already ${r.status}`);
    const fleet = (JSON.parse(r.fleet) as ResolvedAircraft[]).map((a) => this.resolve({ ...a, category: a.category ?? undefined }));
    const taken = fleet.filter((a) => this.fleet.getAircraft(a.tail));
    if (taken.length) throw new AppError(409, 'tail_taken', `Already registered to another operator: ${taken.map((a) => a.tail).join(', ')}`);
    const blocking = fleet.flatMap((a) => a.problems.filter((p) => !p.startsWith('note:')).map((p) => `${a.tail}: ${p}`));
    if (blocking.length) throw new AppError(400, 'bad_application', blocking.join('; '));

    const operatorId = `op_${r.company.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'x'}_${randomBytes(2).toString('hex')}`;
    const portalKey = `opk_${randomBytes(18).toString('hex')}`;
    const feedKey = `feed_${randomBytes(18).toString('hex')}`;
    const now = this.clock.now();
    this.db.tx(() => {
      this.fleet.upsertOperator({
        id: operatorId, name: r.company, certificate: r.certificate, status: 'active', source: 'direct',
        contact: { email: r.email, phone: r.phone, website: r.website },
      }, portalKey);
      for (const a of fleet) {
        let code = a.typeCode;
        if (!code) {
          const t = registerAircraftType({ code: typeCodeFor(a.model, null), name: a.model, category: a.category!, seats: a.seats });
          this.reference.saveAircraftType(t);
          code = t.code;
        }
        this.fleet.upsertAircraft({ tail: a.tail, operatorId, typeCode: code, seats: a.seats, homeBase: findAirport(a.homeBase)!.icao, year: a.year });
      }
      this.fleet.upsertSource({ id: `portal:${operatorId}`, name: `${r.company} portal`, kind: 'operator_portal', operatorId, adapter: 'native', trust: 0.9, ttlMs: 72 * HOUR });
      this.fleet.upsertSource({ id: `api:${operatorId}`, name: `${r.company} API`, kind: 'operator_api', operatorId, adapter: 'native', trust: 0.95, ttlMs: 24 * HOUR }, feedKey);
      this.db.run(`UPDATE operator_applications SET status = 'approved', operator_id = ?, decision_note = ?, decided_at = ? WHERE id = ?`, operatorId, opts.note ?? null, now, id);
      this.outbox.enqueue({
        dedupeKey: `opa:${id}:approved`, recipient: r.email, subject: `You're approved: ${r.company} can now list empty legs`,
        body: `Hi ${r.contact_name},\n\n${r.company} is approved with ${fleet.length} aircraft.\n\nOperator portal: ${this.portalUrl}\nYour portal key: ${portalKey}\n\nPost legs one at a time or upload a spreadsheet in the portal. To send legs automatically from your scheduling system, POST to /api/feeds/api:${operatorId} with feed key ${feedKey}.\n\nKeep these keys private. Reply to this email if you need them reset.`,
      }, now);
    });
    return { operatorId, portalKey, feedKey, aircraft: fleet.length };
  }

  reject(id: string, reason: string) {
    const r = this.row(id);
    if (r.status !== 'pending') throw new AppError(409, 'already_decided', `Application is already ${r.status}`);
    const now = this.clock.now();
    this.db.tx(() => {
      this.db.run(`UPDATE operator_applications SET status = 'rejected', decision_note = ?, decided_at = ? WHERE id = ?`, reason || null, now, id);
      this.outbox.enqueue({
        dedupeKey: `opa:${id}:rejected`, recipient: r.email, subject: 'About your operator application',
        body: `Hi ${r.contact_name},\n\nThank you for applying. We can't approve ${r.company} at this time${reason ? `: ${reason}` : '.'}\n\nReply to this email if anything has changed.`,
      }, now);
    });
    return this.view(this.row(id));
  }

  /** Normalizes and checks one aircraft; problems prefixed "note:" are informational only. */
  resolve(a: AircraftInput): ResolvedAircraft {
    const problems: string[] = [];
    const tail = normalizeTail(String(a?.tail ?? ''));
    const model = String(a?.model ?? '').trim().slice(0, 60);
    const seats = Math.floor(Number(a?.seats));
    const year = Math.floor(Number(a?.year));
    const base = findAirport(String(a?.homeBase ?? ''));
    if (!/^[A-Z0-9]{3,8}$/.test(tail)) problems.push('tail number looks wrong');
    if (!model) problems.push('aircraft model is required');
    const typeCode = model ? matchTypeHint(model) : null;
    const known = typeCode ? findAircraftType(typeCode) : undefined;
    const category = known?.category ?? (CATEGORIES.includes(a?.category as AircraftCategory) ? (a.category as AircraftCategory) : null);
    if (model && !known && !category) problems.push(`we don't recognise "${model}"; choose its category`);
    if (model && !known && category) problems.push(`note: "${model}" will be added as a new ${category} type`);
    if (!Number.isFinite(seats) || seats < 1 || seats > 30) problems.push('seats must be between 1 and 30');
    if (!Number.isFinite(year) || year < 1960 || year > new Date(this.clock.now()).getUTCFullYear() + 1) problems.push('year of manufacture looks wrong');
    if (!base) problems.push(`unknown home base airport "${a?.homeBase ?? ''}"; use the ICAO or IATA code`);
    return { tail, model, typeCode: known?.code ?? null, typeName: known?.name ?? null, category, seats, homeBase: base?.icao ?? String(a?.homeBase ?? ''), year, problems };
  }

  private row(id: string): Row {
    const r = this.db.get<Row>('SELECT * FROM operator_applications WHERE id = ?', id);
    if (!r) throw new AppError(404, 'not_found', 'Application not found');
    return r;
  }

  private view(r: Row) {
    return {
      id: r.id, company: r.company, certificate: r.certificate, certificateNumber: r.certificate_number, contactName: r.contact_name,
      email: r.email, phone: r.phone, website: r.website, fleet: JSON.parse(r.fleet) as ResolvedAircraft[], notes: r.notes, status: r.status,
      operatorId: r.operator_id, decisionNote: r.decision_note, createdAt: new Date(r.created_at).toISOString(),
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    };
  }
}
