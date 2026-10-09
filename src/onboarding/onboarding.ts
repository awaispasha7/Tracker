// Signing and managing operators who list with us directly.
//
//   FAA registry   the weekly FAA Part 135 list (certificate holders + aircraft on each
//                  certificate): who is legal to fly charter, and with which tails.
//   prospects      the sales pipeline built from it (and from operator applications): status,
//                  notes, contacts. Survives re-imports of the FAA list.
//   operators      onboarding a signed operator: account, portal key, feed key, verified fleet.

import type { Database } from '../db/database.ts';
import type { FleetRepo, ReferenceRepo } from '../db/repos.ts';
import type { Outbox } from '../alerts/outbox.ts';
import type { AircraftCategory, Clock, Operator } from '../domain/types.ts';
import { AppError, DAY, HOUR } from '../domain/types.ts';
import { newId, normalizeTail } from '../domain/ids.ts';
import { randomBytes } from 'node:crypto';
import { findAirport } from '../reference/airports.ts';
import { AIRCRAFT_TYPES, findAircraftType, matchTypeHint, registerAircraftType } from '../reference/aircraft-types.ts';
import { readCsv, readXlsx } from './xlsx.ts';

// ---------- FAA model strings → our categories ----------
// FAA models look like "CE-560XL", "BD-100-1A10", "CL-600-2B16", "G-IV", "LJ-45", "EMB-505".

const MODEL_RULES: Array<[RegExp, AircraftCategory | null]> = [
  // helicopters: not sold as empty legs here
  [/HELI|ROBINSON|SIKORSKY|AGUSTA|EUROCOPTER|^(AS|EC|BK|MBB|AW|S|R|A)-?\d{2,3}[A-Z]?\b|^BELL|^(206|407|412|429|430)\b/i, null],
  [/GLOBAL|BD-?700|GV-?SP|^G-?V\b|G-?(500|550|600|650|700|800)\b|GULFSTREAM V|FALCON ?(7X|8X|6X)|FA-?(7X|8X|6X)|BBJ|737|ACJ|A31[89]|LINEAGE/i, 'ultra-long'],
  [/CL-?600|CHALLENGER ?6\d\d|G-?IV|G-?(300|350|400|450)\b|FALCON ?(900|2000)|FA-?(900|2000)|DA-?(900|2000)|LEGACY ?6\d\d|EMB-?135/i, 'heavy'],
  [/BD-?100|CHALLENGER ?3\d\d|G-?(200|280)\b|IAI ?1126|CE-?680\b|LONGITUDE|CE-?700|CE-?750|CITATION ?X|FALCON ?50|FA-?50|EMB-?550|LEGACY ?500|PRAETOR ?600|HAWKER ?4000/i, 'super-midsize'],
  [/560XL|56X|XLS|EXCEL|CE-?680A|SOVEREIGN|LATITUDE|HAWKER ?(750|800|850|900)|HS-?125|BAE ?125|H25B|G-?(100|150)\b|ASTRA|1125|EMB-?545|LEGACY ?450|PRAETOR ?500|LJ-?60|LEARJET ?60/i, 'midsize'],
  [/CE-?5(00|01|10|25|50|51|60)|525|CJ\d?\b|MUSTANG|EMB-?50[05]|PHENOM|LJ-?\d\d|LEARJET|PC-?24|HONDAJET|HA-?420|PREMIER|390|EA-?500|ECLIPSE|SF-?50|VISION/i, 'light'],
  [/KING ?AIR|BE-?(9\w|1\d\d|2\d\d|3\d\d)\b|B-?(200|300|350)\b|^C-?90|PC-?12|TBM|PIAGGIO|P-?180|AVANTI|CONQUEST|MU-?2|CARAVAN|208/i, 'turboprop'],
  // piston singles and twins
  [/^(PA|C|BE|M20|SR|DA)-?\d{2,3}|PIPER|CIRRUS|BONANZA|BARON|SENECA|NAVAJO|CHIEFTAIN/i, null],
];

/** FAA type-certificate model designations for the curated types (FAA lists the certificate model, not the marketing name). */
const FAA_TYPE_MAP: Array<[RegExp, string]> = [
  [/^CE-?560XL/i, 'C56X'], [/^CE-?525B\b/i, 'C25B'], [/^CE-?680A/i, 'C68A'], [/^CE-?700/i, 'C700'],
  [/^EMB-?505/i, 'E55P'], [/^BD-?100-?1A10/i, 'CL35'], [/^CL-?600-?2B16/i, 'CL60'], [/^G-?IV/i, 'GLF4'],
  [/^GVI\b|^G-?VI\b/i, 'GLF6'], [/^BD-?700-?2A12/i, 'GL7T'], [/^(DA|FA)-?2000/i, 'F2TH'], [/^PC-?12/i, 'PC12'],
];

export function classifyModel(model: string): { category: AircraftCategory | null; suggestedType: string | null } {
  const m = model.trim();
  const suggestedType = FAA_TYPE_MAP.find(([re]) => re.test(m))?.[1] ?? matchTypeHint(m) ?? matchTypeHint(m.replace(/^[A-Z]{1,3}-/, ''));
  if (suggestedType) return { category: findAircraftType(suggestedType)?.category ?? null, suggestedType };
  for (const [re, cat] of MODEL_RULES) if (re.test(m)) return { category: cat, suggestedType: null };
  return { category: null, suggestedType: null };
}

// ---------- FAA import ----------

export interface FaaImportResult { operators: number; aircraft: number; jetOperators: number; skippedRows: number; columns: Record<string, string> }

const COLUMN_RULES: Array<[keyof Cols, RegExp]> = [
  ['designator', /designator|cert(ificate)?\s*(no|num|#|id)/i],
  ['name', /holder|operator.*name|company|^name$/i],
  ['office', /district|fsdo|office/i],
  ['tail', /registration|n-?\s?number|tail/i],
  ['serial', /serial/i],
  ['model', /model|make|type/i],
];
interface Cols { designator: number; name: number; office: number; tail: number; serial: number; model: number }

export function parseFaaRows(rows: string[][]): { records: Array<{ designator: string; name: string; office: string; tail: string; serial: string; model: string }>; columns: Record<string, string>; skipped: number } {
  const headerIdx = rows.findIndex((r) => r.some((c) => /designator/i.test(c)) && r.some((c) => /registration|n-?\s?number|tail/i.test(c)));
  if (headerIdx < 0) throw new AppError(400, 'bad_faa_file', 'Could not find the header row (expected columns like "Certificate Designator" and "Registration Number")');
  const header = rows[headerIdx];
  const cols: Partial<Cols> = {};
  const columns: Record<string, string> = {};
  for (const [key, re] of COLUMN_RULES) {
    const i = header.findIndex((h, idx) => re.test(h) && !Object.values(cols).includes(idx));
    if (i >= 0) {
      cols[key] = i;
      columns[key] = header[i];
    }
  }
  for (const k of ['designator', 'name', 'tail', 'model'] as const) {
    if (cols[k] === undefined) throw new AppError(400, 'bad_faa_file', `Missing a "${k}" column in the FAA file`);
  }
  const c = cols as Cols;
  const records = [];
  let skipped = 0;
  // Exports sometimes group rows: holder, designator and office only on the first aircraft row.
  let prev = { designator: '', name: '', office: '' };
  for (const r of rows.slice(headerIdx + 1)) {
    const own = (r[c.designator] ?? '').trim().toUpperCase();
    const designator = own || prev.designator;
    const name = (r[c.name] ?? '').trim() || (own ? '' : prev.name);
    const office = (c.office !== undefined ? (r[c.office] ?? '').trim() : '') || (own ? '' : prev.office);
    const rawTail = (r[c.tail] ?? '').trim().toUpperCase().replace(/\s+/g, '');
    if (own) prev = { designator, name, office };
    if (!designator || !rawTail) {
      skipped++;
      continue;
    }
    const tail = normalizeTail(rawTail.startsWith('N') ? rawTail : `N${rawTail}`);
    records.push({
      designator, tail, name, office,
      serial: c.serial !== undefined ? (r[c.serial] ?? '').trim() : '', model: (r[c.model] ?? '').trim(),
    });
  }
  return { records, columns, skipped };
}

// ---------- service ----------

export interface OperatorInput {
  name: string;
  certificate?: string;
  certificateNumber?: string;
  contactName?: string;
  email: string;
  phone?: string;
  website?: string;
}

export interface AircraftInput {
  tail: string;
  typeCode?: string;
  /** Create a type we don't know yet (performance figures default to the category). */
  newType?: { name: string; category: AircraftCategory };
  seats: number;
  homeBase: string;
  year?: number;
  /** Add even though the tail isn't on this operator's FAA certificate. */
  override?: boolean;
}

interface ProspectRow {
  id: string; designator: string | null; company: string; source: string; status: string; contact_name: string | null;
  contact_email: string | null; contact_phone: string | null; notes: string | null; application: string | null; operator_id: string | null;
  created_at: number; updated_at: number;
}

/**
 * Freshness for a signed operator's own channels. The feed API is expected to push the full list at
 * least daily. Portal listings are typed in once, often weeks ahead, so they stay sellable for a
 * week after the operator last confirmed them (one click, prompted by a weekly email); bookings are
 * confirmed by the operator before the card is charged, so a stale listing costs a decline, not a flight.
 */
export const DIRECT_SOURCES = {
  api: { trust: 0.95, ttlMs: 48 * HOUR, listingMaxAgeMs: 24 * HOUR },
  portal: { trust: 0.9, ttlMs: 10 * DAY, listingMaxAgeMs: 7 * DAY },
};
const RECONFIRM_AFTER_MS = 5 * DAY;

export const PROSPECT_STATUSES = ['new', 'contacted', 'interested', 'onboarding', 'signed', 'declined', 'applied'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class OnboardingService {
  private db: Database;
  private fleet: FleetRepo;
  private reference: ReferenceRepo;
  private outbox: Outbox;
  private clock: Clock;
  private opsEmail: string;

  constructor(deps: { db: Database; fleet: FleetRepo; reference: ReferenceRepo; outbox: Outbox; clock: Clock; opsEmail?: string }) {
    this.db = deps.db;
    this.fleet = deps.fleet;
    this.reference = deps.reference;
    this.outbox = deps.outbox;
    this.clock = deps.clock;
    this.opsEmail = deps.opsEmail ?? 'ops@emptylegtracker.example';
  }

  // ---------- FAA registry ----------

  importFaa(file: Buffer | string, filename = ''): FaaImportResult {
    const isXlsx = Buffer.isBuffer(file) && file.readUInt32LE(0) === 0x04034b50;
    const rows = isXlsx ? readXlsx(file as Buffer) : readCsv(Buffer.isBuffer(file) ? file.toString('utf8') : file);
    const { records, columns, skipped } = parseFaaRows(rows);
    if (!records.length) throw new AppError(400, 'bad_faa_file', `No aircraft rows found in ${filename || 'the file'}`);
    const byOp = new Map<string, { name: string; office: string; cats: Record<string, number>; total: number; jets: number }>();
    this.db.tx(() => {
      this.db.run('DELETE FROM faa_aircraft');
      this.db.run('DELETE FROM faa_operators');
      for (const r of records) {
        const { category, suggestedType } = classifyModel(r.model);
        this.db.run('INSERT OR REPLACE INTO faa_aircraft (tail, designator, serial, model, category, suggested_type) VALUES (?, ?, ?, ?, ?, ?)',
          r.tail, r.designator, r.serial || null, r.model, category, suggestedType);
        const op = byOp.get(r.designator) ?? { name: r.name, office: r.office, cats: {}, total: 0, jets: 0 };
        op.total++;
        if (category) op.cats[category] = (op.cats[category] ?? 0) + 1;
        if (category && category !== 'turboprop') op.jets++;
        byOp.set(r.designator, op);
      }
      for (const [designator, o] of byOp) {
        this.db.run('INSERT INTO faa_operators (designator, name, district_office, aircraft_count, jet_count, categories) VALUES (?, ?, ?, ?, ?, ?)',
          designator, o.name, o.office || null, o.total, o.jets, JSON.stringify(o.cats));
      }
    });
    return { operators: byOp.size, aircraft: records.length, jetOperators: [...byOp.values()].filter((o) => o.jets > 0).length, skippedRows: skipped, columns };
  }

  faaStats() {
    const ops = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM faa_operators')?.n ?? 0;
    const ac = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM faa_aircraft')?.n ?? 0;
    return { operators: ops, aircraft: ac, loaded: ops > 0 };
  }

  faaAircraftFor(designator: string) {
    return this.db.all<{ tail: string; serial: string | null; model: string; category: string | null; suggested_type: string | null }>(
      'SELECT tail, serial, model, category, suggested_type FROM faa_aircraft WHERE designator = ? ORDER BY category IS NULL, model', designator,
    );
  }

  faaTail(tail: string) {
    return this.db.get<{ tail: string; designator: string; model: string }>('SELECT tail, designator, model FROM faa_aircraft WHERE tail = ?', normalizeTail(tail));
  }

  // ---------- prospects ----------

  prospects(filter: { q?: string; category?: string; status?: string; minJets?: number; limit?: number } = {}) {
    const q = `%${(filter.q ?? '').trim().toLowerCase()}%`;
    const rows = this.db.all<{
      designator: string | null; name: string; district_office: string | null; aircraft_count: number | null; jet_count: number | null; categories: string | null;
      p_id: string | null; status: string | null; notes: string | null; contact_email: string | null; operator_id: string | null; source: string | null; updated_at: number | null;
    }>(
      `SELECT f.designator, f.name, f.district_office, f.aircraft_count, f.jet_count, f.categories,
              p.id AS p_id, p.status, p.notes, p.contact_email, p.operator_id, p.source, p.updated_at
         FROM faa_operators f LEFT JOIN prospects p ON p.designator = f.designator
        WHERE (LOWER(f.name) LIKE ? OR LOWER(f.designator) LIKE ? OR LOWER(COALESCE(f.district_office, '')) LIKE ?)
          AND f.jet_count >= ?
       UNION ALL
       SELECT p.designator, p.company, NULL, NULL, NULL, NULL, p.id, p.status, p.notes, p.contact_email, p.operator_id, p.source, p.updated_at
         FROM prospects p WHERE (p.designator IS NULL OR p.designator NOT IN (SELECT designator FROM faa_operators))
          AND LOWER(p.company) LIKE ?
        ORDER BY 5 DESC, 2 LIMIT ?`,
      q, q, q, filter.minJets ?? 0, q, filter.limit ?? 200,
    );
    return rows
      .map((r) => ({
        id: r.p_id ?? `faa:${r.designator}`, designator: r.designator, company: r.name, districtOffice: r.district_office,
        aircraftCount: r.aircraft_count, jetCount: r.jet_count, categories: r.categories ? JSON.parse(r.categories) as Record<string, number> : null,
        status: r.status ?? 'new', notes: r.notes, contactEmail: r.contact_email, operatorId: r.operator_id, source: r.source ?? 'faa',
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      }))
      .filter((p) => (!filter.status || p.status === filter.status) && (!filter.category || (p.categories?.[filter.category] ?? 0) > 0));
  }

  prospect(id: string) {
    const row = this.prospectRow(id);
    const designator = row?.designator ?? (id.startsWith('faa:') ? id.slice(4) : null);
    const faa = designator ? this.db.get<{ name: string; district_office: string | null }>('SELECT name, district_office FROM faa_operators WHERE designator = ?', designator) : undefined;
    if (!row && !faa) throw new AppError(404, 'prospect_not_found', 'Prospect not found');
    return {
      id: row?.id ?? id, designator, company: row?.company ?? faa!.name, districtOffice: faa?.district_office ?? null,
      status: row?.status ?? 'new', source: row?.source ?? 'faa', notes: row?.notes ?? null, faaVerified: !!faa,
      contact: { name: row?.contact_name ?? null, email: row?.contact_email ?? null, phone: row?.contact_phone ?? null },
      application: row?.application ? JSON.parse(row.application) : null, operatorId: row?.operator_id ?? null,
      aircraft: designator ? this.faaAircraftFor(designator).map((a) => ({ ...a, onOurPlatform: !!this.fleet.getAircraft(a.tail) })) : [],
    };
  }

  private prospectRow(id: string): ProspectRow | undefined {
    if (id.startsWith('faa:')) return this.db.get<ProspectRow>('SELECT * FROM prospects WHERE designator = ?', id.slice(4));
    return this.db.get<ProspectRow>('SELECT * FROM prospects WHERE id = ?', id);
  }

  /** Creates the pipeline record the first time a FAA operator is touched. */
  private ensureProspect(id: string): ProspectRow {
    const existing = this.prospectRow(id);
    if (existing) return existing;
    if (!id.startsWith('faa:')) throw new AppError(404, 'prospect_not_found', 'Prospect not found');
    const designator = id.slice(4);
    const faa = this.db.get<{ name: string }>('SELECT name FROM faa_operators WHERE designator = ?', designator);
    if (!faa) throw new AppError(404, 'prospect_not_found', 'Prospect not found');
    const now = this.clock.now();
    const newIdValue = newId('pr');
    this.db.run(`INSERT INTO prospects (id, designator, company, source, status, created_at, updated_at) VALUES (?, ?, ?, 'faa', 'new', ?, ?)`, newIdValue, designator, faa.name, now, now);
    return this.prospectRow(newIdValue)!;
  }

  updateProspect(id: string, patch: { status?: string; notes?: string; contactName?: string; contactEmail?: string; contactPhone?: string }) {
    if (patch.status && !(PROSPECT_STATUSES as readonly string[]).includes(patch.status)) throw new AppError(400, 'bad_status', `status must be one of ${PROSPECT_STATUSES.join(', ')}`);
    if (patch.contactEmail && !EMAIL_RE.test(patch.contactEmail)) throw new AppError(400, 'bad_email', 'Invalid email');
    const p = this.ensureProspect(id);
    this.db.run(
      'UPDATE prospects SET status = ?, notes = ?, contact_name = ?, contact_email = ?, contact_phone = ?, updated_at = ? WHERE id = ?',
      patch.status ?? p.status, patch.notes ?? p.notes, patch.contactName ?? p.contact_name, patch.contactEmail ?? p.contact_email,
      patch.contactPhone ?? p.contact_phone, this.clock.now(), p.id,
    );
    return this.prospect(p.id);
  }

  /** "List your empty legs" form on the operator page. */
  apply(input: { company: string; name: string; email: string; phone?: string; certificateNumber?: string; fleet?: string; message?: string; website?: string; honeypot?: string }) {
    if (input?.honeypot) return { ok: true }; // bots fill hidden fields
    if (!input?.company?.trim() || !input.name?.trim() || !EMAIL_RE.test(input.email ?? '')) {
      throw new AppError(400, 'bad_application', 'Company, your name and a valid email are required');
    }
    const now = this.clock.now();
    const designator = input.certificateNumber?.trim().toUpperCase() || null;
    const faa = designator ? this.db.get<{ name: string }>('SELECT name FROM faa_operators WHERE designator = ?', designator) : undefined;
    const application = { ...input, honeypot: undefined, submittedAt: new Date(now).toISOString(), faaMatch: faa ? faa.name : null };
    const existing = designator ? this.db.get<ProspectRow>('SELECT * FROM prospects WHERE designator = ?', designator) : undefined;
    let id: string;
    if (existing) {
      id = existing.id;
      this.db.run(`UPDATE prospects SET status = CASE WHEN status IN ('signed','onboarding') THEN status ELSE 'applied' END, application = ?,
        contact_name = ?, contact_email = ?, contact_phone = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(application), input.name.trim(), input.email.trim().toLowerCase(), input.phone?.trim() || null, now, id);
    } else {
      id = newId('pr');
      this.db.run(`INSERT INTO prospects (id, designator, company, source, status, contact_name, contact_email, contact_phone, application, created_at, updated_at)
        VALUES (?, ?, ?, 'application', 'applied', ?, ?, ?, ?, ?, ?)`,
      id, designator, input.company.trim(), input.name.trim(), input.email.trim().toLowerCase(), input.phone?.trim() || null, JSON.stringify(application), now, now);
    }
    this.outbox.enqueue({
      dedupeKey: `application:${id}:${now}`, recipient: this.opsEmail,
      subject: `Operator application: ${input.company.trim()}${faa ? ' (FAA Part 135 verified)' : designator ? ' (certificate not found in FAA list)' : ''}`,
      body: `${input.name} <${input.email}> ${input.phone ?? ''}\nCertificate: ${designator ?? '—'}\nFleet: ${input.fleet ?? '—'}\n\n${input.message ?? ''}`,
    }, now);
    this.outbox.enqueue({
      dedupeKey: `application-ack:${id}:${now}`, recipient: input.email.trim().toLowerCase(),
      subject: 'Thanks for applying to list your empty legs',
      body: 'We received your application and will be in touch within one business day to set up your operator account.',
    }, now);
    return { ok: true, faaVerified: !!faa };
  }

  // ---------- operators ----------

  listOperators() {
    return this.fleet.listOperators().filter((o) => (o.source ?? 'direct') === 'direct').map((o) => {
      const fleet = this.fleet.listAircraft(o.id);
      const live = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM legs WHERE operator_id = ? AND supply_status = 'available' AND depart_latest > ?", o.id, this.clock.now())?.n ?? 0;
      const bookings = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookings WHERE operator_id = ? AND status IN ('confirmed', 'completed')", o.id)?.n ?? 0;
      return { ...o, fleetSize: fleet.length, liveLegs: live, confirmedBookings: bookings };
    });
  }

  operatorDetail(id: string) {
    const op = this.fleet.getOperator(id);
    if (!op || (op.source ?? 'direct') !== 'direct') throw new AppError(404, 'operator_not_found', 'Operator not found');
    const designator = op.contact?.certificateNumber ?? null;
    const faaTails = new Set(designator ? this.faaAircraftFor(designator).map((a) => a.tail) : []);
    const faaLoaded = this.faaStats().loaded;
    return {
      ...op,
      faa: designator && faaLoaded ? {
        designator, found: !!this.db.get('SELECT 1 FROM faa_operators WHERE designator = ?', designator), tailsOnCertificate: faaTails.size,
        aircraft: this.faaAircraftFor(designator).map((a) => ({ ...a, onOurPlatform: this.fleet.getAircraft(a.tail)?.operatorId === id })),
      } : null,
      fleet: this.fleet.listAircraft(id).map((a) => ({
        ...a, typeName: findAircraftType(a.typeCode)?.name ?? a.typeCode,
        onCertificate: faaLoaded && designator ? faaTails.has(a.tail) : null,
      })),
    };
  }

  /** Creates the operator, its portal key and its feed key. Keys are returned once and only stored hashed. */
  createOperator(input: OperatorInput, prospectId?: string) {
    if (!input?.name?.trim()) throw new AppError(400, 'bad_operator', 'Operator name is required');
    if (!EMAIL_RE.test(input.email ?? '')) throw new AppError(400, 'bad_operator', 'A valid contact email is required');
    const base = 'op_' + input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    let id = base;
    for (let n = 2; this.fleet.getOperator(id); n++) id = `${base}_${n}`;
    const certificateNumber = input.certificateNumber?.trim().toUpperCase() || null;
    if (certificateNumber && this.faaStats().loaded && !this.db.get('SELECT 1 FROM faa_operators WHERE designator = ?', certificateNumber)) {
      throw new AppError(409, 'certificate_not_found', `Certificate ${certificateNumber} is not in the imported FAA Part 135 list. Check the designator, or leave it blank for a non-US operator.`);
    }
    const op: Operator = {
      id, name: input.name.trim(), certificate: input.certificate?.trim() || (certificateNumber ? 'FAA Part 135' : 'Air operator certificate'),
      status: 'active', source: 'direct', externalId: null,
      contact: { certificateNumber, contactName: input.contactName?.trim() || null, email: input.email.trim().toLowerCase(), phone: input.phone?.trim() || null, website: input.website?.trim() || null },
    };
    const portalKey = `opk_${randomBytes(18).toString('base64url')}`;
    const feedKey = `fdk_${randomBytes(18).toString('base64url')}`;
    this.db.tx(() => {
      this.fleet.upsertOperator(op, portalKey);
      this.fleet.upsertSource({ id: `api:${id}`, name: `${op.name} API`, kind: 'operator_api', operatorId: id, adapter: 'native', ...DIRECT_SOURCES.api }, feedKey);
      this.fleet.upsertSource({ id: `portal:${id}`, name: `${op.name} portal`, kind: 'operator_portal', operatorId: id, adapter: 'native', ...DIRECT_SOURCES.portal });
      if (prospectId) {
        const p = this.ensureProspect(prospectId);
        this.db.run("UPDATE prospects SET status = 'signed', operator_id = ?, updated_at = ? WHERE id = ?", id, this.clock.now(), p.id);
      }
    });
    return { operator: this.operatorDetail(id), keys: { portalKey, feedKey, feedSourceId: `api:${id}` } };
  }

  updateOperator(id: string, patch: Partial<OperatorInput> & { status?: 'active' | 'suspended' }) {
    const op = this.operatorDetail(id);
    if (patch.status && !['active', 'suspended'].includes(patch.status)) throw new AppError(400, 'bad_status', 'status must be active or suspended');
    if (patch.email !== undefined && !EMAIL_RE.test(patch.email)) throw new AppError(400, 'bad_operator', 'Invalid email');
    this.fleet.upsertOperator({
      id, name: patch.name?.trim() || op.name, certificate: patch.certificate?.trim() || op.certificate, status: patch.status ?? op.status, source: 'direct',
      externalId: null,
      contact: {
        ...op.contact,
        ...(patch.certificateNumber !== undefined ? { certificateNumber: patch.certificateNumber.trim().toUpperCase() || null } : {}),
        ...(patch.contactName !== undefined ? { contactName: patch.contactName } : {}),
        ...(patch.email !== undefined ? { email: patch.email.trim().toLowerCase() } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.website !== undefined ? { website: patch.website } : {}),
      },
    });
    return this.operatorDetail(id);
  }

  rotateKey(id: string, which: 'portal' | 'feed'): { key: string } {
    const op = this.operatorDetail(id);
    if (which === 'portal') {
      const key = `opk_${randomBytes(18).toString('base64url')}`;
      this.db.run('UPDATE operators SET api_key_hash = NULL WHERE id = ?', id);
      this.fleet.upsertOperator(op, key);
      return { key };
    }
    if (which === 'feed') {
      const key = `fdk_${randomBytes(18).toString('base64url')}`;
      const src = this.fleet.getSource(`api:${id}`)!;
      this.db.run('UPDATE feed_sources SET api_key_hash = NULL WHERE id = ?', src.id);
      this.fleet.upsertSource(src, key);
      return { key };
    }
    throw new AppError(400, 'bad_key', 'which must be portal or feed');
  }

  addAircraft(operatorId: string, a: AircraftInput) {
    const op = this.operatorDetail(operatorId);
    const tail = normalizeTail(a?.tail ?? '');
    if (tail.length < 3) throw new AppError(400, 'bad_tail', 'Registration is required');
    const owner = this.fleet.getAircraft(tail);
    if (owner && owner.operatorId !== operatorId && (owner.source ?? 'direct') === 'direct') {
      throw new AppError(409, 'tail_taken', `${tail} is already registered to another operator`);
    }
    const designator = op.contact?.certificateNumber;
    const warnings: string[] = [];
    if (this.faaStats().loaded && /^N/.test(tail)) {
      const faa = this.faaTail(tail);
      if (!faa) warnings.push(`${tail} is not on any FAA Part 135 certificate`);
      else if (designator && faa.designator !== designator) warnings.push(`${tail} is on certificate ${faa.designator}, not ${designator}`);
      else if (!designator) warnings.push(`${tail} is on certificate ${faa.designator}; set the operator's certificate number to verify`);
      // Not added: only aircraft on the operator's certificate may fly charter. Ops can override once verified.
      if (warnings.length && !a.override) return { added: false, operator: op, warnings };
    }
    let typeCode = a.typeCode && findAircraftType(a.typeCode) ? a.typeCode : null;
    if (!typeCode && a.newType?.name && a.newType.category) {
      const t = registerAircraftType({ code: 'X-' + a.newType.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24), name: a.newType.name.trim(), category: a.newType.category });
      this.reference.saveAircraftType(t);
      typeCode = t.code;
    }
    if (!typeCode) throw new AppError(400, 'bad_type', 'Choose an aircraft type (or add a new one with its category)');
    const base = findAirport(a.homeBase);
    if (!base) throw new AppError(400, 'bad_base', `Unknown home base airport ${a.homeBase}`);
    const seats = Math.floor(Number(a.seats));
    if (!(seats >= 1 && seats <= 30)) throw new AppError(400, 'bad_seats', 'Seats must be between 1 and 30');
    this.fleet.upsertAircraft({ tail, operatorId, typeCode, seats, homeBase: base.icao, year: Number(a.year) || 0, source: 'direct', externalId: null, images: owner?.images ?? [], amenities: owner?.amenities ?? {} });
    return { added: true, operator: this.operatorDetail(operatorId), warnings };
  }

  removeAircraft(operatorId: string, tail: string) {
    this.operatorDetail(operatorId);
    const t = normalizeTail(tail);
    const live = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM legs WHERE tail = ? AND commerce_status != 'open' AND depart_latest > ?", t, this.clock.now())?.n ?? 0;
    if (live) throw new AppError(409, 'aircraft_booked', `${t} has an active booking; resolve it first`);
    this.db.run('DELETE FROM aircraft WHERE tail = ? AND operator_id = ?', t, operatorId);
    return this.operatorDetail(operatorId);
  }

  /**
   * Weekly nudge to operators whose portal listings haven't been confirmed for 5 days (they leave
   * search at 7). One email per operator per week.
   */
  reconfirmReminders(baseUrl = ''): number {
    const now = this.clock.now();
    const rows = this.db.all<{ operator_id: string; n: number; oldest: number }>(
      `SELECT l.operator_id, COUNT(*) AS n, MIN(l.last_seen_at) AS oldest FROM legs l JOIN operators o ON o.id = l.operator_id
        WHERE o.status = 'active' AND COALESCE(o.source, 'direct') = 'direct' AND l.supply_status = 'available'
          AND l.depart_latest > ? AND l.last_seen_at < ? GROUP BY l.operator_id`,
      now, now - RECONFIRM_AFTER_MS,
    );
    let sent = 0;
    const week = Math.floor(now / (7 * DAY));
    for (const r of rows) {
      const op = this.fleet.getOperator(r.operator_id);
      if (!op?.contact?.email) continue;
      const days = Math.max(0, Math.round((r.oldest + DIRECT_SOURCES.portal.listingMaxAgeMs - now) / DAY));
      if (this.outbox.enqueue({
        dedupeKey: `reconfirm:${op.id}:${week}`, recipient: op.contact.email,
        subject: `Are your ${r.n} empty leg${r.n === 1 ? '' : 's'} still available?`,
        body: `Hi ${op.contact.contactName ?? op.name},\n\n${r.n} of your listed empty legs haven't been confirmed for a few days. They leave search in ${days} day${days === 1 ? '' : 's'} unless you confirm them.\n\nSign in to ${baseUrl}/operator → Empty legs → "All still available" (one click), or withdraw any that have gone.`,
      }, now)) sent++;
    }
    return sent;
  }

  /** Types offered in the console's dropdown: curated first, then learned. */
  aircraftTypes() {
    return AIRCRAFT_TYPES.map((t) => ({ code: t.code, name: t.name, category: t.category, seats: t.seats, curated: t.source !== 'feed' }))
      .sort((a, b) => Number(b.curated) - Number(a.curated) || a.name.localeCompare(b.name));
  }
}
