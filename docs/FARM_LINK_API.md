# Turnrow Farm link API (v1)

The private API between Turnrow Grain and Turnrow Farm (the same owner's farm
management product). Written 2026-09-17; crop insurance and two-way landowners
added 2026-09-21, from the code (source of truth: `app/api/farm-link/v1/*`,
`lib/farm-link.ts`, `lib/farm-link-server.ts`, `lib/farm-link-outbound.ts`,
`lib/farm-link-landowners.ts`, `lib/landowner-match.ts`, migrations
`supabase/087_farm_link.sql`, `supabase/088_farm_link_insurance.sql` and
`supabase/089_farm_link_landowners.sql`); update this file when those change. Part B (the Turnrow Farm side) is written against
this document.

Decisions on record: **Turnrow Farm is the master for entities, farms, fields,
boundaries, and plantings** — with ONE exception, landowners, which from 089 are
shared both ways and merged field by field (see `landowners:write`). Grain is the master for loads, bins, contracts,
hedging, settlements, yields, crop insurance, government payments, and
marketing prices. Both hold the same organization's own data, so unlike the
landowner partner API this link carries financial detail in both directions.

Base URL: `https://<grain host>/api/farm-link/v1`. Every response is JSON. All
timestamps are ISO-8601 UTC. Every record carries `updated_at`.

## Pairing and authentication

1. The Grain owner opens **Settings > Turnrow Farm Link** and generates a
   pairing code: `fl_` + 32 hex characters. It is shown once, stored sha256,
   and expires 7 days after generation. One live (pending or active) link per
   organization.
2. Turnrow Farm redeems it:

   ```
   POST /handshake
   { "code": "fl_…", "farm_org_id": "<Farm organization uuid>", "farm_org_name": "Turnrow Farms" }
   ```

   Response `200`:

   ```json
   { "token": "flt_…", "grain_org_id": "uuid", "grain_org_name": "Turnrow Farm",
     "scopes": ["land:write","production:read","marketing:read","income:read","bins:read","assumptions:write","settlements:write"],
     "api_version": "v1",
     "base_urls": { "api": "…/api/farm-link/v1", "land_snapshot": "…", "land_link": "…", "land_sync": "…",
                    "production": "…", "marketing": "…", "income": "…", "bins": "…", "assumptions": "…", "settlements": "…", "status": "…" } }
   ```

   The token (`flt_` + 48 hex) is returned ONCE and stored sha256 in Grain.
   Errors: `400` malformed body; `404 invalid_code`; `403 link_revoked`;
   `409 code_used` (one redemption); `410 code_expired`.
3. Every other call: `Authorization: Bearer flt_…`. Grain resolves the token
   to its organization and runs every query with the service role scoped to
   that `org_id`.

Error semantics on authenticated calls:

- `401` — unknown token, a revoked link (`code: link_revoked`), or a link that
  never completed the handshake (`link_pending`). Treat a 401 as "reconnect".
- `403 missing_scope` — the owner turned that direction off; the body carries
  `scope`. Re-check `GET /status` rather than caching authorization; scope
  changes apply on the next call.
- `429 rate_limited` — more than 240 calls per minute on one link (per server
  instance). Back off a minute.
- `400` — a malformed parameter or body, with the reason.
- `500` — Grain-side failure; the body carries the message.

Every call is logged with counts (`farm_link_calls`, trimmed to 30 days) and
stamps the link's `last_seen_at`. Inbound writes and outbound pulls record
`last_sync.inbound` / `last_sync.outbound` on the link, which the Grain
settings page shows.

### GET /status

```json
{ "grain_org_id": "uuid", "grain_org_name": "…", "farm_org_id": "uuid", "farm_org_name": "…",
  "status": "active", "scopes": [...], "land_managed_in_farm": true,
  "last_sync": { "inbound": { "at": "…", "endpoint": "land/sync", "counts": {...}, "conflicts": 0 },
                 "outbound": { "at": "…", "endpoint": "production", "count": 120 } }, "api_version": "v1" }
```

`land_managed_in_farm` becomes true after the first successful `land/sync`;
from then on Grain's own land forms and importers refuse with "Land records
are managed in Turnrow Farm."

### Rotation and revocation

The owner can **rotate** the token (a new `flt_` shown once; the old one 401s
immediately — paste the new one into Farm) or **revoke** the link (every call
401s with `link_revoked`; synced land stays in Grain and becomes editable
again). Farm should surface either as "reconnect in Turnrow Grain".

## Scopes

| Scope | Direction | Endpoints |
| --- | --- | --- |
| `land:write` | Farm → Grain | `GET /land/snapshot`, `POST /land/link`, `POST /land/sync` |
| `production:read` | Grain → Farm | `GET /production` |
| `marketing:read` | Grain → Farm | `GET /marketing` |
| `income:read` | Grain → Farm | `GET /income` |
| `bins:read` | Grain → Farm | `GET /bins` |
| `insurance:read` | Grain → Farm | `GET /insurance` |
| `landowners:write` | **both ways** | `GET /landowners`, `POST /landowners/sync`, `POST /landowners/merge`, `POST /landowners/archive`, `GET /lease-terms`, `POST /lease-terms/managed` |
| `assumptions:write` | Farm → Grain | `POST /assumptions` |
| `settlements:write` | Farm → Grain | `POST /settlements` |

All nine are granted at pairing; the Grain owner can remove any.

`landowners:write` is ONE scope for the pull and the writes on purpose: a
landowner is shared both ways, and reading them without being able to write
back has no use.

`insurance:read` (088) and `landowners:write` (089) arrived after the first
pairings. A pairing made before a scope existed keeps the scopes it was
granted, so the endpoint answers 403 with
`{"code": "missing_scope", "scope": "<the scope>"}` — the Farm side reads
`scope` off that body and tells the owner to turn the switch on under Settings
› Turnrow Farm link in Grain, or to re-pair.

## Keys: the id map

Grain never stores Farm uuids on its core tables. `farm_link_ids` maps
`(grain_table, grain_id) ↔ farm_uid` per organization, with BOTH sides unique.
`grain_table` is one of `entities`, `farms`, `fields`, `field_plantings`,
`field_planting_varieties`, `crops`, `landowners`. `farm_uid` is Farm's uuid,
except for crops where it is Farm's crop **slug** (Farm's crops table is
slug-keyed). Every outbound record carries the mapped Farm uuid when the row is
linked, so Farm needs no matching on the way back.

Shape mapping (from Farm's `docs/SEMANTIC_LAYER.md`):

| Turnrow Farm | Turnrow Grain |
| --- | --- |
| entities.name, entity_role | entities.name, entity_role (`farming` \| `marketing_agent`) |
| farms.name + fsa_number | farms.name + fsa_number (exposed as `farm_code`) |
| farms.county_id | farms.county_id via the shared counties reference — sent as `county` + `state` (two-letter) |
| lease: crop_share pct / cash rate | farms.is_share_rent + landlord_share_percentage / cash_rent_per_acre |
| farms.landowner_id | farms.landowner_id (Grain landowners, matched by farm_uid then name) |
| fields.name within farm | fields.name_or_number within farm |
| crops.grain_name | crops.name (per organization) |
| field_crops (field × crop × crop_year) | field_plantings (field × crop × season_year) |
| field_crops.preceding_field_crop_id | field_plantings.paired_planting_id |
| field_crops.varieties [{variety, acres}] | field_planting_varieties rows |
| lease_years.id | landowner_settlements.farm_uid |

## Land, inbound (`land:write`)

### GET /land/snapshot?season_years=2025,2026

Everything Grain holds so Farm can match before it writes. `season_years`
(comma list; `season_year` also accepted) limits plantings; omit for all
years. Archived rows are omitted.

```json
{ "data": {
    "entities": [{ "id": "uuid", "name": "…", "entity_role": "farming", "managed_by": null, "farm_uid": null, "updated_at": "…" }],
    "landowners": [{ "id": "uuid", "name": "…", "farm_uid": null, "updated_at": "…" }],
    "farms": [{ "id": "uuid", "name": "…", "entity_id": "uuid", "farm_code": "1234", "county": "Lawrence", "state": "AL",
                "landowner_id": null, "is_share_rent": true, "landlord_share_percentage": 33.33, "cash_rent_per_acre": null,
                "managed_by": null, "farm_uid": null, "updated_at": "…" }],
    "fields": [{ "id": "uuid", "farm_id": "uuid", "name_or_number": "North 40", "total_acres": 40, "irrigated_acres": 0,
                 "county": "Lawrence", "state": "AL", "managed_by": null, "farm_uid": null, "updated_at": "…" }],
    "crops": [{ "id": "uuid", "name": "Corn", "harvest_category": "fall", "double_crop": false, "farm_uid": null, "updated_at": "…" }],
    "field_plantings": [{ "id": "uuid", "field_id": "uuid", "crop_id": "uuid", "season_year": 2026, "planted_acres": 40,
                          "planting_date": "2026-04-10", "paired_planting_id": null, "irrigated_acres": 0,
                          "varieties": [{ "id": "uuid", "variety": "DKC 68-35", "acres": 40, "bushels": null, "farm_uid": null }],
                          "managed_by": null, "farm_uid": null, "updated_at": "…" }]
  }, "season_years": [2025, 2026], "generated_at": "…" }
```

### POST /land/link

```json
{ "links": [{ "grain_table": "farms", "grain_id": "uuid", "farm_uid": "uuid" }] }
```

Writes the id map for matches Farm confirmed after review (at most 2,000 per
call, one transaction). Each result is `linked`, `unchanged` (identical pair
already mapped), or `rejected` with the reason — a `grain_id` or `farm_uid`
already mapped elsewhere is never re-pointed; unknown tables/ids and
duplicates within the request reject too. Linked land rows are marked
`managed_by = 'turnrow_farm'`.

```json
{ "data": [{ "grain_table": "farms", "grain_id": "…", "farm_uid": "…", "action": "linked" }],
  "counts": { "linked": 12, "unchanged": 3, "rejected": 0 } }
```

### POST /land/sync

Idempotent upserts keyed on `farm_uid` through the id map: create when
unmapped (after a by-name match attempt — see below), update when mapped.
Up to **500 records per batch**, applied in dependency order inside **one
transaction** (`farm_link_apply`); a failing batch rolls back entirely and
returns `409 batch_rolled_back` with the planned results for diagnosis.

```json
{ "entities":   [{ "farm_uid": "uuid", "name": "…", "entity_role": "farming" }],
  "landowners": [{ "farm_uid": "uuid", "name": "…" }],
  "crops":      [{ "farm_uid": "sunflower", "name": "Sunflower", "harvest_category": "fall", "double_crop": false }],
  "farms":      [{ "farm_uid": "uuid", "name": "…", "entity_farm_uid": "uuid", "farm_code": "1234", "county": "Lawrence", "state": "AL",
                   "landowner_farm_uid": "uuid", "is_share_rent": true, "landlord_share_percentage": 33.33, "cash_rent_per_acre": null }],
  "fields":     [{ "farm_uid": "uuid", "farm_farm_uid": "uuid", "name_or_number": "North 40", "total_acres": 40, "irrigated_acres": 0,
                   "county": "Lawrence", "state": "AL" }],
  "plantings":  [{ "farm_uid": "uuid", "field_farm_uid": "uuid", "crop": "Corn", "season_year": 2026, "planted_acres": 40,
                   "irrigated_acres": 0, "planting_date": "2026-04-10", "preceding_farm_uid": null,
                   "varieties": [{ "variety": "DKC 68-35", "acres": 40 }] }],
  "deletions":  [{ "grain_table": "field_plantings", "farm_uid": "uuid" }] }
```

Rules:

- **Order** is entities → landowners → crops → farms → fields → plantings
  → pairing → deletions, whatever order the arrays arrive in. A parent may be
  created in the same batch (the child references it by `*_farm_uid`); a
  parent that is neither mapped, matched, nor in the batch refuses the child
  with the reason.
- **By-name matching** on first contact (Farm's documented keys): entities and
  landowners by name; farms by name (+ FSA number when both sides have one;
  the entity breaks ties); fields by name within the farm; plantings by field ×
  crop × season_year; crops by name. A match writes the id map with
  `linked_by: match`.
- **Counties** resolve by name + two-letter state through Grain's counties
  table; a county without a state, or an unknown county, refuses the record.
- **Crops**: a name Grain lacks (Sunflower) becomes a per-organization crop
  with `harvest_category`/`double_crop` from the batch's `crops` entry, or the
  defaults (fall, false) when a planting simply names it. A `crops` entry
  without `farm_uid` keys on the name alone.
- **Plantings**: `crop` is the crop name; `preceding_farm_uid` becomes
  `paired_planting_id` (resolved from the id map or the same batch, in any
  order; an unknown preceding planting leaves the pairing as is and notes it in
  `reason`). `varieties` (objects or plain strings) replace the planting's
  variety rows **as a set**; omit the key to leave varieties alone.
  `dryland_acres` derives from planted − irrigated on Grain's side.
- **Only sent fields change.** An update touches the columns whose values
  differ; an untouched Grain column is never clobbered.
- **Conflict rule.** A Grain row whose `managed_by` is null (created or
  matched in Grain, never written by the link) and whose `updated_at` is later
  than the last inbound sync — or that has never been synced — is returned as
  `conflict` with `grain_values` (Grain's current values for the fields Farm
  sent) and is **never overwritten silently**. Farm resolves it: accept Grain's
  values, or resend the record with `"force": true` to overwrite. Identical
  values are `unchanged` and mark the row managed. Once `managed_by =
  'turnrow_farm'`, Farm's values win.
- **Every written or matched row gets `managed_by = 'turnrow_farm'`** and
  becomes read-only in Grain's UI (landowners excepted — Grain keeps their
  contact details).
- **Deletions are archive requests.** Grain sets `archived_at` and never
  deletes. It **refuses** to archive a field or planting that carries loads,
  load splits, combine yield entries, gin receipts, or yield breakouts
  (`refused` with the reason); a farm with active fields, or an entity with
  active farms, is refused until those archive first (same batch counts).
  Archived rows drop out of the snapshot and Grain's pages.

Response — every record with its action and reason:

```json
{ "data": [
    { "grain_table": "farms", "farm_uid": "…", "grain_id": "…", "action": "created" },
    { "grain_table": "fields", "farm_uid": "…", "grain_id": "…", "action": "updated" },
    { "grain_table": "field_plantings", "farm_uid": "…", "grain_id": "…", "action": "conflict",
      "reason": "edited in Turnrow Grain since the last sync; send force: true to overwrite with Turnrow Farm's values",
      "grain_values": { "planted_acres": 42 } },
    { "grain_table": "fields", "farm_uid": "…", "grain_id": "…", "action": "refused", "reason": "field has loads, yields, or settlements in Turnrow Grain" },
    { "grain_table": "field_plantings", "farm_uid": "…", "grain_id": "…", "action": "archived" } ],
  "counts": { "created": 1, "updated": 1, "unchanged": 0, "conflict": 1, "refused": 1, "archived": 1, "records": 5 },
  "synced_at": "…" }
```

Actions: `created` | `updated` | `unchanged` | `conflict` | `refused` |
`archived`. After a successful sync (any response other than a rollback),
`land_managed_in_farm` is true.

## Outbound (`*:read`)

All five endpoints share the paging contract: `?limit=` (default 500, max
1,000) and `?cursor=` (opaque; from the previous response's `next_cursor`,
ordered by `updated_at` then id), plus `?since=` (ISO date/timestamp; keeps
records with `updated_at >= since`). Response envelope:

```json
{ "data": [...], "next_cursor": "…" | null, "crop_year": 2026, "generated_at": "…" }
```

The marketing, income, and bins figures are computed per request (their
`updated_at` is the generation time); production carries the newest
contributing row's `updated_at`.

### GET /production?season_year=2026 (`crop_year` also accepted)

One record per field planting (fields with production but no planting
appear keyed on `field|crop|year`). The same classification and quantities
the Yields pages show.

```json
{ "id": "planting uuid", "planting_id": "uuid", "planting_farm_uid": "uuid|null", "field_id": "uuid", "field_farm_uid": "uuid|null",
  "field_name": "North 40", "farm_id": "uuid", "entity_id": "uuid|null", "entity": "…", "crop": "Corn", "crop_year": 2026,
  "planted_acres": 40, "harvest_status": "complete", "harvested_acres": 40, "production": 7400, "unit": "bu",
  "yield_per_acre": 185, "yield_unit": "bu_per_ac", "moisture": 16.4, "source": "combine_yield_entries", "updated_at": "…" }
```

- `unit`: dry bushels (`bu`) for grains, lint pounds (`lbs`) for cotton;
  `yield_unit` follows.
- `harvest_status`: `complete` | `in_progress` | `unharvested`, exactly the
  Yields page's classification (crop-level harvest-complete flags, combine
  entry flags, the "count anyway" override). `harvested_acres` equals planted
  acres when complete, else 0 — Grain has no per-field harvested-acre figure;
  do not divide until complete.
- `yield_per_acre` is the actual only once complete (null while in progress).
- `moisture` is net-lb-weighted over the field's weighed loads (splits
  pro-rated); null for cotton and combine-only fields.
- `source`: Grain's precedence — a combine entry replaces weighed loads for
  the field × crop × year (`combine_yield_entries`), else `loads`; cotton
  is `gin_receipts`.

### GET /marketing?crop_year=2026

Per crop (whole operation, `entity_id: null`) and per farming entity.

```json
{ "id": "cropId|entityId", "crop_id": "uuid", "crop": "Corn", "crop_year": 2026, "entity_id": null, "entity_name": null, "entity_farm_uid": null,
  "unit": "usd_per_bu", "quantity_unit": "bu",
  "settled_average_price": 4.35, "settled_quantity": 4000, "settled_revenue": 17400, "settled_attribution": "operation",
  "projected_average_price": 4.37, "price_is_final": false,
  "basis": { "average": -0.30, "state": "blended", "assumed": -0.35, "locked_quantity": 9000, "assumed_quantity": 9000 },
  "percent_sold": 50, "sold_quantity": 9000, "total_production": 18000, "production_basis": "estimated",
  "hedging_realized": { "net": 1250, "per_unit": 0.0694 },
  "basis_notes": ["basis blends locked contracts with the assumed basis on unpriced bushels"], "as_of": "…", "updated_at": "…" }
```

- **Cotton** rows: `unit: cents_per_lb` (¢/lb as Grain stores it),
  `quantity_unit: lbs` (lint); settled figures come from the physical cotton
  sales (sold lbs and dollars); `sold_quantity` is sold lint.
- `settled_average_price` (grain) = settlement lines' net revenue ÷ net
  units for the crop year's matched loads (net of the statement's
  deductions, as Grain records them). Entity rows carry the entity's acre
  share (`settled_attribution: by_acres`).
- `projected_average_price` is the Marketing dashboard's headline (futures
  average + basis, blended once assumptions apply); `price_is_final` is the
  Settings > Crops "physical sales complete" flag.
- `percent_sold` = contracted (plus seed-committed) bushels ÷ total
  production, capped at 100; cotton uses sold lint ÷ production.
- `hedging_realized.net` = closed futures (net of commission) + closed
  options, the figure the dashboard folds into the price.
- Entity rows are the dashboard with that entity selected: own-name
  positions whole, agent-held / operation-level positions pro rata by the
  entity's acre share of the crop (lib/entity-scope.ts).

### GET /income?crop_year=2026

Per crop × entity (whole-operation rows first, `entity_id: null`). Grain
attributes nothing to a single field planting, so no per-planting rows are
emitted; the `attribution` fields state the basis Grain uses.

```json
{ "id": "cropId|all", "crop_id": "uuid", "crop": "Corn", "crop_year": 2026, "entity_id": null, "entity_name": null, "entity_farm_uid": null,
  "unit": "bu", "acres": 300, "total_production": 54000,
  "crop_revenue": { "total": 235980, "components": { "settled_revenue": 17400, "hedging_realized": 1250, "checkoff": 40, "fees": 12.5 }, "attribution": "operation" },
  "government_payments": { "total": 6750, "arc_plc": 6000, "other_crop_specific": 0, "other_allocated": 750,
    "by_program_farm": [{ "program": "PLC", "farm_id": "uuid", "farm_code": "1234", "farm_farm_uid": "uuid", "commodity": "Corn", "net": 6000 }],
    "attribution": "by_acres" },
  "crop_insurance": { "indemnities": 2000, "premium": 5000, "net": -3000, "attribution": "by_entity" },
  "other_income": { "total": 0 }, "total_revenue": 239730, "as_of": "…", "updated_at": "…" }
```

- `crop_revenue.total` is the Revenue Projections figure: settlements,
  contracts, unpriced bushels at the market/assumed price, and realized
  hedging folded in exactly once (never re-summed from the components, which
  are informational: settled dollars, realized hedging, checkoff and fees from
  the settlements' itemized deductions).
- Government payments: ARC/PLC projected per FSA farm × commodity for the
  program year (payment received in this crop year), filtered to the
  entity's farms, then **allocated to crops by planted-acre share**; other
  USDA payments go whole to their crop when crop-specific, else by acre
  share. `by_program_farm` lists the pieces with the FSA farm number and the
  farm's Farm uuid.
- Crop insurance: policies attribute by their **own entity**; indemnities are
  Grain's projections (RP/YP/area plans + SCO/ECO/STAX/MCO) at the current
  harvest-price tier; `net` = indemnities − premium.
- `other_income` is reserved (always 0 today).

### GET /bins?crop_year=2026&as_of=2026-09-17

Per bin × crop.

```json
{ "id": "binId|cropId", "bin_id": "uuid", "bin_name": "Bin 1", "site_id": "uuid", "site_name": "Home", "entity_id": "uuid", "entity_farm_uid": "uuid|null",
  "capacity_bushels": 20000, "crop_id": "uuid", "crop": "Corn", "crop_year": 2026, "as_of": "…",
  "bushels_on_hand": 2300, "bushels_in_for_year": 2000, "updated_at": "…" }
```

- `bushels_on_hand` is the /inventory page's assembly as of `as_of`: dry
  bushels in − out on loads, ± inventory adjustments, ± bin-to-bin
  transfers, + netted combine remainders.
- `bushels_in_for_year`: dry bushels delivered INTO the bin on loads of the
  crop year (+ that year's positive combine remainders) on or before `as_of`.
- Transfers are not loads and never touch production or marketing.

### GET /insurance?crop_year=2026 (`insurance:read`)

The crop insurance premiums Grain already allocates by entity and crop, so the
Farm side's cost per acre does not ask for them a second time. One row per
**entity × crop × practice** for the crop year. Envelope:

```json
{ "crop_year": 2026, "generated_at": "…", "rows": [ … ], "data": [ … ], "next_cursor": null }
```

`rows` is this endpoint's name for the page; `data` is the same array under the
name the other four pulls use, so a generic pager works here unchanged. `?since=`,
`?limit=`, and `?cursor=` behave exactly as on `/production`.

```json
{ "id": "entityId|cropId|irrigated|2026", "entity_code": "F-ENT-1", "entity_id": "uuid|null", "entity_name": "Turnrow Farms LLC",
  "entity_farm_uid": "F-ENT-1", "crop_id": "uuid", "crop": "Corn", "crop_year": 2026,
  "practice": "irrigated", "plan": "RP", "coverage_level": 0.8, "unit_structure": "enterprise",
  "acres_insured": 640, "producer_premium": 18240, "subsidy": 27360, "total_premium": 45600,
  "indemnity_received": null, "indemnity_expected": 0, "allocation_basis": "entity_crop",
  "effective_date": null, "policy_count": 2, "updated_at": "…" }
```

- **The aggregation.** Grain carries crop insurance per POLICY — entity × crop ×
  county × crop year × practice, plus its SCO / ECO / STAX / MCO riders. Two
  policies for the same entity, crop, and practice in different counties sum
  into one row. Nothing in Grain is per field, so `allocation_basis` is always
  `entity_crop` and the Farm side spreads by planted acres. A policy with no
  entity rolls up to a single operation-level row (`entity_id: null`,
  `entity_code: null`, id prefix `operation`).
- `entity_code` is the Farm side's key for the entity (the id map's `farm_uid`),
  `null` until the land sync has linked that entity — match on `entity_name`
  then. `entity_farm_uid` is the same value under the name the other four pulls
  use.
- `practice`: `irrigated` or `dryland` (Grain stores `non_irrigated`). `null` is
  reserved for a policy that does not split by practice; Grain's schema always
  splits, so it does not occur today.
- `producer_premium` is the **farmer-paid** premium — the base policy plus every
  rider — the same figure the Claims Monitor and `/income` subtract. It is the
  number the Farm side records as a cost.
- `subsidy` and `total_premium` are informational and derived from the policy's
  `premium_subsidy_pct`: the stored premium is AFTER subsidy, so
  `subsidy = producer × pct ÷ (100 − pct)` and `total_premium = producer +
  subsidy`. The percentage lives on the base policy only, so rider premiums
  raise `producer_premium` and `total_premium` without adding subsidy. A row
  whose policies carry no percentage returns `null` for both rather than a
  made-up zero. **Note the name:** the API's `total_premium` is the GROSS
  premium; Grain's `crop_insurance_policies.total_premium` column is the
  producer-paid one.
- `plan` is `RP`, `YP`, `RPHPE`, `ARP`, or `other` (`other` covers AYP and any
  row whose policies disagree). `unit_structure` is `basic`, `optional`,
  `enterprise`, or `mixed` when the policies disagree. `coverage_level` is
  acre-weighted across the row's policies.
- `indemnity_expected` is Grain's projection at the current harvest-price tier
  (RP/YP/area plans + SCO/ECO/STAX/MCO). `indemnity_received` repeats it only
  once **every** contributing policy resolves to a FINAL harvest price — Grain
  records no cheque, so a number that could still move is never called received.
  Both are informational here: indemnities already flow through `/income`, and
  they stay there.
- `effective_date` is always `null`. Grain records the crop year, not a sales
  closing or policy date; the field is in the contract for when it does.
- `policy_count` is how many policies (not riders) rolled into the row.
- **Deletions.** A deleted policy is not by itself a deleted row — the row only
  goes away once nothing covers that entity × crop × practice any more. On a
  `?since=` pull, a key that has gone comes back as
  `{ "id": …, "deleted": true, "updated_at": "<when it went>" , … }` with zeroed
  figures, so the Farm side can remove it. A full pull (no `?since=`) is the
  current picture and never carries `deleted` rows. Removing a RIDER off a
  policy that is still there does not touch the policy's own `updated_at`, so
  that too is recorded and moves the row's `updated_at` — a delta pull sees the
  new premium. (`crop_insurance_deletions`, written by triggers in 088.)
- Every call is written to the sync log (`farm_link_calls`) with the endpoint,
  the token's link, the rows returned, the deleted count, and the elapsed time,
  exactly as the other pulls are.

## Landowners, both ways (`landowners:write`)

Landowners are the ONE exception to "Farm is the master for the land tables".
Grain is where the rent settlement, the partner share, and the payee name live,
so the farmer edits landowners on both sides. From 089 a landowner is a record
either side may edit, merged **field by field**, with conflicts surfaced rather
than overwritten. Everything else on the land tables, every lease, and every
landowner statement stays Farm's.

### The shared fields

`name`, `kind` (`individual` | `family` | `company` | `trust` | `estate` |
`government` | `other`), `contact_name`, `phone`, `email`, `address_street`,
`address_city`, `address_state`, `address_zip`, `payee_name`, `notes`.

Grain's pre-089 free-text `address` is kept and split into the parts where it
parses ("123 Main St, Greenville, MS 38701"); where it does not, the whole
string stays in `address_street`. Nothing is ever discarded.

### Name matching

Both sides normalize a landowner name the same way (`lib/landowner-match.ts`):
case and punctuation go, `&` reads as "and", `/` as a separator, "Estate of X"
as X, and the legal form (LLC, Inc, Co, Ltd…) and the "Farm(s)" descriptor are
dropped. So "Smith Family Farms, LLC" and "Smith Family Farm LLC" are one
landowner. Deliberately NOT collapsed: "Mary Smith Trust" against "Mary Smith",
and "Smith Family Farms" against "Smith Farms" — those are different legal
payees and come back as *near* matches for a person to decide on.

### GET /landowners?since=&cursor=&limit=

Every landowner, **archived and merged rows included** (the Farm side needs to
see an archive to mirror it). Paging and `?since=` exactly as `/production`.

```json
{ "id": "uuid", "farm_uid": "F-LO-1|null", "name": "Smith Farms", "kind": "company",
  "contact_name": "Ann Smith", "phone": "…", "email": "…",
  "address_street": "1 Main St", "address_city": "Greenville", "address_state": "MS", "address_zip": "38701",
  "payee_name": "Smith Farms LLC", "notes": null,
  "archived_at": null, "merged_into_id": null, "merged_into_farm_uid": null,
  "share_active": true, "share_scopes": ["yields", "settlements"], "share_last_viewed_at": "…",
  "changes": [{ "field": "phone", "old": "555-0100", "new": "555-0999", "changed_at": "…", "changed_by": "<user uuid>" }],
  "updated_at": "…" }
```

- `farm_uid` is null until the landowner is linked; match on `name` then.
- `share_*` are **read-only facts** about the landowner's Turnrow Landowner
  share — is it live, what the farmer switched on, and whether the landowner
  has ever opened it. Nothing about any other organization is ever included.
- `changes` is Grain's own per-field history since `?since=`
  (`landowner_field_changes`, kept 90 days). **A change the link itself wrote
  is never listed** — Farm's own edits cannot come back at it as Grain's.

### POST /landowners/sync

```json
{ "rows": [{ "farm_uid": "F-LO-1", "grain_id": "uuid (optional)",
             "fields": { "phone": "555-0999", "payee_name": "Smith Farms LLC" },
             "base": { "phone": "2026-02-01T00:00:00Z", "payee_name": "2026-02-01T00:00:00Z" },
             "create": false }] }
```

`base` is when Farm last saw Grain's value for that field. **The rule:** a field
applies unless Grain's own change log shows a change to it AFTER that base AND
to a different value than Farm is sending. Those fields come back as conflicts
carrying Grain's value and when it changed; every other field in the row still
applies. A Grain change to the *same* value Farm is sending is not a conflict —
the two sides simply agree. A field with **no base** is treated as base = the
beginning of time, so any Grain change conflicts: missing information surfaces,
it never silently overwrites.

A row with no `grain_id` and no id map entry is created **only** when
`create: true` (Farm has already run its duplicate search). Otherwise it answers
`unmatched` with Grain's closest names so Farm can offer a link. Up to 500 rows,
one transaction.

```json
{ "data": [
    { "farm_uid": "F-LO-1", "grain_id": "uuid", "action": "conflict",
      "applied": ["payee_name"],
      "conflicts": [{ "field": "phone", "grain_value": "555-0100", "farm_value": "555-0999",
                      "changed_at": "…", "changed_by": "<user uuid>" }] },
    { "farm_uid": "F-NEW", "grain_id": null, "action": "unmatched",
      "candidates": [{ "grain_id": "uuid", "name": "Smith Farms", "score": 1, "kind": "exact" }] }],
  "counts": { "rows": 2, "created": 0, "updated": 0, "unchanged": 0, "conflict": 1, "unmatched": 1, "refused": 0 } }
```

Every row answers `created` | `updated` | `unchanged` | `conflict` |
`unmatched` | `refused` with a reason. Writes are stamped
`changed_by: 'turnrow_farm'`.

### POST /landowners/merge

```json
{ "survivor_grain_id": "uuid", "merged_grain_id": "uuid", "move_share": false }
```

Moves farms, lease terms, rent settlements, and landowner statements to the
survivor, then sets `merged_into_id` + `archived_at` on the other. One
transaction. **Refuses (409 `share_active`) when the merged landowner has a
live Turnrow Landowner share** unless `move_share: true`, which moves the share
too — silently moving someone's live share is a surprise, not a merge.

```json
{ "survivor_grain_id": "…", "merged_grain_id": "…",
  "moved": { "farms": 3, "lease_terms": 1, "rent_settlements": 2, "landowner_settlements": 1, "partner_shares": 0 } }
```

### POST /landowners/archive

```json
{ "grain_id": "uuid" }
```

Archives (Grain archives, never deletes). Refuses with 409 and the reason when
the landowner has a live share (`share_active`) or a rent settlement in an open
crop year (`open_settlement`, the current calendar year or later) — archiving
someone Stuart is still settling with would drop them out of the Rent
Settlement report mid-season.

### GET /lease-terms?since=

Every `lease_terms` row Farm has **not yet adopted**, as proposals: Farm reads
these once, builds the lease over there, then calls `/lease-terms/managed`.

```json
{ "id": "uuid", "landowner_grain_id": "uuid", "landowner_farm_uid": "F-LO-1", "landowner_name": "Smith Farms",
  "farm_grain_ids": ["uuid"], "farm_farm_uids": ["F-FARM-1"], "lease_type": "crop_share",
  "share_terms": {…}, "expense_terms": {…}, "pricing_method": {…}, "cash_terms": {…}, "flex_terms": {…},
  "payment_timing": "at settlement", "notes": null,
  "source_document_url": "<signed, 15 minutes>", "source_document_name": "lease.pdf", "updated_at": "…" }
```

The terms json goes out exactly as Grain stores it. The lease document is a
**short-lived signed URL** (15 minutes) — the link never hands out a durable
link to a file.

### POST /lease-terms/managed

```json
{ "grain_id": "uuid", "farm_lease_uid": "<Farm lease id>" }
```

Marks the lease managed in Turnrow Farm: read-only in Grain's UI with a link
over there, and no longer offered by `GET /lease-terms`.

## Inbound (`assumptions:write`, `settlements:write`)

### POST /assumptions

```json
{ "crop_year": 2026, "includes_insurance": true,
  "rows": [{ "crop": "Corn", "cost_per_acre": 600, "cost_per_acre_irrigated": 700, "cost_per_acre_dryland": 500,
             "cost_per_acre_dc_irrigated": null, "cost_per_acre_dc_dryland": 350, "source": "budget", "computed_at": "…" }] }
```

`includes_insurance` (088, optional, default `false`) says the pushed cost per
acre **already carries the crop insurance premium** — which it will once the
Farm side's insurance pull is running. Grain stores it on the crop year's
`crop_assumptions` rows (`cost_includes_insurance`) and then stops charging its
own premium a second time: every margin built on those rows counts the
**indemnity alone** instead of indemnity − premium (Revenue Projections, the
`/income` pull, and Ask Turnrow's revenue tool all go through the one engine,
`computeRevenueProjections`). The Marketing dashboard's cost line and the
Revenue Projections report say *"Insurance included in the Turnrow Farm cost per
acre"* beside the figure. Absent or `false` behaves exactly as before. The flag
is echoed back on the response. Grain's breakeven has never included insurance,
so it is unaffected either way.

Writes `crop_assumptions.cost_per_acre` and the four breakouts for the
organization's crop (matched by name) and crop year, stamping `cost_source =
'turnrow_farm'` and `cost_source_updated_at` (= `computed_at`, else now), so
the Marketing report shows "Cost/ac from Turnrow Farm, updated <date>" with a
**Use my own costs** switch. A crop whose switch is on is `skipped` and says
so; an unknown crop is `skipped` ("sync land first"). Budget scenarios for
the crop year marked **Follow Turnrow Farm costs** get their crop lines'
`cost_per_acre` from the matching breakout (irrigated/non-irrigated ×
full-season/double-crop; blended cells take the overall figure). Yields,
basis, futures, and acres assumptions are never touched.

```json
{ "data": [{ "crop": "Corn", "action": "updated", "budget_lines_updated": 3 },
           { "crop": "Soybean", "action": "skipped", "reason": "manual override is on in Turnrow Grain for this crop year", "budget_lines_updated": 0 }],
  "counts": { "rows": 2, "updated": 1, "skipped": 1, "budget_lines": 3 }, "crop_year": 2026 }
```

### POST /settlements

```json
{ "settlements": [{ "farm_uid": "<lease_years.id>", "landowner_name": "Smith Family Trust", "landowner_farm_uid": "<Farm landowner uuid>",
                    "crop_year": 2026, "lease_type": "crop_share", "finalized_at": "…", "status": "final",
                    "statement": { ...the LandownerStatement / section rows exactly as lib/leases/statement.ts produced them... } }] }
```

`status` (089) is `final` (the default) or **`withdrawn`** — how Turnrow Farm
deletes a statement. Grain KEEPS the row (a landowner may already have seen it)
and marks it withdrawn, and a withdrawn statement is **never served to a
landowner share** again. A withdrawal needs no `statement` body. On a database
without 089 a withdrawal is refused per row rather than stored as final and
served on. The response's `action` is `upserted` | `withdrawn` | `refused`.

Upserts `landowner_settlements` by `(org, farm_uid)` — Farm's lease year id
is the identity. Grain's landowner resolves through the id map
(`landowners` × `landowner_farm_uid`), then by exact name; an unresolved
landowner is stored (`landowner_id: null`) but **never served to a landowner
share**. The statement is stored verbatim; Grain adds nothing and strips
nothing. Up to 500 per call.

```json
{ "data": [{ "farm_uid": "…", "action": "upserted", "grain_id": "…", "landowner_id": "uuid|null" }],
  "counts": { "settlements": 1, "upserted": 1, "refused": 0 } }
```

## The landowner partner API's `settlements` scope

A landowner share (Turnrow Landowner) with the **Rent statements** switch on
(`partner_shares.share_settlements`, default OFF) reads its own statements at
`GET /api/partner/v1/settlements?crop_year=` with its `trps_` token — only
`status: 'final'` rows (089) whose Grain `landowner_id` is the share's
landowner, filtered in the
query and again in code, never another landowner's, never an unresolved one.
See `docs/PARTNER_API.md`.

## Grain UI for a linked organization

- Settings > Turnrow Farm Link: pairing code, status + Farm organization
  name, scope toggles, last sync per direction with counts and the conflicts
  returned, recent calls, Rotate token, Revoke. A super admin sees links
  across organizations on /admin (status and dates only).
- Entities / Farms / Fields / Plantings: "Managed in Turnrow Farm; last
  synced <time>" banner once land is managed; synced rows read-only with a
  link to Turnrow Farm; unmanaged rows keep a "not linked" chip and stay
  editable; the add forms and the CSV / document importers refuse with "Land
  records are managed in Turnrow Farm." Entities keep county assignments and
  payment-limit persons editable.
- Marketing assumptions: Farm-sourced costs carry their provenance and the
  manual override switch; Crop Budget scenarios carry "Follow Turnrow Farm
  costs".
- Ask Turnrow's schema digest knows the new tables and the `managed_by` /
  `archived_at` rule.

## Consumer guidance for Turnrow Farm

- Pull `/land/snapshot`, match, `POST /land/link` the confirmed pairs, then
  `POST /land/sync` in batches of ≤ 500 in dependency order. Store every
  `grain_id` from the response in `external_ids (system = grain)`.
- Surface `conflict` results for the operator; resend with `force: true` only
  on an explicit choice.
- Show `refused` archive results as "still has harvest data in Turnrow Grain".
- Pull the four outbound endpoints per crop year with `since` for deltas;
  key on the `*_farm_uid` fields, fall back to Grain ids when null.
- Re-check `/status` on each sync; a `403 missing_scope` means the Grain
  owner turned that direction off.
