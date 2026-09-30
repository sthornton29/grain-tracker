# Government Payment Projections — Public-Data Pathways (handoff)

Implementation handoff for the **landowner app** to replicate Turnrow's ARC/PLC
projections independently from the same public sources. Nothing here requires
Turnrow's database; every input is public USDA data plus the landowner's own
base acres / PLC yields / elections.

Scope notes up front:

- The landowner app **skips payment limits** — ignore `per_person_payment_limit`,
  `entities.payment_limit_persons`, and `paymentLimitTotal`.
- All projections are **estimates**; FSA determines actual payments after the
  marketing year closes. Keep that disclaimer in the UI.
- Units: prices are stored **$/bu** for bushel commodities and **$/lb** for pound
  commodities (seed cotton, peanuts, canola). Convert once at the source boundary
  (NASS) and never again.

Quick index of what to copy:

| Concern | Turnrow file | Port verdict |
|---|---|---|
| NASS parsing / unit conversion / seed-cotton blend | `lib/nass-quickstats.ts` | **Copy verbatim** (pure, unit-tested in `lib/nass-quickstats.test.ts`). Needs `marketingYearMonths` from `lib/mya-estimate.ts` and `monthKey`/`MyaLookupMonth` from `lib/ai-lookups.ts` (trivial — inline them). |
| NASS HTTP + cache | `app/api/nass-monthly-prices/route.ts` | Copy the `fetchNassRows` + `monthlyParams` helpers; drop the request-validation glue if you don't need the same API contract. |
| FSA workbook discovery / parsing / lookup | `lib/fsa-benchmark-file.ts` | **Copy verbatim** (pure, unit-tested in `lib/fsa-benchmark-file.test.ts`). |
| FSA download + cache + fetch-guard | `app/api/fsa-benchmark-yield/route.ts` | Copy the flow; swap Supabase calls for your store. Needs `xlsx`. |
| Marketing-year months, MYA blend weights | `lib/mya-estimate.ts` | Copy `marketingYearMonths`, `defaultMonthWeights`, `estimateMyaBlend` (pass no `futuresPriceForSymbol` if you have no futures feed — published months only). |
| Program parameters resolution | `lib/program-config.ts` | **Copy verbatim**; delete `perPersonPaymentLimit`/`scoTrigger` if unwanted. |
| Payment math + MYA precedence + payment-year attribution | `lib/government-payments.ts` | Copy `olympicAverage`, `computeEffectiveReferencePrice`, `arcBenchmarkPriceFromHistory`, `myaPrice`/`resolveMyaPrice`, `seedCottonMya`, `computePlcPayment`, `computeArcCoPayment`, `computeArcCoFlatPayment`, `expectedCountyYield`, `revenueCropYearFor`/`programYearFor`/`expectedArcPlcDate`. Skip the Barchart helpers (`commodityToTraded`, `nearbyContractSymbol`), `resolveArcBenchmark`/`projectPayments` (Turnrow-schema-shaped), and the payment-limit helpers. |

---

## 1. MYA prices

### 1.1 NASS Quick Stats — the monthly "prices received" series

- **Endpoint:** `GET https://quickstats.nass.usda.gov/api/api_GET/`
- **Key:** free, from <https://quickstats.nass.usda.gov/api>. Env var `NASS_API_KEY`.
  Sent as the `key` query param; `format=JSON`.
- **Base params for every monthly series** (`monthlyParams` in the route):

  ```
  source_desc=SURVEY
  statisticcat_desc=PRICE RECEIVED
  freq_desc=MONTHLY
  agg_level_desc=NATIONAL
  year__GE=<marketing year>          # the two calendar years a marketing year spans
  year__LE=<marketing year + 1>
  + commodity-specific params (below)
  ```

  Do **not** pin `unit_desc` — the parser normalizes whatever unit the series
  actually carries.

- **Per-commodity params + target storage unit** (`nassSeriesFor`):

  | Commodity | `commodity_desc` (+ class) | NASS unit → stored unit |
  |---|---|---|
  | Corn / Soybeans / Wheat / Oats / Barley | `CORN` / `SOYBEANS` / `WHEAT` / `OATS` / `BARLEY` | $/BU → $/bu |
  | Grain Sorghum | `SORGHUM` | $/CWT → $/bu at **56 lb/bu** |
  | Canola | `CANOLA` | $/CWT → $/bu at **50 lb/bu** |
  | Peanuts | `PEANUTS` | → $/lb |
  | Sunflower | `SUNFLOWER` (singular) | $/CWT → $/lb or $/bu per config |
  | Seed cotton — lint | `COTTON`, `class_desc=UPLAND` | $/LB → **¢/lb** |
  | Seed cotton — seed | `COTTON`, `class_desc=COTTONSEED` (not its own commodity) | **$/ton** |

- **Response handling** (`parseNassValue`, `convertNassPrice`, `extractMonthlyPrices`):
  - `Value` is a string with thousands separators; parenthesized codes
    `(NA)`, `(D)`, `(S)`, `(Z)`, `(X)` → null.
  - `reference_period_desc` is `JAN`..`DEC` (occasionally full month names);
    `year` is the calendar year.
  - Keep only rows inside the marketing-year window.
  - The response may carry several series (e.g. `WHEAT` and `WHEAT, WINTER`):
    pick the series covering the **most window months**, ties to the **shortest
    `short_desc`** (the base/all series).
  - A unit the converter can't map **drops the row** — a wrong-magnitude price
    must never leak.
  - Quick Stats returns `{"error": "bad request - invalid query"}` for a
    combination with **no data** — treat as an empty result, not a failure.
    Real failures: 401/403 (key), 429 (rate limit), other `error` strings.
- **Cache:** in-process, **24 h per (params) key**, promise-cached so concurrent
  callers share one request; a rejected promise evicts itself. Recent months
  are preliminary and get revised — 24 h is the right TTL, not longer.

### 1.2 Marketing-year windows and how months blend to an MYA

Marketing year start month lives on the commodity config (`covered_commodities.marketing_year_start_month`):

| Commodity | Start | Window |
|---|---|---|
| Corn, Soybeans, Grain Sorghum, Sesame | 9 | Sep Y – Aug Y+1 |
| Wheat, Oats, Barley | 6 | Jun Y – May Y+1 |
| Seed Cotton, Peanuts | 8 | Aug Y – Jul Y+1 |
| Canola | 7 | Jul Y – Jun Y+1 |

`marketingYearMonths(startMonth, cropYear)` (in `lib/mya-estimate.ts`) yields the
12 `{month, year}` pairs; the crop/program year is the year the marketing year
**starts** in.

**Blend** (`estimateMyaBlend`): the MYA is a **marketing-weighted** average of
monthly prices, not a simple mean. Default weights (marketing-year order,
normalized over the months that have a price; missing months drop out and their
weight is redistributed):

```
corn  (Sep..Aug) [0.06,0.115,0.11,0.10,0.115,0.085,0.08,0.075,0.07,0.07,0.065,0.055]
soy   (Sep..Aug) [0.08,0.16,0.14,0.10,0.11,0.08,0.07,0.06,0.05,0.05,0.05,0.05]
wheat (Jun..May) [0.14,0.15,0.13,0.10,0.08,0.07,0.06,0.06,0.055,0.055,0.05,0.05]
others           uniform 1/12
```

Turnrow fills the not-yet-published months with futures + a basis adjustment
(corn −0.35, soy −0.60, wheat −0.45 $/bu; overridable). If the landowner app has
no futures feed, call `estimateMyaBlend` **without** `futuresPriceForSymbol` —
the estimate is then the weighted average of published months only, which is
what Turnrow already does for untraded commodities (seed cotton, sorghum, oats…).

### 1.3 WASDE midpoint, manual, final — precedence

One precedence drives every projection (`resolveMyaPrice` / `myaPrice`):

```
published FINAL  >  MANUAL override  >  WASDE season-average midpoint  >  blended ESTIMATE  >  missing
```

- **Final** = the USDA-published marketing-year average once the year closes
  (operator-entered; outranks everything, including a stale manual).
- **Manual** = an operator override; must never be displaced by a refreshed
  estimate (Turnrow's estimate writer refuses to overwrite a `source='manual'`
  row).
- **WASDE midpoint** = the midpoint of the season-average farm price range in
  the monthly WASDE; typed by the operator (no WASDE API). It sits at the top of
  the estimate tier.
- **Estimate** = the NASS monthly blend above.

Store per commodity × program year: `effective_reference_price`,
`mya_price_estimate`, `mya_price_final`, `wasde_midpoint`, `source`
(`barchart`|`manual`|`usda`|`wasde`), mirroring `arc_plc_price_data`.

### 1.4 Seed cotton composite

Seed cotton is **one commodity with one $/lb price**; NASS has no seed-cotton
series, so it is blended **in code** from two series, month by month
(`blendSeedCottonMonthly`):

```
seed_cotton_$/lb = lintShare × (lint_¢/lb ÷ 100) + seedShare × (cottonseed_$/ton ÷ 2000)
```

Defaults `LINT_SHARE = 0.43`, `COTTONSEED_SHARE = 0.57` (`lib/government-payments.ts`),
overridable per commodity (`covered_commodities.lint_share` / `cottonseed_share`,
null = code defaults). Single-point helper: `seedCottonMya(lintPerLb, cottonseedPerTon)`.

Cottonseed is only surveyed during ginning season (~Aug/Sep–Feb); other months
return `(NA)`. Handling per month:

1. both published → plain blend;
2. lint published, that month's seed NA, but some seed months exist this
   marketing year → use the **running marketing-year average** of published seed
   prices ("season avg");
3. no seed at all yet (very early season) → the **prior marketing year's annual**
   cottonseed price (same params but `freq_desc=ANNUAL`, `year=<MY−1>`,
   `agg_level_desc=NATIONAL` pinned — the annual query otherwise returns ~18
   per-state rows; `reference_period_desc` is `MARKETING YEAR`/`YEAR`);
4. else the month stays unpublished with a note to enter the seed component manually.

Save the composition with the month (Turnrow writes `"lint 63.1¢ + seed $239/ton → 33.94¢ SC"`
to `mya_monthly_prices.note`) so the derived number is auditable.

---

## 2. ARC-CO benchmarks (county yield + benchmark price)

FSA publishes ARC-CO benchmark **county yields** only in an annual Excel
workbook, "ARC-County Benchmark Yields and Revenues" (~2.5 MB). The same file
prints the national **benchmark price** on every row, so both inputs come from
one download. Everything below is in `lib/fsa-benchmark-file.ts` (pure) and
`app/api/fsa-benchmark-yield/route.ts` (I/O).

### 2.1 Locating the file

1. Fetch `https://www.fsa.usda.gov/resources/programs/arc-plc/program-data`
   (send a user-agent; FSA's CDN is picky).
2. `findBenchmarkFileLinks(html)` scans for entries shaped like

   ```html
   <p>2026 ARC-County Benchmark Yields and Revenues as of January 16, 2026
      (<a href="/documents/arcco-2026-data-2026-01-16">Excel format, 2 MB</a>)</p>
   ```

   The **data year is the description's leading year**, never the "as of" date
   or the href. Entries without a leading year ("Data Sources for 2019 …") are
   skipped; duplicates per year keep the first (newest revision).
3. `pickBenchmarkFile(links, requestedYear)` → the exact year if published, else
   the **most recent earlier year**. Report the year actually used as
   `data_year` so the UI can flag "2025 data — 2026 not yet published".
4. The `/documents/...` href lands on a Drupal **page**, not the file:
   `findFileUrlInDocumentPage(html)` pulls the first `.xlsx` href out of it
   (e.g. `/sites/default/files/2026-01/arcco_2026_data%20%282026-01-16%29.xlsx`).
   Detect this by `content-type` containing `html` on the first download.

### 2.2 Parsing

`XLSX.read` the buffer, then per sheet `sheet_to_json(ws, {header: 1, raw: true, defval: null})`
and hand the row matrices to `parseBenchmarkWorkbook`:

- **Header row is discovered**, not hard-coded — FSA's layout shifts yearly.
  `discoverHeader` scans the first 25 rows for a row naming a state column, a
  county column, and a benchmark yield or revenue column. Real 2026 headers:
  `ST_Cty`, `State Name`, `County Name`, `Sub County`, `Crop Name`,
  `ARC-CO Yield Designation` (practice), `2026 Bench Mark (2020-24 olympic avg)`
  (the yield — no word "yield"), `2026 Bench Mark Price (…)`, `2026 Benchmark Revenue`.
- Rows with a **sub-county** value are skipped (they collide on the key and
  don't match a plain county lookup).
- Normalization: state → 2-letter code (`normalizeStateCode`); county →
  uppercase, punctuation stripped, `COUNTY/PARISH/BOROUGH/CENSUS AREA` suffix
  removed (`normalizeCountyName`, so `St. Clair County` ↔ `ST CLAIR`);
  commodity → uppercased token, matched fuzzily (`commodityMatches`:
  `GRAIN SORGHUM`↔`SORGHUM`, `WHEAT`↔`ALL WHEAT`); practice →
  `irrigated` / `non_irrigated` / `all` (`normalizePractice`).
- Output row: `{state_code, county, commodity, practice, benchmark_yield, benchmark_price, benchmark_revenue}`.

### 2.3 Caching — the `fsa_benchmark_cache` pattern

Table keyed **unique (data_year, state_code, county, commodity, practice)**, plus
`source_url`, `fetched_at`. Companion log `fsa_benchmark_fetches(requested_year, state_code, file_year, file_url, checked_at)`.

Lookup flow for (commodity, county, state, requestedYear):

1. Read cache rows for `state_code + county` with `data_year <= requestedYear`,
   newest year first; `lookupBenchmarkRows` filters by commodity and returns
   every practice present (`all` → `non_irrigated` → `irrigated` ordering).
   Exact-year hit → done, no network.
2. Miss → consult the fetch log: if fsa.usda.gov was checked for this
   `requested_year × state` in the last **24 h**, don't hit it again
   (whatever the prior outcome — unpublished years and missing counties can't
   cause repeated downloads).
3. Otherwise fetch the page, pick the file, and **only download if that
   `data_year × state` isn't ingested yet**. Ingest the requested **state's**
   rows only (dedupe on county|commodity|practice), `delete` that year×state
   slice then `insert` in chunks of 1000, and log the check.
4. Re-read the cache and serve the **best year ≤ requested** (flag via
   `data_year`), or return `not_found`.

An in-process memo holds the parsed workbook for **1 h per URL** so adding
several states doesn't re-download the file. Values are returned for **user
confirmation**; the lookup never writes the projection table directly.

Turnrow's per-county projection row (`arc_benchmark_data`) keys on
`county_id` (→ a counties table carrying the state) because county names repeat
across states; store state + county, never county alone. It also carries
`county_yield_vs_benchmark_pct` (−30..+30) — the operator's expected actual
county yield as a % vs benchmark, applied via `expectedCountyYield`.

Seeded national benchmark prices (2025 and 2026, FSA): corn **5.03**,
soybeans **12.17**, wheat **6.98**. Prefer the file's own price when it parses.

---

## 3. Program parameters

### 3.1 `program_year_config` (one row per crop/program year)

| Column | 2025+ (OBBBA) | Pre-2025 built-in | Used for |
|---|---|---|---|
| `arc_guarantee_pct` | **0.90** | 0.86 | ARC-CO guarantee |
| `arc_payment_cap_pct` | **0.12** | 0.10 | ARC-CO rate cap |
| `erp_olympic_factor` | **0.88** | 0.85 | ERP escalator |
| `erp_cap_pct` | 1.15 | 1.15 | ERP ceiling |
| `payment_factor` | 0.85 | 0.85 | ARC-CO & PLC base-acre factor |
| `arc_ic_payment_factor` | 0.65 | 0.65 | ARC-IC base-acre factor |
| `sequestration_pct` | 0.054 | 0.054 | Federal sequestration haircut |
| `sco_trigger`, `per_person_payment_limit` | — | — | not needed by the landowner app |

Resolution (`resolveProgramYearConfig` in `lib/program-config.ts`): exact-year
row → most recent configured year at/below → earliest configured year →
era-aware built-ins (`defaultArcGuaranteePct(year)` etc., `OBBBA_FIRST_YEAR = 2025`).
Anything other than an exact match sets `isFallback` so the UI can show a
non-blocking notice. Seeded years: 2025, 2026, 2027.

### 3.2 `covered_commodities` — statutory reference prices & loan rates (OBBBA 2025–2031)

| Commodity | Unit | Statutory ref price | National loan rate | MY start |
|---|---|---|---|---|
| Corn | bushel | 4.10 | 2.42 | 9 |
| Soybeans | bushel | 10.00 | 6.82 | 9 |
| Wheat | bushel | 6.35 | 3.72 | 6 |
| Seed Cotton | pound | 0.42 | 0.25 | 8 |
| Grain Sorghum | bushel | 4.40 | 2.42 | 9 |
| Oats | bushel | 2.65 | 2.20 | 6 |
| Barley | bushel | 5.45 | 2.75 | 6 |
| Peanuts | pound | 0.315 | 0.195 | 8 |
| Canola | pound | 0.2015 | 0.1009 | 7 |
| Sesame | pound | 0.2015 | 0.1009 | 9 |

(Loan rates are the OBBBA-raised values effective 2026+; seed cotton keeps the
$0.25 statutory floor. Sesame has no NASS price series — manual MYA only.)

Also per commodity: `mya_basis_adj`, `mya_month_weights` (blend overrides),
`lint_share`/`cottonseed_share` (seed cotton).

### 3.3 Effective reference price (ERP)

```
ERP = min(erp_cap_pct × statutory, max(statutory, erp_olympic_factor × OlympicAvg(5 most recent lagged MYAs)))
```

`olympicAverage` drops the single high and low, averages the rest (Turnrow
accepts ≥3 values). Precedence (`effectiveReferencePrice`): an **FSA-published
ERP stored for the year** wins → computed from the Olympic average when history
is supplied → the statutory price (floor). FSA-published ERPs seeded for 2025
and 2026: corn **4.42**, soybeans **10.71**, wheat **6.35**.

ARC benchmark price from history (`arcBenchmarkPriceFromHistory`): each of the
5 years counts at `max(MYA, that year's ERP)` (a missing MYA counts at its ERP),
then the Olympic average. In practice take the price from the FSA workbook.

---

## 4. The math, exactly

All functions are pure; per-year parameters are passed in (defaults = OBBBA values).

### 4.1 PLC — `computePlcPayment`

```
effective_price   = max(MYA, national_loan_rate)
payment_rate      = max(0, effective_reference_price − effective_price)      # $/bu or $/lb
gross_per_acre    = payment_rate × PLC_yield
gross             = gross_per_acre × base_acres
net               = gross × payment_factor (0.85) × (1 − sequestration_pct (0.054))
```

Rounding: prices 6 dp, dollar figures 2 dp. `plcYield` is forced to 0 when
`baseAcres` is 0.

### 4.2 ARC-CO — `computeArcCoPayment`

```
effective_price    = max(MYA, national_loan_rate)
benchmark_revenue  = benchmark_price × benchmark_county_yield                  # $/ac
guarantee          = arc_guarantee_pct (0.90) × benchmark_revenue
actual_revenue     = actual_county_yield × effective_price
shortfall          = max(0, guarantee − actual_revenue)
max_rate_per_acre  = arc_payment_cap_pct (0.12) × benchmark_revenue
rate_per_acre      = min(shortfall, max_rate_per_acre)                        # capped = shortfall > max
gross              = rate_per_acre × base_acres
net                = gross × payment_factor (0.85) × (1 − sequestration_pct)
```

`actual_county_yield` before FSA publishes it is an expectation:
`expectedCountyYield(benchmarkYield, vsPct) = benchmarkYield × (1 + vsPct/100)`.
Surface the drivers (benchmark revenue, guarantee, actual revenue, cap, capped
flag) — operators want to see *why* ARC pays or doesn't.

### 4.3 Fallbacks and ARC-IC — `computeArcCoFlatPayment`

When no benchmark row exists for the county × year, or for ARC-IC (individual
farm revenue isn't modeled): `gross = projected_rate_per_acre × base_acres`,
netted the same way, with ARC-IC using `arc_ic_payment_factor` (0.65) instead
of 0.85. Label these rows "flat est." and say why (no county vs. no benchmark row).

### 4.4 Election per farm × commodity

Each `farm × commodity × program year` carries one election
(`PLC` | `ARC_CO` | `ARC_IC`; default **PLC** when none is recorded). The
projection runs the matching formula per base-acre record:
`{farm_id, commodity_id, base_acres, plc_yield}`. Unassigned/generic base acres
never generate a payment. For 2025 only, FSA pays the **higher of** ARC/PLC
automatically (OBBBA) — the Decision Aid's PLC-vs-ARC comparison is the right
framing for that year.

---

## 5. Payment-year attribution (migration 039)

> ARC/PLC for **program year N is paid in October of N+1.**

- All **math** (MYA, ERP, benchmarks, base acres, elections) is keyed to the
  **program year** (`arc_plc_payments.crop_year`).
- **Cash/revenue** attributes to the year it arrives:
  `revenue_crop_year = crop_year + 1` (a generated column in Turnrow) and
  `expectedArcPlcDate(programYear) = "<programYear+1>-10-01"`.
- The `+1` lives in **exactly one place**: `revenueCropYearFor(programYear)` /
  `programYearFor(revenueCropYear)` in `lib/government-payments.ts`. Never
  scatter it.
- **Two framings** of the same pool:
  - **By payment year** (default for cash views): crop year Y shows program
    year Y−1's ARC/PLC (header "Y−1 program year → paid Oct Y") plus other USDA
    payments received in Y.
  - **By program year** (FSA reconciliation): the FSA year; switching shifts
    the selected year ±1 so the same money stays on screen.
- Other (non-ARC/PLC) USDA payments attribute by **payment date's year**, else
  their stored `crop_year`, which means the **payment year**, not a program year
  (`paymentAttributionYear`).
- When projecting program year Y−1 for a revenue/cash view of year Y, use that
  program year's **own stored/final prices** — don't let the current year's
  live estimate leak backward.

---

## 6. Caching / refresh patterns by source

| Source | Cache | TTL / trigger | Write pattern |
|---|---|---|---|
| NASS monthly prices | in-process `Map` keyed by the full query params, promise-valued | 24 h; failed promise self-evicts | Lookup returns candidates for **user confirmation**; confirmed months persist with `source='usda'` (edited → `'manual'`); already-entered months are never overwritten silently. |
| NASS → MYA estimate | stored `mya_price_estimate` per commodity × year | lazy — recomputed on page load (`useLiveMya`, which **resets its maps on year change** so a failed refetch can't leave last year's prices in play) | Writer **refuses to overwrite `source='manual'`** rows; a final is untouched. |
| FSA workbook | `fsa_benchmark_cache` (DB, global — shared across tenants) + 1 h in-process parsed-workbook memo | lazy, on lookup miss; `fsa_benchmark_fetches` guards fsa.usda.gov to **≤1 hit per 24 h per year × state** | Per `data_year × state` slice: parse fully first, then `delete` slice + chunked `insert` (validate-before-replace; a parse failure leaves the old slice intact). Lookup never writes the projection table. |
| Program parameters | `program_year_config` rows (global) | operator-edited; fetched per page | Exact year else most-recent fallback with notice. |
| Reference prices / loan rates | `covered_commodities` (global) | operator-edited; OBBBA seeds | — |
| FSA-published ERP | `arc_plc_price_data.effective_reference_price` | operator-entered / seeded | Published value wins over the computed ERP. |
| Benchmark price/yield for projection | per-county rows (`arc_benchmark_data`) | operator-confirmed from the FSA lookup (or manual) | Keyed county_id (state-aware); `source_description` records provenance, including any borrowed nearby-county / prior-year value. |

General rule used across Turnrow's external feeds (NASS, FSA, RMA): **global
caches** (public data isn't tenant-specific), **lazy refresh** on read with a
throttle log rather than cron, and **write-then-swap** — validate the freshly
fetched payload before it replaces anything visible; failures keep the prior
values with an "as of" note, never a blanked screen.

---

## 7. Files referenced

- `lib/nass-quickstats.ts` — NASS parsing, unit conversion, series selection, seed-cotton blend. Tests: `lib/nass-quickstats.test.ts`.
- `app/api/nass-monthly-prices/route.ts` — NASS HTTP, params, 24 h cache, error mapping.
- `lib/mya-estimate.ts` — `marketingYearMonths`, weights, `estimateMyaBlend`. Tests: `lib/mya-estimate.test.ts`.
- `app/api/mya-estimate/route.ts` — blend + persist (shows the manual-protection write rule).
- `lib/fsa-benchmark-file.ts` — FSA page/link discovery, workbook header discovery, normalization, lookup. Tests: `lib/fsa-benchmark-file.test.ts`.
- `app/api/fsa-benchmark-yield/route.ts` — download, cache, fetch-guard, `data_year` fallback.
- `lib/program-config.ts` — `program_year_config` resolution + era-aware defaults. Tests: `lib/program-config.test.ts`.
- `lib/government-payments.ts` — ERP, MYA precedence, `computePlcPayment`, `computeArcCoPayment`, attribution helpers. Tests: `lib/government-payments.test.ts`.
- `lib/use-live-mya.ts` — client hook pattern (reset-on-year-change).
- Schema: `supabase/025_government_payments.sql`, `032_program_year_config.sql`, `037_obbba_arc_plc.sql`, `039_*` (attribution), `040_fsa_benchmark_file_and_seed_cotton.sql`.
