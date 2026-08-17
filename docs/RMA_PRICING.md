# RMA Price Discovery — implementation guide for consuming apps

How Turnrow consumes USDA RMA crop-insurance price data, written so another
app (specifically Turnrow Landowner, for benchmark pricing) can replicate the
approach independently. RMA price discovery is **public data (CC0)** — no
Turnrow partner API involvement, no credentials. Written 2026-08-17 from the
code; cross-check against the referenced files, which are the source of
truth:

- `lib/rma-price-discovery.ts` — pure: URL building, Atom parsing, offer
  selection, window/status classification, tiering, cache-staleness rules.
- `app/api/rma-price-discovery/route.ts` — the fetch/cache route over the
  `rma_price_cache` table (migrations 064/065).
- `lib/crop-insurance.ts` (`rmaToAppInsurancePrice`, line ~109) — the single
  unit-conversion boundary.
- `lib/rma-price-discovery.test.ts` — worked examples of every rule below.

## 1. The service and how requests are keyed

OData endpoint (Atom XML):

```
https://public-rma.fpac.usda.gov/apps/PriceDiscovery/Services/
  RevenuePriceDataService.svc/RevenuePrices
    ?$filter=CommodityYear eq {year} and CommodityCode eq '{code}'
             and StateCode eq '{fips}'
```

Build it with `rmaServiceUrl` semantics: filter by **commodity year**,
**commodity code** (4-digit, e.g. Corn `0041`, Soybeans `0081`, Wheat `0011`,
Cotton `0021`, Canola `0015` — full crop-name→code table in
`RMA_COMMODITY_CODES`), and **state as 2-digit FIPS** (`STATE_FIPS` maps
2-letter → FIPS). Query one crop × state × year per request.

Each `<entry>` is one **offer**: commodity year × commodity × **type** ×
**practice** × **state** × sales-closing date (SCD), carrying:

- `ProjectedPrice`, `ProjectedPriceStatus`, projected window begin/end dates
- `HarvestPrice`, `HarvestPriceStatus`, harvest window begin/end dates
- `ApprovedPriceVolatilityPercent`
- the offer's **base contract** (`ProjectedPriceMarketSymbolCode` /
  `HarvestPriceMarketSymbolCode` + exchange codes) — use it; never assume the
  Midwest benchmark (Alabama corn discovers against ZCU, September — not the
  DEC contract)

**Windows genuinely differ by state** (the Commodity Exchange Price
Provisions key offers per state — Alabama corn discovers Jan 15–Feb 14 where
Illinois runs Feb 1–28). Keep everything state-keyed and read the discovery
periods from the data. Never hard-code dates.

Parse defensively (`parseRmaRevenuePrices`): verify the document is an Atom
`<feed>`, and throw a loud, specific error on a missing key or shape change
so a layout change can never become a silently wrong number. Null-valued
OData properties arrive as self-closed tags — treat as null, not zero.

### Picking "the" row for a crop × state

A state lists many offers per commodity. `pickPrimaryRow` selects:

1. Prefer the **Conventional** practice (organic/specialty exist in the feed
   but aren't the standard reference).
2. Within it, the crop's **preferred type** when one applies (winter vs
   spring wheat etc. — `rmaPreferredType`: spring-HARVESTED crops are the
   fall-planted winter types), else the catch-all "All …" type.
3. Then the earliest sales-closing date.

## 2. Projected vs harvest price semantics

Statuses are verbatim strings, and the **status is authoritative** (RMA sets
it — dates only decorate):

| Status | Meaning |
| --- | --- |
| `Yet To Start` | Window hasn't opened; price field empty/ignorable. |
| `In Discovery` | Window open; the price field holds the **running average to date**. Label it that way (day N of M from the window dates, clamped — `windowState`). |
| `Released` | Final. The published number is a fact. |

- The **projected price** discovers before planting (per that state's
  window) and sets revenue guarantees; the **harvest price** discovers near
  harvest. Both follow the same status lifecycle.
- A successful query returning zero rows means **RMA lists no offer** for
  that crop × state — show a calm "no RMA offer" state, which is data, not
  an error. Distinguish it from a fetch failure (see caching).
- If you tier prices (estimate → RMA), a **Released** RMA value outranks a
  manual/estimated one; Turnrow surfaces that supersede visibly instead of
  silently replacing (`resolveTieredPrice`).

## 3. Units — one conversion boundary

RMA prices arrive in the commodity's RMA unit. Convert **once, at the fetch
boundary**, and use app-native units everywhere else
(`rmaToAppInsurancePrice`, `lib/crop-insurance.ts`):

- Canola: RMA quotes $/lb → multiply by 50 → $/bu (50 lb/bu).
- Cotton: $/lb, kept native.
- Grains: $/bu, kept native.

Everything downstream (display, math, caching) then never converts again —
this rule is what keeps a $0.226 canola price from ever reading as $0.23/bu.

## 4. Caching — global cache, lazy refresh, write-then-swap

Pattern (see `app/api/rma-price-discovery/route.ts` over `rma_price_cache`):

- **Global cache, not per-user**: RMA data is public and identical for
  everyone; cache rows key on crop/commodity × state × year and store the
  parsed fields + `fetched_at`.
- **Lazy refresh on read** — no cron. Staleness (`rmaCacheIsStale`):
  - any window `In Discovery` **or** `Yet To Start` → refresh after
    **24 hours** (daily; pending windows refresh daily too so the flip to
    in-discovery is seen promptly);
  - everything `Released`/idle → refresh after **7 days** (a shape check —
    released values are immutable facts).
- Fetch crop × state combos concurrently with a **per-fetch timeout**
  (Turnrow uses 10s) so one slow query can't hang the set.
- **Write-then-swap** (`mergeRmaResults`): fetch → validate → only then
  replace displayed/cached state. A failed, malformed, or
  suspiciously-empty response keeps the previous values and reports why. A
  per-key `fetch_failed` result never overwrites good prior data for that
  key; a genuine `no_offer` result is data and replaces normally. A refresh
  must never blank a previously-good window.

## 5. Fallback source

If the `.svc` endpoint ever churns, the documented fallback is RMA's **ADM
(actuarial data master) Price dataset** — pipe-delimited files on RMA's
public download site with the same fields (projected/harvest prices,
statuses, windows, volatility, per state/type/practice). Same parse-loudly +
cache + write-then-swap treatment; only the transport differs. Turnrow's
tiering additionally degrades to a live-futures estimate of the offer's own
base contract whenever RMA data is unavailable — optional, but it keeps a
price on screen with an honest label.
