# Empty Leg Tracker

A real-time marketplace for empty-leg private charter flights. Operators list the repositioning
flights they already fly; travelers book the whole aircraft at one all-in price, typically well
below a regular one-way charter.

```
npm install                  # dev tooling only — there are no runtime dependencies
npm start                    # http://localhost:3000 — demo marketplace + Aviapages in mock mode
npm test                     # 108 unit/integration tests
npm run e2e                  # 15 browser end-to-end flows against a fresh server (needs Chromium*)
npm run typecheck

AVIAPAGES_API_KEY=… npm run aviapages:check     # day-1 live check of your Aviapages key
AVIAPAGES_API_KEY=… npm run aviapages:harvest   # download as much as your budget allows
AVIAPAGES_API_KEY=… npm start                   # run on live Aviapages data
npm run skyaccess:check                         # live check of the SkyAccess MCP server (no key needed)
```

Requires Node.js ≥ 22.18 (runs TypeScript natively and uses the built-in `node:sqlite`).
\*E2E uses `playwright-core`: set `CHROMIUM_PATH`, or run `npx playwright install chromium` once.

| Page | URL | Demo credentials |
| --- | --- | --- |
| Traveler site | `/` | — (test cards: `tok_visa`, `tok_decline`, `tok_capture_fail`) |
| Custom charter quotes | `/charter` | — |
| Operator portal | `/operator` | `dev_op_skyline`, `dev_op_coastal`, `dev_op_pacific`, `dev_op_alpine`, … |
| Ops console | `/admin` | `dev_admin_key` (set `ADMIN_KEY` in any real deployment) |

Environment: `PORT` (3000), `DB_PATH` (`data/emptylegs.db`), `ADMIN_KEY`, `SIMULATE=0` to turn off the
demo feed simulator, `SKYACCESS_MODE` (`live` | `mock` | `off`), plus the Aviapages settings in
**[docs/AVIAPAGES.md](docs/AVIAPAGES.md)**.
Delete `data/` to reseed.

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

### Aviapages integration (`src/integrations/aviapages/`, `src/comms/`, `src/charter/`)

| Feature | What it does |
| --- | --- |
| Live empty legs | Budget-paced full + incremental sync; learns operators, tails, photos, amenities, airports and aircraft types from each listing; removed listings are withdrawn (and refunded if booked). |
| Operator communication | Booking a network operator's leg sends them an Aviapages RFQ; delivery status and their offer are polled; an offer within the expected payout confirms and charges automatically, "not available" declines and releases the card, anything else goes to a human. Email in/out with `[ref:…]` threading and portal messages land in one Inbox. |
| Better pricing inputs | Wind-adjusted airway flight times and market charter prices, cached per route + type. |
| Custom charter | Traveler gives a route; Aviapages finds aircraft nearby; one RFQ to chosen operators; offers become privately bookable through the normal payment flow. |
| Trial tooling | Per-endpoint monthly budgets with reserves, raw response archive, live contract check, harvest + JSON export. |

Built against the official OpenAPI spec (vendored); the mock is validated against it in the test
suite. See **[docs/AVIAPAGES.md](docs/AVIAPAGES.md)** for setup and the 14-day trial plan, and
**[docs/FEATURE-CHECK.md](docs/FEATURE-CHECK.md)** for what was tested and how.

### SkyAccess partner flights (`src/integrations/skyaccess/`)

Search results also show up to 5 empty legs from [SkyAccess](https://skyaccess.com)'s public MCP
server. Travelers book those on SkyAccess (booking link), or send a contact request that a
SkyAccess specialist answers by email (`request_booking`: no payment, no booking). See
**[docs/SKYACCESS.md](docs/SKYACCESS.md)**.

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
- `GET  /api/config` — which integrations are enabled
- `POST /api/charter-requests {name, email, phone?, from, to, date, time?, pax, notes?}` → aircraft options
- `POST /api/charter-requests/:id/send {email, aircraftIds[]}` · `GET /api/charter-requests/:id?email=`
- `GET  /api/partners/skyaccess/search?from=&to=&date=&flex=&pax=&maxPrice=` · `GET /api/partners/skyaccess/flights/:id` · `GET /api/partners/skyaccess/estimate?from=&to=&pax=&category=`
- `POST /api/partners/skyaccess/booking-requests {flightId?, name, email, phone?, origin, destination, departureDate, passengers, notes?}`

Feeds (machine-to-machine, `Authorization: Bearer <feed key>`)
- `POST /api/feeds/:sourceId` — JSON in the source's format, or `text/csv` for operator sources

Operator portal (`Authorization: Bearer <operator key>`)
- `GET /api/operator/me|legs|bookings|threads` · `POST /api/operator/legs` (JSON or CSV)
- `GET /api/operator/threads/:id` · `POST /api/operator/threads/:id/reply {body}`
- `POST /api/operator/legs/:id/withdraw` · `POST /api/operator/bookings/:id/confirm|decline`

Ops (`Authorization: Bearer <admin key>`)
- `GET /api/admin/review|ingest-errors|notifications|ledger|sources`
- `POST /api/admin/legs/:id/approve-price` · `POST /api/admin/market {fuelCentsPerGal, fx{EUR}}`
- `GET /api/admin/bookings?status=` · `POST /api/admin/bookings/:id/confirm|decline` (on behalf of network operators)
- `GET /api/admin/threads?attention=1` · `GET /api/admin/threads/:id` · `POST /api/admin/threads/:id/messages|retry|resolve`
- `GET /api/admin/charter-requests` · `GET /api/admin/integrations` · `GET /api/admin/skyaccess`
- `POST /api/admin/integrations/aviapages/sync {kind: full|incremental}` · `…/poll` · `…/check {includeWrites?}`

Inbound email (`?token=$INBOUND_EMAIL_TOKEN`)
- `POST /api/inbound/email {from, to?, subject?, text, messageId?}` — map your email provider's inbound webhook to this

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
