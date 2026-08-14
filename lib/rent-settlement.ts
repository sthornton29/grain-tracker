// Rent Settlement — the pure lease-terms math. Given the structured lease
// (lease_terms row), the account's production for the lease's farms, and the
// operator's answers to the GAP INTERVIEW, compose an itemized landowner
// settlement statement.
//
// Design rules:
//   * every figure carries its SOURCE — 'account' (computed from Turnrow
//     data), 'entered' (typed in the gap interview), or 'reference' (a
//     confirmed outside price) — and the statement prints it;
//   * the settlement NEVER generates with unresolved gaps: anything the
//     lease requires that neither the account nor a reference supplies is a
//     named, labeled input (detectGaps), and buildSettlement refuses until
//     every gap has a value;
//   * no invented numbers: a reference price is always a gap (confirm the
//     figure), an operator-marketed crop with no settled sales is a gap,
//     a shared expense is always a gap (Turnrow doesn't itemize drying/
//     hauling costs today).
//
// The landowner-share bushels here reconcile with the Share Rent report:
// when the lease share % equals the farm's landlord_share_percentage, the
// share bushels equal that report's landlord bushels for the same farms
// (both apply pct × splits-aware dry bushels) — pinned in the tests.

export type LeaseType = 'crop_share' | 'cash' | 'flex'
export type ExpenseCategory = 'drying' | 'hauling' | 'inputs' | 'storage' | 'other'
export type PricingMethodKind = 'landowner_sells_own' | 'operator_actual' | 'reference'

export type LeaseTermsShape = {
  leaseType: LeaseType
  /** Landowner's share % of production; byCrop overrides defaultPct. */
  shareTerms: { defaultPct: number | null; byCrop: Record<string, number> } | null
  /** Shared expenses: the landowner pays landownerPct% of the entered total. */
  expenseTerms: Array<{ category: ExpenseCategory; landownerPct: number; note?: string | null }> | null
  pricingMethod: { method: PricingMethodKind; reference?: { description: string } | null } | null
  /** Cash / flex-base rent. */
  cashTerms: { perAcre: number | null; totalAnnual: number | null } | null
  /** Flex/bonus clauses — amounts come from the gap interview. */
  flexTerms: Array<{ description: string }> | null
  paymentTiming: string | null
}

/** Tolerant jsonb → typed shape (DB rows may carry partial AI extractions). */
export function parseLeaseTerms(row: {
  lease_type: string
  share_terms?: unknown
  expense_terms?: unknown
  pricing_method?: unknown
  cash_terms?: unknown
  flex_terms?: unknown
  payment_timing?: string | null
}): LeaseTermsShape {
  const obj = (v: unknown): Record<string, unknown> | null =>
    v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const st = obj(row.share_terms)
  const byCrop: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj(st?.byCrop) ?? {})) {
    const pct = n(v)
    if (pct != null) byCrop[k] = pct
  }
  const pm = obj(row.pricing_method)
  const method = pm?.method
  const ct = obj(row.cash_terms)
  const CATS: ExpenseCategory[] = ['drying', 'hauling', 'inputs', 'storage', 'other']
  return {
    leaseType: row.lease_type === 'cash' || row.lease_type === 'flex' ? row.lease_type : 'crop_share',
    shareTerms: st ? { defaultPct: n(st.defaultPct), byCrop } : null,
    expenseTerms: arr(row.expense_terms)
      .map((e) => obj(e))
      .filter((e): e is Record<string, unknown> => e != null)
      .map((e) => ({
        category: CATS.includes(e.category as ExpenseCategory) ? (e.category as ExpenseCategory) : 'other',
        landownerPct: n(e.landownerPct) ?? 0,
        note: typeof e.note === 'string' ? e.note : null,
      }))
      .filter((e) => e.landownerPct > 0),
    pricingMethod:
      method === 'landowner_sells_own' || method === 'operator_actual' || method === 'reference'
        ? {
            method,
            reference: obj(pm?.reference) && typeof obj(pm?.reference)?.description === 'string'
              ? { description: String(obj(pm?.reference)!.description) }
              : null,
          }
        : null,
    cashTerms: ct ? { perAcre: n(ct.perAcre), totalAnnual: n(ct.totalAnnual) } : null,
    flexTerms: arr(row.flex_terms)
      .map((f) => obj(f))
      .filter((f): f is Record<string, unknown> => f != null && typeof f.description === 'string')
      .map((f) => ({ description: String(f.description) })),
    paymentTiming: row.payment_timing ?? null,
  }
}

export type CropProductionInput = {
  cropName: string
  /** Total dry bushels produced on the lease's farms (splits-aware). */
  totalBu: number
  acres: number
  /** Weighted avg $/bu from settlement lines where the operator marketed —
   *  null when no settled sales exist for the crop on those farms. */
  actualPricePerBu: number | null
}

export type SettlementGap = {
  key: string
  label: string
  kind: 'price' | 'expense' | 'flex' | 'cash'
  cropName?: string
}

export function sharePctFor(terms: LeaseTermsShape, cropName: string): number | null {
  const st = terms.shareTerms
  if (!st) return null
  const exact = Object.entries(st.byCrop).find(([k]) => k.trim().toLowerCase() === cropName.trim().toLowerCase())
  return exact ? exact[1] : st.defaultPct
}

const usesShares = (terms: LeaseTermsShape) =>
  terms.leaseType === 'crop_share' || (terms.leaseType === 'flex' && terms.shareTerms != null)

/** Everything the lease requires that neither the account nor a reference
 *  price supplies — each becomes one labeled input; the settlement will not
 *  generate while any remain unanswered. */
export function detectGaps(args: {
  terms: LeaseTermsShape
  production: CropProductionInput[]
  totalAcres: number
}): SettlementGap[] {
  const { terms, production, totalAcres } = args
  const gaps: SettlementGap[] = []
  const sharedCrops = usesShares(terms)
    ? production.filter((p) => p.totalBu > 0 && (sharePctFor(terms, p.cropName) ?? 0) > 0)
    : []
  const method = terms.pricingMethod?.method ?? 'operator_actual'
  for (const p of sharedCrops) {
    if (method === 'landowner_sells_own') continue // bushels-only lines, no price
    if (method === 'reference') {
      const ref = terms.pricingMethod?.reference?.description ?? 'the lease’s reference price'
      gaps.push({ key: `price|${p.cropName}`, kind: 'price', cropName: p.cropName, label: `Confirm the price used for ${p.cropName} ($/bu): ${ref}` })
    } else if (p.actualPricePerBu == null) {
      gaps.push({ key: `price|${p.cropName}`, kind: 'price', cropName: p.cropName, label: `No settled sales found for ${p.cropName} on these farms — enter the price used ($/bu)` })
    }
  }
  for (const e of terms.expenseTerms ?? []) {
    for (const p of sharedCrops) {
      gaps.push({
        key: `expense|${e.category}|${p.cropName}`,
        kind: 'expense',
        cropName: p.cropName,
        label: `Lease splits ${e.category} ${e.landownerPct}/${100 - e.landownerPct} — enter TOTAL ${e.category} cost for ${p.cropName} ($)`,
      })
    }
  }
  ;(terms.flexTerms ?? []).forEach((f, i) => {
    gaps.push({ key: `flex|${i}`, kind: 'flex', label: `Flex/bonus adjustment ($, + to landowner / − from landowner): ${f.description}` })
  })
  if (terms.leaseType === 'cash' || terms.leaseType === 'flex') {
    const ct = terms.cashTerms
    if (!ct || (ct.perAcre == null && ct.totalAnnual == null)) {
      gaps.push({ key: 'cash|amount', kind: 'cash', label: 'Enter the cash rent amount for the year ($)' })
    } else if (ct.perAcre != null && ct.totalAnnual == null && totalAcres <= 0) {
      gaps.push({ key: 'cash|amount', kind: 'cash', label: `Lease says $${ct.perAcre}/acre but no acres are on file for these farms — enter the total cash rent ($)` })
    }
  }
  return gaps
}

export type SettlementSource = 'account' | 'entered' | 'reference'
export type SettlementLine = {
  label: string
  quantityBu: number | null
  pricePerBu: number | null
  amount: number | null // null = informational (bushels-only) line
  source: SettlementSource
}
export type SettlementSection = { title: string; lines: SettlementLine[]; subtotal: number }
export type SettlementStatement = {
  landownerName: string
  cropYear: number
  leaseType: LeaseType
  sections: SettlementSection[]
  totalDue: number
  paymentTiming: string | null
  generatedAt: string
  bushelsOnly: boolean
}

const r2 = (v: number) => Math.round(v * 100) / 100

const SOURCE_LABEL: Record<SettlementSource, string> = {
  account: 'From farm records',
  entered: 'Entered at settlement',
  reference: 'Reference price (confirmed)',
}

/** The statement as an ExportPayload — the caller attaches `branding` (org
 *  mode) before handing it to exportToPdf/exportToExcel, so the document
 *  renders under the FARM'S identity with zero Turnrow marks. */
export function settlementExportPayload(args: {
  statement: SettlementStatement
  landownerAddress?: string | null
}): import('@/lib/exports').ExportPayload {
  const s = args.statement
  const columns: import('@/lib/exports').ExportColumn[] = [
    { label: 'Item', width: 52 },
    { label: 'Bushels', align: 'right', format: 'bu' },
    { label: '$/bu', align: 'right', format: 'price' },
    { label: 'Amount', align: 'right', format: 'usd2' },
    { label: 'Source' },
  ]
  const sections: import('@/lib/exports').ExportSection[] = s.sections.map((sec) => ({
    title: sec.title,
    columns,
    rows: [
      ...sec.lines.map((l): import('@/lib/exports').ExportCell[] => [
        l.label,
        l.quantityBu ?? '',
        l.pricePerBu ?? '',
        l.amount ?? '',
        SOURCE_LABEL[l.source],
      ]),
      ['Subtotal', '', '', sec.subtotal, ''],
    ],
    rowMeta: [...sec.lines.map(() => 'data' as const), 'subtotal' as const],
  }))
  sections.push({
    title: s.bushelsOnly ? 'Summary' : 'Amount due',
    columns,
    rows: [[
      s.bushelsOnly ? 'Landowner markets own grain — bushels shown above; expense/adjustment balance:' : `Total due to ${s.landownerName}`,
      '', '', s.totalDue, '',
    ]],
    rowMeta: ['total'],
  })
  sections.push({
    title: 'Acknowledgment',
    columns: [{ label: '', width: 40 }, { label: '', width: 40 }],
    rows: [
      [s.paymentTiming ? `Payment terms: ${s.paymentTiming}` : 'Payment terms: per lease', ''],
      ['', ''],
      ['Landowner signature: ______________________________', 'Date: ______________'],
      ['Operator signature:  ______________________________', 'Date: ______________'],
      ['Notes:', ''],
    ],
  })
  const slugName = s.landownerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return {
    title: `Rent Settlement — ${s.cropYear} Crop Year`,
    filters: `Prepared for ${s.landownerName}${args.landownerAddress ? ` · ${args.landownerAddress.replace(/\n/g, ', ')}` : ''}`,
    summary: [
      { label: 'Landowner', value: s.landownerName },
      { label: 'Crop year', value: String(s.cropYear) },
      { label: s.bushelsOnly ? 'Balance' : 'Total due', value: `$${s.totalDue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
    ],
    sections,
    filename: `rent-settlement-${slugName}-${s.cropYear}`,
    singleSheet: true,
    orientation: 'portrait',
  }
}

export type BuildResult = { ok: true; statement: SettlementStatement } | { ok: false; gaps: SettlementGap[] }

export function buildSettlement(args: {
  terms: LeaseTermsShape
  production: CropProductionInput[]
  totalAcres: number
  gapValues: Record<string, number>
  cropYear: number
  landownerName: string
  generatedAt: string
}): BuildResult {
  const { terms, production, totalAcres, gapValues, cropYear, landownerName, generatedAt } = args
  const unresolved = detectGaps({ terms, production, totalAcres }).filter((g) => {
    const v = gapValues[g.key]
    return v == null || !Number.isFinite(v)
  })
  if (unresolved.length > 0) return { ok: false, gaps: unresolved }

  const sections: SettlementSection[] = []
  const method = terms.pricingMethod?.method ?? 'operator_actual'
  const bushelsOnly = usesShares(terms) && method === 'landowner_sells_own'

  if (usesShares(terms)) {
    for (const p of production) {
      const pct = sharePctFor(terms, p.cropName)
      if (p.totalBu <= 0 || pct == null || pct <= 0) continue
      const shareBu = r2((p.totalBu * pct) / 100)
      const lines: SettlementLine[] = []
      if (method === 'landowner_sells_own') {
        lines.push({
          label: `Landowner share — ${pct}% of ${r2(p.totalBu).toLocaleString()} bu (landowner markets own grain)`,
          quantityBu: shareBu, pricePerBu: null, amount: null, source: 'account',
        })
      } else {
        const entered = gapValues[`price|${p.cropName}`]
        const price = method === 'reference' ? entered : entered ?? p.actualPricePerBu!
        const priceSource: SettlementSource =
          method === 'reference' ? 'reference' : gapValues[`price|${p.cropName}`] != null ? 'entered' : 'account'
        lines.push({
          label: `Landowner share — ${pct}% of ${r2(p.totalBu).toLocaleString()} bu @ $${r2(price).toFixed(2)}/bu`,
          quantityBu: shareBu, pricePerBu: r2(price), amount: r2(shareBu * price), source: priceSource,
        })
      }
      for (const e of terms.expenseTerms ?? []) {
        const total = gapValues[`expense|${e.category}|${p.cropName}`] ?? 0
        if (total === 0) continue
        const share = r2((total * e.landownerPct) / 100)
        lines.push({
          label: `Less: ${e.category} — landowner ${e.landownerPct}% of $${r2(total).toLocaleString()}`,
          quantityBu: null, pricePerBu: null, amount: -share, source: 'entered',
        })
      }
      sections.push({ title: `${p.cropName} — ${cropYear}`, lines, subtotal: r2(lines.reduce((s, l) => s + (l.amount ?? 0), 0)) })
    }
  }

  if (terms.leaseType === 'cash' || terms.leaseType === 'flex') {
    const ct = terms.cashTerms
    const entered = gapValues['cash|amount']
    let amount: number
    let label: string
    let source: SettlementSource
    if (entered != null) {
      amount = entered; label = 'Cash rent (entered)'; source = 'entered'
    } else if (ct?.totalAnnual != null) {
      amount = ct.totalAnnual; label = 'Cash rent — annual amount per lease'; source = 'account'
    } else {
      amount = (ct?.perAcre ?? 0) * totalAcres
      label = `Cash rent — ${r2(totalAcres).toLocaleString()} acres @ $${r2(ct?.perAcre ?? 0).toFixed(2)}/acre`
      source = 'account'
    }
    sections.push({ title: 'Cash rent', lines: [{ label, quantityBu: null, pricePerBu: null, amount: r2(amount), source }], subtotal: r2(amount) })
  }

  const flexLines: SettlementLine[] = (terms.flexTerms ?? []).map((f, i): SettlementLine => ({
    label: f.description,
    quantityBu: null, pricePerBu: null,
    amount: r2(gapValues[`flex|${i}`] ?? 0),
    source: 'entered',
  })).filter((l) => l.amount !== 0)
  if (flexLines.length > 0) {
    sections.push({ title: 'Flex / bonus adjustments', lines: flexLines, subtotal: r2(flexLines.reduce((s, l) => s + (l.amount ?? 0), 0)) })
  }

  const totalDue = r2(sections.reduce((s, sec) => s + sec.subtotal, 0))
  return {
    ok: true,
    statement: { landownerName, cropYear, leaseType: terms.leaseType, sections, totalDue, paymentTiming: terms.paymentTiming, generatedAt, bushelsOnly },
  }
}
