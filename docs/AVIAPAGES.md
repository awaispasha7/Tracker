# Aviapages integration and 14-day trial plan

The site uses Aviapages API v3 for live empty legs, operator communication, flight times, market
prices, custom charter search and directories. Everything was built against Aviapages' official
OpenAPI spec (vendored at `src/integrations/aviapages/openapi.json`) and tested against a mock
that is itself validated against that spec. The first thing to do with a real key is the live check
below, which confirms the real API behaves the same way.

## Setup

```bash
export AVIAPAGES_API_KEY=your-token          # from your Aviapages account (API → tokens)
npm run aviapages:check                      # 1 minute, ~20 calls: does every feature work with this key?
npm start                                    # the site now runs on live Aviapages data
```

Without a key the server runs in **mock mode** (fictional operators and legs) so every feature can
still be tried. The ops console (`/admin` → Integrations) always shows which mode is active.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AVIAPAGES_API_KEY` | — | Your token. Setting it switches to live mode. |
| `AVIAPAGES_MODE` | `live` with a key, else `mock` | `live`, `mock` or `off`. |
| `AVIAPAGES_BASE_URL` | `https://api.aviapages.com` | Taken from where the docs are served; the check confirms it. |
| `AVIAPAGES_BUDGETS` | `{}` | Monthly calls per endpoint, e.g. `{"empty_legs":3000,"flight_calculator":600}`. **Set these to your plan's limits.** |
| `AVIAPAGES_DEFAULT_BUDGET` | `1000` | Budget for endpoints not listed above. |
| `AVIAPAGES_FULL_SYNC_MINUTES` | `240` | Target interval between full empty-leg syncs (stretched automatically if the budget can't sustain it). |
| `AVIAPAGES_INCREMENTAL_SYNC_MINUTES` | `10` | Interval between "what changed" syncs. |
| `AVIAPAGES_LISTING_MAX_AGE_MINUTES` | `720` | A listing stays bookable this long after the last full sync confirmed it. |
| `AVIAPAGES_POLL_MINUTES` | `3` | How often operator replies are fetched while RFQs are open (no polling otherwise). |
| `INBOUND_EMAIL_TOKEN` | `dev_inbound_token` | Secret for `POST /api/inbound/email?token=…` (operator email replies). |
| `REPLY_TO_ADDRESS` | `ops@emptylegtracker.example` | Address operators reply to; threads match on `[ref:…]`. |

## What uses which endpoint

| Feature on the site | Endpoints | When calls happen |
| --- | --- | --- |
| Live empty legs in search | `empty_legs` | Full sync (paced to budget) + incremental every 10 min |
| Operators, tails, photos, amenities, new airports | embedded in `empty_legs` | Free with each sync |
| Book a network operator's leg → RFQ to that operator | `charter_quote_requests` (POST) | Once per booking |
| Delivery status (sent / delivered / opened) | `charter_quote_requests` (GET) | Each poll, only while RFQs are open |
| Operator offers, auto-confirm / auto-decline | `charter_quote_replies` (GET) | Each poll, only while RFQs are open |
| Tell the operator we accepted / declined | `charter_quote_replies` (PATCH reaction) | Once per decision |
| Wind-adjusted flight time in the flight drawer and pricing | `flight_calculator` | Once per route + aircraft type, cached 90 days |
| "X% below a regular charter" market price | `charter_prices` | Once per route + type, cached 7 days |
| Custom charter: suitable aircraft near departure | `charter_search_aircraft` | Once per traveler request |
| Custom charter: quotes from chosen operators | `charter_quote_requests`, `charter_quote_replies` | Once per request, then polling |
| Operator/fleet directories, type catalog | `charter_companies`, `charter_aircraft`, `aircraft_types` | Harvest script only |

Every response is stored raw in the database table `api_archive`, so nothing you paid for is lost.

## The 14-day plan

**Day 1 — prove it works (about 20 calls)**
1. `npm run aviapages:check`. Every line should say PASS. A 401/403 on some lines means your plan
   doesn't include that endpoint: ask Aviapages to enable it for the trial.
2. Ask Aviapages for your trial's monthly limit per endpoint and put them in `AVIAPAGES_BUDGETS`.
   The app never exceeds them and keeps a reserve for bookings.
3. Optional: `npm run aviapages:check -- --with-writes` to prove RFQs can be created (one request
   addressed to no operator, copied to you, then archived).

**Day 1–2 — harvest the reference data that won't change (largest one-off value)**
```bash
npm run aviapages:harvest -- --company-pages=50 --aircraft-pages=50 --calc-limit=300
```
This downloads the aircraft type catalog (real range/speed/seats for every type), the operator
directory (contacts and response rates: your outreach list), the fleet directory (tails, bases,
photos) and flight times + market prices for every route currently in the inventory. Re-run with
bigger page limits on later days if budget remains. Output is also exported to
`data/aviapages-export/<timestamp>/` as JSON.

**Days 2–12 — run the site live**
- Leave `npm start` running. Watch `/admin` → Integrations: calls used vs budget per endpoint, the
  paced full-sync interval, and a warning if the budget can't keep listings fresh.
- Book a few real legs end to end (use a test card). Each booking sends a real RFQ to that
  operator: say in the comment that it's a test if you don't intend to fly. Watch the reply
  arrive in `/admin` → Inbox and the booking auto-confirm or decline.
- Try a couple of custom charter requests on `/charter` to see real operator offers.
- Note which operators answer fastest (Inbox / response rates): they're your first direct signings.

**Days 12–14 — keep what you've learned**
- Final `npm run aviapages:harvest` to refresh flight times/prices for any new routes.
- Copy `data/emptylegs.db` (and `data/aviapages-export/`) somewhere safe. After the trial the site
  keeps working on direct operators, with all learned operators, aircraft, airports, types, cached
  flight times and market prices, and the full raw archive.
- Decide on a paid tier from the actual usage numbers in the Integrations tab.

## What happens when the trial ends

Set `AVIAPAGES_MODE=off` (or just remove the key and set the mode to `off`). Aviapages listings
expire from search within the listing max age; bookings and conversations already made keep
working; learned reference data and cached calculations stay. Operators you were talking to by
RFQ can still be reached by email from the Inbox.

## Known unknowns (confirmed or ruled out by the day-1 check)

- **Base URL**: the spec doesn't name a server; `https://api.aviapages.com` is where the docs are
  hosted. If the check fails on every endpoint with a network error, set `AVIAPAGES_BASE_URL`.
- **Plan limits per endpoint**: the public pricing table doesn't map limits to endpoints clearly;
  ask Aviapages and set `AVIAPAGES_BUDGETS`.
- **RFQ with no recipients** (only used by `--with-writes`): may be rejected by validation. That
  failure doesn't affect real bookings, which always address an operator.
- **Prices**: Aviapages listing prices are posted by operators; we treat them as the operator's ask
  and add our fee and taxes on top. If you learn they already include broker commission, set the
  source's `pricesAreNet` to false in `src/integrations/aviapages/sync.ts`.
