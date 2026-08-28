'use client'

// Buyer Discount Comparison — actual settlement discounts per buyer, the
// quality-adjusted per-point rates, uploaded discount schedules side by
// side, and the expected-vs-actual audit. Math lives in
// lib/buyer-comparison.ts and lib/discount-schedules.ts (unit-tested);
// this component assembles the data and renders/exports it.
//
// Scoping: settlements have no entity column — a settlement joins the entity
// world through its MATCHED loads (field → farm → entity, with the load's
// contract entity as fallback). Viewers (052) get exactly that scope over
// their granted entities; settlements whose matched loads all fall outside
// the grants drop out.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { computeBushels } from '@/lib/shrink'
import { formatNumber, type ExportPayload, type ExportSection } from '@/lib/exports'
import {
  buildBuyerActuals,
  buildQualityAdjusted,
  categoryGroup,
  costliestGroups,
  qualityVerdict,
  CATEGORY_GROUP_LABELS,
  type CategoryGroup,
  type ComparisonSettlement,
} from '@/lib/buyer-comparison'
import {
  expectedDiscountDollars,
  factorMeasurement,
  parseTiers,
  scheduleInForce,
  summarizeRule,
  varianceVerdict,
  type RuleBasis,
  type ScheduleRuleShape,
} from '@/lib/discount-schedules'
import { DISCOUNT_CATEGORY_LABELS, coerceDiscountCategory, type DiscountCategory } from '@/lib/settlement-discounts'
import { buildEntityScope } from '@/lib/entity-scope'
import { useViewerScope, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import {
  EmptyState,
  ReportFilterBar,
  SummaryCards,
  fmtInt,
  fmtNum,
  numCell,
  textCell,
  theadCls,
  toneText,
} from '@/components/reports/report-kit'
import type { Buyer, BuyerDiscountSchedule, BuyerDiscountScheduleRule, Crop, Entity, Farm, Field, LoadSplit } from '@/lib/types'

type SettlementRow = {
  id: string
  buyer_id: string
  settlement_date: string
  settlement_number: string | null
  settlement_lines: Array<{
    id: string
    load_id: string | null
    ticket_number: string | null
    net_bushels: number | string | null
    gross_revenue: number | string | null
    discounts: number | string | null
    net_revenue: number | string | null
    price_per_bushel: number | string | null
  }>
}

type LoadRow = {
  id: string
  to_buyer_id: string | null
  ticket_number: string | null
  crop_id: string | null
  crop_year: number | null
  contract_id: string | null
  moisture: number | string | null
  test_weight: number | string | null
  net_weight: number | string | null
  dry_bushels_override: number | string | null
  from_type: 'field' | 'bin' | null
  from_field_id: string | null
}

type ItemRow = { settlement_id: string; category: string; amount: number | string | null }
type ContractRow = { id: string; entity_id: string | null }

const N = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const N0 = (v: number | string | null | undefined): number => N(v) ?? 0

const fmtCents = (n: number | null | undefined, d = 1) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : `${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}¢`

const GROUP_ORDER: CategoryGroup[] = ['moistureDrying', 'testWeight', 'damage', 'fmDockage', 'other']

export default function BuyerDiscountsReport({
  onPayloadChange,
}: {
  onPayloadChange: (fn: () => ExportPayload) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const viewer = useViewerScope(supabase)

  const [loading, setLoading] = useState(true)
  const [settlementRows, setSettlementRows] = useState<SettlementRow[]>([])
  const [items, setItems] = useState<ItemRow[]>([])
  const [loads, setLoads] = useState<LoadRow[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [contracts, setContracts] = useState<ContractRow[]>([])
  const [schedules, setSchedules] = useState<BuyerDiscountSchedule[]>([])
  const [scheduleRules, setScheduleRules] = useState<BuyerDiscountScheduleRule[]>([])
  const [refreshKey, setRefreshKey] = useState(0)

  const [cropYear, setCropYear] = useState<number | ''>('')
  const [cropId, setCropId] = useState('')
  const [expandedBuyer, setExpandedBuyer] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const [sRes, iRes, lRes, bRes, cRes, eRes, fRes, fdRes, spRes, coRes, schRes, ruleRes] = await Promise.all([
        supabase.from('settlements').select('id, buyer_id, settlement_date, settlement_number, settlement_lines(id, load_id, ticket_number, net_bushels, gross_revenue, discounts, net_revenue, price_per_bushel)'),
        supabase.from('settlement_discount_items').select('settlement_id, category, amount'),
        supabase.from('loads').select('id, to_buyer_id, ticket_number, crop_id, crop_year, contract_id, moisture, test_weight, net_weight, dry_bushels_override, from_type, from_field_id').eq('to_type', 'buyer'),
        supabase.from('buyers').select('*').order('name'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('entities').select('*'),
        supabase.from('farms').select('*'),
        supabase.from('fields').select('*'),
        supabase.from('load_splits').select('*'),
        supabase.from('contracts').select('id, entity_id'),
        supabase.from('buyer_discount_schedules').select('*'),
        supabase.from('buyer_discount_schedule_rules').select('*'),
      ])
      if (cancelled) return
      setSettlementRows((sRes.data as unknown as SettlementRow[]) || [])
      setItems((iRes.data as ItemRow[]) || [])
      setLoads((lRes.data as unknown as LoadRow[]) || [])
      setBuyers((bRes.data as Buyer[]) || [])
      setCrops((cRes.data as Crop[]) || [])
      setEntities((eRes.data as Entity[]) || [])
      setFarms((fRes.data as Farm[]) || [])
      setFields((fdRes.data as Field[]) || [])
      setSplits((spRes.data as LoadSplit[]) || [])
      setContracts((coRes.data as ContractRow[]) || [])
      setSchedules((schRes.data as BuyerDiscountSchedule[]) || [])
      setScheduleRules((ruleRes.data as BuyerDiscountScheduleRule[]) || [])
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [supabase, refreshKey])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const buyerName = (id: string) => buyers.find((b) => b.id === id)?.name ?? '—'
  const loadById = useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads])

  // Unambiguous ticket → load per buyer (same rule as the Settlements pages).
  const buyerLoadsByTicket = useMemo(() => {
    const m = new Map<string, LoadRow[]>()
    for (const l of loads) {
      if (!l.to_buyer_id) continue
      const t = (l.ticket_number ?? '').trim().toLowerCase()
      if (!t) continue
      const key = `${l.to_buyer_id}|${t}`
      const arr = m.get(key)
      if (arr) arr.push(l); else m.set(key, [l])
    }
    return m
  }, [loads])

  // Viewer entity scope over the granted entities ('' = all of them). Owners
  // pass no grants and the scope is inactive (pure pass-through).
  const scope = useMemo(
    () => buildEntityScope({ entityId: '', farms, fields, entities, grantedEntityIds: viewer.grantedIds }),
    [farms, fields, entities, viewer.grantedIds],
  )
  const contractEntity = useMemo(() => new Map(contracts.map((c) => [c.id, c.entity_id])), [contracts])

  function loadInScope(l: LoadRow): boolean {
    if (!scope.active) return true
    const fieldIds: string[] = []
    const s = splits.filter((x) => x.load_id === l.id)
    if (s.length > 0) for (const x of s) fieldIds.push(x.field_id)
    else if (l.from_type === 'field' && l.from_field_id) fieldIds.push(l.from_field_id)
    if (fieldIds.some((id) => scope.fieldIds!.has(id))) return true
    if (l.contract_id) {
      const ent = contractEntity.get(l.contract_id)
      return ent != null && scope.selectedEntityIds!.has(ent)
    }
    return false
  }

  // ---- assemble ComparisonSettlement records, tagged by crop ----
  const assembled = useMemo(() => {
    const itemsBySettlement = new Map<string, Array<{ category: string; amount: number }>>()
    for (const i of items) {
      const arr = itemsBySettlement.get(i.settlement_id) ?? []
      arr.push({ category: i.category, amount: N0(i.amount) })
      itemsBySettlement.set(i.settlement_id, arr)
    }

    const out: Array<ComparisonSettlement & { cropId: string | null; cropYear: number | null }> = []
    for (const s of settlementRows) {
      const lines = s.settlement_lines ?? []
      // Resolve each line to a load: the saved FK, else its unambiguous ticket.
      const matched: Array<{ line: SettlementRow['settlement_lines'][number]; load: LoadRow }> = []
      for (const ln of lines) {
        let load: LoadRow | undefined
        if (ln.load_id) load = loadById.get(ln.load_id)
        else {
          const t = (ln.ticket_number ?? '').trim().toLowerCase()
          if (t) {
            const cands = buyerLoadsByTicket.get(`${s.buyer_id}|${t}`) ?? []
            if (cands.length === 1) load = cands[0]
          }
        }
        if (load) matched.push({ line: ln, load })
      }

      // Viewer scope: at least one matched load must be in scope.
      if (scope.active && !matched.some((m) => loadInScope(m.load))) continue

      // The settlement's crop and crop year: the matched loads' most common
      // value (a settlement covers one delivery stream in practice).
      const mode = <K,>(vals: Array<K | null>): K | null => {
        const counts = new Map<K, number>()
        for (const v of vals) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1)
        let best: K | null = null; let n = 0
        for (const [v, c] of counts) if (c > n) { n = c; best = v }
        return best
      }
      const sCropId = mode(matched.map((m) => m.load.crop_id))
      const sCropYear = mode(matched.map((m) => m.load.crop_year))

      out.push({
        id: s.id,
        buyerId: s.buyer_id,
        settlementDate: s.settlement_date,
        settlementNumber: s.settlement_number,
        settledBu: lines.reduce((t, l) => t + N0(l.net_bushels), 0),
        grossRevenue: lines.reduce((t, l) => t + N0(l.gross_revenue), 0),
        discountTotal: lines.reduce((t, l) => t + N0(l.discounts), 0),
        netRevenue: lines.reduce((t, l) => t + N0(l.net_revenue), 0),
        items: itemsBySettlement.get(s.id) ?? [],
        loads: matched.map(({ line, load }) => {
          const crop = load.crop_id ? cropById.get(load.crop_id) : undefined
          const { dryBushels } = computeBushels({
            netWeightLb: N(load.net_weight),
            moisturePct: N(load.moisture),
            baseMoisturePct: N(crop?.base_moisture_pct ?? null),
            baseLbPerBushel: N(crop?.base_lb_per_bushel ?? null),
            dryBushelsOverride: N(load.dry_bushels_override),
          })
          const bu = N0(line.net_bushels)
          return {
            bu,
            moisture: N(load.moisture),
            testWeight: N(load.test_weight),
            ourDryBu: dryBushels,
            pricePerBu: N(line.price_per_bushel) ?? (bu > 0 ? N0(line.net_revenue) / bu : null),
          }
        }),
        cropId: sCropId,
        cropYear: sCropYear,
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlementRows, items, loadById, buyerLoadsByTicket, cropById, scope, splits, contractEntity])

  // Crop-year options come from the settlements themselves; default = latest.
  const yearOptions = useMemo(() => {
    const ys = [...new Set(assembled.map((s) => s.cropYear).filter((y): y is number => y != null))]
    ys.sort((a, b) => b - a)
    return ys
  }, [assembled])
  useEffect(() => {
    if (cropYear === '' && yearOptions.length > 0) setCropYear(yearOptions[0])
  }, [yearOptions, cropYear])

  const inYear = useMemo(
    () => assembled.filter((s) => cropYear !== '' && s.cropYear === cropYear && (!cropId || s.cropId === cropId)),
    [assembled, cropYear, cropId],
  )
  const cropOptions = useMemo(() => {
    const ids = new Set(assembled.filter((s) => cropYear !== '' && s.cropYear === cropYear).map((s) => s.cropId))
    return crops.filter((c) => ids.has(c.id))
  }, [assembled, cropYear, crops])

  // Per-crop groups (the comparison only means anything within one crop).
  const byCrop = useMemo(() => {
    const m = new Map<string, Array<(typeof inYear)[number]>>()
    for (const s of inYear) {
      const key = s.cropId ?? '__none__'
      const arr = m.get(key)
      if (arr) arr.push(s); else m.set(key, [s])
    }
    return [...m.entries()].sort((a, b) => (cropById.get(a[0])?.name ?? 'z').localeCompare(cropById.get(b[0])?.name ?? 'z'))
  }, [inYear, cropById])

  // ---- schedules: parsed rules per schedule ----
  const rulesBySchedule = useMemo(() => {
    const m = new Map<string, ScheduleRuleShape[]>()
    for (const r of scheduleRules) {
      const shaped: ScheduleRuleShape = {
        factor: coerceDiscountCategory(r.factor),
        basis: (r.basis === 'weight_shrink_pct' || r.basis === 'pct_of_price' ? r.basis : 'cents_per_bu') as RuleBasis,
        base_value: N(r.base_value),
        direction: r.direction === 'below' ? 'below' : 'above',
        rate_per_unit: N(r.rate_per_unit),
        tiers: parseTiers(r.tiers),
        cumulative: r.cumulative === true,
        rejection_at: N(r.rejection_at),
        note: r.note,
      }
      const arr = m.get(r.schedule_id)
      if (arr) arr.push(shaped); else m.set(r.schedule_id, [shaped])
    }
    return m
  }, [scheduleRules])

  // The expected-vs-actual audit, per itemized settlement with a schedule in
  // force at its date. Compares the moisture/drying and test-weight buckets —
  // the factors our loads actually measure.
  type AuditRow = {
    settlement: (typeof inYear)[number]
    scheduleDate: string
    group: 'moistureDrying' | 'testWeight'
    expectedCents: number
    actualCents: number
    varianceCents: number
    flagged: boolean
  }
  const auditRows = useMemo(() => {
    const out: AuditRow[] = []
    for (const s of inYear) {
      if (s.items.length === 0 || s.cropId == null) continue
      const sched = scheduleInForce(schedules, s.buyerId, s.cropId, s.settlementDate)
      if (!sched) continue
      const rules = rulesBySchedule.get(sched.id) ?? []
      if (rules.length === 0) continue
      const matchedBu = s.loads.reduce((t, l) => t + l.bu, 0)
      if (!(matchedBu > 0)) continue
      const price = s.loads.reduce((t, l) => t + (l.pricePerBu ?? 0) * l.bu, 0) / matchedBu
      const expected = expectedDiscountDollars(rules, s.loads, price)
      const groups: Array<{ group: AuditRow['group']; factors: DiscountCategory[] }> = [
        { group: 'moistureDrying', factors: ['moisture_shrink', 'drying'] },
        { group: 'testWeight', factors: ['test_weight'] },
      ]
      for (const g of groups) {
        // Only audit a bucket the schedule actually prices.
        if (!rules.some((r) => g.factors.includes(r.factor) && factorMeasurement(r.factor) != null)) continue
        const expDollars = g.factors.reduce((t, f) => t + (expected.get(f) ?? 0), 0)
        const actDollars = s.items
          .filter((i) => categoryGroup(i.category) === g.group)
          .reduce((t, i) => t + i.amount, 0)
        const expectedCents = (expDollars / matchedBu) * 100
        const actualCents = (actDollars / matchedBu) * 100
        const v = varianceVerdict(expectedCents, actualCents)
        out.push({ settlement: s, scheduleDate: sched.effective_date, group: g.group, expectedCents, actualCents, ...v })
      }
    }
    out.sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.varianceCents - a.varianceCents)
    return out
  }, [inYear, schedules, rulesBySchedule])

  // Schedule side-by-side for the crop filter (or every crop with schedules):
  // per crop, the LATEST schedule per buyer, rules by factor across buyers.
  const scheduleComparison = useMemo(() => {
    const relevantCrops = cropId ? [cropId] : [...new Set(schedules.map((s) => s.crop_id))]
    const blocks: Array<{
      cropId: string
      buyers: Array<{ buyerId: string; effectiveDate: string; rules: ScheduleRuleShape[] }>
      factors: DiscountCategory[]
    }> = []
    for (const cid of relevantCrops) {
      const latestByBuyer = new Map<string, BuyerDiscountSchedule>()
      for (const s of schedules) {
        if (s.crop_id !== cid) continue
        const prev = latestByBuyer.get(s.buyer_id)
        if (!prev || s.effective_date > prev.effective_date) latestByBuyer.set(s.buyer_id, s)
      }
      if (latestByBuyer.size === 0) continue
      const buyerBlocks = [...latestByBuyer.values()]
        .map((s) => ({ buyerId: s.buyer_id, effectiveDate: s.effective_date, rules: rulesBySchedule.get(s.id) ?? [] }))
        .sort((a, b) => buyerName(a.buyerId).localeCompare(buyerName(b.buyerId)))
      const factors = [...new Set(buyerBlocks.flatMap((b) => b.rules.map((r) => r.factor)))]
      blocks.push({ cropId: cid, buyers: buyerBlocks, factors })
    }
    return blocks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedules, rulesBySchedule, cropId, buyers])

  // ---- summary + export ----
  const totalBu = inYear.reduce((t, s) => t + s.settledBu, 0)
  const totalDisc = inYear.reduce((t, s) => t + s.discountTotal, 0)
  const grantLabel = viewerAllEntitiesLabel(viewer, entities)

  function filterSummary(): string {
    const parts: string[] = []
    parts.push(cropYear !== '' ? `${cropYear} crop year` : 'No crop year')
    parts.push(cropId ? cropById.get(cropId)?.name ?? 'Crop' : 'All crops')
    parts.push(grantLabel ?? 'All entities')
    parts.push(`${inYear.length} settlement${inYear.length === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }

  const perCropActuals = useMemo(
    () => byCrop.map(([cid, group]) => ({ cropId: cid, rows: buildBuyerActuals(group) })),
    [byCrop],
  )
  const perCropQuality = useMemo(
    () => byCrop.map(([cid, group]) => {
      const crop = cropById.get(cid)
      return {
        cropId: cid,
        rows: buildQualityAdjusted(group, {
          baseMoisturePct: N(crop?.base_moisture_pct ?? null),
          baseLbPerBushel: N(crop?.base_lb_per_bushel ?? null),
        }),
      }
    }),
    [byCrop, cropById],
  )

  useEffect(() => {
    onPayloadChange(() => buildPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perCropActuals, perCropQuality, auditRows, scheduleComparison, cropYear, cropId])

  function buildPayload(): ExportPayload {
    const cropLabel = (cid: string) => cropById.get(cid)?.name ?? 'Unassigned crop'
    const actualsSection: ExportSection = {
      title: 'Actual discounts by buyer',
      columns: [
        { label: 'Crop' }, { label: 'Buyer' },
        { label: 'Settlements', align: 'right', format: 'int' },
        { label: 'Bushels', align: 'right', format: 'bu' },
        { label: 'Total disc ¢/bu', align: 'right', format: 'dec1' },
        ...GROUP_ORDER.map((g) => ({ label: `${CATEGORY_GROUP_LABELS[g]} ¢/bu`, align: 'right' as const, format: 'dec1' as const })),
        { label: 'Excess shrink ¢/bu', align: 'right', format: 'dec1' },
        { label: 'Gross $/bu', align: 'right', format: 'price' },
        { label: 'Net $/bu', align: 'right', format: 'price' },
        { label: 'Total cost ¢/bu', align: 'right', format: 'dec1' },
        { label: 'Rank', align: 'right', format: 'int' },
      ],
      rows: perCropActuals.flatMap(({ cropId: cid, rows }) =>
        rows.map((r) => [
          cropLabel(cid), buyerName(r.buyerId), r.settlements, r.settledBu,
          r.discountCentsPerBu,
          ...GROUP_ORDER.map((g) => r.groupCents[g]),
          r.excessShrinkCentsPerBu, r.grossPerBu, r.netPerBu, r.totalCostCentsPerBu, r.rank,
        ]),
      ),
    }
    const qualitySection: ExportSection = {
      title: 'Quality-adjusted rates',
      columns: [
        { label: 'Crop' }, { label: 'Buyer' },
        { label: 'Avg moisture %', align: 'right', format: 'dec1' },
        { label: 'Avg test wt lb', align: 'right', format: 'dec1' },
        { label: 'Moisture+drying ¢/point', align: 'right', format: 'dec1' },
        { label: 'Test weight ¢/lb light', align: 'right', format: 'dec1' },
        { label: 'Rated bu', align: 'right', format: 'bu' },
      ],
      rows: perCropQuality.flatMap(({ cropId: cid, rows }) =>
        rows.map((r) => [
          cropLabel(cid), buyerName(r.buyerId), r.avgMoisture, r.avgTestWeight,
          r.moistureCentsPerPoint, r.testWeightCentsPerLb, r.ratedBu,
        ]),
      ),
    }
    const scheduleSection: ExportSection = {
      title: 'Published schedules',
      columns: [
        { label: 'Crop' }, { label: 'Buyer' }, { label: 'Effective' }, { label: 'Factor' }, { label: 'Rule' },
      ],
      rows: scheduleComparison.flatMap((block) =>
        block.buyers.flatMap((b) =>
          b.rules.map((r) => [
            cropLabel(block.cropId), buyerName(b.buyerId), b.effectiveDate,
            DISCOUNT_CATEGORY_LABELS[r.factor], summarizeRule(r),
          ]),
        ),
      ),
    }
    const auditSection: ExportSection = {
      title: 'Expected vs actual',
      columns: [
        { label: 'Settlement' }, { label: 'Buyer' }, { label: 'Date' }, { label: 'Factor' },
        { label: 'Expected ¢/bu', align: 'right', format: 'dec1' },
        { label: 'Charged ¢/bu', align: 'right', format: 'dec1' },
        { label: 'Variance ¢/bu', align: 'right', format: 'dec1' },
        { label: 'Flag' },
      ],
      rows: auditRows.map((a) => [
        a.settlement.settlementNumber ?? a.settlement.id.slice(0, 8),
        buyerName(a.settlement.buyerId), a.settlement.settlementDate,
        a.group === 'moistureDrying' ? 'Moisture / drying' : 'Test weight',
        a.expectedCents, a.actualCents,
        { v: a.varianceCents, tone: a.flagged ? 'unfavorable' as const : undefined },
        a.flagged ? 'Above their schedule' : '',
      ]),
    }
    return {
      title: 'Buyer Discount Comparison',
      filters: filterSummary(),
      summary: [
        { label: 'Settlements', value: formatNumber(inYear.length, 'int') },
        { label: 'Bushels settled', value: formatNumber(totalBu, 'bu') },
        { label: 'Total discounts', value: formatNumber(totalDisc, 'usd0') },
        { label: 'Avg discount ¢/bu', value: totalBu > 0 ? fmtNum((totalDisc / totalBu) * 100, 1) : '—' },
      ],
      sections: [actualsSection, qualitySection, scheduleSection, auditSection].filter((s) => s.rows.length > 0),
    }
  }

  // ---- render ----
  if (loading || viewer.loading) {
    return <p className="text-sm text-slate-400">Loading…</p>
  }
  if (yearOptions.length === 0) {
    return (
      <EmptyState
        message="No settlements with matched loads yet."
        hint="This report compares buyers using your settlements — enter or upload them, and match their lines to loads."
        linkHref="/settlements"
        linkLabel="Go to Settlements"
      />
    )
  }

  return (
    <div className="space-y-4">
      <ReportFilterBar activeCount={(cropId ? 1 : 0)}>
        <label className="text-sm text-slate-600">
          Crop year
          <select
            value={cropYear}
            onChange={(e) => { setCropYear(Number(e.target.value)); setCropId('') }}
            className="block mt-0.5 rounded-lg border border-slate-300 px-3 py-2"
          >
            {yearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </label>
        <label className="text-sm text-slate-600">
          Crop
          <select
            value={cropId}
            onChange={(e) => setCropId(e.target.value)}
            className="block mt-0.5 rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">All crops</option>
            {cropOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </ReportFilterBar>

      <p className="text-sm text-slate-600 max-w-3xl">
        Same crop, same year, similar grain — so a systematic difference in what two buyers deduct is the buyer,
        not the grain. The quality-adjusted section below corrects for the grain you actually hauled each one.
        {grantLabel && <span className="text-slate-400"> Scope: {grantLabel}.</span>}
      </p>

      <SummaryCards cards={[
        { label: 'Settlements', value: fmtInt(inYear.length) },
        { label: 'Bushels settled', value: fmtInt(totalBu) },
        { label: 'Total discounts', value: `$${fmtInt(totalDisc)}` },
        { label: 'Avg discount ¢/bu', value: totalBu > 0 ? fmtCents((totalDisc / totalBu) * 100) : '—', tone: 'warning' },
      ]} />

      {inYear.length === 0 ? (
        <EmptyState
          message={`No settlements for the ${cropYear} crop year${cropId ? ` in ${cropById.get(cropId)?.name ?? 'that crop'}` : ''}.`}
          hint="Settlements join a crop year through their matched loads."
          linkHref="/settlements"
          linkLabel="Go to Settlements"
        />
      ) : (
        <>
          {/* ---- Actuals ---- */}
          {perCropActuals.map(({ cropId: cid, rows }) => (
            <div key={cid} className="space-y-1">
              <h2 className="font-semibold">
                Actual discounts — {cropById.get(cid)?.name ?? 'Unassigned crop'}
              </h2>
              <p className="text-xs text-slate-500">
                Ranked by total cost per bushel (price discounts + weight taken beyond standard shrink).
                The costliest itemized factor per buyer is highlighted.
              </p>
              <div className="overflow-x-auto bg-white rounded-xl shadow">
                <table className="min-w-full text-sm border-collapse">
                  <thead className={theadCls}>
                    <tr>
                      <th className={`${textCell} text-left font-semibold`}>Buyer</th>
                      <th className={`${numCell} font-semibold`}>Stmts</th>
                      <th className={`${numCell} font-semibold`}>Bushels</th>
                      <th className={`${numCell} font-semibold`}>Total disc ¢/bu</th>
                      {GROUP_ORDER.map((g) => (
                        <th key={g} className={`${numCell} font-semibold`}>{CATEGORY_GROUP_LABELS[g]}</th>
                      ))}
                      <th className={`${numCell} font-semibold`}>Excess shrink</th>
                      <th className={`${numCell} font-semibold`}>Gross → net $/bu</th>
                      <th className={`${numCell} font-semibold`}>Total cost ¢/bu</th>
                      <th className={`${numCell} font-semibold`}>Rank</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const hot = new Set(costliestGroups(r))
                      const group = byCrop.find(([k]) => k === cid)?.[1] ?? []
                      const mine = group.filter((s) => s.buyerId === r.buyerId)
                      const isOpen = expandedBuyer === `${cid}|${r.buyerId}`
                      return (
                        <BuyerRowGroup key={r.buyerId} open={isOpen}>
                          <tr
                            className="border-t border-slate-100 cursor-pointer hover:bg-slate-50"
                            onClick={() => setExpandedBuyer(isOpen ? null : `${cid}|${r.buyerId}`)}
                            title="Tap to see this buyer's settlements"
                          >
                            <td className={textCell}>
                              <span className="font-medium">{buyerName(r.buyerId)}</span>
                              <span className="text-slate-400 text-xs ml-1">{isOpen ? '▾' : '▸'}</span>
                              {r.itemizedCoverage < 0.95 && r.discountCentsPerBu > 0 && (
                                <span className="ml-1.5 text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5" title="Some of this buyer's settlements aren't itemized, so the per-category columns understate them">
                                  partly itemized
                                </span>
                              )}
                            </td>
                            <td className={numCell}>{fmtInt(r.settlements)}</td>
                            <td className={numCell}>{fmtInt(r.settledBu)}</td>
                            <td className={`${numCell} font-semibold`}>{fmtCents(r.discountCentsPerBu)}</td>
                            {GROUP_ORDER.map((g) => (
                              <td key={g} className={`${numCell} ${hot.has(g) ? 'text-amber-700 font-semibold' : r.groupCents[g] > 0 ? '' : 'text-slate-300'}`}>
                                {r.groupCents[g] > 0 ? fmtCents(r.groupCents[g]) : '—'}
                              </td>
                            ))}
                            <td className={`${numCell} ${r.excessShrinkCentsPerBu > 0.05 ? 'text-red-700 font-semibold' : r.excessShrinkCentsPerBu < -0.05 ? 'text-green-700' : 'text-slate-400'}`}>
                              {fmtCents(r.excessShrinkCentsPerBu)}
                            </td>
                            <td className={numCell}>${fmtNum(r.grossPerBu)} → ${fmtNum(r.netPerBu)}</td>
                            <td className={`${numCell} font-semibold ${r.rank === 1 ? 'text-green-700' : r.rank === rows.length && rows.length > 1 ? 'text-red-700' : ''}`}>
                              {fmtCents(r.totalCostCentsPerBu)}
                            </td>
                            <td className={numCell}>{r.rank}</td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-slate-50/70">
                              <td colSpan={13} className="px-4 py-2">
                                <div className="text-xs text-slate-500 mb-1">Settlements behind this row:</div>
                                <ul className="text-sm space-y-0.5">
                                  {mine.map((s) => (
                                    <li key={s.id}>
                                      <Link href={`/settlements/${s.id}`} className="text-brand-deep hover:underline">
                                        {s.settlementDate} · {s.settlementNumber ? `#${s.settlementNumber}` : 'no number'}
                                      </Link>
                                      <span className="text-slate-500">
                                        {' '}· {fmtInt(s.settledBu)} bu · discounts ${fmtNum(s.discountTotal)}
                                        {s.settledBu > 0 && <> ({fmtCents((s.discountTotal / s.settledBu) * 100)}/bu)</>}
                                        {s.items.length === 0 && <span className="text-slate-400"> · not itemized</span>}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </td>
                            </tr>
                          )}
                        </BuyerRowGroup>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {/* ---- Quality-adjusted ---- */}
          {perCropQuality.map(({ cropId: cid, rows }) => {
            const crop = cropById.get(cid)
            const withRates = rows.filter((r) => r.moistureCentsPerPoint != null || r.testWeightCentsPerLb != null)
            return (
              <div key={`q-${cid}`} className="space-y-1">
                <h2 className="font-semibold">Quality-adjusted — {crop?.name ?? 'Unassigned crop'}</h2>
                <p className="text-xs text-slate-500 max-w-3xl">
                  Raw averages can just mean you hauled wetter grain to one buyer. These rates divide each buyer&rsquo;s
                  itemized moisture/drying and test-weight charges by how far their grain actually ran over
                  {crop?.base_moisture_pct != null ? ` ${fmtNum(Number(crop.base_moisture_pct), 1)}% moisture` : ' base moisture'} or under
                  {crop?.base_lb_per_bushel != null ? ` ${fmtNum(Number(crop.base_lb_per_bushel), 0)} lb` : ' standard weight'} —
                  the charge per point, like for like. Each buyer&rsquo;s average grain is shown so you can judge comparability.
                </p>
                {withRates.length === 0 ? (
                  <p className="text-sm text-slate-400 bg-white rounded-xl shadow px-4 py-3">
                    Needs itemized settlements with matched loads carrying moisture or test-weight readings.
                  </p>
                ) : (
                  <>
                    <div className="overflow-x-auto bg-white rounded-xl shadow">
                      <table className="min-w-full text-sm border-collapse">
                        <thead className={theadCls}>
                          <tr>
                            <th className={`${textCell} text-left font-semibold`}>Buyer</th>
                            <th className={`${numCell} font-semibold`}>Avg moisture</th>
                            <th className={`${numCell} font-semibold`}>Avg test wt</th>
                            <th className={`${numCell} font-semibold`}>Moisture + drying ¢/point</th>
                            <th className={`${numCell} font-semibold`}>Test weight ¢/lb light</th>
                            <th className={`${numCell} font-semibold`}>Rated bu</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.buyerId} className="border-t border-slate-100">
                              <td className={textCell}>{buyerName(r.buyerId)}</td>
                              <td className={numCell}>{r.avgMoisture != null ? `${fmtNum(r.avgMoisture, 1)}%` : '—'}</td>
                              <td className={numCell}>{r.avgTestWeight != null ? `${fmtNum(r.avgTestWeight, 1)} lb` : '—'}</td>
                              <td className={numCell}>{fmtCents(r.moistureCentsPerPoint)}</td>
                              <td className={numCell}>{fmtCents(r.testWeightCentsPerLb)}</td>
                              <td className={numCell}>{fmtInt(r.ratedBu)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {(['moisture', 'testWeight'] as const).map((which) => {
                      const verdict = qualityVerdict(rows, buyerName, which)
                      return verdict ? (
                        <p key={which} className="text-sm text-slate-700 bg-white rounded-xl shadow px-4 py-2">
                          {verdict}
                        </p>
                      ) : null
                    })}
                  </>
                )}
              </div>
            )
          })}

          {/* ---- Published schedules ---- */}
          <div className="space-y-1">
            <h2 className="font-semibold">Published discount schedules</h2>
            <p className="text-xs text-slate-500 max-w-3xl">
              Each buyer&rsquo;s posted sheet, side by side per factor — the pre-season &ldquo;who&rsquo;s punitive on
              test weight this year&rdquo; view. Schedules carry effective dates; the audit below always uses the
              schedule in force at each settlement&rsquo;s date.
            </p>
            {scheduleComparison.length === 0 ? (
              <p className="text-sm text-slate-400 bg-white rounded-xl shadow px-4 py-3">
                No discount schedules uploaded yet — use &ldquo;Upload discount schedule (AI)&rdquo; below or on the Buyers settings page.
              </p>
            ) : scheduleComparison.map((block) => (
              <div key={block.cropId} className="overflow-x-auto bg-white rounded-xl shadow">
                <table className="min-w-full text-sm border-collapse">
                  <thead className={theadCls}>
                    <tr>
                      <th className={`${textCell} text-left font-semibold`}>{cropById.get(block.cropId)?.name ?? 'Crop'} — factor</th>
                      {block.buyers.map((b) => (
                        <th key={b.buyerId} className={`${textCell} text-left font-semibold`}>
                          {buyerName(b.buyerId)}
                          <span className="block text-[10px] font-normal text-slate-200">eff. {b.effectiveDate}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.factors.map((f) => (
                      <tr key={f} className="border-t border-slate-100">
                        <td className={`${textCell} font-medium whitespace-nowrap`}>{DISCOUNT_CATEGORY_LABELS[f]}</td>
                        {block.buyers.map((b) => {
                          const rule = b.rules.find((r) => r.factor === f)
                          return (
                            <td key={b.buyerId} className={`${textCell} ${rule ? 'text-slate-700' : 'text-slate-300'}`}>
                              {rule ? summarizeRule(rule) : '—'}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          {/* ---- Expected vs actual ---- */}
          <div className="space-y-1">
            <h2 className="font-semibold">Expected vs actual — charged above their own sheet?</h2>
            <p className="text-xs text-slate-500 max-w-3xl">
              For each itemized settlement with a schedule on file, the buyer&rsquo;s own rules are applied to the
              matched loads&rsquo; known moisture and test weight. A flag means the charge ran materially above what
              their published schedule predicts — worth a phone call.
            </p>
            {auditRows.length === 0 ? (
              <p className="text-sm text-slate-400 bg-white rounded-xl shadow px-4 py-3">
                Nothing to audit yet — it needs itemized settlements, matched loads with moisture/test weight, and an
                uploaded schedule in force at the settlement date.
              </p>
            ) : (
              <div className="overflow-x-auto bg-white rounded-xl shadow">
                <table className="min-w-full text-sm border-collapse">
                  <thead className={theadCls}>
                    <tr>
                      <th className={`${textCell} text-left font-semibold`}>Settlement</th>
                      <th className={`${textCell} text-left font-semibold`}>Buyer</th>
                      <th className={`${textCell} text-left font-semibold`}>Factor</th>
                      <th className={`${numCell} font-semibold`}>Expected ¢/bu</th>
                      <th className={`${numCell} font-semibold`}>Charged ¢/bu</th>
                      <th className={`${numCell} font-semibold`}>Variance</th>
                      <th className={`${textCell} text-left font-semibold`}>Schedule</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditRows.map((a, i) => (
                      <tr key={`${a.settlement.id}-${a.group}-${i}`} className={`border-t border-slate-100 ${a.flagged ? 'bg-red-50' : ''}`}>
                        <td className={textCell}>
                          <Link href={`/settlements/${a.settlement.id}`} className="text-brand-deep hover:underline">
                            {a.settlement.settlementDate} · {a.settlement.settlementNumber ? `#${a.settlement.settlementNumber}` : 'no number'}
                          </Link>
                        </td>
                        <td className={textCell}>{buyerName(a.settlement.buyerId)}</td>
                        <td className={textCell}>{a.group === 'moistureDrying' ? 'Moisture / drying' : 'Test weight'}</td>
                        <td className={numCell}>{fmtCents(a.expectedCents)}</td>
                        <td className={numCell}>{fmtCents(a.actualCents)}</td>
                        <td className={`${numCell} ${a.flagged ? toneText('unfavorable') + ' font-semibold' : a.varianceCents < 0 ? toneText('favorable') : ''}`}>
                          {a.varianceCents >= 0 ? '+' : ''}{fmtCents(a.varianceCents)}
                        </td>
                        <td className={`${textCell} text-xs text-slate-500`}>eff. {a.scheduleDate}{a.flagged && <span className="ml-1.5 rounded-full bg-red-100 text-red-700 px-2 py-0.5 text-[10px] font-semibold uppercase">above schedule</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <p className="text-xs text-slate-400 max-w-3xl">
        Settlements join a crop and year through their matched loads; unmatched settlements don&rsquo;t appear here.
        Per-category columns come from itemized discounts — settlements without itemization count in the totals but
        can&rsquo;t be broken out (open one and add its discount lines to complete the picture).
      </p>
    </div>
  )
}

// Wrapper so the buyer row + its expansion render as siblings inside <tbody>.
function BuyerRowGroup({ children }: { children: React.ReactNode; open: boolean }) {
  return <>{children}</>
}
