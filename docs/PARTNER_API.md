# Turnrow Partner API (v1)

Read-only REST API for partner software, primarily Turnrow Landowner.
Base path: `https://turnrowgrain.com/api/partner/v1`. All responses are JSON.
Written 2026-08-15 from the code, updated 2026-08-17 for the lease-projection
scopes and 2026-08-21 for operating entities (source of truth:
`app/api/partner/v1/*`, `lib/partner-api.ts`, `lib/partner-api-server.ts`,
`lib/partner-marketing.ts`, `lib/partner-marketing-server.ts`,
`lib/entity-marketing.ts`); update this file when those change.

## Operating entities (2026-08-21, additive)

A farm tenant commonly operates through several legal entities. Every
field belongs to a farm, and every farm belongs to ONE **farming entity** —
the entity that farms that ground. Some tenants also have a
**marketing-agent** entity that holds contracts and the hedge account on
behalf of the farming entities; it holds paper, not ground, so it never
appears as a field's entity and never appears in the entity lists below.

- `/fields`, `/plantings`, `/production`, and `/projected-yields` rows carry
  `entity_id` (stable uuid, the field's farm's entity) next to the existing
  `entity` display name. Join any field-keyed row to its entity through
  `/fields` by `field_id`, or read `entity_id` straight off the row. Null when
  the farm has no entity assigned.
- `/handshake` and `POST /shares/redeem` carry `entities`: the farming
  entities behind the shared fields with each one's shared field count.
- `/marketing-prices` adds `by_entity`: the same one-number-per-crop price,
  per farming entity with shared fields.

All of this is additive — existing consumers that ignore the new keys keep
working unchanged.

## Authentication

Bearer token in the Authorization header: `Authorization: Bearer <token>`.

Two token classes:

1. Full-org tokens (`partner_api_tokens`, minted by the platform super-admin
   at /admin, plus the legacy `PARTNER_API_TOKEN` env var). See every
   endpoint, all data for the org.
2. Landowner-share tokens (`partner_shares`, migrations 070/072; prefix
   `trps_`). Minted when a landowner redeems a farmer-created one-time share
   code. Scoped to the fields on the farms belonging to that share's
   landowner. May call: `/handshake`, `/fields`, `/plantings`, `/production`
   (the last only when the share includes yields), and — each behind its own
   opt-in scope, default OFF — `/marketing-prices` and `/projected-yields`.
   The farm-wide endpoints (`/settlements`, `/hedging`, `/crop-year-status`)
   return 403 with code `not_in_share_scope`.

Error semantics:

- 401: missing/unknown/invalid token.
- 403 `share_revoked`: the farmer ended the share ("Your farmer has ended or
  changed this share."). Consumers should flip the connection to an error
  state and surface that message.
- 403 `not_in_share_scope`: a share token hit a farmer-only endpoint, or an
  endpoint whose scope the farmer has not turned on. In the latter case the
  body carries a `scope` field naming it, e.g.
  `{ "error": "This share does not include projected prices.",
  "code": "not_in_share_scope", "scope": "projected_prices" }`. Scope
  changes apply on the next API call — re-check `/handshake` rather than
  caching authorization.

## Share lifecycle

1. Farmer: Settings > Landowner Shares > pick landowner, choose the scopes,
   create. Plantings and harvest status are always shared; **actual yields**
   (on by default), **projected prices**, and **projected yields** (both off
   by default) are separate opt-ins the farmer can flip at any time — the
   change applies on the consumer's next call. A one-time code (format
   `TRW-XXXX-XXXX-XXXX`) is shown exactly once; it expires after 7 days if
   unredeemed. Codes and tokens are stored sha256-hashed.
2. Consumer redeems the code (below), receives the bearer token once, and
   stores it (encrypted at rest on the consumer side).
3. Farmer may end the share at any time; the token then returns 403
   `share_revoked` everywhere.

### POST /shares/redeem (no auth)

Body: `{ "code": "TRW-XXXX-XXXX-XXXX" }` (case-insensitive).

200 response:

```json
{
  "token": "trps_...",
  "handshake": {
    "operation_name": "Turnrow Farm",
    "landowner_name": "Martin Land LLC",
    "label": null,
    "scopes": { "fields": true, "plantings": true, "harvest": true, "yields": true,
                "projected_prices": false, "projected_yields": false },
    "field_count": 42,
    "entities": [
      { "id": "uuid", "name": "Martin Farms LLC", "field_count": 30 },
      { "id": "uuid", "name": "Martin Brothers LP", "field_count": 12 }
    ],
    "api_version": "v1"
  }
}
```

Failures: 404 invalid code, 409 already used, 410 expired, 403 revoked.
Redemption is one-time (guarded against concurrent redeems).

`entities` is the share's entity structure: every FARMING entity that
operates at least one shared field, sorted by name, with the number of shared
fields it operates. Marketing-agent entities never appear. Fields whose farm
has no entity are in `field_count` but in no entity's count, so the counts
may sum to less than `field_count`. The list can change as the farmer
reassigns farms — re-read it with `/handshake` rather than caching it.

### GET /handshake (bearer)

Returns the same handshake object (minus `token`/`label`) for the current
token. Use it to re-check scopes, detect revocation, and refresh `entities`.
Full-org tokens get every farming entity that operates ground, with
org-wide field counts.

## Data endpoints

All list responses are `{ "data": [...] }`. Timestamps are ISO 8601;
`updated_at` supports consumer-side change detection. No pagination is
required of consumers (the server pages internally).

### GET /fields

Field records for the token's scope. No boundary geometry exists in this
system.

```json
{
  "id": "uuid", "name": "North 40", "aliases": [],
  "farm_id": "uuid", "farm_name": "Home Place", "farm_code": "1234",
  "entity_id": "uuid", "entity": "Martin Farms LLC",
  "acres": { "total": 40.0, "irrigated": 32.5, "dryland": 7.5 },
  "updated_at": "2026-05-01T12:00:00Z"
}
```

`entity_id` / `entity` are the field's **operating entity** — the farming
entity its farm belongs to (stable id + display name; both null when the farm
has no entity). The id matches `entities[].id` on the handshake and
`by_entity[].entity_id` on `/marketing-prices`. A field never attributes to a
marketing-agent entity.

### GET /plantings?year=YYYY (year required)

The year's plantings for the token's scope.

```json
{
  "id": "uuid", "field_id": "uuid", "field_name": "North 40",
  "crop": "Corn", "crop_year": 2026,
  "planted_acres": 40.0, "irrigated_acres": 32.5, "dryland_acres": 7.5,
  "planting_date": "2026-04-14",
  "varieties": [{ "variety": "P1197", "acres": 40.0 }],
  "entity_id": "uuid", "entity": "Martin Farms LLC", "updated_at": "..."
}
```

`planting_date` and `varieties` may be null/empty when the farmer has not
recorded them.

### GET /production?year=YYYY[&crop=Name]

Per field and crop production. Each row carries `harvest_status` —
`"complete" | "in_progress" | "unharvested"` — sourced from the same
classification the tenant's Yields page shows (the low-yield in-progress
heuristic plus the crop-level harvest-complete flags, the combine-entry
harvest_complete flags, and the farmer's explicit "count anyway"
overrides), so a partner sees exactly what the farmer sees.

`harvested_acres` follows the status: equal to `planted_acres` when
`harvest_status` is `"complete"`, else 0 (Grain Tracker records production
per load, not a per-field harvested-acre figure, so it cannot know
acres-harvested-to-date for an in-progress field). **Do not divide by
`harvested_acres` until `harvest_status` is `"complete"`.**
`production_units` still flows on in-progress rows so partners can show
harvest progress. Rows with production but no planting record report
`"complete"` with null acres. Cotton fields classify through the same
analysis (their lint lbs come from gin receipts), so they typically read
unharvested until the farmer marks the crop's harvest complete — the lint
poundage flows regardless.

Harvest status is always shared; on a share WITHOUT the yields scope,
`production_units` is returned as null (quantities withheld, harvest
progress intact).

```json
{
  "field_id": "uuid", "field_name": "North 40",
  "entity_id": "uuid", "entity": "Martin Farms LLC",
  "crop": "Corn", "crop_year": 2026,
  "planted_acres": 40.0, "harvested_acres": 40.0,
  "harvest_status": "complete",
  "production_units": 7200, "unit": "bu",
  "updated_at": "..."
}
```

Yield per acre = `production_units / harvested_acres` (bu/ac for grains,
lint lbs/ac for cotton) — valid only once `harvest_status` is
`"complete"`. The field is additive: existing consumers that ignore it
keep working, though `harvested_acres` on a partially-harvested field is
now 0 (previously it read as planted acres as soon as any load existed —
the very number consumers must not average against).

### GET /marketing-prices?year=YYYY (year required; scope `projected_prices`)

The operation's projected average price per crop the token may see (share
tokens: crops planted that year on the share's fields). **One aggregate
number per crop** — by design there are no components, no priced/unpriced
split, no bushel quantities, no acre shares, and no cost or profit data
anywhere on this endpoint, so the tenant's marketing position cannot be
reconstructed from it. Share tokens without the scope get the 403 described
above.

```json
{
  "data": [
    { "crop": "Corn", "crop_year": 2026, "unit": "usd_per_bu",
      "projected_avg_price": 4.63, "is_final": false,
      "as_of": "2026-08-21T12:00:00.000Z" }
  ],
  "by_entity": [
    { "entity_id": "uuid", "entity_name": "Martin Farms LLC",
      "crop": "Corn", "crop_year": 2026, "unit": "usd_per_bu",
      "projected_avg_price": 4.58, "is_final": false,
      "as_of": "2026-08-21T12:00:00.000Z" },
    { "entity_id": "uuid", "entity_name": "Martin Brothers LP",
      "crop": "Corn", "crop_year": 2026, "unit": "usd_per_bu",
      "projected_avg_price": 4.71, "is_final": false,
      "as_of": "2026-08-21T12:00:00.000Z" }
  ]
}
```

- `data` (unchanged): the **whole operation's** average per crop.
- `by_entity` (additive, 2026-08-21): the same number per **farming entity**
  that operates shared fields — one row per entity × crop planted on that
  entity's shared fields. It is the price the tenant's own Marketing
  dashboard shows with that entity selected: the entity's own-name contracts
  and hedges count wholly; positions held by a marketing-agent entity (or
  recorded at the operation level) flow down to it pro rata by its share of
  the crop's planted acres — same per-bushel prices, so the figure is a true
  average for that entity's production. Only entities with shared fields
  appear, and a crop whose per-entity price isn't computable is simply
  omitted from `by_entity` (whereas `data` carries `null`) — never guessed.
  Per-entity prices are not a breakdown of the whole-operation price and do
  not average back to it; use `data` for the operation and `by_entity` for
  the entity that farms a given field (`/fields.entity_id`).

- `unit`: `usd_per_bu` for grains; `cents_per_lb` for cotton (its native
  marketing terms).
- `projected_avg_price` is the same headline number the tenant's own
  Marketing dashboard shows (priced production at its prices, unpriced
  production at the tenant's standing assumptions, realized hedge results
  counted once). Null when nothing is computable yet. Values are recomputed
  per request — there is no `updated_at`; use `as_of`.
- `is_final`: false ⇒ a projection — label it "projected" wherever shown.
  True ⇒ the tenant marked the crop year's physical sales complete, and the
  number is their actual final average price — label it "final".

### GET /projected-yields?year=YYYY (year required; scope `projected_yields`)

Pre-harvest projected yield per shared field × crop, from the tenant's
standing expectations (with an irrigated/dryland breakout where the planting
carries both practices). Distinct from `/production` + the `yields` scope,
which covers harvested actuals. Once a field's harvest is complete, recorded
production replaces the expectation and the row flags `basis: "actual"`.
Fields are strictly the share's field set. Share tokens without the scope get
the 403 described above.

```json
{ "field_id": "uuid", "field_name": "North 40", "entity_id": "uuid",
  "crop": "Corn", "crop_year": 2026, "planted_acres": 100.0,
  "yield_per_acre": 184.0, "unit": "bu_per_ac", "basis": "expected",
  "practices": [
    { "practice": "irrigated", "acres": 60.0, "yield_per_acre": 220.0 },
    { "practice": "dryland",  "acres": 40.0, "yield_per_acre": 130.0 }
  ] }
```

- `unit`: `bu_per_ac` for grains; `lbs_per_ac` (lint) for cotton.
- `entity_id`: the field's operating entity (same value as `/fields`), so a
  yield row can be paired with its entity's `by_entity` price without a join.
- `practices` is null for single-practice fields, and on `basis: "actual"`
  rows whenever the split isn't determinable.
- A crop the tenant has set no yield expectation for is simply absent until
  harvest data exists.

### GET /crop-year-status, /settlements, /hedging (full-org tokens only)

Farmer-facing financial/status endpoints; out of scope for landowner shares.

## Consumer guidance

- Treat the API as intermittently available; cache locally and sync.
- Sync per crop year with upserts; never delete prior years on sync.
- A 403 `share_revoked` should flip the stored connection to an error state
  with the plain-language message, not retry loops.
- Key entity-level data on `entity_id`, never on the display name — farmers
  rename entities. Refresh the entity list from `/handshake` on each sync.
