# Empty Leg Tracker

A real-time marketplace for empty-leg private charter flights. Operators list the repositioning
flights they already fly; travelers book the whole aircraft at one all-in price, typically well
below a regular one-way charter.

```
npm install        # dev tooling only (TypeScript types) — there are no runtime dependencies
npm start          # http://localhost:3000, seeded with a demo marketplace and a live feed simulator
npm test           # 48 tests: adapters, reconciliation, pricing guardrails, search, booking & payments
npm run typecheck
```

Requires Node.js ≥ 22.18 (runs TypeScript natively and uses the built-in `node:sqlite`).

| Page | URL | Demo credentials |
| --- | --- | --- |
| Traveler site | `/` | — (test cards: `tok_visa`, `tok_decline`, `tok_capture_fail`) |
| Operator portal | `/operator` | `dev_op_skyline`, `dev_op_coastal`, `dev_op_pacific`, `dev_op_alpine`, … |
| Ops review | `/admin` | `dev_admin_key` (set `ADMIN_KEY` in any real deployment) |

Environment: `PORT` (3000), `DB_PATH` (`data/emptylegs.db`), `ADMIN_KEY`, `SIMULATE=0` to turn off the
demo feed simulator. Delete `data/` to reseed.

## What it does

The four hard problems, and where each lives:

| Problem | Module | In one line |
| --- | --- | --- |
| **Operator integrations** — feeds that disagree; deciding what's true | `src/ingestion/` | Adapters normalize three wire formats into an append-only observation log; reconciliation derives one canonical leg with a confidence score, field-level provenance and an explicit list of conflicts. |
| **Search & inventory** — matching supply to what travelers want, fast | `src/inventory/search.ts` | In-memory index bucketed by origin airport; loose on what travelers flex on (nearby airports, ± days, "anywhere"), strict on seats, lead time and guardrailed price. ~1–3 ms per query. |
| **Pricing** — all-in price with margin logic and guardrails | `src/pricing/` | Operator ask (or modelled repositioning rate) + fees + margin + taxes; 14 guardrails decide whether a number may reach a customer. |
| **Booking & payments** — selected flight → confirmed, paid trip | `src/booking/` | Quote → hold + card authorization → operator confirms → capture. Idempotent, race-safe, with a balanced ledger and refunds when the operator cancels. |

Plus route alerts (`src/alerts/`) evaluated on every inventory change, delivered through a
transactional outbox.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the design: how truth is decided, the price
waterfall and every guardrail, the booking state machine, and what changes for production.

## API

Public
- `GET  /api/search?from=HPN&to=PBI&date=2026-10-20&flex=2&pax=4&category=light,midsize&radius=75&maxPrice=15000&sort=best|price|departure`
- `GET  /api/legs/:id?pax=` · `GET /api/airports?q=` · `GET /api/agreement`
- `POST /api/quotes {legId, pax}` → 15-minute price lock
- `POST /api/bookings` (header `Idempotency-Key`) `{quoteId, contact, passengers[], paymentToken, agreement{accepted, signedName, version}}`
- `GET  /api/bookings/:id?email=` · `POST /api/bookings/:id/cancel {email}`
- `POST /api/alerts {email, from, to?, radiusNm?, pax?, maxPrice?, dateFrom?, dateTo?}`
- `GET  /api/stream` — server-sent events when inventory changes

Feeds (machine-to-machine, `Authorization: Bearer <feed key>`)
- `POST /api/feeds/:sourceId` — JSON in the source's format, or `text/csv` for operator sources

Operator portal (`Authorization: Bearer <operator key>`)
- `GET /api/operator/me|legs|bookings` · `POST /api/operator/legs` (JSON or CSV)
- `POST /api/operator/legs/:id/withdraw` · `POST /api/operator/bookings/:id/confirm|decline`

Ops (`Authorization: Bearer <admin key>`)
- `GET /api/admin/review|ingest-errors|notifications|ledger|sources`
- `POST /api/admin/legs/:id/approve-price` · `POST /api/admin/market {fuelCentsPerGal, fx{EUR}}`

### Pushing legs from an operator system

```bash
curl -X POST localhost:3000/api/feeds/api:op_skyline \
  -H 'authorization: Bearer dev_feed_api_op_skyline' -H 'content-type: application/json' \
  -d '{"legs":[{"externalId":"trip-881-pos","tailNumber":"N512SK","from":"KTEB","to":"KPBI",
       "departureEarliest":"2026-10-20T13:00:00Z","departureLatest":"2026-10-20T17:00:00Z",
       "price":{"amount":780000,"currency":"USD"},"status":"available"}]}'
```

Send the same `externalId` again to update it, with `"status":"cancelled"` to withdraw it. The
response reports accepted/rejected records and why.
