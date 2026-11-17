// The Marketing dashboard's export payload, extracted pure so the mixed
// grain + cotton unit formatting is unit-testable: grain sections stay $/bu +
// bushels; cotton sections render $/lb + lbs of lint (with bales as a
// companion figure) and skip the grain-shaped basis/sales blocks entirely.
//
// Every figure is a REAL number. A line reads Item | Quantity | Unit |
// Price / amount, so the card's "20,000 bu @ $4.85" is two numeric cells and
// a unit — never one string. The page is a stack of crop cards (one small
// table per crop), so the workbook stacks them on one sheet the same way.

import { cropYearLabel } from '@/components/reports/report-format'
import { CONTRACT_TYPE_LABEL } from '@/lib/contracts'
import type { ExportCell, ExportColumn, ExportPayload, NumFmt, RowKind, Tone } from '@/lib/exports'
import { breakevenAvgPrice, DEFAULT_BALE_LBS, type MarketingRow, type SegmentAcres } from '@/lib/marketing'
import type { Contract } from '@/lib/types'

const COLUMNS: ExportColumn[] = [
  { label: 'Item' },
  { label: 'Quantity', align: 'right' },
  { label: 'Unit' },
  { label: 'Price / amount', align: 'right' },
]

type Qty = { v: number; format: NumFmt; unit: string }
const qty = (v: number, format: NumFmt, unit: string): Qty => ({ v, format, unit })
/** A price or dollar amount — blank when there is none. */
const amt = (v: number | null | undefined, format: NumFmt, tone?: Tone): ExportCell =>
  v == null || !Number.isFinite(v) ? null : tone ? { v, format, tone } : { v, format }
const signed = (n: number): Tone | undefined => (n > 0 ? 'favorable' : n < 0 ? 'unfavorable' : undefined)

/** One crop's table, built line by line. */
function tableBuilder() {
  const rows: ExportCell[][] = []
  const rowMeta: RowKind[] = []
  const push = (kind: RowKind, label: ExportCell, q: Qty | null, amount: ExportCell) => {
    rows.push([label, q ? { v: q.v, format: q.format } : null, q ? q.unit : null, amount])
    rowMeta.push(kind)
  }
  return {
    rows,
    rowMeta,
    sub: (t: string) => { rows.push([t, null, null, null]); rowMeta.push('subhead') },
    line: (label: ExportCell, q: Qty | null = null, amount: ExportCell = null) => push('data', label, q, amount),
    /** The result of one block (average futures, basis). */
    subtotal: (label: ExportCell, q: Qty | null = null, amount: ExportCell = null) => push('subtotal', label, q, amount),
    /** A bottom line (the average price, the total profit). */
    total: (label: ExportCell, q: Qty | null = null, amount: ExportCell = null) => push('total', label, q, amount),
    /** A sentence instead of a figure. */
    note: (text: string, tone: Tone = 'muted') => push('data', { v: text, tone }, null, null),
  }
}

export function buildMarketingExport(args: {
  year: number | null
  rows: MarketingRow[]
  contracts: Contract[]
  /** cropId → "advanced" (has hedges / HTA / basis contracts). */
  cropMeta: Map<string, boolean>
  segByCrop: Map<string, SegmentAcres>
  /** Active entity filter's display name (null = All entities). */
  entityName?: string | null
  /** Per-crop reference contracts ("Corn: ZCZ26, Wheat: ZWU26 (rolled from Jul 26)"). */
  referenceNote?: string | null
  combined: { acres: number; profit: number | null }
}): ExportPayload {
  const { year, rows, contracts, cropMeta, segByCrop, combined } = args
  const sections: ExportPayload['sections'] = []

  const summary = tableBuilder()
  summary.line('Total acres', qty(combined.acres, 'acres', 'ac'))
  summary.line('Total projected profit', null, amt(combined.profit, 'usd0', combined.profit != null ? signed(combined.profit) : undefined))
  sections.push({ title: 'Summary', columns: COLUMNS, rows: summary.rows, rowMeta: summary.rowMeta })

  for (const r of rows) {
    const t = tableBuilder()
    const seg = segByCrop.get(r.cropId)
    const irrAc = seg ? seg.fullIrr + seg.dcIrr : 0
    const dryAc = seg ? seg.fullDry + seg.dcDry : 0
    const acresLabel = r.acresSource === 'assumed' ? 'Assumed acres (no plantings yet)' : 'Planted acres'
    const yieldLabel = `Yield (${r.yieldLabel === 'Actual' ? 'actual' : 'estimate'})`
    const profitTone: Tone | undefined = r.totalProfit == null ? undefined : r.totalProfit >= 0 ? 'favorable' : 'unfavorable'

    t.sub('Production')
    t.line(acresLabel, qty(r.acres, 'acres', 'ac'))
    if (irrAc > 0 || dryAc > 0) {
      t.line('Irrigated acres', qty(irrAc, 'acres', 'ac'))
      t.line('Dryland acres', qty(dryAc, 'acres', 'ac'))
    }

    if (r.unit === 'lbs') {
      // ---- Cotton: lbs of lint + $/lb (prices are stored in cents/lb). ----
      t.line(yieldLabel, r.yield != null ? qty(r.yield, 'yield', 'lbs lint/ac') : null)
      t.line('Total production', qty(r.totalProduction, 'lbs', 'lbs lint'))
      const lintEst = r.cottonLint && r.cottonLint.basis !== 'actual' ? r.cottonLint : null
      if (lintEst) {
        t.line('Lint on gin receipts', qty(lintEst.actualLbs, 'lbs', 'lbs lint'))
        t.line(
          { v: `Lint estimated from seed cotton not yet ginned (${lintEst.turnoutLabel ?? 'assumed turnout'})`, ...(lintEst.turnoutAssumed ? { tone: 'warning' as const } : {}) },
          qty(lintEst.estimatedLbs, 'lbs', 'lbs lint'),
        )
      }
      if (r.productionBales != null) t.line(`Production in bales (at ${r.baleWeightLbs ?? DEFAULT_BALE_LBS} lb per bale)`, qty(r.productionBales, 'int', 'bales'))
      if (r.cottonBales != null) t.line('Ginned bales', qty(r.cottonBales, 'int', 'bales'))

      const cp = r.cottonPhysical
      if (cp) {
        // The card's Sold / Pool / In loan / Hedged unsold / Unpriced position.
        const ps = cp.summary
        t.sub('Marketing position')
        if (ps.soldLbs > 0) t.line('Sold', qty(ps.soldLbs, 'lbs', 'lbs'), amt(r.avgCashPrice, 'cents'))
        if (ps.poolLbs > 0) t.line(cp.poolEstimated ? 'Pool (estimated)' : 'Pool', qty(ps.poolLbs, 'lbs', 'lbs'))
        if (ps.inLoanLbs > 0) t.line('In loan (price shown is the loan floor)', qty(ps.inLoanLbs, 'lbs', 'lbs'), amt(ps.loanFloorCents, 'cents'))
        if (cp.hedgedUnsoldLbs > 0) t.line('Hedged unsold', qty(cp.hedgedUnsoldLbs, 'lbs', 'lbs'), amt(r.openHedgeAvg, 'cents'))
        if (cp.unpricedLbs > 0) t.line('Unpriced', qty(cp.unpricedLbs, 'lbs', 'lbs'))
        if (ps.awaitingCallLbs > 0) t.line({ v: 'On-call awaiting futures (unpriced until fixed)', tone: 'warning' }, qty(ps.awaitingCallLbs, 'lbs', 'lbs'))

        t.sub('Physical sales')
        if (ps.soldSources.length > 0) for (const src of ps.soldSources) t.line(src.label, qty(src.lbs, 'lbs', 'lbs'), amt(src.cents, 'cents'))
        else t.note('No priced physical sales yet.')
        if (ps.poolLbs > 0) t.line(`Pool — ${cp.poolEstimated ? 'estimated value' : 'received'}`, qty(ps.poolLbs, 'lbs', 'lbs'), amt(cp.poolValueDollars, 'usd0'))
        if (ps.inLoanLbs > 0) t.line(`In CCC loan — ${cp.inLoanFloored ? 'at the banked loan floor' : 'at market above the floor'}`, qty(ps.inLoanLbs, 'lbs', 'lbs'), amt(cp.inLoanValueDollars, 'usd0'))

        t.sub('Program dollars and fees')
        t.line(`Program dollars (${ps.programLabel})`, null, amt(ps.programDollars, 'usd0', ps.programDollars > 0 ? 'favorable' : undefined))
        // Fees come off revenue: written as a negative amount.
        t.line('Net fees', null, ps.feeDollars !== 0 ? amt(-ps.feeDollars, 'usd0', ps.feeDollars > 0 ? 'unfavorable' : undefined) : null)
      }

      t.sub('Hedging position')
      if (!cp) t.note('No physical cotton marketing entered yet — production and futures hedges only.')
      t.line('Hedged (open futures)', qty(r.openHedgeBu, 'lbs', 'lbs'), amt(r.openHedgeAvg, 'cents'))
      t.line('Unhedged', qty(r.unpricedBu, 'lbs', 'lbs'), r.unpricedFuturesPrice > 0 ? amt(r.unpricedFuturesPrice, 'cents', 'warning') : null)
      if (r.hedgeRealizedPnl !== 0) t.line('Realized hedge P&L (in revenue)', null, amt(r.hedgeRealizedPnl, 'usd2', signed(r.hedgeRealizedPnl)))
      t.total('Effective avg price ($/lb)', null, amt(r.totalAvgPrice, 'cents'))

      t.sub('Profitability')
      t.line('Cost / acre', null, amt(r.costPerAcre, 'usd0'))
      t.line('Cost / lb', null, amt(r.costPerBu, 'cents'))
      t.line('Revenue / acre', null, amt(r.revenuePerAcre, 'usd0'))
      t.line('Profit / acre', null, amt(r.profitPerAcre, 'usd0', profitTone))
      t.total('Total profit', null, amt(r.totalProfit, 'usd0', profitTone))
      const bePriceLb = r.costPerAcre != null && r.yield != null && r.yield > 0 ? (r.costPerAcre * 100) / r.yield : null
      const beYieldLb = r.costPerAcre != null && r.totalAvgPrice != null && r.totalAvgPrice > 0 ? (r.costPerAcre * 100) / r.totalAvgPrice : null
      t.line('Breakeven price ($/lb)', null, amt(bePriceLb, 'cents'))
      t.line('Breakeven yield', beYieldLb != null ? qty(beYieldLb, 'yield', 'lbs lint/ac') : null)

      sections.push({ title: r.cropName, columns: COLUMNS, rows: t.rows, rowMeta: t.rowMeta })
      continue
    }

    const adv = cropMeta.get(r.cropId) ?? false
    // Seed production contracts get their own block below, never the grain type lines.
    const cropContracts = contracts.filter((c) => c.crop_id === r.cropId && (c.contract_kind ?? 'grain') !== 'seed_production')
    // The virtual spot contract (094) lists as its own line, never as a forward.
    const byType = new Map<string, number>()
    for (const c of cropContracts) {
      const type = (c as { virtual?: string }).virtual === 'spot' ? 'Spot' : CONTRACT_TYPE_LABEL[c.contract_type ?? 'forward']
      byType.set(type, (byType.get(type) ?? 0) + Number(c.contracted_bushels ?? 0))
    }
    // The standing headline figures lean on assumed pricing whenever some
    // production isn't fully locked — carry that qualifier into the export.
    const qual = r.lockedPriceBu + 0.5 < r.totalProduction ? ', incl. assumed pricing' : ''

    t.line(yieldLabel, r.yield != null ? qty(r.yield, 'yield', 'bu/ac') : null)
    t.line('Total production', qty(r.totalProduction, 'bu', 'bu'))

    t.sub('Sales')
    t.line('Contracted', qty(r.contractedBu, 'bu', 'bu'))
    t.line('Remaining', qty(r.remaining, 'bu', 'bu'))
    for (const [type, bushels] of byType) t.line(type, qty(bushels, 'bu', 'bu'))
    if (r.seed) {
      t.sub(`Seed production${r.seed.buyers.length > 0 ? ` — ${r.seed.buyers.join(', ')}` : ''}`)
      t.line(`Committed${r.seed.estimated ? ' (est.)' : ''}`, qty(r.seed.committedBu, 'bu', 'bu'))
      t.line('Priced (elected)', qty(r.seed.electedBu, 'bu', 'bu'), amt(r.seed.electedAvgPrice, 'price'))
      t.line('Unpriced (seed est.)', qty(r.seed.unpricedBu, 'bu', 'bu'), r.seed.unpricedBu > 0 ? amt(r.seed.unpricedNetPerBu, 'price') : null)
      if (r.seed.missingPremiums) t.note('Expected premium / bu: none entered for the expected outcome — valued at base price only.', 'warning')
      else t.line('Expected premium / bu (assumed)', null, amt(r.seed.premiumPerBu, 'price'))
      if (r.seed.usageFeePerBu > 0) t.line('Usage fee / bu', null, amt(r.seed.usageFeePerBu, 'price'))
    }

    if (adv) {
      // Block 1 — Average Futures Price Buildup (line-item ledger).
      t.sub('Avg Futures Price Buildup')
      if (r.futuresSources.length > 0) {
        for (const s of r.futuresSources) t.line(s.label, qty(s.bushels, 'bu', 'bu'), amt(s.avgPrice, 'price'))
        t.line('Weighted avg futures', qty(r.futuresPricedBu, 'bu', 'bu'), amt(r.rawAvgFutures, 'price'))
        if (r.hedgeRealizedPnl !== 0) t.line('Realized hedge P&L / bu', null, amt(r.hedgeAdjPerBu, 'price', signed(r.hedgeAdjPerBu)))
        t.subtotal('Average futures price ($/bu)', null, amt(r.avgFutures, 'price'))
      } else {
        t.note('No futures positions — priced through flat cash contracts.')
      }
      // Block 2 — Basis Buildup (with actual/assumed/blended state).
      t.sub('Basis Buildup')
      if (r.basisLockedBu > 0) t.line('Locked basis', qty(r.basisLockedBu, 'bu', 'bu'), amt(r.basisLockedAvg, 'price'))
      if (r.basisAssumedBu > 0) t.line('Assumed basis', qty(r.basisAssumedBu, 'bu', 'bu'), amt(r.assumedBasis, 'price', 'warning'))
      t.subtotal(`Basis ($/bu, ${r.basisState})`, null, amt(r.avgBasis, 'price', r.basisState === 'actual' ? undefined : 'warning'))
      t.total(`Total avg price ($/bu${qual})`, null, amt(r.totalAvgPrice, 'price'))
      if (r.hedgeRealizedPnl !== 0) t.line('Realized hedge P&L (in revenue)', null, amt(r.hedgeRealizedPnl, 'usd2', signed(r.hedgeRealizedPnl)))
    } else {
      t.sub('Pricing')
      t.total(`Avg price ($/bu${qual})`, null, amt(r.totalAvgPrice, 'price'))
    }

    t.sub('Profitability')
    t.line('Cost / acre', null, amt(r.costPerAcre, 'usd0'))
    t.line('Cost / bu', null, amt(r.costPerBu, 'price'))
    t.line('Revenue / acre', null, amt(r.revenuePerAcre, 'usd0'))
    t.line('Profit / acre', null, amt(r.profitPerAcre, 'usd0', profitTone))
    t.total('Total profit', null, amt(r.totalProfit, 'usd0', profitTone))
    const beAvg = breakevenAvgPrice(r)
    const bePrice = r.costPerAcre != null && r.yield != null && r.yield > 0 ? r.costPerAcre / r.yield : null
    const beYield = r.costPerAcre != null && beAvg != null && beAvg > 0 ? r.costPerAcre / beAvg : null
    t.line('Breakeven price ($/bu)', null, amt(bePrice, 'price'))
    t.line('Breakeven yield', beYield != null ? qty(beYield, 'yield', 'bu/ac') : null)

    sections.push({ title: r.cropName, columns: COLUMNS, rows: t.rows, rowMeta: t.rowMeta })
  }

  return {
    title: 'Marketing Dashboard',
    // The same line the screen's header shows, plus the futures contract each
    // crop's unpriced production is valued at.
    filters: [
      year != null ? cropYearLabel(year) : null,
      args.entityName ?? 'All Entities',
      args.referenceNote ? `Unpriced production valued at ${args.referenceNote}` : null,
    ].filter(Boolean).join(' · '),
    sections,
    singleSheet: true,
  }
}
