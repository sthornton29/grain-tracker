// RMA Price Discovery lookup — the authoritative projected/harvest insurance
// prices, tiered ABOVE the Barchart estimate (/api/harvest-price-estimate).
//
// POST { crop_year, crops: [{crop_id, crop_name}], states: ['GA','AL'], force? }
//
// Per crop × state: serve from rma_price_cache (064, global reference) unless
// stale — daily while a discovery window is open or pending, weekly once
// released — then refresh from RMA's public OData service and upsert the
// cache. Cache writes are owner-only (the 054 global-table rule, same as
// fsa_benchmark_cache): a non-owner's miss still returns fresh RMA data, it
// just isn't cached. Released/discovery values are then MIRRORED into the
// org's harvest_price_estimates ('authed all', so this works for any role):
//   harvest Released      → price_type 'harvest_final',   source 'RMA final'
//   harvest In Discovery  → price_type 'harvest_estimate', source 'rma_discovery'
//   projected Released    → price_type 'projected',        source 'RMA final'
//                           (ONLY when the crop/year has no manual projected
//                            row — the editor's manual entry always wins)
// The resolver (lib/crop-insurance.ts) reads those rows source-aware; the
// Income Sensitivity harvest-price pinning rides the harvest_final tier
// exactly as it always has — now fed automatically.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  parseRmaRevenuePrices, pickPrimaryRow, rmaCommodityCode, stateFips,
  rmaServiceUrl, rmaCacheIsStale, windowState, rmaSourceLabel, offerIdentityLabel,
  type RmaPriceRow, type RmaWindowStatus,
} from '@/lib/rma-price-discovery'
import { rmaToAppInsurancePrice } from '@/lib/crop-insurance'

export const runtime = 'nodejs'
export const maxDuration = 30

type ReqCrop = { crop_id: string; crop_name: string }

export type RmaLookupResult = {
  crop_id: string
  state_code: string // 2-letter
  commodity_code: string
  projected_price: number | null
  projected_status: RmaWindowStatus | null
  projected_begin_date: string | null
  projected_end_date: string | null
  projected_label: string | null
  harvest_price: number | null
  harvest_status: RmaWindowStatus | null
  harvest_begin_date: string | null
  harvest_end_date: string | null
  harvest_label: string | null
  volatility: number | null
  fetched_at: string
  /** The offer's base contracts (CEPP-keyed, e.g. AL corn ZCU26) — the
   *  Barchart-estimate tier must quote THESE, never a hard-coded month. */
  projected_market_symbol: string | null
  harvest_market_symbol: string | null
  harvest_exchange_code: string | null
  /** Which offer was chosen (provenance): type · practice · SCD. */
  offer_identity: string | null
  /** True when RMA lists no offer for this crop × state — render "no RMA
   *  offer for <state>", never a blank row. */
  no_offer?: boolean
}

type CacheRow = {
  commodity_year: number; commodity_code: string; commodity_name: string
  state_code: string; state_name: string
  type_code: number; type_name: string; practice_code: number; practice_name: string
  sales_closing_date: string | null
  projected_price: number | null; projected_status: string | null
  projected_begin_date: string | null; projected_end_date: string | null
  harvest_price: number | null; harvest_status: string | null
  harvest_begin_date: string | null; harvest_end_date: string | null
  volatility: number | null; fetched_at: string
  projected_exchange_code?: string | null; projected_market_symbol?: string | null
  harvest_exchange_code?: string | null; harvest_market_symbol?: string | null
}

const rowToCache = (r: RmaPriceRow): Omit<CacheRow, 'fetched_at'> => ({
  commodity_year: r.commodityYear, commodity_code: r.commodityCode, commodity_name: r.commodityName,
  state_code: r.stateCode, state_name: r.stateName,
  type_code: r.typeCode, type_name: r.typeName, practice_code: r.practiceCode, practice_name: r.practiceName,
  sales_closing_date: r.salesClosingDate,
  projected_price: r.projectedPrice, projected_status: r.projectedStatus,
  projected_begin_date: r.projectedBeginDate, projected_end_date: r.projectedEndDate,
  harvest_price: r.harvestPrice, harvest_status: r.harvestStatus,
  harvest_begin_date: r.harvestBeginDate, harvest_end_date: r.harvestEndDate,
  volatility: r.volatility,
  projected_exchange_code: r.projectedExchangeCode, projected_market_symbol: r.projectedMarketSymbol,
  harvest_exchange_code: r.harvestExchangeCode, harvest_market_symbol: r.harvestMarketSymbol,
})

const cacheToRow = (c: CacheRow): RmaPriceRow => ({
  commodityYear: c.commodity_year, commodityCode: c.commodity_code, commodityName: c.commodity_name,
  stateCode: c.state_code, stateName: c.state_name,
  typeCode: c.type_code, typeName: c.type_name, practiceCode: c.practice_code, practiceName: c.practice_name,
  salesClosingDate: c.sales_closing_date,
  projectedPrice: c.projected_price != null ? Number(c.projected_price) : null,
  projectedStatus: (c.projected_status as RmaWindowStatus | null) ?? null,
  projectedBeginDate: c.projected_begin_date, projectedEndDate: c.projected_end_date,
  harvestPrice: c.harvest_price != null ? Number(c.harvest_price) : null,
  harvestStatus: (c.harvest_status as RmaWindowStatus | null) ?? null,
  harvestBeginDate: c.harvest_begin_date, harvestEndDate: c.harvest_end_date,
  volatility: c.volatility != null ? Number(c.volatility) : null,
  projectedExchangeCode: c.projected_exchange_code ?? null,
  projectedMarketSymbol: c.projected_market_symbol ?? null,
  harvestExchangeCode: c.harvest_exchange_code ?? null,
  harvestMarketSymbol: c.harvest_market_symbol ?? null,
})

export async function POST(req: NextRequest) {
  const supabase = createClient()

  let body: { crop_year?: unknown; crops?: unknown; states?: unknown; force?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const cropYear = Number(body.crop_year)
  const crops = (Array.isArray(body.crops) ? body.crops : []) as ReqCrop[]
  const states = (Array.isArray(body.states) ? body.states : []).filter((s): s is string => typeof s === 'string')
  const force = body.force === true
  if (!Number.isFinite(cropYear) || crops.length === 0 || states.length === 0) {
    return NextResponse.json({ error: 'crop_year, crops, and states are required.' }, { status: 400 })
  }

  const results: RmaLookupResult[] = []
  let note: string | undefined

  for (const crop of crops) {
    const code = rmaCommodityCode(crop.crop_name)
    if (!code) continue
    for (const st of states) {
      const fips = stateFips(st)
      if (!fips) continue

      // 1. Cache (the fsa_benchmark_cache lookup-miss pattern).
      const { data: cached } = await supabase
        .from('rma_price_cache')
        .select('*')
        .eq('commodity_year', cropYear)
        .eq('commodity_code', code)
        .eq('state_code', fips)
      let rows = ((cached as CacheRow[] | null) ?? []).map(cacheToRow)
      const fetchedAt = ((cached as CacheRow[] | null) ?? [])[0]?.fetched_at ?? null
      const stale = force || rows.length === 0 || fetchedAt == null || rows.some((r) =>
        rmaCacheIsStale({
          fetchedAt: fetchedAt!,
          projectedStatus: r.projectedStatus,
          harvestStatus: r.harvestStatus,
        }),
      )

      // 2. Refresh from RMA when stale. Failures degrade to the cached rows
      //    (or nothing — the caller's tiering falls back to the estimate).
      if (stale) {
        try {
          const resp = await fetch(rmaServiceUrl({ commodityYear: cropYear, commodityCode: code, stateFips: fips }), {
            headers: { accept: 'application/atom+xml' },
          })
          if (!resp.ok) throw new Error(`RMA returned ${resp.status}.`)
          const fresh = parseRmaRevenuePrices(await resp.text())
          if (fresh.length > 0) {
            rows = fresh
            // Owner-only global cache (054): a non-owner's write fails
            // silently and the fresh data still serves this response.
            const { error: cacheErr } = await supabase
              .from('rma_price_cache')
              .upsert(fresh.map(rowToCache).map((r) => ({ ...r, fetched_at: new Date().toISOString() })), {
                onConflict: 'commodity_year,commodity_code,state_code,type_code,practice_code,sales_closing_date',
              })
            if (cacheErr) console.error(`[rma-price-discovery] cache write failed (${crop.crop_name}/${st}): ${cacheErr.message}`)
          }
        } catch (e) {
          console.error(`[rma-price-discovery] ${crop.crop_name}/${st}: ${e instanceof Error ? e.message : e}`)
          if (rows.length === 0) {
            note = 'Could not reach RMA Price Discovery — showing estimates instead.'
            continue
          }
        }
      }

      const primary = pickPrimaryRow(rows)
      if (!primary) {
        // RMA lists no offer for this crop x state - say so, never a blank.
        results.push({
          crop_id: crop.crop_id, state_code: st.toUpperCase(), commodity_code: code,
          projected_price: null, projected_status: null, projected_begin_date: null, projected_end_date: null, projected_label: null,
          harvest_price: null, harvest_status: null, harvest_begin_date: null, harvest_end_date: null, harvest_label: null,
          volatility: null, fetched_at: new Date().toISOString(),
          projected_market_symbol: null, harvest_market_symbol: null, harvest_exchange_code: null,
          offer_identity: null, no_offer: true,
        })
        continue
      }
      // Offer-selection diagnostics: which candidates existed, which won.
      console.log(`[rma-price-discovery] ${crop.crop_name}/${st}: ${rows.length} offer(s); chose ${primary.typeName} / ${primary.practiceName} / SCD ${primary.salesClosingDate ?? '-'}`)

      const today = new Date().toISOString().slice(0, 10)
      const pw = windowState({ status: primary.projectedStatus, beginDate: primary.projectedBeginDate, endDate: primary.projectedEndDate, today })
      const hw = windowState({ status: primary.harvestStatus, beginDate: primary.harvestBeginDate, endDate: primary.harvestEndDate, today })
      // RMA-native -> app-native units at the one boundary (canola $/lb -> $/bu).
      const appProjected = primary.projectedPrice != null ? rmaToAppInsurancePrice(crop.crop_name, primary.projectedPrice) : null
      const appHarvest = primary.harvestPrice != null ? rmaToAppInsurancePrice(crop.crop_name, primary.harvestPrice) : null
      results.push({
        crop_id: crop.crop_id,
        state_code: st.toUpperCase(),
        commodity_code: code,
        projected_price: appProjected,
        projected_status: primary.projectedStatus,
        projected_begin_date: primary.projectedBeginDate,
        projected_end_date: primary.projectedEndDate,
        projected_label: pw ? rmaSourceLabel({ status: pw.status, dayOfWindow: pw.dayOfWindow, windowDays: pw.windowDays, asOf: today }) : null,
        harvest_price: appHarvest,
        harvest_status: primary.harvestStatus,
        harvest_begin_date: primary.harvestBeginDate,
        harvest_end_date: primary.harvestEndDate,
        harvest_label: hw ? rmaSourceLabel({ status: hw.status, dayOfWindow: hw.dayOfWindow, windowDays: hw.windowDays, asOf: today }) : null,
        volatility: primary.volatility,
        fetched_at: new Date().toISOString(),
        projected_market_symbol: primary.projectedMarketSymbol,
        harvest_market_symbol: primary.harvestMarketSymbol,
        harvest_exchange_code: primary.harvestExchangeCode,
        offer_identity: offerIdentityLabel({ ...primary, stateAbbr: st.toUpperCase() }),
      })

      // 3. Mirror into the org's estimate rows so the resolvers (and the
      //    Income Sensitivity pinning) see RMA values with zero special-casing.
      if (primary.harvestStatus === 'released' && appHarvest != null) {
        await supabase.from('harvest_price_estimates').upsert({
          crop_id: crop.crop_id, crop_year: cropYear, price_type: 'harvest_final',
          price: appHarvest, source: 'RMA final',
          price_date: primary.harvestEndDate ?? today,
        }, { onConflict: 'crop_id,crop_year,price_type,price_date' })
      } else if (primary.harvestStatus === 'in_discovery' && appHarvest != null) {
        await supabase.from('harvest_price_estimates').upsert({
          crop_id: crop.crop_id, crop_year: cropYear, price_type: 'harvest_estimate',
          price: appHarvest, source: 'rma_discovery',
          price_date: today,
        }, { onConflict: 'crop_id,crop_year,price_type,price_date' })
      }
      // ALWAYS mirror a Released projected price. The old only-when-no-manual
      // guard let the 024 seeds (and any manual row) MASK the real state value;
      // precedence now lives in resolveProjectedPrice (RMA > manual > seed),
      // which surfaces the supersede as a notice instead of skipping the write.
      if (primary.projectedStatus === 'released' && appProjected != null) {
        await supabase.from('harvest_price_estimates').upsert({
          crop_id: crop.crop_id, crop_year: cropYear, price_type: 'projected',
          price: appProjected, source: 'RMA final',
          price_date: primary.projectedEndDate ?? today,
        }, { onConflict: 'crop_id,crop_year,price_type,price_date' })
      }
    }
  }

  return NextResponse.json({ data: { results, note } })
}
