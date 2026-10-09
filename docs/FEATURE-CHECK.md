# Feature check

What was verified, how, and what can only be confirmed with a real Aviapages key.

**Result: 104/104 automated tests, 18/18 browser end-to-end flows, 23/23 mock endpoints conform to
the official Aviapages OpenAPI spec, typecheck clean.** Run them yourself with `npm test`,
`npm run e2e` and `npm run typecheck`.

How each feature was checked:
- **Unit**: automated test file in `test/`, run by `npm test`.
- **E2E**: a real Chromium browser driving the site, run by `npm run e2e` (`scripts/e2e.ts`).
- **Spec**: response validated against Aviapages' published OpenAPI schema.

## Aviapages API → site

| API capability | Site feature | Unit | E2E | Spec |
| --- | --- | --- | --- | --- |
| `empty_legs` list (paged, filtered) | Live empty legs in search | `aviapages-sync` (10 tests) | Geneva search shows network legs | ✓ |
| `empty_legs` incremental (`updated_at_gt`) | New/changed legs within minutes | `aviapages-sync` | — | ✓ |
| `empty_legs` embedded company / aircraft / airports | Operators, tails, photos, amenities, new airports and types learned | `aviapages-sync`, `aviapages-directory` | Photos and amenities in the flight drawer | ✓ |
| Listing removed from feed | Leg withdrawn; booking refunded if confirmed | `aviapages-sync`, `booking` | — | — |
| `charter_quote_requests` POST | Booking a network leg sends an RFQ to that operator | `comms` | Request-to-book flow | ✓ |
| Quote message delivery state | "Request delivered / opened" for traveler and ops | `comms` | "Request sent to the operator" in booking timeline | ✓ |
| `charter_quote_replies` GET | Operator offer ingested into the Inbox | `comms`, `charter` | Offer arrives, booking auto-confirms | ✓ |
| Offer → auto-confirm / auto-decline | Card captured or released without a human | `comms` (3 tests) | Auto-confirm | — |
| Offer above expected payout | Flagged for ops; confirm/decline on behalf | `comms` | Ops confirms a booking | — |
| `charter_quote_replies` PATCH reaction | Operator told Accept / Reject / Seen | `comms`, `charter` | — | ✓ |
| `flight_calculator` | Wind-adjusted flight time in pricing and the flight drawer | `calculators` | "airway route with typical winds" shown | ✓ |
| `charter_prices` | "% below a regular charter" uses market price | `calculators` | — | ✓ |
| `charter_search_aircraft` | Custom charter: aircraft near departure | `charter` | Charter options grid | ✓ |
| Multi-operator RFQ + offers | Custom charter offers, priced all-in, bookable privately | `charter` (8 tests) | Offer booked, then confirmed by ops | ✓ |
| `charter_companies` | Operator directory (contacts, response rates) | `aviapages-directory` | — (harvest script) | ✓ |
| `charter_aircraft` | Fleet directory (tails, bases, photos) | `aviapages-directory` | — (harvest script) | ✓ |
| `aircraft_types` | Real range/speed/seats for learned types | `aviapages-directory` | — (harvest script) | ✓ |
| `airports`, `aircraft_classes`, `tokens`, `charter_searches`, `price_calculator`, `operator_quote_messages` | Contract check, directory/catalog support | `aviapages-contract` | Contract check in ops console | ✓ |
| Auth (`Token` header), 401 | Clear "key rejected" error, no retries | `aviapages-client` | — | ✓ |
| 429 per-minute / 5xx | Retried with backoff | `aviapages-client` | — | — |
| 429 monthly limit | Stops immediately, marks endpoint exhausted | `aviapages-client` | — | ✓ (documented example) |
| Budgets and reserves | Never exceeds per-endpoint monthly budgets; sync paced to budget | `aviapages-client`, `aviapages-sync` | Usage table in ops console | — |
| Raw archive | Every paid response kept in `api_archive` | `aviapages-client` | Counter in ops console | — |

## Rest of the site

| Area | Feature | Unit | E2E |
| --- | --- | --- | --- |
| Search | Nearby airports, ± days, anywhere, seats, category, max price, sorting, live updates | `search` (8) | Search NY / Geneva / LA; live indicator |
| Search | 2,000 legs searched < 50 ms | `search` | — |
| Ingestion | Three feed formats, CSV quoting, bad records rejected with reasons | `adapters` (4) | — |
| Reconciliation | Operator > aggregator, registry authority, decay/expiry, overlap, quarantine | `reconcile` (11) | — |
| Pricing | All-in waterfall, FET/segment/intl taxes, FX, margins, 14 guardrails | `pricing` (10) | Price breakdown in drawer |
| Booking | Quote lock, hold, auth → capture, idempotency, races, decline, expiry, refunds, ledger | `booking` (15) | Direct booking confirmed by operator |
| Operator portal | Login, booking requests, confirm/decline, legs, post leg/CSV, fleet, messages | `comms` | Confirm in portal; reply in Messages |
| Ops console | Integrations, Inbox, Bookings, Charter requests, Review, Feed errors, Notifications, Ledger | — | Integrations + check, Inbox reply, Bookings confirm |
| Communications | Inbound email threading by ref / sender / unassigned; outbound email with ref | `comms` | Inbound email threaded by reference |
| Alerts | Route alerts on new/cheaper legs, deduplicated | `booking` | Alert signup |
| Layout | Every page at 390 px wide without horizontal scroll | — | All five pages |
| Operator supply | FAA Part 135 import (.xlsx and .csv), model → category, prospects, re-import keeps notes | `onboarding` (9) | Import, filter, open prospect, notes |
| Operator supply | Application form → prospect, FAA match, ops + applicant emailed, bot trap | `onboarding` | Operator applies |
| Operator supply | Onboard: account, keys shown once, rotate, suspend; fleet checked against certificate | `onboarding` | Onboard from prospect, add aircraft, warning for a tail on another certificate |
| Operator supply | New operator posts a leg → traveler books → operator confirms | `onboarding` | Full flow with the issued key |
| Operator supply | Listings reconfirmed weekly (7-day validity, reminder email) | `onboarding` | "All still available" |
| Market data | ECB rates (real file format, AED peg), fuel form | `onboarding` | Fuel update in Market tab |
| Production mode | Weak admin key refused; no demo data, hints, Aviapages or charter link; bookings closed on simulated payments | — | ✓ |
| Quality | No browser console errors on any page | — | ✓ |

## Bugs found and fixed during testing

- **Portal listings went off sale after 6 hours** unless re-posted, though operators post legs weeks
  ahead. Signed operators' portal listings now stay on sale 7 days after the operator last confirmed
  them, with a one-click reconfirm and a reminder email.
- **Booking requests were addressed to `operator:<id>`** instead of the operator's email. Fixed.
- **An application sent before the FAA list was imported** never matched its FAA record. Fixed; test added.
- **The ECB doesn't publish AED**, so dirham prices would never have been sold. AED now uses its USD peg.
- **An empty `AVIAPAGES_MODE=` variable turned the integration on.** Empty now means unset; unknown values stop the server.
- **Production could have taken bookings on simulated cards.** Bookings are closed in production until a real payment provider is connected.

- **Mock under a URL path prefix returned 404.** If Aviapages' base URL turns out to include a path,
  the client already keeps it; the mock now strips its own prefix. A regression test covers it.
- **Hidden sections showing.** A layout class overrode the `hidden` attribute, so the charter page
  showed its empty form above the request status. Fixed for every page.
- **Header 2 px too wide on phones** after adding the Custom charter link. Fixed.
- **Mock schema drift.** The spec validator caught two places where the mock didn't match the
  published spec: fuel breakdown arrays, and number types in the type catalog. Both fixed.
- **Margin floor below card-processing cost** (from the first build): the fee is now always at least
  break-even after 2.9% + 30¢.

## Needs your real key (one command: `npm run aviapages:check`)

These are the only things that can't be proven without your account:
- The base URL (`https://api.aviapages.com` is assumed from where the docs are hosted).
- Which endpoints your trial plan includes, and its per-endpoint limits. Set `AVIAPAGES_BUDGETS` to match.
- Real data volumes and shapes. Each response is validated against the spec, and any difference is listed.
- Real operator behaviour on RFQs: reply times, and whether they use Aviapages replies or email (both are handled).

Not production-ready in this build, by design: a payment processor (mock card provider; production
mode refuses bookings until one is connected), an email provider (messages print to the server log),
traveler accounts, and legal review of the charter agreement and broker disclosures. See
[PRODUCTION.md](PRODUCTION.md).
