# Architecture

```
 operator APIs ─┐                                         ┌─► search index (in-memory) ─► traveler site
 operator portal├─► adapters ─► observations ─► reconcile ─► legs ─┤
 aggregators    │   (normalize)  (append-only)  (decide truth)     ├─► route alerts ─► outbox ─► email/SMS
 broker feeds  ─┘                                                  └─► bookings whose flight changed/vanished
                                                                          │
 traveler ─► quote (priced + guardrails, 15 min) ─► hold + authorize ─► operator confirms ─► capture ─► ledger
```

One process, one SQLite file, no runtime dependencies. Every module is a plain class wired
together in `src/app.ts`, which takes an injectable clock and payment provider so the tests can
drive time and payments deterministically.

## 1. Operator integrations: deciding what is true

### Ingestion

Each feed source has a **kind** (`operator_api`, `operator_portal`, `aggregator`,
`broker_network`), a **trust** prior, a **TTL**, and an **adapter**:

| Adapter | Format | Notable quirks it handles |
| --- | --- | --- |
| `native` | our JSON schema | ISO times must carry an offset; price in minor units |
| `aerofeed` | a third-party aggregator | IATA codes, local date + time + UTC offset, `± flex_hours`, `"12,500.00"` / `"POA"` prices, `Y/N` availability, free-text aircraft names, `N-123AB` registrations |
| `csv` | operator bulk upload | quoted cells, major-unit prices, bad rows reported by line number |

Adapters are strict: anything they can't interpret becomes an **ingest issue** (stored, shown in
ops), never a guess. Accepted records become **observations** in an append-only log, so every
canonical value can be traced back to who said what, when.

### Identity

Two reports are the same flight if they have the same tail, departures within 6 h, and origin and
destination each within 30 nm (an aggregator saying JFK where the operator says TEB is the same
leg with a route disagreement, not a second leg). The `(source, externalId) → leg` link is
remembered, so later updates and cancellations land on the right leg.

### Reconciliation (`src/ingestion/reconcile.ts`)

1. **The verified fleet registry is authoritative** for who operates a tail and its type. A feed
   that says otherwise produces an `aircraft_type_mismatch` conflict and is ignored. Unknown tails
   and suspended operators are quarantined (`unknown_tail`, `operator_inactive`).
2. **A fresh report from the operator's own channel is authoritative** for route, departure
   window, price and availability: the operator is the one who will fly it. Third-party dissent is
   recorded (`status_disagreement`, `route_disagreement`, `price_disagreement`) but loses.
3. **Without an operator report**, each field is decided by a vote weighted by
   `trust × freshness`. Departure times are clustered within ±2 h. A tie on availability resolves
   to *unavailable*: selling a flight that doesn't exist is worse than missing a sale.
4. **Freshness**: a report's weight decays linearly to half at its source's TTL and drops to zero
   after. A leg with no fresh reports **expires**. Aggregator-only legs therefore leave search
   unless they keep being re-confirmed.
5. **Confidence** = noisy-OR of agreeing sources × the share of weight that agrees (or the
   operator's own weight, if higher). One aggregator alone ≈ 0.70; two agreeing ≈ 0.91; operator
   API ≈ 0.95. Legs below 0.5 aren't sold; between 0.5 and 0.8 they're labelled "availability
   confirmed on request".
6. **Physical feasibility across legs**: one tail can't fly two legs whose times overlap once block
   time, a 30-minute turn and the repositioning flight between them are counted. The
   lower-confidence leg is quarantined (`tail_schedule_overlap`), never one a customer holds.
7. **Versioning**: a leg's version changes only on *material* change (route, times, price,
   status, aircraft, blocking conflicts). Confidence decay alone never invalidates an open quote.

Downstream effects run after each reconciliation: the search index is invalidated, travelers
holding a leg whose time or route moved are notified, a held/booked leg that the operator
withdraws triggers void/refund, and newly listable or repriced legs are matched against alerts.

## 2. Search & inventory (`src/inventory/search.ts`)

Empty legs are rigid (fixed aircraft, airports, narrow window), so literal matching finds almost
nothing. Matching is loose where travelers are flexible and strict where the flight isn't:

- **Origin/destination radius** (default 75 nm): searching HPN finds TEB departures, FLL finds PBI
  arrivals. Each result explains itself ("Departs TEB, 21nm from HPN").
- **Dates**: ± flex days, or any time in the next 60 days; destination optional ("anywhere").
- **Hard filters**: seats ≥ passengers, category, max price, lead time, and a price that passed
  every guardrail.
- **Ranking** (`best`): savings vs. full charter, confidence, date distance, airport distance;
  also `price` and `departure` sorts.

Only sellable legs are indexed, bucketed by origin airport, in memory. The index is rebuilt when
ingestion or bookings change inventory (and at least every minute so time-based rules apply). A
query touches only the buckets within its radius; with 2,000 live legs it takes a few ms
(`test/search.test.ts` asserts < 50 ms). Clients subscribe to `/api/stream` and re-run their
search when inventory changes.

## 3. Pricing (`src/pricing/`)

### The all-in waterfall

```
operator payout     operator's net ask (FX-converted)                         — or, with no ask —
                    hourly rate × billable hours × repositioning factor + fuel surcharge + handling
+ platform fee      category margin (8–13%) ± lead-time adjustment, clamped to [break-even, 20%]
= transportation    (what US excise tax is assessed on)
+ taxes             US domestic: 7.5% FET + segment fee × pax × segments
                    touching the US: international head tax × pax
= all-in total      exactly what the traveler pays; nothing is added at checkout
```

- **Repositioning economics**: the flight happens anyway, so a modelled price is a fraction of
  the full hourly rate that shrinks as departure nears (55% > 7 days … 33% < 24 h): perishable
  inventory.
- **Billable hours**: operators bill a 1-hour minimum; short hops are priced accordingly.
- **Fuel**: rates assume a baseline fuel price; a fuel index above it adds a surcharge to
  modelled prices (operator asks are all-in).
- **Margin**: thinner in the last 24 h (move it or lose it), thicker > 14 days out. The floor is
  the *break-even fee*: the smallest fee that still leaves the minimum net margin after 2.9% + 30¢
  card processing on the whole total, solved in closed form. If the price would exceed 85% of the
  equivalent full charter, margin is **compressed** toward break-even before giving up.

### Guardrails: what stops a bad number reaching a customer

Every price is checked on display, on quote, and again at the moment of booking. Any failure hides
the leg from travelers and surfaces it in the ops review queue.

| Guardrail | Catches |
| --- | --- |
| `LEG_AVAILABLE`, `LEG_UNCONFLICTED`, `LEG_CONFIDENCE` | selling supply we don't believe in |
| `LEG_FRESH` | supply not re-confirmed within 6 h |
| `MARKET_FRESH`, `FX_AVAILABLE` | stale fuel index or FX rate |
| `LEAD_TIME` | departs too soon for the operator to confirm (3 h) |
| `CAPACITY`, `AIRCRAFT_KNOWN` | more passengers than seats; unknown aircraft |
| `FULL_CHARTER_CEILING` | an "empty leg" that isn't actually a deal (> 85% of full charter even after margin compression) |
| `MIN_NET_MARGIN` | a sale that loses money after card fees |
| `OPERATOR_FLOOR` | paying an operator less than they asked (invariant) |
| `PRICE_SANITY` | all-in outside 12–150% of the type's hourly rate per billable hour: dollars-vs-cents errors, wrong currency, wrong aircraft |
| `PRICE_JUMP` (review) | a > 35% move vs. the last price shown; held until ops approves it |

Quotes lock a price for 15 minutes against a specific leg version. Booking re-prices at that
moment and refuses if the leg changed, the total changed, or any guardrail now fails.

## 4. Booking & payments (`src/booking/`)

```
quote ─► pending ─auth ok─► authorized ─operator confirms + capture─► confirmed ─► completed
            │                  │   │   │                                  │
            └─auth fails─► payment_failed  ├─operator declines─► declined       └─operator cancels─► cancelled_by_operator (full refund)
                               │   └─hold lapses (2 h SLA)─► expired
                               └─traveler cancels─► cancelled_by_customer
```

- **One leg, one hold**: the hold is a compare-and-set on the leg's version and commerce status,
  inside a write transaction, so two travelers racing for the same leg can't both win.
- **Money moves only on commitment**: the card is authorized at request and captured only when the
  operator confirms. Declines, lapsed holds and pre-confirmation cancels void the authorization.
- **No DB lock across network calls**: hold in one transaction, call the payment provider, record
  the outcome in another.
- **Idempotency everywhere**: the client's `Idempotency-Key` makes booking retries safe; every
  provider call carries a key derived from booking id + step; every state transition is a
  compare-and-set on the current status, so double-clicks, webhook retries and sweeper races apply
  once.
- **The charter agreement** (version + SHA-256 of the text, typed signature, timestamp, IP, user
  agent) is recorded with the booking; an outdated version is refused.
- **Operator cancellation after confirmation** (empty legs follow the primary trip): when the
  operator's feed or portal withdraws a booked leg, the payment is refunded in full, the ledger is
  reversed, and the traveler is told to use their backup and offered alerts on the route.
- **Ledger**: balanced postings per capture (`cash`, `operator_payable`, `tax_payable`,
  `platform_revenue`) and their reversal on refund.
- **Notifications** go through a transactional outbox (written in the same transaction as the
  state change, deduplicated by key, delivered asynchronously), so a rollback never sends a
  "confirmed" email and a replayed event never sends two.

## Competitive context

Avi-Go and Avinode-style networks aggregate operator schedules for brokers; consumer apps (Jettly,
XO, Villiers, Victor, operator sites like Silver Hawk) sell legs directly. Common gaps this design
targets: stale listings (handled by TTLs, confidence decay and re-checks at booking), opaque
pricing (one all-in number with the breakdown shown), rigid matching (radius + flex + anywhere),
and the cancellation risk travelers carry (auth-then-capture, automatic refunds, backup guidance).

## Going to production

| Area | Here | Production |
| --- | --- | --- |
| Storage | SQLite (WAL) | Postgres; the SQL is portable. Row-level `SELECT … FOR UPDATE` or the same CAS pattern |
| Search | in-process index | same design per node, rebuilt from a change stream; or Postgres + PostGIS for the candidate set |
| Payments | `MockPaymentProvider` | Stripe PaymentIntents with `capture_method=manual` (implement `PaymentProvider`); wire transfer for large heavy-jet trips; 3DS |
| Notifications | console sender | SES/Postmark + Twilio behind the `Sender` interface |
| Market data | production mode: ECB daily FX every 6 h (AED via its USD peg); fuel set in Ops → Market, valid 30 days | a regional Jet-A index feed if modelled prices matter; `MARKET_FRESH`/`FX_AVAILABLE` already block when inputs stall |
| Feeds | per-operator portal + feed keys issued and rotated in Ops → Operators; portal listings valid 7 days after the operator reconfirms, feed listings 24 h | scheduled pulls for pull-only systems, schema contracts per partner |
| Auth | bearer keys, email-scoped booking lookup | traveler accounts (magic link), operator SSO, admin RBAC, audit log |
| Compliance | agreement capture; fleet checked against the FAA Part 135 list at onboarding | legal review of the agreement, DOT Part 295 broker disclosures, passenger document checks, PCI scope kept at the provider |
| Ops | `/admin` review queue | alerting when ingest error rate, quarantine rate or `PRICE_JUMP` holds spike |

## Aviapages integration

Aviapages is wired in as one more feed source (`aviapages`, an operator-run marketplace: trusted
below a signed operator's own channel, its posted prices usable as the operator's ask) plus three
services: the communications hub (`src/comms/`: RFQs, offers, email and portal threads), the
calculators (`src/integrations/aviapages/calculators.ts`: cached flight times and market prices fed
to pricing), and custom charter requests (`src/charter/`: offers become private legs booked through
the normal flow). Setup, budgets and the trial plan: [AVIAPAGES.md](AVIAPAGES.md). What was tested:
[FEATURE-CHECK.md](FEATURE-CHECK.md).

## Direct operators (`src/onboarding/`)

The launch inventory comes from operators signed directly, found in the FAA Part 135 list. The
importer reads the FAA spreadsheet (a small built-in .xlsx reader, no dependency), classifies each
aircraft's FAA model designation into a category and, where it can, one of our types, and builds a
prospect per certificate holder. Prospect status and notes live in their own table, so re-importing
the list keeps them; an operator applying through the site is matched to their FAA record by
certificate designator, even if the list is imported afterwards. Onboarding creates the operator,
its portal and feed sources (keys stored hashed, shown once) and its fleet; a tail that isn't on the
operator's certificate needs an explicit override. Steps for launch: [PRODUCTION.md](PRODUCTION.md).
