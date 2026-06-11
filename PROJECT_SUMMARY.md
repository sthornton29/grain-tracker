# Grain Tracker — Project Summary

> Internal farm-management web app for Turnrow Farm. Tracks grain from the field
> through storage, contracts, settlements, hedging, crop insurance, and government
> programs. **Not a SaaS product** — single-tenant, used on iPads in trucks by a
> small team, so the UX favors fast capture and forgiving data entry.
>
> _Snapshot date: 2026-06-11. Schema at migration `033`._

---

## Table of contents

1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [Pages — every route and what it does](#2-pages--every-route-and-what-it-does)
3. [Database schema](#3-database-schema)
4. [Features & AI document parsing](#4-features--ai-document-parsing)
5. [Integrations and their status](#5-integrations-and-their-status)
6. [Known issues & partially-built features](#6-known-issues--partially-built-features)
7. [Developer onboarding](#7-developer-onboarding)
8. [Domain glossary](#8-domain-glossary)

---

## 1. Architecture at a glance

| Layer | Choice |
| --- | --- |
| Framework | **Next.js `^14.2.35`** (App Router — server components, route handlers, `middleware.ts`) |
| UI | **React `^18.3.1`**, **Tailwind CSS `^3.4.14`** (no theme extensions/plugins) |
| Language | **TypeScript `^5`**, `strict: true`, path alias `@/* → ./*`, target ES2022 |
| Backend / DB / Auth | **Supabase** (Postgres) via `@supabase/ssr ^0.5.2` + `@supabase/supabase-js ^2.45.4` |
| AI | **`@anthropic-ai/sdk ^0.95.2`** — Claude `claude-sonnet-4-6` for document extraction |
| Market data | **Barchart OnDemand** REST (futures + options quotes) |
| Exports / files | `exceljs`, `xlsx` (SheetJS), `jspdf` + `jspdf-autotable`, `pdf-lib`, `jszip` |
| Testing / CI | **Vitest `^4.1.8`** — 280 unit tests over the pure `lib/` math (11 `lib/*.test.ts` files); ESLint (`.eslintrc.json`, `next/core-web-vitals`); **GitHub Actions CI** (`.github/workflows/ci.yml`: lint + test on every push/PR) |
| Packaging | **npm** (`package-lock.json`); installable **PWA** (service worker `/sw.js`, `manifest.json`) |

**Request flow:** `middleware.ts` → `lib/supabase/middleware.ts` refreshes the Supabase
session and redirects unauthenticated users to `/login` (public paths: `/login`,
`/auth/callback`). The root layout (`app/layout.tsx`) renders the top `<Nav>` only when
signed in, plus `<PwaRegister>`.

**Data access:** Pages mostly read/write Supabase **directly** from server or client
components. The only server-side API routes are for AI parsing and market-price fetching
(see §5). Heavy report math lives in `lib/` (pure functions) and `components/reports/`.

**No views in the database** — all reporting is computed in the app layer. The money-critical
pure logic in `lib/` is covered by Vitest unit tests (`npm run test`); UI components are not.

---

## 2. Pages — every route and what it does

### Navigation structure

The global nav (`components/nav.tsx`, sticky green bar) exposes 9 top-level destinations:
New Load, Loads, Bin Inventory, Contracts, Settlements, Yields, Hedging, Reports, Settings.
The home page (`app/page.tsx`) is a tile launcher. There are **two layouts**: the root
(auth + nav + PWA) and `app/reports/layout.tsx` (a left sidebar). The Reports navigation —
group order, item order, display names, routes, descriptions — has a **single source of truth**
in `app/reports/reports-nav.ts`; both the sidebar and the landing-page cards render from it.
Groups: **Main Reports / Crop Insurance / Production Reports / Government Payments /
Operational Reports**. Items marked `external` point back to standalone pages with a ↗ marker.

> Most report subpages are thin `'use client'` wrappers that render a heavy component from
> `components/reports/*` and wire an `<ExportBar>` (Excel/PDF/Print). All reports share a
> **design-system kit** (`components/reports/report-kit.tsx`): header/filter bar/summary
> cards/tables/empty states, number formatters, and color-tone semantics (green favorable,
> red unfavorable, amber warning). Detail pages handle missing records with `notFound()`.
> There are **no** `loading.tsx`/`error.tsx`/`not-found.tsx` files.

### Core operational pages

| Route | File | Purpose |
| --- | --- | --- |
| `/` | `app/page.tsx` | Home dashboard / tile launcher. No data. |
| `/login` | `app/login/page.tsx` | Sign-in (nav hidden). Honors `?next=` (paths only). Shows a public `<MarketBoard>` of grain futures via `fetchPublicQuotes()` (cached 5 min, blanks on failure). |
| `/loads` | `app/loads/page.tsx` | Master load log: search, filter (date/entity/county/crop year/contract), sortable columns, per-row split breakdown, paid/unpaid badges (matched to settlement lines by ticket #), CSV export, bulk delete (chunks of 50). |
| `/loads/new` | `app/loads/new/page.tsx` | Create one load manually (`<LoadForm mode="create">`); links to `/loads/scan`. |
| `/loads/[id]/edit` | `app/loads/[id]/edit/page.tsx` | Edit a load + its splits + `<LoadAttachments>`. |
| `/loads/scan` | `app/loads/scan/page.tsx` | **AI scale-ticket capture** (photo/PDF → editable rows via `parseDocument(…, 'tickets')`). Fuzzy-matches truck/crop/field/bin/buyer, Ready/Needs-Review status, source preview, bulk-save. |
| `/loads/import` | `app/loads/import/page.tsx` | Bulk CSV import of loads with template, FK resolution by name, validation, dedupe by ticket, net = gross − tare fallback. |
| `/loads/unpaid` | `app/loads/unpaid/page.tsx` | Buyer-delivered loads with no matching settlement line; totals outstanding dry bushels. |
| `/inventory` | `app/inventory/page.tsx` | Live bin inventory = loads-in − loads-out + beginning inventory − empty-bin adjustments, grouped by bin site; flags "Unsited bins"; CSV export. |
| `/contracts` | `app/contracts/page.tsx` | Contract tracker: delivered-vs-contracted, pricing status, paid/unpaid revenue, progress bars, **first-notice-day warnings** (HTA/basis within 30 days), orphan-load warnings. |
| `/contracts/[id]` | `app/contracts/[id]/page.tsx` | Printable contract detail; loads-delivered table (our dry bu vs settlement net bu); `<ContractActions>` (complete/delete) + attachments. |
| `/contracts/[id]/edit` | `app/contracts/[id]/edit/page.tsx` | Edit a contract via shared `<ContractFields>`. |
| `/settlements` | `app/settlements/page.tsx` | List of buyer settlement statements with line/unmatched counts, net bu/revenue, PDF link, Review link. |
| `/settlements/new` | `app/settlements/new/page.tsx` | Create + reconcile a settlement. Three entry paths: **AI PDF/photo** (`parseDocument(…, 'settlement')`), CSV, or manual rows. Per-line ticket→load match status. |
| `/settlements/[id]` | `app/settlements/[id]/page.tsx` | Review/reconcile: Matched loads (diff >1% flagged), Unmatched lines, Missing loads; `<SettlementPdfPanel>`. **Persists** ticket→load matches on view (`relinkSettlementLines` server action; ambiguous tickets left for manual resolution) and offers a **manual match dropdown** per unmatched line (`line-match-select.tsx`). |
| `/yields` | `app/yields/page.tsx` | Yield analysis — **By field / farm / variety / landowner**. Filters persist in localStorage. Practice filter + irrigated/dryland breakdown. Excludes unharvested/in-progress fields (per-field "Count anyway" override). Inline irr/dry and per-variety bushel allocation — **offered only once a field's harvest is complete** (`harvestStatusOf` in `lib/yields.ts`). Accepts `?breakout=1` deep-link. |
| `/hedging` | `app/hedging/page.tsx` | Futures & options position tracking with live P&L. Open/closed tables, per-crop-year × commodity summary cards, new/edit/close dialogs, brokerage statement import. Live prices via `/api/market-prices` and `/api/options-prices`. |
| `/revenue-projections` | `app/revenue-projections/page.tsx` | Legacy **redirect** → `/reports/revenue-projections`. |

### Settings pages (`/settings/*`)

`/settings` is a hub tile-grid (+ Sign Out → `/logout`). Subpages:

| Route | Manages |
| --- | --- |
| `/settings/entities` | Farming legal entities + their county assignments (`entity_counties`). |
| `/settings/landowners` | Landowners (name/phone/email/address); shows their farms. |
| `/settings/farms` | Farms: entity (required), county (scoped to entity), FSA #, landowner, **share-rent flag + landlord share %**. CSV import. Delete cascades to fields. |
| `/settings/fields` | Fields: total/irrigated acres (derived dryland), county; expandable plantings; CSV + **AI import** (`<FieldsAiImport>`). Delete cascades to plantings. |
| `/settings/plantings` | Field plantings (field × crop × season) with multiple varieties; CSV + **AI import** (`<PlantingsAiImport>`). |
| `/settings/bin-sites` | Bin sites and the bins within them; shows current bushels on hand per bin. |
| `/settings/trucks` | Thin: `<CsvImport>` + generic `<SimpleCrud>`. |
| `/settings/buyers` | Buyers + their delivery locations. |
| `/settings/crops` | Crops (base moisture, lb/bu, harvest category, double-crop). |
| `/settings/contracts` | Create/manage contracts (forward/HTA/basis) with **AI import**, CSV, shared `<ContractFields>`. |
| `/settings/crop-insurance` | MPCI policies with SCO/ECO endorsements; entity filter; **AI import** (`<PolicyAiImport>`); **RMA projected-prices editor** (`<ProjectedPricesEditor>` — per crop×year rows in `harvest_price_estimates`, replaces the old hard-coded 2026 map). |
| `/settings/government-payments` | ARC/PLC base acres, elections, price data, payments, payment limits; FSA base-acres import; seed-cotton calculator; **per-year program parameters** (`program_year_config`: SCO trigger, per-person payment limit, sequestration %). |

### Reports (`/reports/*`)

| Route | Report |
| --- | --- |
| `/reports` | Landing page (cards rendered from `reports-nav.ts`). |
| `/reports/yields-by-landowner` | **Yields by Landowner** — per-landowner production grouped by farm/field (splits-aware). |
| `/reports/share-rent` | **Share Rent Report** — landlord-share production at each farm's configured share %. |
| `/reports/crop-insurance` | **Crop Insurance Production Report** — county × practice (irrigated/dryland) production for insurance agents. Mixed-practice plantings without a breakout are gated — **only once harvest is complete** (`components/reports/crop-insurance-report.tsx`). |
| `/reports/season` | **Season Summary** — acres & yield by crop; excludes unharvested/in-progress. |
| `/reports/cash-flow` | **Cash Flow Forecast** — monthly received / outstanding / projected revenue + a **Total Safety Net** (projected ARC/PLC, crop-insurance indemnity, other USDA payments). |
| `/reports/marketing` | **Marketing Dashboard** — one **full-width section per crop**, stacked vertically: header row = identity · position bars (full center width) · headline numbers (Total Avg Price with a basis qualifier, Profit/acre, Total Profit); a chevron (persisted per crop) expands a responsive 4-column detail grid (Production \| Sales & Contracts \| Pricing Buildup \| Profitability & What-If). Every basis figure carries its **actual / assumed / blended** state (locked-vs-assumed bushel composition in the Pricing Buildup column, tooltips, and exports). Production is actual once harvest complete, else assumption-derived; **what-if pricing on unpriced bushels** (incl. "use today's price" via the new-crop benchmark contract); Assumptions editor (yield/cost irr-dry & full-season/double-crop breakouts, assumed basis, harvest-complete snap). |
| `/reports/hedging-summary` | **Hedging Summary** — all futures positions (open + closed) with realized/unrealized P&L by crop year. |
| `/reports/crop-insurance-claims` | **Crop Insurance Claims Monitor** — estimated indemnity per policy (RP/RP-HPE/YP + SCO/ECO) with What-If sliders. |
| `/reports/arc-plc-decision-aid` | **ARC/PLC Decision Aid** — compare projected PLC vs ARC-CO per farm/commodity; test MYA price; set election. |
| `/reports/government-payments` | **Government Payment Tracker** — projected ARC/PLC + other USDA payments with per-entity payment-limit tracking. |
| `/reports/revenue-projections` | **Revenue Projections** — one-page financial summary: all revenue sources + cost, profit, breakeven. Crop sales revenue = the Marketing engine's **blended expected revenue** (each bushel bucket at its own price; realized hedge P&L counted once). |
| `/reports/settlement-pdfs` | **Bundled Settlement Statements (Production Audit)** — zips every attached buyer settlement PDF for a crop & year. |

---

## 3. Database schema

**Supabase / PostgreSQL** with `pgcrypto` (`gen_random_uuid()`). Defined by **33 sequential,
idempotent migrations** in `supabase/` (`schema.sql` = 001, then `002_*.sql` … `033_*.sql`).
Every table re-runs safely (`create table if not exists`, guarded `do $$…$$`), uses a `uuid`
PK and `created_at`. ~36 tables, **no views**. Later migrations frequently `ALTER` earlier
tables (esp. `contracts`, `farms`, `fields`, `field_plantings`, `crop_assumptions`).

### Migration history (feature areas)

- `schema.sql` (001) — core: `farms`, `fields`, `bins`, `trucks`, `buyers`, `crops` (seeds Corn/Soybean/Wheat), `contracts`, `loads`; `set_updated_at()` trigger; base RLS.
- `002` seasons — `entities`, `field_plantings` (+ `paired_planting_id` self-FK), `fields.total_acres`; seeds Canola.
- `003` delivery — `delivery_locations`; contract delivery type/location.
- `004` — `loads.dry_bushels_override`.
- `005` — `bins.crop_id`. · `006` — `farms.fsa_number`.
- `007` payments — `crop_year` on contracts/loads; contract delivery dates; `settlements` + `settlement_lines` (generated `net_revenue`, `price_per_bushel`).
- `008` — `bin_inventory_adjustments`. · `009` — re-adds `contracts.entity_id`.
- `010` counties — `counties` (all US counties + DC), `entity_counties`, county FKs on farms/fields.
- `011` — `bin_sites` + `bins.bin_site_id`. · `012` — `contracts.completed_at`.
- `013` pdf parsing — `source_pdf_url` on settlements/loads; **public `documents` storage bucket** + storage RLS.
- `014` — `load_splits`. · `015` — `landowners` + share-rent columns on farms.
- `016` irrigated/dryland — irr/dry acres on fields & plantings (**trigger-derived dryland**); `irrigated_bushels`/`dryland_bushels`/`yield_breakout_entered`.
- `017` — `load_attachments`.
- `018` hedging — `commodity_specs` (seeds ZC/ZS/ZW), `futures_positions`, `market_prices`.
- `019` — `options_positions` (generated `premium_total`).
- `020` marketing — contract pricing breakdown (`contract_type`, futures/basis/cash/service_fee, `pricing_status`); `crop_assumptions`.
- `021` — `contract_attachments`. · `022` — `field_planting_varieties`.
- `023` — `field_plantings.yield_include_override`.
- `024` crop insurance — `crop_insurance_policies` (RP/RP_HPE/YP), `crop_insurance_sco`, `crop_insurance_eco`, `harvest_price_estimates` (seeds 2026 projected prices).
- `025` government — `covered_commodities` (OBBBA reference prices), `farm_base_acres`, `arc_plc_elections`, `arc_plc_price_data`, `arc_plc_payments`, `other_government_payments`, `payment_limit_config`.
- `026` — generic/unassigned base acres. · `027` — Canola & Sesame commodities.
- `028` — `crops.harvest_category` (fall/spring). · `029` — `crop_assumptions` yield breakout columns.
- `030` — `crops.double_crop`. · `031` — `crop_assumptions` cost breakout columns.
- `032` program config — `program_year_config` (per-year SCO trigger, payment limit, sequestration %; seeds 2026 + 2027).
- `033` — `crop_assumptions.assumed_basis` (Marketing fallback basis).

### Tables (grouped) — purpose & key columns

**Org & land**

- **`entities`** — legal entities (LLCs/partnerships). `name` (unique), `notes`.
- **`landowners`** — third-party owners of rented ground. name/phone/email/address/notes.
- **`farms`** — `name`, `entity_id`→entities, `fsa_number`, `county_id`→counties, `landowner_id`→landowners, `is_share_rent`, `landlord_share_percentage` (0–100, required when share-rent).
- **`fields`** — `farm_id`→farms (cascade), `name_or_number`, `total_acres`, `county_id`, `irrigated_acres`, **`dryland_acres` (trigger-derived = total − irrigated)**.
- **`counties`** — US county reference (all states + DC). unique `(name, state_code)`.
- **`entity_counties`** — entity↔county junction. unique `(entity_id, county_id)`.

**Crops & planting**

- **`crops`** — `name` (unique), `base_moisture_pct`, `base_lb_per_bushel`, `harvest_category` (fall/spring), `double_crop`.
- **`field_plantings`** — field×crop×season. `field_id`, `crop_id`, `season_year`, `planted_acres`, `planting_date`, `paired_planting_id` (double-crop), `irrigated_acres`, **`dryland_acres` (trigger-derived)**, `irrigated_bushels`/`dryland_bushels`, **`yield_breakout_entered`**, **`yield_include_override`** (null=auto, true=force-include).
- **`field_planting_varieties`** — `planting_id`→plantings, `variety`, `acres`, `bushels` (nullable, manual allocation).
- **`crop_assumptions`** — per crop×year marketing inputs. unique `(crop_id, crop_year)`. `expected_yield`, **`harvest_complete`**, `cost_per_acre`, **`assumed_basis`** (033, fallback basis for unlocked bushels), plus `*_irr`/`*_dry`/`*_dc_irr`/`*_dc_dry` yield (029) and cost (031) breakouts.

**Storage & logistics**

- **`bins`** — `name_or_number`, `crop_id` (single designated crop), `bin_site_id`.
- **`bin_sites`** — `name`, `entity_id` (cascade), `county_id`, `address`. unique `(entity_id, name)`.
- **`trucks`** — `name_or_number`. · **`buyers`** — `name`. · **`delivery_locations`** — `buyer_id`, `name`, `address`.
- **`bin_inventory_adjustments`** — `bin_id`, `crop_id`, `adjustment_type` (`beginning_inventory`/`empty_bin`), `bushels` (≥0), `moisture`, `as_of_date`.

**Loads (central transactional table)**

- **`loads`** — `date`/`time`, `truck_id`, `crop_id`, weights (`gross`/`tare`/`net`), `moisture`, `test_weight`, `bushels`, **`dry_bushels_override`**, `from_type` (field/bin) + `from_field_id`/`from_bin_id`, `to_type` (bin/buyer) + `to_bin_id`/`to_buyer_id`, `contract_id`, `ticket_number`, `crop_year`, `source_pdf_url`, `updated_at` (trigger).
- **`load_splits`** — multi-field load allocation. `load_id` (cascade), `field_id`, `crop_id`, `net_weight` (>0), `percentage` (0–100], `wet_bushels`, `dry_bushels`.
- **`load_attachments`** — files per load (in `documents` bucket): `file_url`/`file_path`/`file_name`, `mime_type`, `file_size`.

**Contracts & settlements**

- **`contracts`** — `contract_number`, `buyer_id`, `crop_id`, `entity_id`, `contracted_bushels`, `price_per_bushel` (legacy, synced to cash), `crop_year`, `delivery_type` (pickup/delivered), `delivery_location_id`, delivery start/end dates, `completed_at`, `contract_month`, **`contract_type`** (forward/hta/basis), `futures_price`/`basis`/`cash_price`/`service_fee`, set-dates, **`pricing_status`** (fully_priced/awaiting_basis/awaiting_futures).
- **`settlements`** — `buyer_id`, `settlement_date`, `settlement_number`, `source_pdf_url`.
- **`settlement_lines`** — `settlement_id` (cascade), `load_id` (set null), `ticket_number`, `net_bushels`, `gross_revenue`, `discounts`; **generated** `net_revenue` and `price_per_bushel`.
- **`contract_attachments`** — files per contract (mirrors load_attachments).

**Hedging**

- **`commodity_specs`** — futures specs (seeds Corn ZC, Soybeans ZS, Chicago Wheat ZW). `commodity` (unique), `symbol`, `exchange`, `contract_size_bu`, tick size/value, `contract_months`.
- **`futures_positions`** — `entity_id`, `commodity`, `contract_month`/`contract_symbol` (e.g. `ZCZ26`), `crop_year`, `side` (long/short), `num_contracts`, `trade_price`/`trade_date`, `status` (open/closed), close fields, `realized_pnl`, `source` (manual/statement_import).
- **`options_positions`** — `option_type` (call/put), `side` (buy/sell), `strike_price`, `num_contracts`, `premium_cents`, **generated `premium_total`**, `status` (open/closed_offset/expired_worthless/exercised), `manual_current_value_cents` (fallback), `exercised_position_id`→futures.
- **`market_prices`** — EOD price cache. unique `(contract_symbol, price_date)`.

**Crop insurance**

- **`crop_insurance_policies`** — one per crop×county×year. `plan_type` (RP/RP_HPE/YP), `coverage_level` (0.5–0.85), `unit_structure`, `aph_yield`, `projected_price`/`harvest_price`, `volatility_factor`, `insured_acres`, premium fields, `source`.
- **`crop_insurance_sco`** / **`crop_insurance_eco`** — 1:1 endorsements on a policy (unique `policy_id`); trigger levels, expected county yield, premiums.
- **`harvest_price_estimates`** — discovery cache. `crop_id`, `crop_year`, `price_type` (projected/harvest_final/harvest_estimate), `price`. unique `(crop_id, crop_year, price_type, price_date)`.

**Government (ARC/PLC) programs**

- **`covered_commodities`** — FSA program crops (separate from `crops`; base can exist for non-grown commodities). `name` (unique), `crop_id`, `statutory_reference_price`, `unit`, `national_loan_rate`, marketing-year months.
- **`farm_base_acres`** — `farm_id`, `commodity_id` (nullable since 026 for generic base), `base_acres`, `plc_yield`, `is_unassigned`. unique `(farm_id, commodity_id)`.
- **`arc_plc_elections`** — `election` (PLC/ARC_CO/ARC_IC) per farm×commodity×year.
- **`arc_plc_price_data`** — `effective_reference_price`, `mya_price_estimate`/`_final`, `source`.
- **`arc_plc_payments`** — projected/actual payments; `payment_factor` (0.85), `sequestration_pct` (~0.054), `net_payment`, `payment_status`.
- **`other_government_payments`** — manual non-ARC/PLC USDA payments.
- **`payment_limit_config`** — per entity×year: `eligible_persons`, `per_person_limit` (default 155000).
- **`program_year_config`** — per-crop-year program parameters (032): `sco_trigger` (0.86 in 2026, 0.90 in 2027), `per_person_payment_limit`, `sequestration_pct`, `notes`, `updated_at` (trigger). unique `crop_year`; seeded 2026 + 2027. Resolved via `lib/program-config.ts` (falls back to the most recent configured year with a UI notice).

### Triggers, generated columns, storage, RLS

- **Triggers:** `loads_set_updated_at` and `program_year_config_set_updated_at` (BEFORE UPDATE); `fields_set_dryland` and `field_plantings_set_dryland` keep `dryland_acres = greatest(0, total/planted − irrigated)` even on raw/CSV imports.
- **Generated columns:** `settlement_lines.net_revenue` & `price_per_bushel`; `options_positions.premium_total`.
- **Storage:** public bucket **`documents`** (load tickets, settlement scans, contract attachments, AI parse uploads).
- **RLS:** enabled on every table with a single permissive policy `for all to authenticated using (true) with check (true)` — appropriate for a single-tenant internal app. Storage has authenticated CRUD policies scoped to `bucket_id = 'documents'`; the bucket is also public-read so the PDF viewer can load files without signed URLs.

---

## 4. Features & AI document parsing

### Cross-cutting capabilities

- **Shrink math** (`lib/shrink.ts`) — net weight + moisture + crop base values → wet & dry bushels; honors `dry_bushels_override`; falls back to wet bushels when moisture is missing.
- **Yield analysis** (`lib/yields.ts`) — aggregates dry bushels per field/crop/year, drops unharvested fields, flags the currently-combined field as "in progress" (yield >15% below the crop's other harvested fields **and** last load within 5 days), supports "count anyway" overrides, produces weighted averages and harvest-progress-by-acres. `harvestStatusOf` / `isHarvestComplete` classify a planting (complete / in-progress / unharvested) to gate the bushel-allocation and variety-prompt UI; `cropsWithCompleteHarvest` feeds the Marketing dashboard's actual-vs-estimated switch.
- **Double-crop classification** (`lib/plantings.ts`) — a `double_crop` crop on a field that also had a spring-harvest planting that season.
- **Split loads** (`lib/load-splits.ts`) — allocate one load across multiple fields with per-split shrink; validates weights sum to parent net (±1 lb).
- **CSV import engine** (`lib/csv.ts`) — config-driven importer with FK lookups/aliases, child relations, derived columns, `add` vs `sync` modes (sync only updates changed columns; blanks never overwrite), batch insert with per-row fallback. Styled Excel templates via `lib/import-template.ts`.
- **Universal exports** (`lib/exports.ts`) — Excel/PDF/Print from a section/row model (used by `<ExportBar>`); heavy libs dynamically imported.
- **Settlement linking** (`lib/settlement-link.ts`) — back-fills `settlement_lines.load_id` by ticket when a buyer load is saved (`relinkSettlementLinesForLoad`) **and** for a whole settlement when its Review screen opens (`relinkSettlementLines`), so the DB stays in sync with what the screen shows. Ambiguous tickets are always left unlinked for manual resolution.
- **Marketing engine** (`lib/marketing.ts`) — per-crop position for a crop year: acres segmented full-season/double-crop × irr/dry, expected production from assumption breakouts (or **actual production once harvest is complete**), a Total Average Price buildup (weighted futures from physical contracts + open short hedges, realized futures/options P&L spread per bushel, weighted or **assumed** basis), and a **blended expected revenue** that values each bushel bucket (flat-cash, futures+basis, open-hedge, unpriced-at-market) at its own price — the single source of truth Revenue Projections reuses. Also exposes the **basis composition** (`basisLockedBu`/`basisLockedAvg`/`basisAssumedBu`/`basisState`) behind the dashboard's actual/assumed/blended labeling — display fields only, no effect on totals.
- **Program-year config** (`lib/program-config.ts`) — resolves the SCO trigger, per-person payment limit, and sequestration % for a crop year from `program_year_config` rows, falling back to the most recent configured year (or built-in 2026 defaults) with a plain-English notice for the UI.
- **Insurance / government / revenue engines** (`lib/crop-insurance.ts`, `lib/government-payments.ts`, `lib/revenue-projections.ts`) — pure math feeding the financial reports. Projected prices now come from `harvest_price_estimates` (`projectedPriceFromEstimates`) instead of a hard-coded map.
- **Unit tests** — 280 Vitest tests in `lib/*.test.ts` (shrink, yields, csv, contracts, marketing, crop-insurance, government-payments, revenue-projections, hedging, load-splits, program-config) with hand-verified worked examples; run in CI on every push/PR.

### AI document parsing pipeline

All AI extraction funnels through **one route** — `POST /api/parse-document` — called only via
`parseDocument(input, documentType)` in `lib/pdf-upload.ts`. A PDF is uploaded to the
`documents` bucket and sent to Claude **by https URL** (to stay under Vercel's 4.5 MB
serverless body limit; the temp object is deleted after parsing). Photos are inlined as
base64 `images[]`. Long PDFs are split into ≤4-page batches (`lib/pdf-split.ts`) to avoid
504s; `.xlsx/.xls` are rendered to PDF first (`lib/excel-to-pdf.ts`).

The route selects one of **8 hard-coded prompts** by `document_type`, sends document blocks +
a text prompt as a single message, strips markdown fences, and `JSON.parse`s the result.
**No tool use and no structured-output schema enforcement** — prompts say "respond ONLY in
JSON" and parsing is defensive (a malformed response → 500 "Couldn't parse the response").

Extracted rows are fuzzy-matched (`lib/fuzzy.ts`) to existing reference data and land in an
**editable review table** — nothing is written to Supabase until the user presses "Save All".

| Document type | UI component | What it extracts |
| --- | --- | --- |
| `tickets` | `/loads/scan` | Scale/hauling tickets: weights, moisture, test weight, from/to. |
| `settlement` | `/settlements/new` | Buyer settlement: buyer, date, line items (ticket #, net bushels, gross revenue, discounts). |
| `fields` | `<FieldsAiImport>` | Per field: `field_name`, `farm_name`, `total_acres`, `irrigated_acres` (dryland derived). |
| `plantings` | `<PlantingsAiImport>` | Per planting: field, crop, season_year, planted/irrigated acres, planting date, `varieties[]`, notes. Classifies New/Update/Unchanged. |
| `crop_insurance_policy` | `<PolicyAiImport>` | Per crop/county policy: plan type, coverage level, unit structure, APH yield, projected price, insured acres, premiums, policy #, plus nested **SCO** and **ECO** objects. |
| `contract` | `/settings/contracts` | Contract #, buyer, crop, type (forward/hta/basis), month, crop year, bushels, futures/basis/cash/service fee, delivery window, notes. |
| `fsa_base_acres` | `<FsaBaseAcresImport>` | FSA 156EZ: per farm (FSA #, county, state) and per commodity (base acres, PLC yield, election, unassigned, OBBBA new/total base). |
| `brokerage_statement` | `<StatementImport>` (hedging) | RJ O'Brien futures/options: long/short, open/closed trades, options, account summary. |

---

## 5. Integrations and their status

### Supabase — **Live (core dependency)**

- Browser, server, and middleware client factories in `lib/supabase/`.
- Auth enforced in `middleware.ts`; unauthenticated → `/login`. Users created via Supabase Auth.
- Direct table reads/writes from components; storage bucket `documents` for file uploads.
- **Env:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

### Anthropic / Claude API — **Live**

- Package `@anthropic-ai/sdk ^0.95.2`; single call site `app/api/parse-document/route.ts`.
- **Model `claude-sonnet-4-6`**, `max_tokens: 8192`, `thinking: { type: 'disabled' }`,
  `output_config: { effort: 'low' }`, `runtime = 'nodejs'`, `maxDuration = 60`. No streaming, no agent loop.
- **Env:** `ANTHROPIC_API_KEY` (server-only; route returns 500 if unset). Key never reaches the browser.
- Note: the project's documented default model elsewhere is `claude-opus-4-8`; Sonnet here is a
  deliberate cost/speed choice for extraction. Parsing relies on "JSON only" + fence-stripping rather
  than `output_config.format` schema enforcement — hardening opportunity if revisited.

### Barchart OnDemand — **Live but fully env-gated; options pricing partial**

- Used for live grain **futures quotes** (`getQuote.json`, cents/bu → $/bu) and **options premiums** (`getFuturesOptions.json`).
- **Env:** `BARCHART_API_KEY` (server-only, passed as `apikey` query param).
- Call sites: `app/api/market-prices/route.ts`, `app/api/harvest-price-estimate/route.ts`,
  `app/api/mya-estimate/route.ts`, `app/api/options-prices/route.ts`, and `lib/barchart-quotes.ts`
  (login-page public board).
- **Status:**
  - Futures quotes: **live, fault-tolerant.** Without the key (or on error / market-closed), every route
    falls back to the most-recent cached `market_prices` row and returns an explanatory `note`. Successful
    fetches are day-cached in `market_prices` (mirrored to `harvest_price_estimates` / `arc_plc_price_data`).
  - Options pricing (`/api/options-prices`): **partial / "future-ready."** Wired to Barchart but on missing
    key / no requests / error / no data returns `available: false` with null values so the Hedging UI falls
    back to manual premium entry. No Supabase caching of options data.
  - Untraded commodities (Canola, sesame, sorghum, seed cotton, …) have no futures-derived pricing → manual entry.

### API endpoints (all `POST`, `runtime = 'nodejs'`)

| Endpoint | File | Purpose | External |
| --- | --- | --- | --- |
| `/api/parse-document` | `parse-document/route.ts` | AI extraction for 8 doc types (`maxDuration 60`). | Anthropic |
| `/api/market-prices` | `market-prices/route.ts` | Live futures quotes for hedging board; day-caches. | Barchart + Supabase |
| `/api/options-prices` | `options-prices/route.ts` | Live option premiums (strike matching). | Barchart |
| `/api/harvest-price-estimate` | `harvest-price-estimate/route.ts` | RMA harvest-price estimate per crop (discovery-month contract). | Barchart + Supabase |
| `/api/mya-estimate` | `mya-estimate/route.ts` | MYA price estimate per commodity for ARC/PLC. | Barchart + Supabase |

---

## 6. Known issues & partially-built features

- **Options pricing is "future-ready," not finished** — `/api/options-prices` always degrades to manual entry today (see §5). Functional fallback, but the live path is unproven.
- **Stale comment** in `lib/revenue-projections.ts:5` calls government payments "a placeholder until that section is built." That section **is** built and wired in (`projectPayments` → `revenue-projections-report.tsx`). Comment only; not a missing feature.
- **SheetJS styling is non-functional** — `lib/crop-insurance-export.ts:96-99`: the Community build writes the style property but doesn't apply it; bold/title styling only survives a re-save. Cosmetic, documented trade-off.
- **Split vs manual parent override** — `lib/load-splits.ts:38-43`: a manually-overridden parent `dry_bushels` is **not** redistributed back into splits (deliberate; surfaced to the user via a note).
- **Program parameters still need yearly data entry** — the SCO trigger, payment limit, sequestration %, and RMA projected prices are now **DB-configured** (`program_year_config`, `harvest_price_estimates`) rather than hard-coded, but someone must enter each new year's values in Settings (Government Payments / Crop Insurance). Missing years fall back to the most recent configured year with a visible notice — math keeps working but on last year's numbers.
- **No UI/component tests** — Vitest covers the pure `lib/` math only; pages and components are untested.
- **Redirects are intentional, not orphans** — `/revenue-projections` and the `/season`, `/marketing`, `/cash-flow` paths redirect to their `/reports/*` homes (`next.config.js`).

---

## 7. Developer onboarding

### Setup (from `README.md`)

```bash
npm install
cp .env.local.example .env.local      # then fill in the values below
# In the Supabase SQL editor, run supabase/schema.sql, then 002…033 in order
# Create a Supabase Auth user (this app has no self-serve signup)
npm run dev
```

Scripts: `dev` (`next dev`), `build` (`next build`), `start` (`next start`), `lint` (`next lint`),
`test` (`vitest run`), `test:watch` (`vitest`). CI (`.github/workflows/ci.yml`) runs lint + tests
on every push and PR. Deploy target is Vercel; installs as a PWA via Safari "Add to Home Screen."

### Environment variables (`.env.local.example`)

| Var | Scope | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser+server | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser+server | Supabase anon key for auth. |
| `ANTHROPIC_API_KEY` | server | AI PDF/photo parsing via `/api/parse-document`. |
| `BARCHART_API_KEY` | server | Live futures/options pricing. Without it, market features serve cached prices or manual entry. |

### Where things live

- **Pages/routes:** `app/**/page.tsx` (+ two `layout.tsx`). API routes: `app/api/**/route.ts`.
- **Business logic:** `lib/*.ts` (pure functions — shrink, yields, contracts, hedging, marketing, crop-insurance, government-payments, program-config, revenue-projections, csv, exports, fuzzy, pdf-*). Unit tests live alongside as `lib/*.test.ts`.
- **Central types:** `lib/types.ts`.
- **Components:** `components/*` (forms, AI-import widgets, dialogs, PDF/attachments) and `components/reports/*` (the heavy report bodies + the shared `report-kit.tsx` design system).
- **Schema:** `supabase/*.sql` (run in numeric order).

### Conventions / gotchas

- Reports compute everything in the app layer (no DB views). Pure libs take pre-fetched rows.
- Supabase has a row cap per request — list pages that need everything paginate via `.range()` loops.
- `dryland_acres` is **trigger-maintained**; don't try to set it directly.
- Filters on many pages persist in `localStorage` via `usePersistentState`.
- Heavy export/PDF libs are dynamically `import()`-ed to keep first-load small.
- Single-tenant security model: RLS is permissive for any authenticated user — **do not** treat this as multi-tenant isolation.

---

## 8. Domain glossary

- **Shrink / dry bushels / wet bushels** — wet = net weight ÷ test weight; dry = wet shrunk to the crop's base moisture. Shrink removes water weight above base so grain prices at a common moisture.
- **Base moisture / base lb-per-bushel** — per-crop FSA standards (e.g. corn 15% / 56 lb).
- **Practice (irrigated / dryland)** — whether acres are irrigated; tracked per field/planting and reported separately (esp. crop insurance).
- **Double-crop** — a second crop after a spring-harvest crop in the same season (e.g. soybeans after wheat).
- **FSA number** — USDA Farm Service Agency farm serial number.
- **APH yield** — Actual Production History; approved per-acre yield setting insurance guarantees.
- **RP / RP-HPE / YP** — Revenue Protection, RP with Harvest Price Exclusion, Yield Protection.
- **Coverage level / unit structure** — % of guarantee insured; enterprise / basic / optional acre grouping.
- **SCO / ECO** — Supplemental / Enhanced Coverage Option: county-based band endorsements above the base policy.
- **Projected / harvest price** — RMA's spring and harvest futures-based prices valuing the guarantee/indemnity.
- **Indemnity / premium** — the insurance payout / the producer-paid cost of coverage.
- **ARC / PLC** — USDA Title I: Agriculture Risk Coverage (county/individual) and Price Loss Coverage; elected per farm × commodity.
- **Base acres / PLC yield** — program acreage and payment yield a farm carries (independent of what's planted); unassigned/generic base carries no payment.
- **MYA price** — Marketing-Year Average price; drives PLC and ARC.
- **Reference price / loan rate** — statutory PLC price floor and the national loan rate that floors the MYA.
- **Payment factor / sequestration** — the 85% base-acre payment factor and ~5.4% federal sequestration cut on ARC/PLC.
- **Forward / HTA / Basis contract** — forward locks flat cash; HTA locks futures (basis later); basis locks basis (futures later). `cash = futures + basis − fee`.
- **Basis** — local cash minus futures (positive = "over", negative = "under"). **Assumed basis** — the per-crop-year fallback (`crop_assumptions.assumed_basis`) used to value bushels whose basis isn't locked yet, so Total Average Price always computes.
- **Hedging (long / short)** — offsetting futures/options; farmers typically short futures to lock a price.
- **Realized / unrealized P&L** — closed-position profit/loss vs mark-to-market on open positions.
- **Settlement / settlement line** — the buyer's payment document; lines match delivered loads by **ticket number** (gross − discounts = net).
- **Scale ticket / ticket number** — the per-load weigh-in document; the join key between loads and settlement lines.
- **Crop year vs season year** — `crop_year` (marketing/program year on loads/contracts) vs `season_year` (planting season); usually aligned, tracked separately.
