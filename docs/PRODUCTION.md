# Going live with direct operators

The launch plan: no paid data feed. Inventory comes from operators you sign yourself. They list
legs in the operator portal, upload a spreadsheet, or push from their scheduling system through the
feed API. You find them in the free FAA Part 135 list. Aviapages stays off and can be added later
with one environment variable.

## 1. Run it in production mode

```bash
NODE_ENV=production \
ADMIN_KEY="$(openssl rand -hex 24)" \
PUBLIC_URL=https://your-domain.example \
OPS_EMAIL=ops@your-domain.example \
npm run start:prod
```

Production mode (`NODE_ENV=production` or `--production`) changes these things:

| | Development | Production |
| --- | --- | --- |
| Demo operators, legs, feed simulator | yes | no: empty marketplace until you onboard operators |
| Admin key | `dev_admin_key` | `ADMIN_KEY` required, 16+ characters; the server won't start without it |
| Aviapages | mock | off unless `AVIAPAGES_API_KEY` is set |
| Custom charter page | on (mock) | hidden (needs Aviapages) |
| Demo login hints | shown | hidden |
| Exchange rates | seeded | European Central Bank daily rates at boot and every 6 h (free, no key) |
| Fuel index | seeded | `FUEL_CENTS_PER_GAL` (default 600) at first boot, then set in Ops → Market |
| Bookings | open (test cards) | **closed** until a real payment provider is connected (below) |

| Variable | Purpose |
| --- | --- |
| `PORT`, `DB_PATH` | listen port (3000), SQLite file (`data/emptylegs.db`): put it on a persistent disk and back it up |
| `ADMIN_KEY` | ops console login |
| `PUBLIC_URL` | used in emails to operators (portal links) |
| `OPS_EMAIL` | where operator applications are sent |
| `FUEL_CENTS_PER_GAL` | starting Jet-A index |
| `INBOUND_EMAIL_TOKEN` | enables `POST /api/inbound/email` so operator email replies land in the Inbox |
| `ALLOW_SIMULATED_PAYMENTS=1` | staging only: take bookings on test cards in production mode |

## 2. Sign your first 10–20 operators

1. **Import the FAA list.** Download the Part 135 operators-and-aircraft spreadsheet from faa.gov
   (Part 135 certificate holders, with aircraft). Ops → Prospects → Import, or
   `npm run faa:import -- part135.xlsx`. Each certificate holder becomes a prospect with its fleet
   counted by category; helicopters and piston aircraft are recognised and don't count as jets.
   Re-import whenever the FAA updates it; your statuses and notes are kept.
2. **Pick targets.** Filter by "Min. jets" and category. Operators with 3–15 light/midsize jets in
   your launch region are the best start. Many already post empty legs on their own website; you're
   asking them to also send them to you.
3. **Work the pipeline.** Open a prospect, record the contact and notes, move the status
   (new → contacted → interested → onboarding → signed). Operators can also apply themselves at
   `/operator` ("List your empty legs"); applications show up as `applied`, matched to their FAA record,
   and you get an email.
4. **Onboard.** "Onboard as operator" creates the account, a portal key and a feed key. **Copy the
   keys from the green box and send them to the operator; they're stored hashed and shown once.**
   (Lost keys: "New portal key" / "New feed key".)
5. **Add their fleet.** The aircraft on their FAA certificate are listed; "Use" fills in the type,
   you add the home base. A tail that isn't on their certificate is refused unless you tick the
   override after verifying it (e.g. a newly added aircraft). Only fleet aircraft can be sold.
6. **Send them the [operator guide](../public/operator-guide.html)** (`/operator-guide.html`) and the
   CSV template. That's all they need.

## 3. How listings stay accurate

- Portal and spreadsheet listings stay on sale for **7 days** after the operator last confirmed them.
  Operators confirm everything with one click ("All still available"); a reminder email goes out
  after 5 days.
- Feed API listings stay on sale for **24 hours** after the last push.
- Every booking is confirmed by the operator before the card is charged (2-hour window), so a
  stale listing costs a decline, never a flight that doesn't exist.

## 4. What must be done before taking real money

These are outside the code and are blockers:

| Blocker | What to do |
| --- | --- |
| **Payments** | Implement `PaymentProvider` (`src/booking/payments.ts`) with Stripe PaymentIntents, `capture_method=manual` (authorize at request, capture on operator confirm, void on decline). Then pass it to `createApp({ payments })` in `src/server.ts`; bookings stay closed in production until you do. Card authorizations expire after ~7 days, which fits the 2-hour confirmation window. |
| **Email** | Notifications go through the outbox to `consoleSender` (server log). Replace it with a `Sender` for Postmark/SES/Resend in `src/server.ts`. Operators get booking requests by email, so this is required. Map your provider's inbound webhook to `/api/inbound/email`. |
| **Hosting** | One Node 22.18+ process with a persistent disk for the SQLite file, behind HTTPS. Back up the DB file daily. Outbound HTTPS to `www.ecb.europa.eu` for exchange rates. |
| **Legal** | Have a lawyer review the charter agreement (`src/booking/agreement.ts`). In the US, selling flights you don't operate makes you an air charter broker: DOT Part 295 disclosures (you are not the operator; the operator's name and certificate shown before purchase, which the site does), plus terms of service and a privacy policy. A written agreement with each operator covering payout timing, cancellations and liability. |
| **Operator payouts** | The ledger records what each operator is owed (`operator_payable`). Pay out by bank transfer from it, or use Stripe Connect. |

## 5. Adding Aviapages later

Set `AVIAPAGES_API_KEY` (a plan that permits resale, not the trial) and restart. Their network's
legs join search alongside your direct operators, and the Integrations tab shows sync and budget.
See [AVIAPAGES.md](AVIAPAGES.md).
