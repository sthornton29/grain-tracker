# Grain Tracker — Project Summary

> Internal farm-management web app for Turnrow Farm. Tracks grain from the field
> through storage, contracts, settlements, hedging, crop insurance, and government
> programs. **Not a SaaS product** — single-tenant, used on iPads in trucks by a
> small team, so the UX favors fast capture and forgiving data entry.
>
> _Snapshot date: 2026-07-19 (evening). Schema at migration `043`._

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
| AI | **`@anthropic-ai/sdk ^0.95.2`** — Claude `claude-sonnet-4-6` for document extraction + **web-search lookups** via shared `lib/ai-web-search.ts` (now explicit FALLBACKS behind the deterministic USDA sources) |
| USDA data | **NASS Quick Stats API** (monthly MYA "prices received" — the primary lookup, `lib/nass-quickstats.ts`, free `NASS_API_KEY`) + **FSA ARC-CO benchmark workbook** downloaded and parsed server-side (`lib/fsa-benchmark-file.ts`, cached in the DB) |
| Market data | **Barchart OnDemand** REST (futures + options quotes) |
| Exports / files | `exceljs`, `xlsx` (SheetJS), `jspdf` + `jspdf-autotable`, `pdf-lib`, `jszip` |
| Testing / CI | **Vitest `^4.1.8`** — 645 unit tests over the pure `lib/` math (24 `lib/*.test.ts` files); ESLint (`.eslintrc.json`, `next/core-web-vitals`); **GitHub Actions CI** (`.github/workflows/ci.yml`: lint + test on every push/PR) |
| Packaging | **npm** (`package-lock.json`); installable **PWA** (service worker `/sw.js`, `manifest.json`) |

**Request flow:** `middleware.ts` → `lib/supabase/middleware.ts` refreshes the Supabase
session and redirects unauthenticated users to `/login` (public paths: `/login`,
`/auth/callback`). **Gin-role guard**: users with role `gin` (user_profiles) are
server-side-redirected to `/cotton/loads` from every non-cotton path — the nav hides
everything else and the 042 RLS policies enforce underneath. The root layout (`app/layout.tsx`) renders the top `<Nav>` only when
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
New Load, Loads, Bin Inventory, Contracts, Settlements, Yields, Hedging, Reports, Settings —
plus a single **Cotton** tab (inserted right after Hedging) when the **Cotton module** is
enabled (`app_settings.cotton_module_enabled`, toggled under Settings → Users & Modules).
The three cotton pages live in a **Reports-style left sidebar** (`app/cotton/layout.tsx`) —
the old green sub-nav bar is gone. **Gin-role** users see ONLY the Cotton tab (the sidebar
inside gives them the three intake pages).
The home page (`app/page.tsx`) is a tile launcher. There are **three layouts**: the root
(auth + nav + PWA), `app/reports/layout.tsx`, and `app/cotton/layout.tsx` (left sidebars). The Reports navigation —
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
>
> **Printing** is a single shared `@media print` stylesheet in `app/globals.css` (it hides
> nav/sidebar/`.no-print`/form controls, flows the body with `break-inside: avoid` on cards
> and rows, repeats table headers, and forces `print-color-adjust: exact` so green/red/amber
> survive). A print-only `<PrintHeader>` (reports layout) stamps the generation date; report
> titles print. The browser **Print** button alone now yields the full formatted document —
> the earlier `body:has(.print-area)` isolation rule blanked the page and was removed.

### Core operational pages

| Route | File | Purpose |
| --- | --- | --- |
| `/` | `app/page.tsx` | Home dashboard / tile launcher. No data. |
| `/login` | `app/login/page.tsx` | Sign-in (nav hidden). Honors `?next=` (paths only). Shows a public `<MarketBoard>` of grain futures via `fetchPublicQuotes()` (cached 5 min, blanks on failure). |
| `/loads` | `app/loads/page.tsx` | Master load log: search, filter (date/entity/county/crop year/contract), sortable columns (incl. **test weight**), paid/unpaid badges (matched to settlement lines by ticket #). The **whole row is clickable → the read-only detail page** (a helper line says so; checkbox + split-expand chevron `stopPropagation`); per-row View/Edit/Delete buttons were removed. Per-row split breakdown via the chevron, CSV export, multi-select **bulk delete** (chunks of 50). The derived paid/unpaid badge exports too — a **Payment** column in the Excel/PDF payload and a `paid_status` column in the CSV. |
| `/loads/new` | `app/loads/new/page.tsx` | Create one load manually (`<LoadForm mode="create">`); links to `/loads/scan`. |
| `/loads/[id]` | `app/loads/[id]/page.tsx` | **Read-only load detail** — one printable page (identity/logistics, weights/bushels, split breakdown, linked contract, and **payment** resolved from the settlement that matched this load's ticket). Payment state = paid / ambiguous (ticket shared by >1 load) / unpaid / N-A (stored, not sold); flags our-dry vs their-settled bushel diff >1%. Header actions: Edit, **Delete** (with confirm — `<DeleteLoadButton>`, moved here from the list rows), and `<LoadPdfBar>` Print/PDF/Excel via the shared export model. |
| `/loads/[id]/edit` | `app/loads/[id]/edit/page.tsx` | Edit a load + its splits + `<LoadAttachments>`. |
| `/loads/scan` | `app/loads/scan/page.tsx` | **AI scale-ticket capture** (photo/PDF → editable rows via `parseDocument(…, 'tickets')`). Fuzzy-matches truck/crop/field/bin/buyer, Ready/Needs-Review status, source preview, bulk-save. |
| `/loads/import` | `app/loads/import/page.tsx` | Bulk CSV import of loads with template, FK resolution by name, validation, dedupe by ticket, net = gross − tare fallback. |
| `/loads/unpaid` | `app/loads/unpaid/page.tsx` | Buyer-delivered loads with no matching settlement line; totals outstanding dry bushels. |
| `/inventory` | `app/inventory/page.tsx` | Live bin inventory = loads-in − loads-out + beginning inventory − empty-bin adjustments, grouped by bin site; flags "Unsited bins"; CSV export. |
| `/contracts` | `app/contracts/page.tsx` | Contract tracker: delivered-vs-contracted, pricing status, paid/unpaid revenue, progress bars, orphan-load warnings, and **first-notice-day + delivery-window warnings** (HTA/basis first notice within 30 days; delivery end within 14) — both **suppressed once a contract is completed** (marked complete or fully delivered). Type shown via **`effectiveContractType`**: a contract priced on *both* futures and basis reads as **Forward** (an HTA that got its basis, or a basis that got its futures), so it no longer mislabels. |
| `/contracts/[id]` | `app/contracts/[id]/page.tsx` | Printable contract detail; loads-delivered table (our dry bu vs settlement net bu); `<ContractActions>` (complete/delete) + attachments. |
| `/contracts/[id]/edit` | `app/contracts/[id]/edit/page.tsx` | Edit a contract via shared `<ContractFields>`. |
| `/settlements` | `app/settlements/page.tsx` | List of buyer settlement statements with line/unmatched counts, net bu/revenue, PDF link, Review link. |
| `/settlements/new` | `app/settlements/new/page.tsx` | Create + reconcile a settlement. The three entry paths present as one evenly-aligned set (`items-start`): **AI PDF/photo** (`parseDocument(…, 'settlement')`), CSV upload, or manual rows. Per-line ticket→load match status. |
| `/settlements/[id]` | `app/settlements/[id]/page.tsx` | Review/reconcile: Matched loads (diff >1% flagged), Unmatched lines, Missing loads; `<SettlementPdfPanel>`. **Persists** ticket→load matches on view (`relinkSettlementLines` server action; ambiguous tickets left for manual resolution) and offers a **manual match dropdown** per unmatched line (`line-match-select.tsx`). |
| `/yields` | `app/yields/page.tsx` | Yield analysis — **By field / farm / entity / variety / landowner**. Filters persist in localStorage. Practice filter + irrigated/dryland breakdown. Excludes unharvested/in-progress fields (per-field "Count anyway" override). Inline irr/dry and per-variety bushel allocation — **offered only once a field's harvest is complete** (`harvestStatusOf` in `lib/yields.ts`). Accepts `?breakout=1` deep-link. |
| `/hedging` | `app/hedging/page.tsx` | Futures & options position tracking with live P&L. Open/closed tables, per-crop-year × commodity summary cards, new/edit/close dialogs, brokerage statement import (`<StatementImport>`). Closed trades import as **per-lot offset groups**: each opening lot becomes its own closed position with realized P&L **computed in code** (`expandClosedGroup`, `(open−close)×contracts×size`), never the statement's group GROSS PROFIT/LOSS total — matched lots anchor to the DB entry price/size, each group's lot-sum reconciles to the statement total (`reconcileClosedGroup`, >$1 flagged on the review screen). Statement import also has a **distinct second step** that flags app-open positions absent from the statement as *possibly closed* (commodity+month match, scoped to the account entity) → **Close this position** (the real close workflow, no auto-close) or **Keep open**. Live prices via `/api/market-prices` and `/api/options-prices`. **Cotton-aware end to end**: every quantity displays in the commodity's own unit (`quantityFor`/`contractUnit` — lbs for CT; the tables' Bushels column is now **Qty**) and every price via `fmtCommodityPrice` (¢/lb for cotton — the position form's price field says so); the statement import extracts **ICE Cotton No. 2 alongside grains** (plain-decimal ¢/lb, never fractional-converted — the parse prompt scopes fractional conversion to CBT grains), and its review table keeps **Crop Yr beside Commodity** (both sticky) so the two per-row decisions need no horizontal scrolling. |
| `/revenue-projections` | `app/revenue-projections/page.tsx` | Legacy **redirect** → `/reports/revenue-projections`. |

### Settings pages (`/settings/*`)

`/settings` is a hub tile-grid (+ Sign Out → `/logout`). Subpages:

| Route | Manages |
| --- | --- |
| `/settings/entities` | Farming legal entities + their county assignments (`entity_counties`) + **payment-limit persons** (`entities.payment_limit_persons`, 041) — the FSA eligible-persons count, set ONCE per entity (not annually); total ARC/PLC limit = persons × the program year's per-person limit from Program Parameters. |
| `/settings/landowners` | Landowners (name/phone/email/address); shows their farms. |
| `/settings/farms` | Farms: entity (required), county (scoped to entity), FSA #, landowner, **share-rent flag + landlord share %**. CSV import. Delete cascades to fields. |
| `/settings/fields` | Fields: total/irrigated acres (derived dryland), county; expandable plantings; CSV + **AI import** (`<FieldsAiImport>`). Persisted **Farm filter** + an "N of M fields" count line. Delete cascades to plantings. |
| `/settings/plantings` | Field plantings (field × crop × season) with multiple varieties; CSV + **AI import** (`<PlantingsAiImport>`). Persisted **Farm filter** (also narrows the Field dropdown; clears a now-inconsistent field pick). Both imports route variety names through the shared **variety-resolution pipeline** (§4). |
| `/settings/varieties` | **Varieties duplicate cleanup — per-PAIR decisions** (no group merge). Strict pairing: two spellings pair only when normalized-equal or differing solely in the brand prefix (identical **numeric core** — "68-35" ↔ "DK 68-35"); any digit/trait-letter difference never pairs. Each pair card shows both spellings + usage counts and two actions: **Same variety — merge into [picked spelling]** (`buildVarietyMergePlan`: one row per planting, acres/bushels summed, redundant rows deleted, confirm with counts) or **Different varieties — keep both** → a `variety_match_dismissals` row silences the pair everywhere (this page AND import-time prompts). Empty state is the expected normal. |
| `/settings/bin-sites` | Bin sites and the bins within them; shows current bushels on hand per bin. |
| `/settings/trucks` | Thin: `<CsvImport>` + generic `<SimpleCrud>`. |
| `/settings/buyers` | Buyers + their delivery locations. |
| `/settings/crops` | Crops (base moisture, lb/bu, harvest category, double-crop). |
| `/settings/contracts` | Create/manage contracts (forward/HTA/basis) with **AI import**, CSV, shared `<ContractFields>` — whose Buyer and Delivery Location dropdowns carry **"+ Add new…" inline creation** (`components/buyer-location-pickers.tsx`, landowner-picker pattern): compact modal, same tables the settings pages manage, case-insensitive duplicate warning with "Use existing", locations scoped to the selected buyer. |
| `/settings/crop-insurance` | MPCI policies with SCO/ECO endorsements + an **irrigated/dryland practice** selector (the same crop/county/year can carry one of each); entity filter; **per-entity assignment** (a policy is carried by one entity — multi-entity ops must pick on upload/manual entry, single-entity auto-assigns); **AI import** (`<PolicyAiImport>`, captures practice per line, requires/auto-assigns the insured entity for the whole upload, lets you set the **"covers all planted acres" attestation per row before saving** — seeded from any existing match — and **dedupes like the brokerage import** on **entity**+crop+county+year+practice+plan: identical policies classify **"Already exists"** (unchecked/disabled, existing values shown), material differences classify **"Update available"** with a field-level existing→extracted diff and patch the existing policy in place — never duplicated — and only new combinations insert; footer reads "X already exist · Y updates · Z new"; SCO/ECO dedupe with their parent — absent-from-upload is never a change, upload-only shows "SCO: none → added". Pure logic `classifyPolicyUpload`/`diffPolicyUpload` in `lib/crop-insurance.ts`); **RMA projected-prices editor** (`<ProjectedPricesEditor>` — per crop×year rows in `harvest_price_estimates`); and a **Coverage Check** (`<CoverageCheck>`) reconciling insured vs planted acres by entity·crop·county·practice, with an inline **"covers all planted acres" attestation** (🟢 *Covered*) that suppresses the acre-mismatch flag for a combination (never the "no policy" flag). The **Variance column shows only when a residual under/over-insured gap remains** after submittal — once everything is attested or matched it's hidden (planted & insured stay side by side). |
| `/settings/government-payments` | ARC/PLC base acres, elections, price data (incl. **WASDE midpoint**), **ARC-CO Benchmarks**, ARC flat rates (fallback), payment limits (read-only — see `/settings/entities`), FSA base-acres import, **per-year program parameters** (`program_year_config`: SCO trigger, per-person limit, sequestration %, plus OBBBA ARC guarantee/cap %, ERP factor/cap, payment factors). The year selector is labeled **Program year** (everything here is program-year-keyed) and honors the reports' `?year=` deep link. **Benchmarks**: FSA benchmark price/county yield per commodity × **county + state** — rows key on `county_id`, display as "County, ST"; the add-row county picker **defaults to a single dropdown of the operation's own counties** ("County, ST", from farms), with "Other county…" revealing the full state → county cascade (paginated counties fetch). The **FSA lookup** button reads the county yield (per practice — irrigated/non-irrigated radio when both exist) straight from FSA's published "ARC-County Benchmark Yields and Revenues" workbook via `/api/fsa-benchmark-yield` (DB-cached; most-recent-published-year fallback via `data_year`) and the price from the file/seeded national values (`yield_source`/`price_source` 'usda'); the **AI web search survives only as a labeled fallback** (kept low-confidence guardrails). When a lookup finds nothing, retry controls offer a **nearby county (same state) and/or a prior year** — borrowed values still save to the row's own county with the borrowing recorded in `source_description` and amber chips before confirm. Legacy ambiguous-name rows stay flagged "(state unknown)". |
| `/settings/users` | **Users & Modules** — the Cotton module toggle + the role system: assign `owner`/`gin` by email (`assign_user_role`/`list_user_roles` security-definer RPCs; login credentials are still created in the Supabase Auth dashboard — no service key in the browser). |

### Cotton module pages (`/cotton/*`, feature-flagged, migration 042)

All three share the Reports-style sidebar layout (`app/cotton/layout.tsx`) under the single Cotton tab.

| Route | Purpose |
| --- | --- |
| `/cotton/loads` | **Seed Cotton Loads** — the gin's module/weight tickets (lbs seed cotton, no shrink math; unique per crop year × load #). Manual form (persistent crop year, farm→field cascade, net = gross − tare) + **AI Module List upload** (`document_type 'cotton_weight_ticket'`, one load per page, farm matched by FSA # then producer name, review → batch save) + **Yard Inventory** (delivered lbs not on any gin receipt, by field — inventory until ginned). |
| `/cotton/receipts` | **Gin Receipts** (Statements of Ginning; multiple per field). Manual form + **AI upload** (`'gin_receipt'`: header/totals — modules, seed cotton lbs, bales, lint lbs, cottonseed lbs, turnout — the load table, and the FULL bale list across pages). Review matches farm/field, matches load lines to `cotton_loads` by load # (**create missing inline**), flags stated-vs-captured **bale-count mismatches** (`reconcileBaleCount`), saves receipt + links + bales with compensating cleanup on failure. |
| `/cotton/bales` | **Bales & Grades** — every bale with its HVI classing. **Deterministic classing-CSV import** (`lib/cotton-grades.ts` — NO AI): preamble skipped, columns mapped by header name (order-tolerant), CRLF + blank Ex/Rm handled; rows match bales by **PBI #** (leading zeros ignored; Farm/Field columns are corroboration only), NetWt cross-checked >1% vs the receipt bale, unmatched rows held visible for later; upsert one grade row per bale. |

### Reports (`/reports/*`)

| Route | Report |
| --- | --- |
| `/reports` | Landing page (cards rendered from `reports-nav.ts`). |
| `/reports/yields-by-landowner` | **Yields by Landowner** — per-landowner production grouped by farm/field (splits-aware). |
| `/reports/share-rent` | **Share Rent Report** — landlord-share production at each farm's configured share %. |
| `/reports/bale-quality` | **Bale Quality Summary** (Cotton module) — per field: bales, lint lbs, weighted avg loan ¢/lb, and color/staple/mic/strength distributions — the HVI package a producer shows buyers. Shared export layer. |
| `/reports/crop-insurance` | **Crop Insurance Production Report** — county × practice (irrigated/dryland) production for insurance agents. Filters: crop year, entity, and a **multi-select crop filter** (toggle chips; empty = all; options scoped to crops present in the selected year + entity; persists like the other filters) that flows through the tables, the mixed-practice gate (a Corn-only view isn't blocked by a Soybean planting), and both exports. Mixed-practice plantings without a breakout are gated — **only once harvest is complete** (`components/reports/crop-insurance-report.tsx`). Exports mirror the screen's three per-crop metric groups (Certified Acres / Production / **Yield/Acre**) as spanning group headers. |
| `/reports/season` | **Season Summary** — acres & yield by crop; excludes unharvested/in-progress. A cotton crop's row keeps its acres but shows "lbs of lint — see Cotton Yields below" instead of bushel/yield cells (`isCottonCrop`; the export mirrors it), pointing to the flag-gated **Cotton (lint) section** (`components/reports/cotton-yields-section.tsx`, also on `/yields`): lbs lint/acre, seed cotton lbs/ac, turnout %, and "on yard awaiting gin" per field. |
| `/reports/cash-flow` | **Cash Flow Forecast** — monthly **received** (cash collected on settled loads, in the settlement's month) / **outstanding** (delivered-but-unpaid, valued at contract price, current month) / **projected** (undelivered contracted bushels at contract price, spread across the remaining delivery window) revenue + a **Total Safety Net** (projected ARC/PLC, crop-insurance indemnity, other USDA payments). Filtering to crop year Y shows the **program-year-Y−1 ARC/PLC arriving in Oct Y** (payment-year attribution — the summary card and disclaimer name the program year); other payments count by the year received. A **completed contract** (`completed_at` set or fully delivered) books **no projected/unearned revenue** even with bushels remaining (`isContractComplete`), shown with a `complete` badge; an in-page legend defines received/outstanding/projected. The **crop-insurance line uses the shared `projectInsuranceIndemnities`** (same per-practice yields + today's live Barchart harvest price as the Claims Monitor — this page fetches the live estimate too), so the two reports' projected indemnity reconciles. |
| `/reports/marketing` | **Marketing Dashboard** — one **full-width section per crop**, stacked vertically: header = crop identity (name + total production) alongside large **Acres**, **Yield**, **Total/Avg Price** (with its **Futures** and **Basis** components shown on the line beneath, no "blended" qualifier), **Profit/acre** and **Total Profit** stats, with the **marketing position bars running full width *beneath* the metrics** (Sold, or Futures-priced + an expandable Basis bar). A chevron (persisted per crop) expands a detail view that reads like a financial statement: a responsive grid of **Avg Futures Price Buildup** (per-source ledger → weighted-avg subtotal → realized hedge P&L/bu → bold avg-futures total, then the assumed price on the unpriced bushels re-footed to an avg across all production) \| **Basis Buildup** (locked vs assumed bushels → bushel-weighted blended total, footed with its state — `actual`/`assumed` shown as a qualifier, the blend itself carrying none) \| **Profitability** — 3-up (advanced) / 2-up (simple) — above a **full-width horizontal What-If** row. **Assumed futures and assumed basis are standing per-crop assumptions** (persist to `crop_assumptions.assumed_futures`/`assumed_basis`, survive leaving the page, save on blur, wiped by a per-crop **Clear assumptions** button); they value the crop's unpriced bushels, and the headline **Total/Avg Price · Profit/acre · Total Profit reflect them**. **Revenue/acre, Profit/acre and Total Profit derive from the crop's blended expected revenue** (÷ acres, then − cost) — the same single source of truth Revenue Projections uses — so the two pages reconcile to the cent; **breakeven = cost ÷ avg price / cost ÷ yield** (sales-only, identical to Revenue Projections). An amber **"includes assumptions"** marker shows whenever any production isn't fully locked (nothing when fully locked; tooltip breaks down X unpriced = Y futures + Z basis). Production is actual once harvest complete, else assumption-derived; the futures input offers **"use today's price"** (new-crop benchmark contract); the Assumptions editor holds just yield/cost irr-dry & full-season/double-crop breakouts + the harvest-complete snap. **Cotton crops get their own lbs-native section** (`unit: 'lbs'` marketing rows): production in lbs of lint (+ bale-count companion) from gin receipts, hedged lbs = open short CT contracts at their weighted ¢/lb, **no Sold/basis blocks** (physical cotton marketing isn't tracked yet — the section says so), unhedged lbs valued at the CTZ estimate or the standing assumed ¢/lb; dollar outputs (revenue/profit) mean the same as grains so the combined totals still mix crops safely. The whole export payload is extracted pure to **`lib/marketing-export.ts`** so the mixed grain ($/bu + bu) / cotton (¢/lb + lbs) formatting is unit-tested. |
| `/reports/income-sensitivity` | **Income Sensitivity** — one **futures-price × yield two-variable data table per crop** (full-width sections stacked, Marketing-dashboard layout language). Rows = futures levels for the crop's new-crop benchmark contract (symbol in the axis header, centered on today's live Barchart price); columns = yield levels (centered on expected yield). Axis center/step/±count editable per crop (persisted); the row/column closest to today's price × expected yield is highlighted (**"you are here"**). Cell math is the pure `lib/income-sensitivity.ts` engine composing the marketing + crop-insurance engines: **contracted bushels stay at locked prices** (scenario price values only unpriced bushels; over-contract cap applies; a regime badge says "No contracts — fully price-sensitive" vs "X bu contracted at locked prices"); **harvested bushels are fixed facts** — the yield axis applies only to remaining acres (`splitHarvestByCrop`; mid-harvest the header reads "Yield on remaining X acres" with a "Harvested so far: Y bu on Z ac" note; a fully-harvested crop collapses to one actual-yield column, price-only); **insurance re-runs per policy/practice** at the scenario price as harvest price (**pinned to the RMA final once on file**), net of premium; an **Include government payments** toggle adds the payments **received during crop year Y** (program-year-Y−1 ARC/PLC paid in fall Y + other payments landing in Y) as one flat $/ac (total net ARC/PLC + other USDA ÷ total planted acres) identically to every crop, constant across cells. Display toggle **Revenue/acre \| Net profit/acre** (persisted; profit view tones negatives red-in-parens), methodology panel, Excel/PDF export with the price axis as first column and active toggles in the filter line. **Cotton sections run in ¢/lb × lbs lint/ac** (default steps 2¢ / 50 lbs, CTZ axis symbol; hedged-lbs badge and cell tooltips carry the units). |
| `/reports/hedging-summary` | **Hedging Summary** — all futures positions (open + closed) with realized/unrealized P&L by crop year; quantities and prices in each commodity's own unit (lbs + ¢/lb for cotton). |
| `/reports/crop-insurance-claims` | **Crop Insurance Claims Monitor** — estimated indemnity per policy (RP/RP-HPE/YP + SCO/ECO), **no what-if controls** (scenario analysis moved to the Income Sensitivity Report, linked from the page). **Per-practice**: irrigated and dryland are separate rows, each using its own practice yield — actual `irrigated_bushels`/`dryland_bushels` once harvested, else the **Marketing report's per-practice expected-yield breakout** (`crop_assumptions.expected_yield_irr`/`_dry`, blended-`expected_yield` fallback) so irrigated/dryland differ even before harvest, then crop default / mean APH — with a per-crop subtotal. The harvest-price basis is **today's live Barchart price** (discovery-month contract) until the RMA final is on file, then the final. Links to the **Income Sensitivity Report** and the **Coverage Check** (`/settings/crop-insurance#coverage-check`). |
| `/reports/arc-plc-decision-aid` | **ARC/PLC Decision Aid** — a **Program Comparison by Crop** summary leads the page (and the PDF export): per commodity — base acres, resolved MYA (state chip, what-if-adjusted), effective reference price, PLC spread, all-farms-PLC vs all-farms-ARC-CO totals (summed from the per-farm engine rows, live with the What-If slider), $/ac difference, and a Favors PLC / Favors ARC-CO / **Toss-up** verdict (`TOSS_UP_BAND_PER_ACRE` = $2/base acre) with an "N on flat est." chip; **All PLC / All ARC-CO bulk buttons** set every farm's election after a confirm listing the changing farms (per-farm rows stay editable). Below it: compare projected PLC vs the **real ARC-CO county-revenue engine** (`computeArcCoPayment`: 90% guarantee on benchmark price × benchmark county yield, actual county revenue at max(MYA, loan), capped at 12% of benchmark revenue — parameters from `program_year_config`) per farm/commodity; set election. Counties without benchmark data fall back to the flat $/acre estimate, labeled — the **"flat est." chip's tooltip says WHY** (farm has no county assigned vs. no benchmark row for that county × program year), and a **program-year mismatch notice** fires when benchmark rows exist only for OTHER years (with a `?year=`-carrying settings deep link). Surfaces the shared **MYA Prices panel** (NASS Quick Stats lookup) + **County Yield Expectation** control (% vs benchmark ↔ absolute yield, persisted per commodity × county × year on `arc_benchmark_data`; counties resolve by `county_id` and display as "County, ST"); per-row **drivers** breakdown; the What-If MYA % slider moves BOTH programs. OBBBA SCO note (SCO available regardless of election, 80% subsidy; 2025 pays higher-of automatically). |
| `/reports/government-payments` | **Government Payment Tracker** — projected ARC/PLC + other USDA payments with per-entity payment-limit tracking. A **By Entity × Crop matrix** leads the page (and the exports): entities × nonzero commodities + Other USDA + totals; farm-linked payments roll up via the farm's entity, non-farm others attribute by entity_id with a "— no entity —" row so the corner always reconciles; entity Total cells carry the payment-limit tone. **Year framing** (payment-year attribution): the default **"By payment year"** view shows the payments received in crop year Y — program year Y−1's ARC/PLC (header: "Y−1 program year → paid Oct Y") plus other payments landing in Y; a **"By program year"** toggle re-frames to the FSA program year for reconciliation (switching shifts the selected year ±1 so the same pool stays on screen). All math stays keyed to the program year. A **program-year mismatch notice** fires when ARC-CO benchmark rows exist only for years OTHER than the program year in view (names both, links to Settings pre-set to the right year); the **"ARC-CO settings →"** button deep-links with `?year=<programYear>#bench` so entered data always lands on the year the report computes. **Payment limits** = each entity's `payment_limit_persons` (set once — Settings → Entities) × the program year's per-person limit from Program Parameters; the Payment Limit Status table shows the persons × limit breakdown per entity. A one-time amber note flags other-payment entries that look like old program-year semantics. A shared **MYA Prices panel** (`components/reports/mya-price-panel.tsx`, also on the Decision Aid) gives **EVERY covered commodity the same treatment** — Auto \| Manual toggle, inline manual entry, USDA lookup, inline ↻ refresh (compact confirm strip); commodities without Barchart futures simply have no futures tier (their Auto = the USDA monthly blend alone); a published final locks the row. Each row shows the resolved MYA with a state chip (**est. / manual / final / WASDE**), its source, the effective reference price, and the **PLC payment-rate spread**. The **"Look up USDA prices"** button (and ↻) hits `/api/nass-monthly-prices` — the **NASS Quick Stats API, real published data** — with fetched months beside existing entries (differences highlighted; already-entered months start **unchecked**, never overwritten without explicit confirmation); confirmed months save `source='usda'` (an edited value becomes `'manual'`). On NASS failure or an empty result, an inline **"Try AI lookup"** button runs the old web-search route as a labeled fallback (`source='ai'`, confidence chip kept). **Seed cotton is ONE commodity with ONE price**: the lookup fetches the NASS lint (¢/lb) + cottonseed ($/ton) series and blends **in code** at configurable 43/57 shares (editable in its Details), with the composition shown at confirm and saved to the month's `note`. All projections update live on toggle/confirm. Exports carry the per-commodity **Election** column, the year-basis framing in the filter line, and the **Payment Limit Status** table (second section, status tones). |
| `/reports/revenue-projections` | **Revenue Projections** — one-page financial summary: all revenue sources + cost, profit, breakeven. Crop sales revenue = the Marketing engine's **blended expected revenue** (each bushel bucket at its own price; realized hedge P&L counted once), so its **profit reconciles with the Marketing dashboard exactly** — the only difference is the crop-insurance proceeds + government payments (attributed to the crop year received: program-year-Y−1 ARC/PLC + other payments landing in Y) this page adds (asserted by a Vitest identity test). Both pages roll up through **one shared `aggregateMarketing`** (full-precision sum, rounded only at display) and feed `computeMarketing` the **same `expectedProductionByCrop` + live harvest-price estimate**, so their totals are structurally identical. The dashboard's What-If (assumed basis &amp; futures) is a **saved standing assumption**, so it flows straight through here and values unpriced bushels the same way. **Breakeven** (sales-only, identical to the dashboard): price = cost ÷ yield; yield = cost ÷ the large headline **Total Avg Price** (`breakevenAvgPrice` — the effective revenue ÷ production price once assumptions blend in), surfaced as its own column beside breakeven. All methodology lives in one collapsible **How this is calculated** panel; $/bu prices show two decimals. **Cotton rows carry `unit: 'lbs'`**: effective price and breakeven price in ¢/lb, breakeven yield in lbs/ac (against the row's own `totalAvgPrice`), and the totals keep grain bushels and cotton lbs separate (`RevenueTotals.totalProductionLbs`) — dollar columns mix crops as before. |
| `/reports/settlement-pdfs` | **Bundled Settlement Statements (Production Audit)** — zips every attached buyer settlement PDF for a crop & year. |

---

## 3. Database schema

**Supabase / PostgreSQL** with `pgcrypto` (`gen_random_uuid()`). Defined by **43 sequential,
idempotent migrations** in `supabase/` (`schema.sql` = 001, then `002_*.sql` … `043_*.sql`).
Every table re-runs safely (`create table if not exists`, guarded `do $$…$$`), uses a `uuid`
PK and `created_at`. ~47 tables, **no views**. Later migrations frequently `ALTER` earlier
tables (esp. `contracts`, `farms`, `fields`, `field_plantings`, `crop_assumptions`,
`crop_insurance_policies`). `035` adds the irrigated/dryland **practice** column to
`crop_insurance_policies` (default `non_irrigated`); a policy is now keyed by entity ×
crop × county × crop_year × practice (+ plan_type), SCO/ECO inherit it. `036` adds
`covers_all_planted_acres` (default false) + `coverage_note` to `crop_insurance_policies` — the
Coverage Check attestation that suppresses acre-mismatch flags for a combination.

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
- `034` — `crop_assumptions.assumed_futures` (Marketing assumed/what-if futures price; nullable).
- `035` crop-insurance practice — `crop_insurance_policies.practice` (irrigated/non_irrigated, default dryland).
- `036` — `crop_insurance_policies.covers_all_planted_acres` (default false) + `coverage_note` (Coverage Check attestation).
- `037` — post-OBBBA ARC/PLC: `program_year_config` OBBBA parameter columns, OBBBA reference prices/loan rates on `covered_commodities` (+ `mya_basis_adj`/`mya_month_weights`), new `arc_benchmark_data` + `mya_monthly_prices` tables, `arc_plc_price_data.wasde_midpoint`/`mya_note` + `'wasde'` source, seeded 2025/2026 ERPs and benchmark prices.
- `038` — county + state keying & AI MYA: `arc_benchmark_data.county_id`→counties (backfilled where the name is unambiguous nationwide; uniqueness re-keyed on commodity × year × county_id, legacy name key kept only for rows without one); `mya_monthly_prices.source` check widened to `('usda','manual','ai')`.
- `039` — payment-year attribution: `arc_plc_payments.revenue_crop_year` (generated `crop_year + 1` — the crop year the cash arrives in; `crop_year` = the PROGRAM year that drives the math); column comments pinning the semantics (`other_government_payments.crop_year` = the payment/attribution year).
- `040` — FSA benchmark file cache + unified seed cotton: `fsa_benchmark_cache` (parsed rows from FSA's annual benchmark workbook, per data_year × state × county × commodity × practice) + `fsa_benchmark_fetches` (daily fetch-guard log); `covered_commodities.lint_share`/`cottonseed_share` (configurable seed cotton weight shares, defaults 43/57 in code); `mya_monthly_prices.note` (component provenance for derived prices).
- `041` — entity payment limits: `entities.payment_limit_persons` (default 1, ≥1, backfilled from each entity's most recent `payment_limit_config` row); `payment_limit_config` **deprecated** (kept for history, never read).
- `042` — **Cotton module** + first roles: `app_settings` (single-row org settings — `cotton_module_enabled`; designed for the per-org re-key), `gins`, `cotton_loads`, `gin_receipts` + `gin_receipt_loads`, `cotton_bales` (PBI unique per crop year), `cotton_bale_grades` (full HVI columns + loan $ and derived ¢/lb), `user_profiles` (role `owner`/`gin`) with security-definer `app_role()`/`assign_user_role()`/`list_user_roles()`; Cotton seeded into `commodity_specs` (CT, 50,000 lbs — note the real tick columns are `tick_size_cents`/`tick_value_usd`). **Role RLS**: gin users get full cotton-table access, SELECT-only on farms/fields/entities/counties (RESTRICTIVE write-block policies), and a RESTRICTIVE all-block on every other table — RESTRICTIVE policies AND with the existing permissive ones, the groundwork multi-tenancy extends.
- `043` — **`variety_match_dismissals`**: "keep both" decisions on suspected-duplicate variety spellings (crop_id + sorted normalized key pair, unique; permissive authenticated policy + RESTRICTIVE gin block), consulted by the Varieties cleanup page and both planting-import possible-match prompts.

### Tables (grouped) — purpose & key columns

**Org & land**

- **`entities`** — legal entities (LLCs/partnerships). `name` (unique), `notes`, **`payment_limit_persons`** (041 — FSA eligible persons, entity-level: total ARC/PLC limit = persons × the program year's per-person limit).
- **`landowners`** — third-party owners of rented ground. name/phone/email/address/notes.
- **`farms`** — `name`, `entity_id`→entities, `fsa_number`, `county_id`→counties, `landowner_id`→landowners, `is_share_rent`, `landlord_share_percentage` (0–100, required when share-rent).
- **`fields`** — `farm_id`→farms (cascade), `name_or_number`, `total_acres`, `county_id`, `irrigated_acres`, **`dryland_acres` (trigger-derived = total − irrigated)**.
- **`counties`** — US county reference (all states + DC, 3,143 rows). unique `(name, state_code)`. Consumers that need the whole table fetch it via `lib/counties.ts` `fetchAllCounties` (paginated `.range()` loop — a bare `select('*')` silently truncates at Supabase's ~1,000-row cap, which used to hide most counties from the government-payments pickers).
- **`entity_counties`** — entity↔county junction. unique `(entity_id, county_id)`.

**Crops & planting**

- **`crops`** — `name` (unique), `base_moisture_pct`, `base_lb_per_bushel`, `harvest_category` (fall/spring), `double_crop`.
- **`field_plantings`** — field×crop×season. `field_id`, `crop_id`, `season_year`, `planted_acres`, `planting_date`, `paired_planting_id` (double-crop), `irrigated_acres`, **`dryland_acres` (trigger-derived)**, `irrigated_bushels`/`dryland_bushels`, **`yield_breakout_entered`**, **`yield_include_override`** (null=auto, true=force-include).
- **`field_planting_varieties`** — `planting_id`→plantings, `variety`, `acres`, `bushels` (nullable, manual allocation).
- **`variety_match_dismissals`** (043) — "keep both" decisions on suspected-duplicate variety spellings: `crop_id`→crops (cascade), `key_a`/`key_b` (varietyKey-normalized, sorted, unique per crop). Consulted by Settings → Varieties and import-time possible-match prompts.
- **`crop_assumptions`** — per crop×year marketing inputs. unique `(crop_id, crop_year)`. `expected_yield`, **`harvest_complete`**, `cost_per_acre`, **`assumed_basis`** (033, fallback basis for unlocked bushels), **`assumed_futures`** (034, assumed futures price for unpriced bushels; nullable), plus `*_irr`/`*_dry`/`*_dc_irr`/`*_dc_dry` yield (029) and cost (031) breakouts.

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

- **`commodity_specs`** — futures specs (seeds Corn ZC, Soybeans ZS, Chicago Wheat ZW; 042 adds **Cotton CT** — ICE, 50,000 lbs, months H/K/N/V/Z, prices in ¢/lb; futures P&L uses `pnlSizeFor()` = $500/point). `commodity` (unique), `symbol`, `exchange`, `contract_size_bu`, tick size/value, `contract_months`.
- **`futures_positions`** — `entity_id`, `commodity`, `contract_month`/`contract_symbol` (e.g. `ZCZ26`), `crop_year`, `side` (long/short), `num_contracts`, `trade_price`/`trade_date`, `status` (open/closed), close fields, `realized_pnl`, `source` (manual/statement_import).
- **`options_positions`** — `option_type` (call/put), `side` (buy/sell), `strike_price`, `num_contracts`, `premium_cents`, **generated `premium_total`**, `status` (open/closed_offset/expired_worthless/exercised), `manual_current_value_cents` (fallback), `exercised_position_id`→futures.
- **`market_prices`** — EOD price cache. unique `(contract_symbol, price_date)`.

**Crop insurance**

- **`crop_insurance_policies`** — one per entity×crop×county×year×practice. `entity_id` (the insured entity), `plan_type` (RP/RP_HPE/YP), `practice`, `coverage_level` (0.5–0.85), `unit_structure`, `aph_yield`, `projected_price`/`harvest_price`, `volatility_factor`, `insured_acres`, premium fields, **`covers_all_planted_acres`** + **`coverage_note`** (036 attestation — all planted acres covered, suppresses the Coverage Check acre-mismatch flag), `source`.
- **`crop_insurance_sco`** / **`crop_insurance_eco`** — 1:1 endorsements on a policy (unique `policy_id`); trigger levels, expected county yield, premiums.
- **`harvest_price_estimates`** — discovery cache. `crop_id`, `crop_year`, `price_type` (projected/harvest_final/harvest_estimate), `price`. unique `(crop_id, crop_year, price_type, price_date)`.

**Government (ARC/PLC) programs**

- **`covered_commodities`** — FSA program crops (separate from `crops`; base can exist for non-grown commodities). `name` (unique), `crop_id`, `statutory_reference_price`, `unit`, `national_loan_rate`, marketing-year months, `mya_basis_adj`/`mya_month_weights` (blend overrides), **`lint_share`/`cottonseed_share`** (040 — seed cotton blend weights; null = 43/57 code defaults).
- **`farm_base_acres`** — `farm_id`, `commodity_id` (nullable since 026 for generic base), `base_acres`, `plc_yield`, `is_unassigned`. unique `(farm_id, commodity_id)`.
- **`arc_plc_elections`** — `election` (PLC/ARC_CO/ARC_IC) per farm×commodity×year.
- **`arc_plc_price_data`** — `effective_reference_price`, `mya_price_estimate`/`_final`, `source`.
- **`arc_plc_payments`** — projected/actual payments; `payment_factor` (0.85), `sequestration_pct` (~0.054), `net_payment`, `payment_status`. `crop_year` = the **program year** (drives the math); `revenue_crop_year` (039, generated `crop_year + 1`) = the crop year the payment is actually received in (October of program + 1) — drives revenue attribution. The +1 lives in ONE place in code: `revenueCropYearFor`/`programYearFor` in `lib/government-payments.ts`.
- **`other_government_payments`** — manual non-ARC/PLC USDA payments. `crop_year` = the **payment/attribution year** (the year received, not a program year); attribution prefers `payment_date`'s year when set (`paymentAttributionYear`). Entries that look like old program-year semantics (dated the year after their crop_year) surface a one-time review note on the Tracker.
- **`payment_limit_config`** — **DEPRECATED (041)**: eligible persons moved to `entities.payment_limit_persons`; the per-person $ cap lives in `program_year_config`. Kept for history, never read.
- **`fsa_benchmark_cache`** (040) — parsed rows from FSA's annual "ARC-County Benchmark Yields and Revenues" Excel workbook: `data_year` (the FILE's year — may trail the requested program year), `state_code`, normalized `county`, `commodity` (as printed), `practice` (irrigated/non_irrigated/all), `benchmark_yield`/`benchmark_price`/`benchmark_revenue`, `source_url`, `fetched_at`. Ingested per state on lookup miss; unique on the five-part key.
- **`fsa_benchmark_fetches`** (040) — fetch-guard log (requested_year × state_code × checked_at) so a missing county or unpublished year hits fsa.usda.gov at most daily.
- **`program_year_config`** — per-crop-year program parameters (032, extended 037): `sco_trigger` (0.86 in 2026, 0.90 in 2027), `per_person_payment_limit`, `sequestration_pct`, plus the OBBBA columns `arc_guarantee_pct` (0.90), `arc_payment_cap_pct` (0.12), `erp_olympic_factor` (0.88), `erp_cap_pct` (1.15), `payment_factor` (0.85), `arc_ic_payment_factor` (0.65); `notes`, `updated_at` (trigger). unique `crop_year`; seeded 2025–2027. Resolved via `lib/program-config.ts` (most-recent-year fallback with UI notice; era-aware built-ins — pre-2025 years default to 86%/10%/85%).
- **`arc_benchmark_data`** (037, re-keyed 038) — FSA ARC-CO benchmark price & county benchmark yield per commodity × crop_year × optional county. **Keys on `county_id`→counties (which carries the state)** — county names repeat across states; the `county` text column is display/legacy only (a row with `county` set but `county_id` null predates 038 and had an ambiguous name). Null county_id + null county = the all-counties default row. `price_source`/`yield_source` (usda/manual/ai), `county_yield_vs_benchmark_pct` (the persisted county-yield expectation, −30..+30), `source_description` (AI lookup provenance). Seeded 2025/2026 benchmark prices (corn 5.03 / soy 12.17 / wheat 6.98, source usda). Resolution (`resolveArcBenchmark`): county_id match > name match against legacy rows (never a row pinned to a different county_id) > default row.
- **`mya_monthly_prices`** (037; `source` gains `'ai'` in 038; `note` in 040) — USDA/NASS monthly national average farm prices per commodity × marketing year × calendar month, feeding the MYA blend estimate (`lib/mya-estimate.ts`; published months + futures-implied remainder × marketing weights). `source`: `'usda'` = confirmed from the NASS Quick Stats lookup (real published data), `'ai'` = confirmed from the web-search fallback, `'manual'` = operator-typed (incl. an edited fetched value). `note` = component provenance for derived prices (seed cotton: "lint 63.1¢ + seed $239/ton → 33.94¢ SC"). `covered_commodities` gains `mya_basis_adj` + `mya_month_weights`; `arc_plc_price_data` gains `wasde_midpoint` (overrides the blend within the estimate tier) + `mya_note`, with FSA-published 2025/2026 effective reference prices seeded (corn 4.42 / soy 10.71 / wheat 6.35) and OBBBA statutory prices/loan rates updated on `covered_commodities`.

**Cotton module (042)**

- **`app_settings`** — single row (`id = 1`): `cotton_module_enabled`. Org-level; the multi-tenant conversion re-keys it per organization.
- **`user_profiles`** — `user_id`→auth.users, `role` ('owner' | 'gin'). No row = owner. Read via security-definer `app_role()` so policies don't recurse.
- **`gins`** — `name` (unique), address/phone/notes.
- **`cotton_loads`** — seed cotton module tickets, parallel to grain loads: `load_number` (unique per `crop_year`), entity/farm/field FKs, picked/delivered dates, truck, gross/tare/`net_weight` (lbs SEED COTTON), `gin_id`, source ('manual'|'document_import'), `source_pdf_url`. Yard inventory until on a receipt.
- **`gin_receipts`** — one Statement of Ginning (unique `crop_year`+`receipt_number`): gin/entity/farm/field, `modules_count`, `total_seed_cotton_weight`, `bales_count`, `total_bale_weight` (lbs LINT), `avg_bale_weight`, `seed_lbs` (cottonseed), `lint_turnout_pct`, `lint_lbs_per_bale`.
- **`gin_receipt_loads`** — receipt ↔ cotton_load junction (the receipt's load table, matched by load #).
- **`cotton_bales`** — one row per bale: `gin_receipt_id` (cascade), denormalized `crop_year` + `pbi_number` (unique pair), `net_weight_lbs`.
- **`cotton_bale_grades`** — one HVI classing row per bale (unique `bale_id`): class_date, color/leaf grades, staple 32nds, mic, strength g/tex, composite grade, Rd/+b, trash/uniformity/length, extraneous/remarks, `loan_value_total` $ + derived `loan_value_cents_per_lb`, source ('csv_import'|'manual').

### Triggers, generated columns, storage, RLS

- **Triggers:** `loads_set_updated_at` and `program_year_config_set_updated_at` (BEFORE UPDATE); `fields_set_dryland` and `field_plantings_set_dryland` keep `dryland_acres = greatest(0, total/planted − irrigated)` even on raw/CSV imports.
- **Generated columns:** `settlement_lines.net_revenue` & `price_per_bushel`; `options_positions.premium_total`.
- **Storage:** public bucket **`documents`** (load tickets, settlement scans, contract attachments, AI parse uploads).
- **RLS:** every table has the permissive `for all to authenticated` policy; since 042, **RESTRICTIVE role policies** AND with it — gin-role users keep the cotton tables, get SELECT-only on farms/fields/entities/counties, and are blocked everywhere else. Still single-tenant (one operation); the role layer is the multi-tenancy groundwork. Storage has authenticated CRUD policies scoped to `bucket_id = 'documents'`; the bucket is also public-read so the PDF viewer can load files without signed URLs.

---

## 4. Features & AI document parsing

### Cross-cutting capabilities

- **Shrink math** (`lib/shrink.ts`) — net weight + moisture + crop base values → wet & dry bushels; honors `dry_bushels_override`; falls back to wet bushels when moisture is missing.
- **Yield analysis** (`lib/yields.ts`) — aggregates dry bushels per field/crop/year, drops unharvested fields, and flags **any** still-being-harvested field as "in progress" — every field with a load within the last 5 days (`IN_PROGRESS_STALE_DAYS`, since harvest jumps between fields / runs two combines) whose yield is >15% (`IN_PROGRESS_THRESHOLD`) below the **weighted average of the crop's *settled* fields** (last load older than the window), so a partial field never drags the baseline down; supports "count anyway" overrides, produces weighted averages and harvest-progress-by-acres. `harvestStatusOf` / `isHarvestComplete` classify a planting (complete / in-progress / unharvested) to gate the bushel-allocation and variety-prompt UI; `cropsWithCompleteHarvest` feeds the Marketing dashboard's actual-vs-estimated switch. `groupYieldAggregates` rolls the harvest-included plantings up by group × crop × season (same irr/dry breakdown rules as By Farm) — powers the **Yields By Entity** tab and is generic enough for any grouping.
- **Double-crop classification** (`lib/plantings.ts`) — a `double_crop` crop on a field that also had a spring-harvest planting that season.
- **Split loads** (`lib/load-splits.ts`) — allocate one load across multiple fields with per-split shrink; validates weights sum to parent net (±1 lb).
- **CSV import engine** (`lib/csv.ts`) — config-driven importer with FK lookups/aliases, child relations, derived columns, `add` vs `sync` modes (sync only updates changed columns; blanks never overwrite), batch insert with per-row fallback. Styled Excel templates via `lib/import-template.ts`. An `ImportConfig.resolution` hook (`ChildResolution`) routes a child column's values (plantings: varieties, scoped per crop) through the variety-resolution pipeline — `extractChildValues` previews the file's names per scope, the UI shows matched / possible / new counts and blocks import until every possible-match is decided, and `runImport`'s `childValueTransform` rewrites each value to its resolved name on save; an optional `loadDismissed` supplies per-scope "keep both" pairs so dismissed pairs never re-prompt.
- **Variety resolution pipeline** (`lib/variety-resolution.ts`) — pure, shared by the CSV importer, the AI plantings import, and Settings → Varieties. `varietyKey` normalizes spellings (uppercase, spaces/hyphens/periods stripped) so format variants ("DG 3644 B3XF" / "dg3644-b3xf") are the SAME variety and auto-link to the stored spelling. **Strict near-matching**: seed names are [brand prefix][number][trait tail] and the **numeric core** (`numericCore` — everything from the first digit on) IS the product identity, so `keysNear` flags a possible match ONLY when two different keys share an identical core (i.e. differ solely in the brand prefix: "68-35" ↔ "DK 68-35", "Dyna-Gro 3644B3XF" ↔ "DG3644B3XF") — any difference in a digit or trait letter ("DK 65-95" vs "DK 68-35", "47XF2" vs "47XF6", "DP 2131" vs "DP 2239", "DG 3644" vs "DG 3646") is a different product and never prompts; substring/edit-distance rules are gone. Possible matches are **decided by the user, never auto-merged**; new names are created once per file (first-seen spelling canonical, variants collapse via `buildVarietyPlan`). **"Keep both" dismissals** (`variety_match_dismissals`, `dismissalKey` on sorted normalized keys) permanently silence a pair across the cleanup page and both import paths. `findSimilarVarietyPairs` (pairwise, no transitive grouping, dismissal-aware) + `buildVarietyMergePlan` (one surviving row per planting, acres/bushels summed) power the cleanup screen.
- **Planting-row classification** (`lib/planting-import.ts`) — pure New/Update/Unchanged rules for the AI plantings upload, **including varieties**: `classifyPlantingRow` marks a row Update when a provided scalar differs OR the row carries a variety the matched planting doesn't have (`varietyAdditions`, by normalized key) — a row identical except its varieties is never Unchanged, and a no-variety planting gaining its first variety is the canonical Update. On save, update rows patch changed scalars AND insert the missing variety rows (resolved names, acres carried; existing variety rows never modified/removed); resolution runs on every extracted row regardless of classification, and unresolved possible-matches block update rows too.
- **Universal exports** (`lib/exports.ts`) — the **shared export layer** every report goes through (`<ExportBar>` → `exportToPdf`/`exportToExcel`), so formatting is defined once and the export mirrors the screen. An `ExportPayload` carries the title, plain-English `filters`, `summary` cards, and table `sections` (typed columns with a `format`, optional spanning `groups`, and `rowMeta` for subhead/subtotal/total rows). **Number formatting is centralized** in `formatNumber`/`excelNumFmt` keyed off each column's `NumFmt` (int/bu 0-dec, acres/yield 1, dec2/usd2/price 2, pct, …): thousands separators everywhere, `$`/`%` where applicable, **negatives in parentheses**; numbers with no declared format are inferred (commas, ≤2 dec). **Excel uses exceljs** — real numeric cells with a numFmt (sortable/sum-able), bold green header fill, frozen header + first column, auto column widths, distinct subtotal/total rows, and — for multi-section reports that supply summary cards — a Summary cover sheet first. **Worksheet names are guaranteed unique** (sanitized, ≤31 chars, collisions auto-suffixed ` (2)`), so a report whose own section is titled "Summary" (e.g. Crop Insurance Production, Share Rent) no longer throws `Worksheet name already exists`. **PDF uses jspdf + autotable** — formatted strings, a summary band, spanning group headers, tone text colors (sign stays meaningful in grayscale via parentheses), `rowPageBreak:'avoid'`, auto landscape/portrait by column count, and a title + page-number footer. Heavy libs dynamically imported. Pure `formatNumber`/`excelNumFmt`/`defaultFilename` are unit-tested. **Every report routes through this one layer** — the `/reports/*` pages and components via `<ExportBar>`, server-rendered pages (Contract Tracker, Unpaid Loads, contract/load detail) via a thin `<StaticExportBar payload={…}>` that adapts a server-built payload, and the operational lists (Load Log, Bin Inventory) alongside their CSV. The old per-report SheetJS workbook was deleted. A **canonical metric→format contract** (documented atop `lib/exports.ts`) keeps a value identical across every export: year→`text`, bushels→`bu`, acres/yield→1-dec, $/bu→`price`, whole-$ totals→`usd0`, hedging P&L→`usd2`, counts/weights→`int`, %→`pct`, plus the cotton units **`cents`** (72.65¢, 2-dec with the ¢ suffix in Excel numFmts too) and **`lbs`** (0-dec, commas). **Every export carries every on-screen column** — a parity audit fixed the three reports that dropped some (Crop Insurance Production's Yield/Acre group, Government Payments' election + payment-limit table, Load Log's paid/unpaid badge); click-to-expand drill-downs (claims policy detail, gov farm detail, load split sub-table) stay out of exports by design.
- **Settlement linking** (`lib/settlement-link.ts`) — back-fills `settlement_lines.load_id` by ticket when a buyer load is saved (`relinkSettlementLinesForLoad`) **and** for a whole settlement when its Review screen opens (`relinkSettlementLines`), so the DB stays in sync with what the screen shows. Ambiguous tickets are always left unlinked for manual resolution.
- **Marketing engine** (`lib/marketing.ts`) — per-crop position for a crop year: acres segmented full-season/double-crop × irr/dry, expected production from assumption breakouts (or **actual production once harvest is complete**), a Total Average Price buildup (weighted futures from physical contracts + open short hedges, realized futures/options P&L spread per bushel, and a **bushel-weighted basis blend** — locked contracts at their weighted basis, the rest at the assumed basis), and a **blended expected revenue** that values each bushel bucket (flat-cash, futures+basis, open-hedge, and completely-unpriced at the **assumed futures price** when set else the harvest-price estimate, + assumed basis) at its own price. Blended revenue is the **single source of truth** for `revenuePerAcre`/`profitPerAcre`/`totalProfit` (so the dashboard and Revenue Projections agree) and is **capped at `totalProduction`** — contracts beyond expected production (over-contracting, e.g. canola sold on a higher yield) scale down so revenue can't be booked for grain you won't grow. Exposes the **basis composition** (`basisLockedBu`/`basisLockedAvg`/`basisAssumedBu`/`basisState`) and `unpricedFuturesPrice` (lets the dashboard's live what-if re-price the unpriced bushels as an exact delta on blended revenue). Money is kept **full-precision** (rounded only at display); grand totals roll up through one shared **`aggregateMarketing(rows)`** that both the dashboard and Revenue Projections consume, so neither page sums on its own. **`breakevenAvgPrice(row)`** returns the large headline Total Avg Price (effective revenue ÷ production once an assumed futures blends in, else the futures+basis total) — the price breakeven yield divides into. `effectiveContractType` (`lib/contracts.ts`) reads a both-legs contract as a Forward for the futures buildup grouping. **Cotton rows** (`isCottonCrop` → `computeCottonRow`): every `MarketingRow` now carries `unit: 'bu' | 'lbs'` + `cottonBales`; a cotton crop is lbs-of-lint native (¢/lb prices), takes actuals from `cottonProductionByCrop` (gin receipts — never the grain loads map), hedges from open short CT contracts (lbs = contracts × 50,000 via `quantityFor`), has **no basis/contract buckets** (physical cotton marketing isn't tracked), and its blended revenue = hedged lbs at the weighted hedge ¢/lb + unhedged lbs at the assumed/CTZ ¢/lb, ÷100 to dollars, + realized hedge P&L once — so dollar fields aggregate with grains unchanged. **Two crop→commodity maps** (`lib/contracts.ts`): `cropToCommodity` deliberately does NOT map cotton (physical-contract and government-program surfaces are grain-shaped $/bu flows); `cropToHedgeCommodity` adds Cotton → CT and is what marketing, income sensitivity, and the harvest-price symbols use.
- **Income Sensitivity engine** (`lib/income-sensitivity.ts`) — the pure two-variable scenario grid behind the Income Sensitivity Report, **composing** the existing engines (no duplicated formulas): each cell pins scenario production into `computeMarketing` (scenario price rides in as the assumed futures, so locked prices/basis blend/hedge P&L/over-contract cap all fall out unchanged) and re-runs `computePolicy` per policy at the scenario harvest price (or the RMA final once on file) with the cell's blended yield allocated to practices by the expected irr/dry breakout. `splitHarvestByCrop` splits acres into harvested-fact vs remaining using the Yields-page classification (collapses the aggregate keys' calendar year so a January haul-out still counts); `axisValues`/`defaultPriceStep`/`defaultYieldStep`/`closestIndex` drive the editable axes; `flatGovPerAcre` is the constant government-payment layer.
- **Payment-year attribution** (`lib/government-payments.ts`) — ARC/PLC for PROGRAM year N is paid in October of N+1; revenue views attribute payments to the crop year the cash arrives in. `revenueCropYearFor`/`programYearFor` hold the single +1 (never scattered); `expectedArcPlcDate` derives from them; `paymentAttributionYear`/`otherPaymentsInRevenueYear` attribute other USDA payments (payment-date year, else `crop_year` = payment year); `suspectProgramYearEntries` flags legacy entries dated the year after their crop_year. Consumers: Revenue Projections + Income Sensitivity project program year Y−1 (its own stored/final prices via `applyMyaResolution` without live estimates) for crop year Y's gov pool; Cash Flow places program year Y−1 in Oct Y (each program year lands in exactly one crop year everywhere); the Tracker frames both ways ("By payment year" default, "By program year" for FSA reconciliation). Payment limits stay per program year.
- **Shared MYA resolution** (`lib/government-payments.ts`) — `resolveMyaPrice` is the ONE precedence for the MYA driving every PLC projection (**published final > manual override > WASDE midpoint > live/stored estimate > missing**). **Every commodity gets the same treatment**: Barchart-less commodities (seed cotton, sorghum, oats, …) take the estimate tier too — their Auto is the USDA monthly blend alone, delivered through the same liveEstimate slot (`manualOnly` is display metadata, not a gate). `applyMyaResolution` bakes it into effective `arc_plc_price_data` rows for `projectPayments`. Consumed by the Decision Aid, Payment Tracker, Revenue Projections, and Income Sensitivity, so all four project PLC from the same price. Live estimates come through one **`useLiveMya` hook** (`lib/use-live-mya.ts`) that resets on year change so a failed refetch can't leave last year's prices in play.
- **USDA data lookups** — three layers, all confirm-before-save (the routes never write the target tables):
  - **NASS Quick Stats** (`lib/nass-quickstats.ts` + `/api/nass-monthly-prices`) — the PRIMARY monthly MYA price source: real published "prices received by farmers" per commodity (free `NASS_API_KEY`). Series are selected from what the API returns (best marketing-year coverage, then shortest short_desc — all-wheat beats the 8 class series) rather than trusting exact `_desc` strings; ALL unit conversions live here ($/CWT→$/bu at the commodity's lb/bu — sorghum 56, canola 50; ¢/lb↔$/lb; $/ton), and an unconvertible unit drops the row so a wrong-magnitude price can never leak. **Seed cotton** fetches BOTH series (upland lint = COTTON/UPLAND, cottonseed = COTTON/**class COTTONSEED** — not its own commodity, live-verified) and blends in code at the configurable shares, handling the ginning-season cadence: an NA cottonseed month uses the season average of the published months ("season avg" label), pre-season falls back to the prior year's annual national price ("prior-year annual"), else the month waits for manual entry. Quick Stats reports no-data combinations as "bad request - invalid query" — treated as an empty result (sesame has no price series; the panel then offers the AI fallback). 24 h in-process cache per series × marketing year.
  - **FSA benchmark workbook** (`lib/fsa-benchmark-file.ts` + `/api/fsa-benchmark-yield`) — ARC-CO county YIELDS come only from FSA's annual ~2.5 MB "ARC-County Benchmark Yields and Revenues" Excel (web search can't open it). The page's per-year links are discovered from the real HTML shape (description outside the anchor, extensionless Drupal hrefs → a second hop to the `.xlsx` inside the landing page); the header row is DISCOVERED by scanning (the real benchmark-yield column is "2026 Bench Mark (2020-24 olympic avg)" — no word "yield"; practice is "ARC-CO Yield Designation"); county/state/commodity names normalize (LAWRENCE↔Lawrence County, ST. CLAIR, GRAIN SORGHUM↔SORGHUM); sub-county rows are skipped; the file's own benchmark price is parsed too. Rows cache per data_year × state in `fsa_benchmark_cache` (fsa.usda.gov hit at most daily per year × state via `fsa_benchmark_fetches`); requested-year misses fall back to the most recent published year (`data_year` flag).
  - **AI web-search fallback** (`lib/ai-web-search.ts` + `lib/ai-lookups.ts` behind `/api/arc-benchmark-lookup` and `/api/mya-monthly-lookup`) — one web-search-enabled Claude call returning parsed JSON, in-process cached + concurrent-deduped, offered only when the deterministic sources fail or find nothing (labeled, low-confidence guardrails kept). `lib/ai-lookups.ts` stays the pure layer: request validation (benchmark lookup rejects a missing state), response normalization (marketing-year window only; seed cotton requires BOTH components — never a lint-only blend), and the confirm-before-save merge (`defaultConfirmedMonths`/`planMonthlySaves`: manual wins unless explicitly confirmed; `confirmedSource` 'usda' \| 'ai'; an edited value saves `'manual'` and drops the note).
- **FSA base-acres import merge** (`lib/fsa-base-import.ts`) — FSA documents naturally repeat a farm × commodity (tracts, existing+new base lines, page batches, duplicate extraction), and `farm_base_acres` is unique on (farm_id, commodity_id). `mergeFsaLines` collapses lines per (commodity, is_unassigned) at REVIEW time — exact re-reads keep one silently; differing lines sum acres with an acres-weighted PLC yield and a merge note saved to the row (`"Merged 2 lines from upload: 120.0 + 85.5 ac"`), shown as an expandable "merged from N lines". `planBaseAcreSaves` re-checks the exact upsert batch as a backstop: identical duplicates collapse, contradictory ones block the save with a plain-English message naming the offenders — the raw Postgres "ON CONFLICT … cannot affect row a second time" error can never surface.
- **Program-year config** (`lib/program-config.ts`) — resolves the SCO trigger, per-person payment limit, and sequestration % for a crop year from `program_year_config` rows, falling back to the most recent configured year (or built-in 2026 defaults) with a plain-English notice for the UI.
- **Insurance / government / revenue engines** (`lib/crop-insurance.ts`, `lib/government-payments.ts`, `lib/revenue-projections.ts`) — pure math feeding the financial reports. `lib/crop-insurance.ts` computes per-policy RP/RP-HPE/YP + SCO/ECO indemnity (now per **practice**, each from its own APH/coverage/acres/yield) exposes **`projectInsuranceIndemnities`** — the **single source of truth for projected indemnity** that both the Claims Monitor and the Cash Flow safety-net call (per-practice yield resolution: override → actual irr/dry → `expected_yield_irr`/`_dry` breakout → crop default → APH × what-if slider; harvest resolution: override → final → today's live Barchart → stored estimate → projected), so the two reports reconcile; and exposes **`reconcileAcreage`** — the Coverage Check that reconciles insured vs planted acres per **entity**·crop·county·practice (status no-policy / under-insured / over-reported / matched / **covered**, `max(0.5 ac, 1%)` tolerance). A combination whose policies carry the **`coversAllPlanted`** attestation is reported `covered` and excluded from uninsured/flagged totals (the acre variance stays visible, just unflagged); the `no_policy` flag is never suppressed. Projected prices now come from `harvest_price_estimates` (`projectedPriceFromEstimates`) instead of a hard-coded map. `computeRevenueProjections` rolls totals up through the marketing engine's shared **`aggregateMarketing`** (so crop-sales + projected profit are structurally identical to the dashboard), layers insurance proceeds + government payments on top, and divides breakeven by **`breakevenAvgPrice`** (the headline Total Avg Price). Both pages value unpriced bushels with the **same live harvest-price estimate fetched for every planted crop** (`/api/harvest-price-estimate`).
- **Cotton module math** (`lib/cotton.ts` + `lib/cotton-grades.ts`) — lint turnout (lint ÷ seed cotton), loan ¢/lb (Total Value $ ÷ NetWt × 100: 280.46/509 → 55.1¢), **lbs-of-lint-per-acre yields** (Σ bale net weights per field's receipts ÷ planted acres, receipt-stated-total fallback; seed cotton lbs/ac + turnout companions), **yard inventory** (delivered loads not on any receipt → in-progress "awaiting gin"), bale↔grade matching by PBI (zero-tolerant, >1% NetWt cross-check), receipt bale-count reconciliation, and the deterministic classing-CSV parser (preamble skip, header-name mapping, CRLF, blank cells). No moisture/shrink math — cotton weights are plain lbs.
- **Unit tests** — 645 Vitest tests across 24 `lib/*.test.ts` files (shrink, yields, csv, contracts, marketing, crop-insurance, government-payments, revenue-projections, **revenue-marketing-reconciliation**, hedging, **statement-matching**, load-splits, program-config, exports, **income-sensitivity**, **mya-estimate**, **ai-lookups**, **fsa-base-import**, **fsa-benchmark-file**, **nass-quickstats**, **cotton**, **cotton-marketing**, **variety-resolution**, **planting-import**) with hand-verified worked examples; run in CI on every push/PR. The variety-resolution file asserts the STRICT rules (identical numeric core only — "DK 65-95" ✗ "DK 68-35", "47XF2" ✗ "47XF6"/"55XF5", "DP 2131" ✗ "DP 2239", "DG 3644" does NOT flag "DG 3646"; "68-35" ✓ "DK 68-35"), dismissal suppression, and pairwise (non-chaining) duplicate detection; planting-import covers varieties driving Update classification (no-variety→variety = Update + add; identical-but-for-variety ≠ Unchanged); crop-insurance adds the policy-upload dedupe suite (exists/update/new, blank-never-diffs, field-level diffs, SCO dedupe-with-parent). The fsa-benchmark-file suite includes a verbatim fixture of FSA's REAL 2026 workbook header (link discovery on the real page structure, header-row scanning, county/state matching incl. same-name-other-state, practice rows, sub-county skip, fallback-year pick); nass-quickstats covers value/suppression parsing, corn-vs-wheat window mapping, series preference, the sorghum $/cwt→$/bu conversion, the hand-verified seed cotton blend (0.43×63.1¢ + 0.57×$208/2000 = 33.06¢/lb), the season-avg and prior-year-annual substitutions, and the both-components rule; fsa-base-import covers the merge/plan dedupe guarantees. The ai-lookups file covers the county+state requirement (state-less benchmark requests rejected), monthly-response normalization (only marketing-year-window months accepted, null → not-yet-published), elapsed-month windows (corn Sep–Aug vs wheat Jun–May), and the manual-wins-unless-confirmed merge; the government-payments file adds `resolveArcBenchmark` county_id disambiguation (same-named counties in two states resolve by id; a third state's county falls to the default row instead of another state's yield; legacy name-only rows still match) and the **payment-year attribution boundary suite** (a program-year-2025 payment appears in crop year 2026 and NOT 2025 across the Revenue Projections/Tracker pool, the Income Sensitivity flat $/ac, and the Cash Flow October bucket; the year helpers are inverses; other-payment attribution and the legacy-semantics suspect filter). The income-sensitivity file covers the RP floor flattening the downside below the guarantee (and zero indemnity above), the identical flat gov $/ac on two crops, the over-contract cap (and full-contract price-insensitivity), the mid-harvest fixed + scenario × remaining blend, 1:1 price sensitivity on a zero-contract crop, the collapsed price-only table when fully harvested, the cross-calendar-year haul-out, and RMA-final pinning. The government-payments file adds the MYA resolution precedence (final beats a source=manual row — the Settings page stamps `manual` on every edit; manual beats live; Barchart-less commodities get the uniform treatment — their Auto tier is the USDA monthly blend riding the same liveEstimate slot, with manual/final still outranking it). The hedging file includes the closed-offset-group regression (three corn lots closed together net $71,875 per lot, **not** 3× that); the crop-insurance file covers the Coverage Check `covers-all-planted` attestation (covered ≠ under-insured, excluded from uninsured totals, never suppresses `no_policy`), `resolveUploadEntityId` (single-entity auto-assign vs multi-entity choice), and entity-matched reconciliation (a null-entity policy fails to match a planting — the Issue-1 symptom). The reconciliation file asserts the identity *Revenue Projections profit − Marketing total profit = insurance + government* per crop (incl. a zero-safety-net crop that matches to the cent). The exports file adds worksheet-naming regression tests — a section titled "Summary" (or long titles that truncate alike) exports without the `Worksheet name already exists` collision — and a grouped-export regression driving the three-metric-group shape (with an empty leading group) through exceljs. The cotton-marketing file covers the lbs-native marketing row (hedged lbs = open short CT × 50,000; revenue = lbs × ¢/lb ÷ 100; realized CT hedge P&L counted exactly once; actual gin-receipt lbs + bales once harvest completes), lbs kept out of the shared aggregate's bushel total, the plain-decimal ¢/lb statement shapes (no fractional conversion; option premium over 50,000 lbs), the RevProj−Marketing reconciliation identity holding with a cotton crop present, and the mixed grain+cotton export formats (`cents`/`lbs`). The variety-resolution file covers key normalization, the near-match rules (substring, digit-tail, edit-distance — and that "DG 3644" vs "DG 3646" does flag rather than auto-match), within-file variant collapse, decision resolution, and the duplicate-group clustering + merge plans; the csv file adds `extractChildValues`/`childValueTransform` coverage.

### AI document parsing pipeline

All AI extraction funnels through **one route** — `POST /api/parse-document` — called only via
`parseDocument(input, documentType)` in `lib/pdf-upload.ts`. A PDF is uploaded to the
`documents` bucket and sent to Claude **by https URL** (to stay under Vercel's 4.5 MB
serverless body limit; the temp object is deleted after parsing). Photos are inlined as
base64 `images[]`. Long PDFs are split into ≤4-page batches (`lib/pdf-split.ts`) to avoid
504s; `.xlsx/.xls` are rendered to PDF first (`lib/excel-to-pdf.ts`).

The route selects one of **10 hard-coded prompts** by `document_type`, sends document blocks +
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
| `plantings` | `<PlantingsAiImport>` | Per planting: field, crop, season_year, planted/irrigated acres, planting date, `varieties[]`, notes. Classifies New/Update/Unchanged via pure `lib/planting-import.ts` — **varieties count**: a row whose variety the matched planting lacks is an Update (added on save; a no-variety planting gaining its first variety included), never Unchanged. Variety names run through the shared **variety-resolution pipeline** (per crop, dismissal-aware) on EVERY row regardless of classification: exact-key matches auto-link (badged "already on this planting" vs "will be added"), brand-prefix variants block save until the user picks link-vs-create, everything else creates once per file. |
| `crop_insurance_policy` | `<PolicyAiImport>` | Per crop × county × **practice** line: plan type, **practice** (irrigated/non_irrigated), coverage level, unit structure, APH yield, projected price, insured acres, premiums, policy #, plus nested **SCO** and **ECO** objects. The review screen assigns the whole upload to **one insured entity** (auto for single-entity ops, required for multi) and lets you tick the **"covers all planted acres" attestation per row before saving**; dedupe keys on entity+crop+county+year+practice+plan. |
| `contract` | `/settings/contracts` | Contract #, buyer, crop, type (forward/hta/basis), month, crop year, bushels, futures/basis/cash/service fee, delivery window, notes. |
| `fsa_base_acres` | `<FsaBaseAcresImport>` | FSA 156EZ: per farm (FSA #, county, state) and per commodity (base acres, PLC yield, election, unassigned, OBBBA new/total base). Duplicate farm × commodity lines (tracts, existing+new base, page batches) **merge at review time** via `lib/fsa-base-import.ts` — one row per key with a "merged from N lines" expandable; `planBaseAcreSaves` guarantees the upsert batch has no duplicate conflict keys (contradictions block with a plain-English message). |
| `cotton_weight_ticket` | `/cotton/loads` | Cotton Module List tickets (one load per page): load #, producer, farm #, field, picked/delivered dates, truck, gross/tare/net lbs. |
| `gin_receipt` | `/cotton/receipts` | Statement of Ginning: gin identity, statement #, totals (modules/weights/bales/turnout), the load table, and the FULL multi-page bale list (PBI # + net wt). |
| `brokerage_statement` | `<StatementImport>` (hedging) | Broker-neutral futures/options statement (StoneX/FCStone, RJO, …): long/short, open positions, **closed offset groups** (one or more opening lots + a single close), options, account summary. Extracts Corn, Soybeans, Wheat, **and ICE Cotton No. 2** ("DEC 26 ICE COTTON 2" → COTTON, prices copied as plain-decimal ¢/lb — the prompt scopes fractional-price conversion to CBT grains only). Closed trades arrive as `closed_groups[]` carrying per-lot opening facts plus the statement's `statement_reported_total` (reconciliation only); **realized P&L is computed per lot in code** (`expandClosedGroup`), never copied from the statement total — matched lots anchor to the DB entry price/size, and each group reconciles against its printed total (`reconcileClosedGroup`). A closed group's **side is corrected from the matched DB positions** when the extraction read it backwards (`resolveClosedGroupSide`), and a computed-vs-statement total that's an *exact opposite* triggers a **sign-flip suggestion** with a one-click side flip (`signFlipSuspected`). Dedupe is **tolerant** (`lib/statement-matching.ts`): dates normalized to YYYY-MM-DD, prices matched within half a cent (`PRICE_MATCH_EPSILON`) so fractional-parse drift can't re-flag existing positions as New; near-misses are explained inline and New rows offer a manual **"Match to existing"** pairing. After review, a **second step** flags app-open positions missing from the statement as *possibly closed* → Close (real workflow) / Keep open. |

---

## 5. Integrations and their status

### Supabase — **Live (core dependency)**

- Browser, server, and middleware client factories in `lib/supabase/`.
- Auth enforced in `middleware.ts`; unauthenticated → `/login`. Users created via Supabase Auth.
- Direct table reads/writes from components; storage bucket `documents` for file uploads.
- **Env:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

### Anthropic / Claude API — **Live**

- Package `@anthropic-ai/sdk ^0.95.2`; call sites: `app/api/parse-document/route.ts` (document
  extraction) and `lib/ai-web-search.ts` (the shared web-search lookup helper behind
  `/api/arc-benchmark-lookup` and `/api/mya-monthly-lookup` — both now explicit FALLBACKS
  behind the FSA workbook / NASS Quick Stats primary sources).
- **Model `claude-sonnet-4-6`** everywhere. Parse-document: `max_tokens: 8192`, `thinking: { type: 'disabled' }`,
  `output_config: { effort: 'low' }`. Lookups: `web_search_20250305` tool (6–8 uses), 2048–3072 tokens,
  JSON-only contract, confirm-before-save, in-process cache + concurrent-request dedupe.
  All: `runtime = 'nodejs'`, `maxDuration = 60`. No streaming, no agent loop.
- **Env:** `ANTHROPIC_API_KEY` (server-only; routes return 500 if unset). Key never reaches the browser.
- Note: the project's documented default model elsewhere is `claude-opus-4-8`; Sonnet here is a
  deliberate cost/speed choice for extraction. Parsing relies on "JSON only" + fence-stripping rather
  than `output_config.format` schema enforcement — hardening opportunity if revisited.

### USDA NASS Quick Stats — **Live (needs the free `NASS_API_KEY`)**

- Primary source for monthly MYA prices via `/api/nass-monthly-prices` (see §4 "USDA data lookups").
- **Env:** `NASS_API_KEY` (server-only; free at quickstats.nass.usda.gov/api). Without it the route
  returns a "not configured" message pointing at the signup and the panel offers the AI fallback.
- Verified live against the real API: series/unit shapes for corn, wheat (all-classes preferred),
  sorghum, peanuts, sunflower (SUNFLOWER singular, $/CWT), upland lint (published in **$ / LB**),
  cottonseed (COTTON + class COTTONSEED, $/TON, ginning-season cadence), and the "invalid query" =
  no-data behavior. 24 h in-process cache; 401/429/record-limit surface as real errors.

### USDA FSA program-data page — **Live (no key needed)**

- `/api/fsa-benchmark-yield` scrapes the ARC/PLC program-data page for the annual "ARC-County
  Benchmark Yields and Revenues" workbook, downloads it through the Drupal landing page, parses it
  (header-row discovery), and caches per data_year × state in `fsa_benchmark_cache` — at most one
  fsa.usda.gov check per day per year × state (`fsa_benchmark_fetches`).

### Barchart OnDemand — **Live but fully env-gated; options pricing partial**

- Used for live grain **futures quotes** (`getQuote.json`, cents/bu → $/bu) and **options premiums** (`getFuturesOptions.json`).
- **Env:** `BARCHART_API_KEY` (server-only, passed as `apikey` query param).
- Call sites: `app/api/market-prices/route.ts`, `app/api/harvest-price-estimate/route.ts`,
  `app/api/mya-estimate/route.ts`, `app/api/options-prices/route.ts`, and `lib/barchart-quotes.ts`
  (login-page public board).
- **Status:**
  - Futures quotes: **live, fault-tolerant.** Quote magnitudes normalize in ONE place — `normalizeBarchartPrice` (`lib/hedging.ts`), used by `/api/market-prices` and `/api/harvest-price-estimate`: grains convert cents/bu → $/bu, ICE Cotton (CT…) quotes stay in **¢/lb as quoted** (72.65) — no ÷100. Without the key (or on error / market-closed), every route
    falls back to the most-recent cached `market_prices` row and returns an explanatory `note`. Successful
    fetches are day-cached in `market_prices` (mirrored to `harvest_price_estimates` / `arc_plc_price_data`).
  - Options pricing (`/api/options-prices`): **partial / "future-ready."** Wired to Barchart but on missing
    key / no requests / error / no data returns `available: false` with null values so the Hedging UI falls
    back to manual premium entry. No Supabase caching of options data.
  - Untraded commodities (canola, sesame, sorghum, seed cotton, …) have no futures-derived pricing — their MYA fills from the NASS monthly lookup (blend of published months) or manual entry.

### API endpoints (all `POST`, `runtime = 'nodejs'`)

| Endpoint | File | Purpose | External |
| --- | --- | --- | --- |
| `/api/parse-document` | `parse-document/route.ts` | AI extraction for 10 doc types (`maxDuration 60`). | Anthropic |
| `/api/market-prices` | `market-prices/route.ts` | Live futures quotes for hedging board; day-caches. | Barchart + Supabase |
| `/api/options-prices` | `options-prices/route.ts` | Live option premiums (strike matching). | Barchart |
| `/api/harvest-price-estimate` | `harvest-price-estimate/route.ts` | RMA harvest-price estimate per crop (discovery-month contract). | Barchart + Supabase |
| `/api/mya-estimate` | `mya-estimate/route.ts` | MYA price estimate per commodity for ARC/PLC. | Barchart + Supabase |
| `/api/nass-monthly-prices` | `nass-monthly-prices/route.ts` | **Primary** monthly MYA lookup: NASS Quick Stats "prices received" per commodity, unit-normalized; seed cotton = lint + cottonseed blended in code (cottonseed-cadence aware). Confirm-before-save; 24 h cache. | NASS |
| `/api/fsa-benchmark-yield` | `fsa-benchmark-yield/route.ts` | **Primary** ARC-CO benchmark yield (+ price) lookup from FSA's published workbook (per-practice rows; DB-cached; most-recent-year fallback via `data_year`). Confirm-before-save. | fsa.usda.gov + Supabase |
| `/api/arc-benchmark-lookup` | `arc-benchmark-lookup/route.ts` | AI web-search **fallback** for ARC-CO benchmarks (county + state required; confirm-before-save; cached 24 h). | Anthropic |
| `/api/mya-monthly-lookup` | `mya-monthly-lookup/route.ts` | AI web-search **fallback** for monthly farm prices (seed cotton fetches both raw series, blended in code; confirm-before-save; cached 30 min). | Anthropic |

---

## 6. Known issues & partially-built features

- **Options pricing is "future-ready," not finished** — `/api/options-prices` always degrades to manual entry today (see §5). Functional fallback, but the live path is unproven.
- **Stale comment** in `lib/revenue-projections.ts:5` calls government payments "a placeholder until that section is built." That section **is** built and wired in (`projectPayments` → `revenue-projections-report.tsx`). Comment only; not a missing feature.
- **Excel styling** — the shared exporter now uses **exceljs** (real number formats, bold/frozen headers, fills), so the old SheetJS no-styling limitation is gone. The legacy `lib/crop-insurance-export.ts` was removed; the Production Report goes through the shared `lib/exports.ts` layer.
- **Split vs manual parent override** — `lib/load-splits.ts:38-43`: a manually-overridden parent `dry_bushels` is **not** redistributed back into splits (deliberate; surfaced to the user via a note).
- **Program parameters still need yearly data entry** — the SCO trigger, payment limit, sequestration %, and RMA projected prices are now **DB-configured** (`program_year_config`, `harvest_price_estimates`) rather than hard-coded, but someone must enter each new year's values in Settings (Government Payments / Crop Insurance). Missing years fall back to the most recent configured year with a visible notice — math keeps working but on last year's numbers.
- **No UI/component tests** — Vitest covers the pure `lib/` math only; pages and components are untested.
- **Redirects are intentional, not orphans** — `/revenue-projections` and the `/season`, `/marketing`, `/cash-flow` paths redirect to their `/reports/*` homes (`next.config.js`).
- **`payment_limit_config` is a dead table** — deprecated by 041 (persons moved to `entities.payment_limit_persons`, backfilled). Kept for history; nothing reads or writes it.
- **Program-year keying is the classic data-entry trap** — benchmarks/elections are per PROGRAM year while the Tracker defaults to payment-year framing (year Y view computes program year Y−1). Mitigated by the mismatch notices, the `?year=` deep link, and the "Program year" labeling in Settings — keep those intact when touching year plumbing.

---

## 7. Developer onboarding

### Setup (from `README.md`)

```bash
npm install
cp .env.local.example .env.local      # then fill in the values below
# In the Supabase SQL editor, run supabase/schema.sql, then 002…042 in order
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
| `ANTHROPIC_API_KEY` | server | AI PDF/photo parsing via `/api/parse-document` + the web-search lookup fallbacks. |
| `BARCHART_API_KEY` | server | Live futures/options pricing. Without it, market features serve cached prices or manual entry. |
| `NASS_API_KEY` | server | USDA NASS Quick Stats — the primary monthly MYA price lookup. Free (quickstats.nass.usda.gov/api). Without it, the lookup reports "not configured" and offers the AI fallback. |

### Where things live

- **Pages/routes:** `app/**/page.tsx` (+ two `layout.tsx`). API routes: `app/api/**/route.ts`.
- **Business logic:** `lib/*.ts` (pure functions — shrink, yields, contracts, hedging, marketing, marketing-export, crop-insurance, income-sensitivity, government-payments, program-config, revenue-projections, mya-estimate, ai-lookups, nass-quickstats, fsa-benchmark-file, fsa-base-import, cotton, cotton-grades, variety-resolution, csv, exports, fuzzy, pdf-*; `ai-web-search.ts` is the one server-only AI helper). Unit tests live alongside as `lib/*.test.ts`.
- **Central types:** `lib/types.ts`.
- **Components:** `components/*` (forms, AI-import widgets, dialogs, PDF/attachments) and `components/reports/*` (the heavy report bodies + the shared `report-kit.tsx` design system).
- **Schema:** `supabase/*.sql` (run in numeric order).

### Conventions / gotchas

- Reports compute everything in the app layer (no DB views). Pure libs take pre-fetched rows.
- Supabase has a row cap per request — list pages that need everything paginate via `.range()` loops.
- `dryland_acres` is **trigger-maintained**; don't try to set it directly.
- Filters on many pages persist in `localStorage` via `usePersistentState`.
- Heavy export/PDF libs are dynamically `import()`-ed to keep first-load small.
- Single-tenant security model: RLS is permissive for any authenticated user, minus the 042 gin-role RESTRICTIVE policies — **do not** treat this as multi-tenant isolation.
- **Cotton prices are ¢/lb end to end** (stored 72.65, not 0.7265): futures P&L must use `pnlSizeFor()` ($500/point), never the raw 50,000-lb contract size; quantities use `quantityFor()`/`contractUnit()` (lbs for CT) and Barchart quote magnitudes normalize only in `normalizeBarchartPrice` (CT passes through, grains ÷100).
- **Two crop→commodity maps**: `cropToCommodity` (grain-shaped $/bu surfaces — physical contracts, government programs) deliberately excludes cotton; `cropToHedgeCommodity` (marketing, income sensitivity, harvest-price symbols) adds Cotton → CT. Pick the right one when wiring a new surface.
- **Cotton scope notes**: physical cotton marketing/contracts are deliberately NOT tracked yet — the Marketing dashboard, Revenue Projections, and Income Sensitivity carry cotton as lbs-native rows (`unit: 'lbs'`, production + CT hedges, no basis/Sold buckets); the Crop Insurance Production report and the Yields variety/landowner groupings still don't include cotton (it has its own unit-aware section on Yields/Season instead).

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
- **Basis** — local cash minus futures (positive = "over", negative = "under"). **Assumed basis / assumed futures** — per-crop-year standing assumptions (`crop_assumptions.assumed_basis` / `assumed_futures`) used to value the crop's unlocked / unpriced bushels, so Total Average Price always computes; both are edited in the dashboard's What-If block and cleared together via "Clear assumptions".
- **Hedging (long / short)** — offsetting futures/options; farmers typically short futures to lock a price.
- **Realized / unrealized P&L** — closed-position profit/loss vs mark-to-market on open positions.
- **Settlement / settlement line** — the buyer's payment document; lines match delivered loads by **ticket number** (gross − discounts = net).
- **Scale ticket / ticket number** — the per-load weigh-in document; the join key between loads and settlement lines.
- **Crop year vs season year** — `crop_year` (marketing/program year on loads/contracts) vs `season_year` (planting season); usually aligned, tracked separately.
