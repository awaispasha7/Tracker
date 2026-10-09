# SkyAccess partner flights

[SkyAccess](https://skyaccess.com) is an empty-leg marketplace (5,000+ live legs, mostly US) that
publishes a free, public MCP server at `https://mcp.skyaccess.com/mcp`. No account, API key or
OAuth is needed ([server docs](https://github.com/sky-access/skyaccess-mcp)).

We use it to show travelers more flights next to our own inventory. SkyAccess flights are **not
ingested or sold by us**: the traveler books and pays on SkyAccess, or asks a SkyAccess specialist
to contact them.

```
traveler search ─┬─► our search index ─────────────► our legs (quote → authorize → confirm)
                 └─► search_empty_legs (MCP) ──────► "More from SkyAccess"
                                                       ├─ Book on SkyAccess   booking_handoff link
                                                       └─ Ask SkyAccess       request_booking → specialist emails traveler
```

## Running it

| `SKYACCESS_MODE` | Behaviour |
| --- | --- |
| `live` (default) | Calls `https://mcp.skyaccess.com/mcp` (override with `SKYACCESS_ENDPOINT`). |
| `mock` | In-process mock with six US flights. Used by the tests and the E2E suite. |
| `off` | Hides the SkyAccess section. |

```
npm run skyaccess:check                         # handshake, tool schemas, one read-only search
npm run skyaccess:check -- "Los Angeles" "Las Vegas"
```

The check never calls `request_booking`. Run it once from a machine with internet access: it
prints the raw shape of a live flight record next to our normalized version, and lists any field
we failed to map.

## Tools used

| MCP tool | Our endpoint | Notes |
| --- | --- | --- |
| `search_empty_legs` | `GET /api/partners/skyaccess/search?from=&to=&date=&flex=&pax=&maxPrice=` | Up to 5 flights. `date ± flex` becomes `departureDateFrom/To`. Identical searches are cached for 60 s. |
| `get_flight` | `GET /api/partners/skyaccess/flights/:flightId` | 404 when SkyAccess no longer publishes it. Adds a `booking_handoff` link if the record has none. |
| `booking_handoff` | (inside the flight endpoint) | Only `https:` links are passed to the browser. |
| `get_charter_estimate` | `GET /api/partners/skyaccess/estimate?from=&to=&pax=&category=` | Indicative full-charter ranges, not a quote. |
| `request_booking` | `POST /api/partners/skyaccess/booking-requests` | See below. |

Ops: `GET /api/admin/skyaccess` returns the live tool list and the latest enquiries.

### Booking requests (`request_booking`)

`POST /api/partners/skyaccess/booking-requests`

```json
{ "flightId": "…", "name": "Ada Lovelace", "email": "ada@example.com", "phone": "+1 555 0100",
  "origin": "TEB", "destination": "PBI", "departureDate": "2026-10-20", "passengers": 4, "notes": "Two dogs" }
```

→ `201 { "id": "sar_…", "status": "sent", "message": "<SkyAccess's reply>", "createdAt": "…" }`

- This is the only call that sends personal data. The UI sends it only after the traveler ticks a
  consent box. It takes no payment and creates no booking: a SkyAccess specialist replies by email.
- We validate the request before anything is sent (name, email, a date that isn't in the past,
  1–50 passengers).
- We map fields to the property names in the server's own `request_booking` input schema (read
  from `tools/list` and cached for an hour). Fields the schema doesn't accept, such as `flightId`
  or `phone`, are dropped, and the phone number is added to `notes`. If SkyAccess starts requiring
  a field we don't have, the request fails with `partner_schema_changed`. It is never sent
  half-filled.
- Every attempt, sent or failed, is stored in `skyaccess_requests`, so there is a record of what
  personal data was sent and when.

## Limits and errors

SkyAccess allows 30 tool calls per minute and 10 `request_booking` calls per hour, **per client IP**.
Every traveler's request comes from our server, so they all share one quota. Searches are cached
for that reason. Errors:

| Situation | Our response |
| --- | --- |
| Rate limited (HTTP 429 / JSON-RPC −32029) | `429 partner_rate_limited`, `details.retryAfterS` |
| Tool reported an error | `422 partner_tool_error` (`get_flight`: 404) |
| Unreachable, timeout, bad reply | `502 partner_unavailable` |

The search UI shows a short message in place of the SkyAccess section. Our own results are never
affected.

For higher volume, SkyAccess also offers a Partner API (see skyaccess.com/become-a-broker).
