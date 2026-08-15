# Turnrow Partner API (v1)

Read-only REST API for partner software, primarily Turnrow Landowner.
Base path: `https://turnrowgrain.com/api/partner/v1`. All responses are JSON.
Written 2026-08-15 from the code (source of truth: `app/api/partner/v1/*`,
`lib/partner-api.ts`, `lib/partner-api-server.ts`); update this file when
those change.

## Authentication

Bearer token in the Authorization header: `Authorization: Bearer <token>`.

Two token classes:

1. Full-org tokens (`partner_api_tokens`, minted by the platform super-admin
   at /admin, plus the legacy `PARTNER_API_TOKEN` env var). See every
   endpoint, all data for the org.
2. Landowner-share tokens (`partner_shares`, migration 070; prefix `trps_`).
   Minted when a landowner redeems a farmer-created one-time share code.
   Scoped to the fields on the farms belonging to that share's landowner.
   May call: `/handshake`, `/fields`, `/plantings`, `/production` (the last
   only when the share includes yields). The farm-wide endpoints
   (`/settlements`, `/hedging`, `/crop-year-status`) return 403 with code
   `not_in_share_scope`.

Error semantics:

- 401: missing/unknown/invalid token.
- 403 `share_revoked`: the farmer ended the share ("Your farmer has ended or
  changed this share."). Consumers should flip the connection to an error
  state and surface that message.
- 403 `yields_not_shared`: `/production` called on a share without yields.
- 403 `not_in_share_scope`: a share token hit a farmer-only endpoint.

## Share lifecycle

1. Farmer: Settings > Landowner Shares > pick landowner, choose whether to
   include yields, create. A one-time code (format `TRW-XXXX-XXXX-XXXX`) is
   shown exactly once; it expires after 7 days if unredeemed. Codes and
   tokens are stored sha256-hashed.
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
    "scopes": { "fields": true, "plantings": true, "harvest": true, "yields": true },
    "field_count": 42,
    "api_version": "v1"
  }
}
```

Failures: 404 invalid code, 409 already used, 410 expired, 403 revoked.
Redemption is one-time (guarded against concurrent redeems).

### GET /handshake (bearer)

Returns the same handshake object (minus `token`/`label`) for the current
token. Use it to re-check scopes and detect revocation.

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
  "entity": "Martin Farms LLC",
  "acres": { "total": 40.0, "irrigated": 32.5, "dryland": 7.5 },
  "updated_at": "2026-05-01T12:00:00Z"
}
```

### GET /plantings?year=YYYY (year required)

The year's plantings for the token's scope.

```json
{
  "id": "uuid", "field_id": "uuid", "field_name": "North 40",
  "crop": "Corn", "crop_year": 2026,
  "planted_acres": 40.0, "irrigated_acres": 32.5, "dryland_acres": 7.5,
  "planting_date": "2026-04-14",
  "varieties": [{ "variety": "P1197", "acres": 40.0 }],
  "entity": "Martin Farms LLC", "updated_at": "..."
}
```

`planting_date` and `varieties` may be null/empty when the farmer has not
recorded them.

### GET /production?year=YYYY[&crop=Name] (yields scope required for share tokens)

Per field and crop production. "Harvested" is inferred from recorded
production (loads / gin receipts / combine entries); `harvested_acres`
equals planted acres once anything is produced, else 0.

```json
{
  "field_id": "uuid", "field_name": "North 40", "entity": "Martin Farms LLC",
  "crop": "Corn", "crop_year": 2026,
  "planted_acres": 40.0, "harvested_acres": 40.0,
  "production_units": 7200, "unit": "bu",
  "updated_at": "..."
}
```

Yield per acre = `production_units / harvested_acres` (bu/ac for grains,
lint lbs/ac for cotton).

### GET /crop-year-status, /settlements, /hedging (full-org tokens only)

Farmer-facing financial/status endpoints; out of scope for landowner shares.

## Consumer guidance

- Treat the API as intermittently available; cache locally and sync.
- Sync per crop year with upserts; never delete prior years on sync.
- A 403 `share_revoked` should flip the stored connection to an error state
  with the plain-language message, not retry loops.
