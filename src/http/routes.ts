import { timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { App } from '../app.ts';
import { Router, type Ctx } from './router.ts';
import { AppError, CATEGORIES, DAY, type AircraftCategory, type Leg, type Operator } from '../domain/types.ts';
import { searchAirports, getAirport } from '../reference/airports.ts';
import { getAircraftType } from '../reference/aircraft-types.ts';
import { AGREEMENT_HASH, AGREEMENT_TEXT, AGREEMENT_VERSION } from '../booking/agreement.ts';
import { isListable } from '../inventory/search.ts';
import { runContractCheck } from '../integrations/aviapages/contract-check.ts';

export function buildRouter(app: App, opts: { adminKey: string; inboundToken?: string }): Router {
  const r = new Router();
  const now = () => app.clock.now();

  // ---------- auth ----------
  const requireOperator = (ctx: Ctx): Operator => {
    const op = ctx.bearer ? app.fleet.operatorByApiKey(ctx.bearer) : undefined;
    if (!op) throw new AppError(401, 'unauthorized', 'Valid operator API key required');
    if (op.status !== 'active') throw new AppError(403, 'operator_suspended', 'Operator account is suspended');
    return op;
  };
  const requireAdmin = (ctx: Ctx): void => {
    const a = Buffer.from(ctx.bearer ?? '');
    const b = Buffer.from(opts.adminKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, 'unauthorized', 'Admin key required');
  };
  const num = (v: string | null): number | undefined => (v === null || v === '' ? undefined : Number(v));
  const legView = (leg: Leg) => ({
    id: leg.id, version: leg.version, tail: leg.tail, operatorId: leg.operatorId,
    aircraft: leg.typeCode ? { code: leg.typeCode, name: getAircraftType(leg.typeCode).name, category: getAircraftType(leg.typeCode).category } : null,
    from: getAirport(leg.fromIcao), to: getAirport(leg.toIcao),
    departEarliest: new Date(leg.departEarliest).toISOString(), departLatest: new Date(leg.departLatest).toISOString(),
    supplyStatus: leg.supplyStatus, commerceStatus: leg.commerceStatus, confidence: leg.confidence,
    lastSeenAt: new Date(leg.lastSeenAt).toISOString(),
  });

  // ---------- public: discovery ----------
  r.on('GET', '/api/health', () => ({ ok: true, time: new Date(now()).toISOString(), index: app.search.stats() }));

  r.on('GET', '/api/airports', ({ query }) => searchAirports(query.get('q') ?? ''));

  r.on('GET', '/api/search', ({ query }) => {
    const cats = (query.get('category') ?? '').split(',').filter(Boolean) as AircraftCategory[];
    if (cats.some((c) => !CATEGORIES.includes(c))) throw new AppError(400, 'bad_category', `category must be one of ${CATEGORIES.join(', ')}`);
    const maxPrice = num(query.get('maxPrice'));
    const sort = query.get('sort') ?? 'best';
    if (!['best', 'price', 'departure'].includes(sort)) throw new AppError(400, 'bad_sort', 'sort must be best|price|departure');
    return app.search.search({
      from: query.get('from') ?? '',
      to: query.get('to') || null,
      date: query.get('date') || null,
      flexDays: num(query.get('flex')),
      pax: num(query.get('pax')),
      categories: cats,
      maxPriceCents: maxPrice ? Math.round(maxPrice * 100) : null,
      radiusNm: num(query.get('radius')),
      sort: sort as 'best' | 'price' | 'departure',
      limit: num(query.get('limit')),
    }, now());
  });

  /** Spends calculator calls only when a traveler shows intent; bounded so a slow provider never stalls the page. */
  const warm = async (legId: string, pax: number) => {
    const leg = app.legs.get(legId);
    if (!leg?.typeCode) return;
    await Promise.race([
      app.calculators.warm(leg.fromIcao, leg.toIcao, leg.typeCode, { tail: leg.tail, pax }),
      new Promise((r) => setTimeout(r, 4000).unref()),
    ]);
  };

  r.on('GET', '/api/legs/:id', async ({ params, query }) => {
    const pax = Math.max(1, num(query.get('pax')) ?? 1);
    if (app.legs.get(params.id)) await warm(params.id, pax);
    const leg = app.legs.get(params.id);
    if (!leg || !leg.operatorId) throw new AppError(404, 'leg_not_found', 'Flight not found');
    const aircraft = app.fleet.getAircraft(leg.tail);
    const operator = app.fleet.getOperator(leg.operatorId);
    const price = app.pricing.price({ leg, pax, seats: aircraft?.seats ?? 0, now: now() });
    const sellable = leg.visibility === 'private'
      ? leg.supplyStatus === 'available' && leg.commerceStatus === 'open'
      : isListable(leg, app.pricing.config.minConfidence);
    const bookable = price.ok && sellable;
    const insight = leg.typeCode ? app.calculators.flight(leg.fromIcao, leg.toIcao, leg.typeCode) : undefined;
    return {
      leg: { ...legView(leg), note: leg.note ?? null, kind: leg.kind ?? 'empty_leg' },
      aircraft: aircraft && { seats: aircraft.seats, year: aircraft.year, homeBase: aircraft.homeBase, images: aircraft.images ?? [], amenities: aircraft.amenities ?? {} },
      operator: operator && {
        id: operator.id, name: operator.name, certificate: operator.certificate, source: operator.source ?? 'direct',
        responseRate: operator.contact?.responseRate ?? null, confirmation: operator.source === 'aviapages' ? 'on_request' : 'portal',
      },
      flight: price.flight && { ...price.flight, fuelKg: insight?.fuelKg ?? null, minutes: insight?.minutes ?? null },
      bookable,
      price: bookable
        ? { totalCents: price.totalCents, currency: price.currency, lines: price.lines, savingsPct: price.savingsPct, fullCharterEstimateCents: price.fullCharterEstimateCents, fullCharterSource: price.fullCharterSource, flight: price.flight }
        : null,
      // Travelers see that it isn't bookable, not our internal guardrail detail.
      unavailableReason: bookable ? null : leg.commerceStatus !== 'open' ? 'reserved' : 'unavailable',
    };
  });

  r.on('GET', '/api/agreement', () => ({ version: AGREEMENT_VERSION, hash: AGREEMENT_HASH, text: AGREEMENT_TEXT }));

  // ---------- public: booking ----------
  r.on('POST', '/api/quotes', async ({ body }) => {
    const b = body as { legId?: string; pax?: number };
    if (!b?.legId) throw new AppError(400, 'bad_request', 'legId is required');
    const pax = Math.max(1, Math.floor(Number(b.pax ?? 1)));
    await warm(b.legId, pax);
    return app.bookings.createQuote(b.legId, pax);
  });

  r.on('POST', '/api/bookings', async ({ body, req, res }) => {
    const key = String(req.headers['idempotency-key'] ?? '');
    const input = body as Parameters<App['bookings']['createBooking']>[0];
    const booking = await app.bookings.createBooking(
      { ...input, meta: { ip: req.socket.remoteAddress, userAgent: String(req.headers['user-agent'] ?? '') } }, key,
    );
    res.statusCode = 201;
    return booking;
  });

  r.on('GET', '/api/bookings/:id', ({ params, query }) => ({
    ...app.bookings.viewForCustomer(params.id, query.get('email') ?? ''),
    operatorUpdates: app.comms.travelerTimeline(params.id),
  }));

  r.on('POST', '/api/bookings/:id/cancel', ({ params, body }) =>
    app.bookings.customerCancel(params.id, String((body as { email?: string })?.email ?? '')));

  r.on('GET', '/api/config', () => ({
    aviapages: app.aviapages ? { enabled: true, mode: app.aviapages.mode } : { enabled: false, mode: 'off' },
    charterQuotes: app.charters.enabled,
    skyaccess: app.skyaccess ? { enabled: true, mode: app.skyaccess.mode } : { enabled: false, mode: 'off' },
  }));

  // ---------- public: SkyAccess partner flights (booked on SkyAccess, not through us) ----------
  const skyaccess = () => {
    if (!app.skyaccess) throw new AppError(404, 'partner_disabled', 'SkyAccess partner flights are not enabled');
    return app.skyaccess;
  };
  const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

  r.on('GET', '/api/partners/skyaccess/search', async ({ query }) => {
    const date = query.get('date');
    const flex = Math.max(0, Math.min(14, num(query.get('flex')) ?? 0));
    const day = date ? Date.parse(date) : NaN;
    if (date && Number.isNaN(day)) throw new AppError(400, 'bad_date', 'date must be YYYY-MM-DD');
    const maxPrice = num(query.get('maxPrice'));
    return skyaccess().search({
      origin: query.get('from') || undefined,
      destination: query.get('to') || undefined,
      dateFrom: date ? isoDay(Math.max(now(), day - flex * DAY)) : undefined,
      dateTo: date ? isoDay(day + flex * DAY) : undefined,
      passengers: num(query.get('pax')),
      maxPriceUsd: maxPrice && maxPrice > 0 ? maxPrice : undefined,
    });
  });

  r.on('GET', '/api/partners/skyaccess/flights/:id', async ({ params }) => {
    const flight = await skyaccess().flight(params.id);
    if (!flight) throw new AppError(404, 'flight_not_found', 'This SkyAccess flight is no longer available');
    return flight;
  });

  r.on('GET', '/api/partners/skyaccess/estimate', ({ query }) => skyaccess().estimate({
    origin: query.get('from') ?? '', destination: query.get('to') ?? '', passengers: num(query.get('pax')), category: query.get('category') ?? undefined,
  }));

  /** Sends the traveler's enquiry to a SkyAccess specialist. No payment, no booking. */
  r.on('POST', '/api/partners/skyaccess/booking-requests', async ({ body, res }) => {
    const out = await skyaccess().requestBooking(body as Parameters<NonNullable<App['skyaccess']>['requestBooking']>[0]);
    res.statusCode = 201;
    return out;
  });

  // ---------- public: custom charter requests ----------
  r.on('POST', '/api/charter-requests', async ({ body, res }) => {
    const out = await app.charters.create(body as Parameters<App['charters']['create']>[0]);
    res.statusCode = 201;
    return out;
  });
  r.on('GET', '/api/charter-requests/:id', ({ params, query }) => app.charters.view(params.id, query.get('email') ?? ''));
  r.on('POST', '/api/charter-requests/:id/send', ({ params, body }) => {
    const b = body as { email?: string; aircraftIds?: number[] };
    return app.charters.send(params.id, String(b?.email ?? ''), Array.isArray(b?.aircraftIds) ? b.aircraftIds.map(Number) : []);
  });

  // ---------- inbound email webhook (map your provider's payload to {from, to, subject, text, messageId}) ----------
  r.on('POST', '/api/inbound/email', ({ query, body }) => {
    const a = Buffer.from(query.get('token') ?? '');
    const b = Buffer.from(opts.inboundToken ?? "");
    if (!opts.inboundToken || a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, 'unauthorized', 'Bad inbound token');
    const m = body as { from?: string; to?: string; subject?: string; text?: string; messageId?: string };
    if (!m?.from || typeof m.text !== 'string') throw new AppError(400, 'bad_request', 'from and text are required');
    return app.comms.inboundEmail({ from: m.from, to: m.to, subject: m.subject, text: m.text, messageId: m.messageId });
  });

  // ---------- public: alerts ----------
  r.on('POST', '/api/alerts', ({ body }) => {
    const b = body as { email: string; from: string; to?: string; radiusNm?: number; pax?: number; maxPrice?: number; dateFrom?: string; dateTo?: string };
    return app.alerts.create({ ...b, maxPriceCents: b?.maxPrice ? Math.round(b.maxPrice * 100) : null });
  });
  r.on('GET', '/api/alerts', ({ query }) => app.alerts.list(query.get('email') ?? ''));
  r.on('DELETE', '/api/alerts/:id', ({ params, query }) => {
    app.alerts.deactivate(params.id, query.get('email') ?? '');
    return { ok: true };
  });

  // ---------- live updates (server-sent events) ----------
  const clients = new Set<ServerResponse>();
  let pending: NodeJS.Timeout | null = null;
  app.search.onInvalidate(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const msg = `event: inventory\ndata: ${JSON.stringify({ at: new Date(now()).toISOString() })}\n\n`;
      for (const c of clients) c.write(msg);
    }, 1000);
    pending.unref();
  });
  r.on('GET', '/api/stream', ({ req, res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  // ---------- feeds: machine-to-machine ingestion ----------
  r.on('POST', '/api/feeds/:sourceId', async ({ params, bearer, body, req }) => {
    const source = bearer ? app.fleet.sourceByApiKey(bearer) : undefined;
    if (!source || source.id !== params.sourceId) throw new AppError(401, 'unauthorized', 'Valid feed key for this source required');
    const isCsv = String(req.headers['content-type'] ?? '').includes('text/csv');
    return app.ingest.ingest(source.id, body, isCsv ? 'csv' : undefined);
  });

  // ---------- operator portal ----------
  r.on('GET', '/api/operator/me', (ctx) => {
    const op = requireOperator(ctx);
    return { operator: op, fleet: app.fleet.listAircraft(op.id).map((a) => ({ ...a, typeName: getAircraftType(a.typeCode).name })) };
  });

  r.on('GET', '/api/operator/legs', (ctx) => {
    const op = requireOperator(ctx);
    const t = now();
    return app.legs.listByOperator(op.id, t).map((leg) => {
      const seats = app.fleet.getAircraft(leg.tail)?.seats ?? 0;
      const p = app.pricing.price({ leg, pax: 1, seats, now: t });
      return {
        ...legView(leg),
        askCents: leg.askCents, currency: leg.currency,
        listed: p.ok && isListable(leg, app.pricing.config.minConfidence),
        travelerPriceCents: p.ok ? p.totalCents : null,
        payoutCents: p.ok ? p.operatorPayoutCents : null,
        issues: [...leg.conflicts.map((c) => ({ code: c.code, blocking: c.blocking, detail: c.detail })),
          ...p.failures.map((f) => ({ code: f.code, blocking: true, detail: f.message }))],
        provenance: leg.provenance,
      };
    });
  });

  r.on('POST', '/api/operator/legs', async (ctx) => {
    const op = requireOperator(ctx);
    const isCsv = String(ctx.req.headers['content-type'] ?? '').includes('text/csv');
    return app.ingest.ingest(`portal:${op.id}`, ctx.body, isCsv ? 'csv' : undefined);
  });

  r.on('POST', '/api/operator/legs/:id/withdraw', async (ctx) => {
    const op = requireOperator(ctx);
    return legView(await app.ingest.operatorWithdraw(op.id, ctx.params.id));
  });

  r.on('GET', '/api/operator/threads', (ctx) => app.comms.list({ operatorId: requireOperator(ctx).id }));
  r.on('GET', '/api/operator/threads/:id', (ctx) => {
    const op = requireOperator(ctx);
    const t = app.comms.thread(ctx.params.id);
    if (t.operator_id !== op.id) throw new AppError(404, 'thread_not_found', 'Conversation not found');
    const view = app.comms.threadView(t);
    // Operators see the conversation, not our internal notes.
    return { ...view, messages: view.messages!.filter((m) => m.direction !== 'internal') };
  });
  r.on('POST', '/api/operator/threads/:id/reply', (ctx) => {
    app.comms.portalReply(requireOperator(ctx).id, ctx.params.id, String((ctx.body as { body?: string })?.body ?? ''));
    return { ok: true };
  });

  r.on('GET', '/api/operator/bookings', (ctx) => app.bookings.listForOperator(requireOperator(ctx).id));
  r.on('POST', '/api/operator/bookings/:id/confirm', (ctx) => app.bookings.operatorConfirm(ctx.params.id, requireOperator(ctx).id));
  r.on('POST', '/api/operator/bookings/:id/decline', (ctx) =>
    app.bookings.operatorDecline(ctx.params.id, requireOperator(ctx).id, String((ctx.body as { reason?: string })?.reason ?? '')));

  // ---------- admin / operations ----------
  r.on('GET', '/api/admin/review', (ctx) => {
    requireAdmin(ctx);
    const t = now();
    const out = [];
    for (const leg of app.legs.listActive(t)) {
      const seats = app.fleet.getAircraft(leg.tail)?.seats ?? 0;
      const p = app.pricing.price({ leg, pax: 1, seats, now: t });
      const blocking = leg.conflicts.filter((c) => c.blocking);
      const advisory = leg.conflicts.filter((c) => !c.blocking);
      if (p.ok && blocking.length === 0 && advisory.length === 0) continue;
      out.push({
        leg: legView(leg),
        operator: leg.operatorId ? app.fleet.getOperator(leg.operatorId)?.name ?? null : null,
        listed: p.ok && isListable(leg, app.pricing.config.minConfidence),
        conflicts: leg.conflicts,
        priceFailures: p.failures,
        candidatePriceCents: p.totalCents || null,
        lastPublishedPriceCents: leg.lastPublishedPriceCents,
        provenance: leg.provenance,
      });
    }
    return out.sort((a, b) => Number(a.listed) - Number(b.listed));
  });

  r.on('POST', '/api/admin/legs/:id/approve-price', (ctx) => {
    requireAdmin(ctx);
    const leg = app.legs.get(ctx.params.id);
    if (!leg) throw new AppError(404, 'leg_not_found', 'Leg not found');
    const p = app.pricing.price({ leg: { ...leg, lastPublishedPriceCents: null }, pax: 1, seats: app.fleet.getAircraft(leg.tail)?.seats ?? 0, now: now() });
    if (!p.ok) throw new AppError(409, 'still_blocked', 'Other guardrails still fail', p.failures);
    app.legs.setLastPublishedPrice(leg.id, p.totalCents);
    app.search.invalidate();
    return { approvedPriceCents: p.totalCents };
  });

  r.on('GET', '/api/admin/ingest-errors', (ctx) => {
    requireAdmin(ctx);
    return app.legs.recentIngestErrors(100);
  });
  r.on('GET', '/api/admin/skyaccess', async (ctx) => {
    requireAdmin(ctx);
    if (!app.skyaccess) return { enabled: false, mode: 'off' };
    const tools = await app.skyaccess.client.listTools(true).then(
      (t) => t.map((x) => ({ name: x.name, readOnly: x.annotations?.readOnlyHint ?? null, input: Object.keys(x.inputSchema?.properties ?? {}) })),
      (e: Error) => ({ error: e.message }),
    );
    return { enabled: true, mode: app.skyaccess.mode, endpoint: app.skyaccess.client.config.endpoint, tools, requests: app.skyaccess.recentRequests() };
  });

  r.on('GET', '/api/admin/sources', (ctx) => {
    requireAdmin(ctx);
    return app.fleet.listSources();
  });
  r.on('GET', '/api/admin/notifications', (ctx) => {
    requireAdmin(ctx);
    return app.outbox.list(ctx.query.get('recipient') ?? undefined);
  });
  r.on('GET', '/api/admin/ledger', (ctx) => {
    requireAdmin(ctx);
    return app.bookings.ledger(ctx.query.get('booking') ?? undefined);
  });
  // bookings across all operators; ops confirm/decline on behalf of network operators
  r.on('GET', '/api/admin/bookings', (ctx) => {
    requireAdmin(ctx);
    return app.bookings.listAll(ctx.query.get('status') ?? undefined).map((b) => {
      const op = app.fleet.getOperator(b.operatorId);
      const t = app.comms.threadForBooking(b.id);
      return { ...b, operator: op ? { id: op.id, name: op.name, source: op.source ?? 'direct' } : null, threadId: t?.id ?? null, threadStatus: t?.status ?? null };
    });
  });
  r.on('POST', '/api/admin/bookings/:id/confirm', async (ctx) => {
    requireAdmin(ctx);
    const v = await app.bookings.operatorConfirm(ctx.params.id, app.bookings.operatorOf(ctx.params.id));
    await app.comms.afterDecision(ctx.params.id, 'confirmed');
    return v;
  });
  r.on('POST', '/api/admin/bookings/:id/decline', async (ctx) => {
    requireAdmin(ctx);
    const reason = String((ctx.body as { reason?: string })?.reason ?? 'declined by ops');
    const v = await app.bookings.operatorDecline(ctx.params.id, app.bookings.operatorOf(ctx.params.id), reason);
    await app.comms.afterDecision(ctx.params.id, 'declined');
    return v;
  });

  // operator conversations
  r.on('GET', '/api/admin/threads', (ctx) => {
    requireAdmin(ctx);
    return app.comms.list({ attention: ctx.query.get('attention') === '1', status: ctx.query.get('status') ?? undefined });
  });
  r.on('GET', '/api/admin/threads/:id', (ctx) => {
    requireAdmin(ctx);
    return app.comms.threadView(app.comms.thread(ctx.params.id));
  });
  r.on('POST', '/api/admin/threads/:id/messages', (ctx) => {
    requireAdmin(ctx);
    app.comms.send(ctx.params.id, String((ctx.body as { body?: string })?.body ?? ''));
    return app.comms.threadView(app.comms.thread(ctx.params.id));
  });
  r.on('POST', '/api/admin/threads/:id/retry', async (ctx) => {
    requireAdmin(ctx);
    await app.comms.retry(ctx.params.id);
    return app.comms.threadView(app.comms.thread(ctx.params.id));
  });
  r.on('POST', '/api/admin/threads/:id/resolve', (ctx) => {
    requireAdmin(ctx);
    app.comms.update(ctx.params.id, { needsAttention: false, status: 'closed' });
    return app.comms.threadView(app.comms.thread(ctx.params.id));
  });
  r.on('GET', '/api/admin/charter-requests', (ctx) => {
    requireAdmin(ctx);
    return app.charters.list();
  });

  // integrations
  r.on('GET', '/api/admin/integrations', (ctx) => {
    requireAdmin(ctx);
    const avp = app.aviapages;
    if (!avp) return { aviapages: { enabled: false, mode: 'off' } };
    const ops = app.fleet.listOperators();
    const aircraft = app.fleet.listAircraft();
    return {
      aviapages: {
        enabled: true,
        mode: avp.mode,
        baseUrl: avp.client.config.baseUrl,
        usage: avp.client.usage(),
        defaultBudget: avp.client.config.defaultBudget,
        sync: avp.sync.status(),
        comms: app.comms.pollState(),
        openRfqs: app.comms.hasOpenRfqs(),
        learned: {
          operators: ops.filter((o) => o.source === 'aviapages').length,
          aircraft: aircraft.filter((a) => a.source === 'aviapages').length,
          airports: app.reference.airports().length,
          aircraftTypes: app.reference.aircraftTypes().length,
          ...app.calculators.stats(),
          archivedResponses: app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_archive')?.n ?? 0,
        },
        lastCheck: app.kv.get('aviapages:last-check') ?? null,
      },
    };
  });
  r.on('POST', '/api/admin/integrations/aviapages/sync', async (ctx) => {
    requireAdmin(ctx);
    if (!app.aviapages) throw new AppError(409, 'integration_off', 'Aviapages integration is off');
    const kind = (ctx.body as { kind?: string })?.kind === 'incremental' ? 'incremental' : 'full';
    return kind === 'full' ? app.aviapages.sync.full() : app.aviapages.sync.incremental();
  });
  r.on('POST', '/api/admin/integrations/aviapages/poll', async (ctx) => {
    requireAdmin(ctx);
    return app.comms.poll();
  });
  r.on('POST', '/api/admin/integrations/aviapages/check', async (ctx) => {
    requireAdmin(ctx);
    if (!app.aviapages) throw new AppError(409, 'integration_off', 'Aviapages integration is off');
    const out = await runContractCheck(app.aviapages.client, { includeWrites: !!(ctx.body as { includeWrites?: boolean })?.includeWrites, now: now() });
    const record = { at: new Date(now()).toISOString(), mode: app.aviapages.mode, ...out };
    app.kv.set('aviapages:last-check', record, now());
    return record;
  });

  r.on('POST', '/api/admin/market', (ctx) => {
    requireAdmin(ctx);
    const b = ctx.body as { fuelCentsPerGal?: number; fx?: Record<string, number> };
    const t = now();
    if (b?.fuelCentsPerGal) app.market.set('fuel_cents_per_gal', b.fuelCentsPerGal, t);
    for (const [ccy, v] of Object.entries(b?.fx ?? {})) app.market.set(`fx_usd_per_${ccy.toUpperCase()}`, v, t);
    app.search.invalidate();
    return { ok: true };
  });

  return r;
}
