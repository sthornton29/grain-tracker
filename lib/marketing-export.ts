// The Marketing dashboard's export payload, extracted pure so the mixed
// grain + cotton unit formatting is unit-testable: grain sections stay $/bu +
// bushels; cotton sections render $/lb + lbs of lint (with bales as a
// companion figure) and skip the grain-shaped basis/sales blocks entirely.

import { CONTRACT_TYPE_LABEL } from '@/lib/contracts'
import { formatNumber, type ExportPayload } from '@/lib/exports'
import { breakevenAvgPrice, type MarketingRow, type SegmentAcres } from '@/lib/marketing'
import type { Contract } from '@/lib/types'

const ac = (n: number) => formatNumber(n, 'acres')
const buf = (n: number) => formatNumber(n, 'bu')
const lbsf = (n: number) => formatNumber(n, 'lbs')
const usd = (n: number) => formatNumber(n, 'usd0')
const price = (n: number) => formatNumber(n, 'price')
const cents = (n: number) => formatNumber(n, 'cents')
const yld = (n: number) => formatNumber(n, 'yield')

export function buildMarketingExport(args: {
  year: number | null
  rows: MarketingRow[]
  contracts: Contract[]
  /** cropId → "advanced" (has hedges / HTA / basis contracts). */
  cropMeta: Map<string, boolean>
  segByCrop: Map<string, SegmentAcres>
  /** Active entity filter's display name (null = All entities). */
  entityName?: string | null
  combined: { acres: number; profit: number | null }
}): ExportPayload {
  const { year, rows, contracts, cropMeta, segByCrop, combined } = args
  const sections: ExportPayload['sections'] = []
  const KV: ExportPayload['sections'][number]['columns'] = [{ label: 'Item' }, { label: 'Value', align: 'right' }]

  sections.push({
    title: 'Summary',
    columns: KV,
    rows: [
      ['Total acres', ac(combined.acres)],
      ['Total projected profit', combined.profit != null ? usd(combined.profit) : '—'],
    ],
  })

  for (const r of rows) {
    const rows2: Array<Array<string | number | null>> = []
    const meta2: ('data' | 'subhead' | 'total')[] = []
    const sub = (t: string) => { rows2.push([t, '']); meta2.push('subhead') }
    const kv = (k: string, v: string | number | null) => { rows2.push([k, v]); meta2.push('data') }
    const tot = (k: string, v: string | number | null) => { rows2.push([k, v]); meta2.push('total') }
    const seg = segByCrop.get(r.cropId)
    const irrAc = seg ? seg.fullIrr + seg.dcIrr : 0
    const dryAc = seg ? seg.fullDry + seg.dcDry : 0

    if (r.unit === 'lbs') {
      // ---- Cotton: lbs of lint + $/lb display; production and futures hedges only. ----
      sub('Production')
      kv('Planted acres', `${ac(r.acres)}${irrAc > 0 || dryAc > 0 ? ` (irr ${ac(irrAc)} / dry ${ac(dryAc)})` : ''}`)
      kv('Yield', r.yield != null ? `${yld(r.yield)} lbs lint/ac ${r.yieldLabel}` : '—')
      kv('Total production', `${lbsf(r.totalProduction)} lbs${r.cottonBales != null ? ` · ${lbsf(r.cottonBales)} bales` : ''}`)

      sub('Hedging position')
      kv('Note', 'Physical cotton marketing not yet tracked — production and futures hedges only.')
      kv('Hedged (open CT shorts)', `${lbsf(r.openHedgeBu)} lbs${r.openHedgeAvg != null ? ` @ ${cents(r.openHedgeAvg)}` : ''}`)
      kv('Unhedged', `${lbsf(r.unpricedBu)} lbs${r.unpricedFuturesPrice > 0 ? ` @ ${cents(r.unpricedFuturesPrice)}` : ''}`)
      if (r.hedgeRealizedPnl !== 0) kv('Realized hedge P&L (in revenue)', usd(r.hedgeRealizedPnl))
      tot('Effective avg price', r.totalAvgPrice != null ? cents(r.totalAvgPrice) : '—')

      sub('Profitability')
      kv('Cost / acre', r.costPerAcre != null ? usd(r.costPerAcre) : '—')
      kv('Cost / lb', r.costPerBu != null ? cents(r.costPerBu) : '—')
      kv('Revenue / acre', r.revenuePerAcre != null ? usd(r.revenuePerAcre) : '—')
      kv('Profit / acre', r.profitPerAcre != null ? usd(r.profitPerAcre) : '—')
      tot('Total profit', r.totalProfit != null ? usd(r.totalProfit) : '—')
      kv('Breakeven price', r.costPerAcre != null && r.yield != null && r.yield > 0 ? cents((r.costPerAcre * 100) / r.yield) : '—')
      kv('Breakeven yield', r.costPerAcre != null && r.totalAvgPrice != null && r.totalAvgPrice > 0 ? `${yld((r.costPerAcre * 100) / r.totalAvgPrice)} lbs/ac` : '—')

      sections.push({ title: r.cropName, columns: KV, rows: rows2, rowMeta: meta2 })
      continue
    }

    const adv = cropMeta.get(r.cropId) ?? false
    const cropContracts = contracts.filter((c) => c.crop_id === r.cropId)
    const byType = new Map<string, number>()
    for (const c of cropContracts) {
      const t = CONTRACT_TYPE_LABEL[c.contract_type ?? 'forward']
      byType.set(t, (byType.get(t) ?? 0) + Number(c.contracted_bushels ?? 0))
    }
    // The standing headline figures lean on assumed pricing whenever some
    // production isn't fully locked — carry that qualifier into the export.
    const qual = r.lockedPriceBu + 0.5 < r.totalProduction ? ' (incl. assumed pricing)' : ''

    sub('Production')
    kv('Planted acres', `${ac(r.acres)}${irrAc > 0 || dryAc > 0 ? ` (irr ${ac(irrAc)} / dry ${ac(dryAc)})` : ''}`)
    kv('Yield', r.yield != null ? `${yld(r.yield)} bu/ac ${r.yieldLabel}` : '—')
    kv('Total production', `${buf(r.totalProduction)} bu`)

    sub('Sales')
    kv('Contracted', `${buf(r.contractedBu)} bu`)
    kv('Remaining', `${buf(r.remaining)} bu`)
    for (const [t, b] of byType) kv(t, `${buf(b)} bu`)

    if (adv) {
      // Block 1 — Average Futures Price Buildup (line-item ledger).
      sub('Avg Futures Price Buildup')
      if (r.futuresSources.length > 0) {
        for (const s of r.futuresSources) kv(s.label, `${buf(s.bushels)} bu @ ${price(s.avgPrice)}`)
        kv(`Weighted avg futures (${buf(r.futuresPricedBu)} bu)`, r.rawAvgFutures != null ? price(r.rawAvgFutures) : 'N/A')
        if (r.hedgeRealizedPnl !== 0) kv('Realized hedge P&L / bu', price(r.hedgeAdjPerBu))
        tot('= Average futures price', r.avgFutures != null ? price(r.avgFutures) : 'N/A')
      } else {
        kv('Futures', 'No futures positions — flat cash')
      }
      // Block 2 — Basis Buildup (with actual/assumed/blended state).
      sub('Basis Buildup')
      if (r.basisLockedBu > 0) kv(`Locked basis (${buf(r.basisLockedBu)} bu)`, r.basisLockedAvg != null ? price(r.basisLockedAvg) : '—')
      if (r.basisAssumedBu > 0) kv(`Assumed basis (${buf(r.basisAssumedBu)} bu)`, price(r.assumedBasis))
      tot(r.basisState === 'blended' ? '= Basis' : `= Basis (${r.basisState})`, price(r.avgBasis))
      tot(`Total avg price${qual}`, r.totalAvgPrice != null ? price(r.totalAvgPrice) : '—')
      if (r.hedgeRealizedPnl !== 0) kv('Realized hedge P&L (in revenue)', usd(r.hedgeRealizedPnl))
    } else {
      sub('Pricing')
      tot(`Avg price${qual}`, r.totalAvgPrice != null ? price(r.totalAvgPrice) : '—')
    }

    sub('Profitability')
    kv('Cost / acre', r.costPerAcre != null ? usd(r.costPerAcre) : '—')
    kv('Cost / bu', r.costPerBu != null ? price(r.costPerBu) : '—')
    kv('Revenue / acre', r.revenuePerAcre != null ? usd(r.revenuePerAcre) : '—')
    kv('Profit / acre', r.profitPerAcre != null ? usd(r.profitPerAcre) : '—')
    tot('Total profit', r.totalProfit != null ? usd(r.totalProfit) : '—')
    const beAvg = breakevenAvgPrice(r)
    const bePrice = r.costPerAcre != null && r.yield != null && r.yield > 0 ? r.costPerAcre / r.yield : null
    const beYield = r.costPerAcre != null && beAvg != null && beAvg > 0 ? r.costPerAcre / beAvg : null
    kv('Breakeven price', bePrice != null ? price(bePrice) : '—')
    kv('Breakeven yield', beYield != null ? `${yld(beYield)} bu/ac` : '—')

    sections.push({ title: r.cropName, columns: KV, rows: rows2, rowMeta: meta2 })
  }

  return {
    title: `Marketing — ${year ?? ''}`,
    filters: `Crop year: ${year ?? '—'}${args.entityName ? ` · Entity: ${args.entityName}` : ''}`,
    sections,
    singleSheet: true,
  }
}
