'use client'

// Buyer Discount Comparison — rebuilt around ONE unified measure: total
// LOST REVENUE from discounting, in ¢/bu, by buyer × crop × crop year.
// Buyers discount inconsistently (price cuts, volume cuts, both), so every
// mechanism is normalized to dollars lost (lib/lost-revenue.ts):
//   * price-type — itemized settlement_discount_items dollars, by category;
//   * volume-type — pay-bushels below FSA-standard dry bushels, valued at
//     the settlement's own prices (categorized by the statement's weight
//     itemization where present, else "Weight deduction").
// LEAD METRIC: lost ¢ per CONTRACTED bushel (settlements link to contracts
// through their matched loads; weighted across the buyer's contracts).
// Companion: lost ¢ per settled bushel — also the fallback for spot/
// unlinked settlements. Secondary detail: the quality-adjusted per-point
// rates (lib/buyer-comparison.ts). Schedules + the expected-vs-actual audit
// read from the schedules attached to buyers (Settings → Buyers).
//
// Scoping: settlements join the entity world through their MATCHED loads
// (field → farm → entity, contract-entity fallback); viewers (052) get
// exactly that scope over their granted entities.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import { formatNumber, type ExportPayload, type ExportSection } from '@/lib/exports'
import {
  buildQualityAdjusted,
  categoryGroup,
  qualityVerdict,
  type ComparisonSettlement,
} from '@/lib/buyer-comparison'
import {
  buildLostRevenueRows,
  costliestLostGroups,
  LOST_GROUP_LABELS,
  LOST_GROUP_ORDER,
  type ContractInfo,
  type LostGroup,
} from '@/lib/lost-revenue'
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
import { DISCOUNT_CATEGORY_LABELS, coerceDeductionKind, coerceDiscountCategory, type DiscountCategory } from '@/lib/settlement-discounts'
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

type ItemRow = { settlement_id: string; category: string; amount: number | string | null; deduction_kind?: string | null }
type ContractRow = { id: string; entity_id: string | null; contract_number: string | null; contracted_bushels: number | string | null }

// The report's working settlement: the comparison shape + contract linkage.
type WorkingSettlement = ComparisonSettlement & { cropId: string | null; cropYear: number | null; contractId: string | null }

const N = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const N0 = (v: number | string | null | undefined): number => N(v) ?? 0

const fmtCents = (n: number | null | undefined, d = 1) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : `${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}¢`

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

  const [cropYear, setCropYear] = useState<number | ''>('')
  const [cropId, setCropId] = useState('')
  const [expandedBuyer, setExpandedBuyer] = useState<string | null>(null)
  const [showQuality, setShowQuality] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const [sRes, iRes, lRes, bRes, cRes, eRes, fRes, fdRes, spRes, coRes, schRes, ruleRes] = await Promise.all([
        supabase.from('settlements').select('id, buyer_id, settlement_date, settlement_number, settlement_lines(id, load_id, ticket_number, net_bushels, gross_revenue, discounts, net_revenue, price_per_bushel)'),
        supabase.from('settlement_discount_items').select('*'),
        fetchAllRows((f, t) => supabase.from('loads').select('id, to_buyer_id, ticket_number, crop_id, crop_year, contract_id, moisture, test_weight, net_weight, dry_bushels_override, from_type, from_field_id').eq('to_type', 'buyer').order('id').range(f, t)),
        supabase.from('buyers').select('*').order('name'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('entities').select('*'),
        supabase.from('farms').select('*'),
        supabase.from('fields').select('*'),
        fetchAllRows((f, t) => supabase.from('load_splits').select('*').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('contracts').select('id, entity_id, contract_number, contracted_bushels').order('id').range(f, t)),
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
      setContracts((coRes.data as unknown as ContractRow[]) || [])
      setSchedules((schRes.data as BuyerDiscountSchedule[]) || [])
      setScheduleRules((ruleRes.data as BuyerDiscountScheduleRule[]) || [])
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [supabase])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const buyerName = (id: string) => buyers.find((b) => b.id === id)?.name ?? '—'
  const loadById = useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads])
  const contractsById = useMemo(
    () => new Map<string, ContractInfo>(contracts.map((c) => [c.id, { id: c.id, number: c.contract_number, bushels: N0(c.contracted_bushels) }])),
    [contracts],
  )

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

  // Viewer entity scope over the granted entities ('' = all of them).
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

  // ---- assemble working settlements, tagged by crop/year/contract ----
  const assembled = useMemo(() => {
    const itemsBySettlement = new Map<string, Array<{ category: string; amount: number; deduction_kind?: string | null }>>()
    for (const i of items) {
      const arr = itemsBySettlement.get(i.settlement_id) ?? []
      arr.push({ category: i.category, amount: N0(i.amount), deduction_kind: coerceDeductionKind(i.deduction_kind) })
      itemsBySettlement.set(i.settlement_id, arr)
    }

    const out: WorkingSettlement[] = []
    for (const s of settlementRows) {
      const lines = s.settlement_lines ?? []
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

      if (scope.active && !matched.some((m) => loadInScope(m.load))) continue

      const mode = <K,>(vals: Array<K | null>): K | null => {
        const counts = new Map<K, number>()
        for (const v of vals) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1)
        let best: K | null = null; let n = 0
        for (const [v, c] of counts) if (c > n) { n = c; best = v }
        return best
      }

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
        cropId: mode(matched.map((m) => m.load.crop_id)),
        cropYear: mode(matched.map((m) => m.load.crop_year)),
        contractId: mode(matched.map((m) => m.load.contract_id)),
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlementRows, items, loadById, buyerLoadsByTicket, cropById, scope, splits, contractEntity])

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

  const byCrop = useMemo(() => {
    const m = new Map<string, WorkingSettlement[]>()
    for (const s of inYear) {
      const key = s.cropId ?? '__none__'
      const arr = m.get(key)
      if (arr) arr.push(s); else m.set(key, [s])
    }
    return [...m.entries()].sort((a, b) => (cropById.get(a[0])?.name ?? 'z').localeCompare(cropById.get(b[0])?.name ?? 'z'))
  }, [inYear, cropById])

  // ---- the lead view: lost revenue per contracted bushel ----
  const perCropLost = useMemo(
    () => byCrop.map(([cid, group]) => ({ cropId: cid, rows: buildLostRevenueRows(group, contractsById) })),
    [byCrop, contractsById],
  )
  // Settlements by id for the drill-down (rows carry LostRevenueSettlement).
  const settlementById = useMemo(() => new Map(inYear.map((s) => [s.id, s])), [inYear])

  // ---- secondary detail: quality-adjusted per-point rates ----
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

  type AuditRow = {
    settlement: WorkingSettlement
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
        if (!rules.some((r) => g.factors.includes(r.factor) && factorMeasurement(r.factor) != null)) continue
        const expDollars = g.factors.reduce((t, f) => t + (expected.get(f) ?? 0), 0)
        const actDollars = s.items
          .filter((i) => coerceDeductionKind(i.deduction_kind) === 'price' && categoryGroup(i.category) === g.group)
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
  const totalSettledBu = inYear.reduce((t, s) => t + s.settledBu, 0)
  const totalLost = perCropLost.reduce((t, g) => t + g.rows.reduce((u, r) => u + r.totalLostDollars, 0), 0)
  const grantLabel = viewerAllEntitiesLabel(viewer, entities)

  function filterSummary(): string {
    const parts: string[] = []
    parts.push(cropYear !== '' ? `${cropYear} crop year` : 'No crop year')
    parts.push(cropId ? cropById.get(cropId)?.name ?? 'Crop' : 'All crops')
    parts.push(grantLabel ?? 'All entities')
    parts.push(`${inYear.length} settlement${inYear.length === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }

  useEffect(() => {
    onPayloadChange(() => buildPayload())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perCropLost, perCropQuality, auditRows, scheduleComparison, cropYear, cropId])

  function buildPayload(): ExportPayload {
    const cropLabel = (cid: string) => cropById.get(cid)?.name ?? 'Unassigned crop'
    const lostSection: ExportSection = {
      title: 'Lost revenue by buyer',
      columns: [
        { label: 'Crop' }, { label: 'Buyer' },
        { label: 'Settlements', align: 'right', format: 'int' },
        { label: 'Settled bu', align: 'right', format: 'bu' },
        { label: 'Contracted bu', align: 'right', format: 'bu' },
        { label: 'Lost ¢/contracted bu', align: 'right', format: 'dec1' },
        { label: 'Lost ¢/settled bu', align: 'right', format: 'dec1' },
        ...LOST_GROUP_ORDER.map((g) => ({ label: `${LOST_GROUP_LABELS[g]} ¢/bu`, align: 'right' as const, format: 'dec1' as const })),
        { label: 'Total lost $', align: 'right', format: 'usd0' },
        { label: 'Rank', align: 'right', format: 'int' },
      ],
      rows: perCropLost.flatMap(({ cropId: cid, rows }) =>
        rows.map((r) => [
          cropLabel(cid),
          r.spotOnly ? `${buyerName(r.buyerId)} (spot/unlinked)` : buyerName(r.buyerId),
          r.settlements, r.settledBu, r.contractedBu > 0 ? r.contractedBu : null,
          r.leadCentsPerContractedBu, r.centsPerSettledBu,
          ...LOST_GROUP_ORDER.map((g) => r.groupCents[g]),
          r.totalLostDollars, r.rank,
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
        { label: 'Bushels settled', value: formatNumber(totalSettledBu, 'bu') },
        { label: 'Total lost revenue', value: formatNumber(totalLost, 'usd0') },
        { label: 'Avg lost ¢/settled bu', value: totalSettledBu > 0 ? fmtNum((totalLost / totalSettledBu) * 100, 1) : '—' },
      ],
      sections: [lostSection, qualitySection, scheduleSection, auditSection].filter((s) => s.rows.length > 0),
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
        Same crop, same year, similar grain — so a systematic difference in what two buyers take is the buyer, not the
        grain. Every mechanism is normalized to <span className="font-medium">lost revenue</span>: price discounts in
        dollars off the check, plus pay-bushels taken beyond FSA-standard shrink valued at that settlement&rsquo;s own
        price. The lead figure is lost ¢ per <span className="font-medium">contracted</span> bushel.
        {grantLabel && <span className="text-slate-400"> Scope: {grantLabel}.</span>}
      </p>

      <SummaryCards cards={[
        { label: 'Settlements', value: fmtInt(inYear.length) },
        { label: 'Bushels settled', value: fmtInt(totalSettledBu) },
        { label: 'Total lost revenue', value: `$${fmtInt(totalLost)}`, tone: 'unfavorable' },
        { label: 'Avg lost ¢/settled bu', value: totalSettledBu > 0 ? fmtCents((totalLost / totalSettledBu) * 100) : '—', tone: 'warning' },
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
          {/* ---- Lost revenue (lead view) ---- */}
          {perCropLost.map(({ cropId: cid, rows }) => (
            <div key={cid} className="space-y-1">
              <h2 className="font-semibold">
                Lost revenue — {cropById.get(cid)?.name ?? 'Unassigned crop'}
              </h2>
              <p className="text-xs text-slate-500 max-w-3xl">
                Ranked on lost ¢ per contracted bushel (rank 1 = cheapest buyer). Rows marked spot/unlinked have no
                contract behind their settlements and rank on the settled-bushel figure. The costliest category per
                buyer is highlighted. Tap a buyer to open its contracts and settlements.
              </p>
              <div className="overflow-x-auto bg-white rounded-xl shadow">
                <table className="min-w-full text-sm border-collapse">
                  <thead className={theadCls}>
                    <tr>
                      <th className={`${textCell} text-left font-semibold`}>Buyer</th>
                      <th className={`${numCell} font-semibold`}>Stmts</th>
                      <th className={`${numCell} font-semibold`}>Settled bu</th>
                      <th className={`${numCell} font-semibold`}>Contracted bu</th>
                      <th className={`${numCell} font-semibold`}>Lost ¢/contracted bu</th>
                      <th className={`${numCell} font-semibold`}>Lost ¢/settled bu</th>
                      {LOST_GROUP_ORDER.map((g) => (
                        <th key={g} className={`${numCell} font-semibold`}>{LOST_GROUP_LABELS[g]}</th>
                      ))}
                      <th className={`${numCell} font-semibold`}>Rank</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const hot = new Set<LostGroup>(costliestLostGroups(r))
                      const isOpen = expandedBuyer === `${cid}|${r.buyerId}`
                      return (
                        <RowGroup key={r.buyerId}>
                          <tr
                            className="border-t border-slate-100 cursor-pointer hover:bg-slate-50"
                            onClick={() => setExpandedBuyer(isOpen ? null : `${cid}|${r.buyerId}`)}
                            title="Tap to see this buyer's contracts and settlements"
                          >
                            <td className={textCell}>
                              <span className="font-medium">{buyerName(r.buyerId)}</span>
                              <span className="text-slate-400 text-xs ml-1">{isOpen ? '▾' : '▸'}</span>
                              {r.spotOnly && (
                                <span className="ml-1.5 text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5" title="No contract linked to these settlements — the lead figure falls back to lost ¢ per settled bushel">
                                  spot/unlinked
                                </span>
                              )}
                            </td>
                            <td className={numCell}>{fmtInt(r.settlements)}</td>
                            <td className={numCell}>{fmtInt(r.settledBu)}</td>
                            <td className={numCell}>{r.contractedBu > 0 ? fmtInt(r.contractedBu) : <span className="text-slate-300">—</span>}</td>
                            <td className={`${numCell} font-semibold ${r.rank === 1 ? 'text-green-700' : r.rank === rows.length && rows.length > 1 ? 'text-red-700' : ''}`}>
                              {r.leadCentsPerContractedBu != null ? fmtCents(r.leadCentsPerContractedBu) : (
                                <span title="Spot/unlinked — the settled-bu figure stands in">{fmtCents(r.centsPerSettledBu)}*</span>
                              )}
                            </td>
                            <td className={numCell}>{fmtCents(r.centsPerSettledBu)}</td>
                            {LOST_GROUP_ORDER.map((g) => (
                              <td key={g} className={`${numCell} ${hot.has(g) ? 'text-amber-700 font-semibold' : Math.abs(r.groupCents[g]) > 0.05 ? '' : 'text-slate-300'} ${r.groupCents[g] < -0.05 ? 'text-green-700' : ''}`}>
                                {Math.abs(r.groupCents[g]) > 0.05 ? fmtCents(r.groupCents[g]) : '—'}
                              </td>
                            ))}
                            <td className={numCell}>{r.rank}</td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-slate-50/70">
                              <td colSpan={13} className="px-4 py-2">
                                {r.contracts.map((c) => (
                                  <div key={c.contractId} className="mb-2">
                                    <div className="text-sm font-medium">
                                      Contract {c.contractNumber ? `#${c.contractNumber}` : c.contractId.slice(0, 8)}
                                      <span className="text-slate-500 font-normal">
                                        {' '}· {fmtInt(c.contractBushels)} bu contracted · lost ${fmtNum(c.lostDollars)}
                                        {c.centsPerContractedBu != null && <> ({fmtCents(c.centsPerContractedBu)}/contracted bu)</>}
                                      </span>
                                    </div>
                                    <ul className="text-sm space-y-0.5 ml-4 mt-0.5">
                                      {c.settlements.map(({ settlement: sRef, lost }) => {
                                        const s = settlementById.get(sRef.id)
                                        return (
                                          <li key={sRef.id}>
                                            <Link href={`/settlements/${sRef.id}`} className="text-brand-deep hover:underline">
                                              {sRef.settlementDate} · {sRef.settlementNumber ? `#${sRef.settlementNumber}` : 'no number'}
                                            </Link>
                                            <span className="text-slate-500">
                                              {' '}· {fmtInt(sRef.settledBu)} bu · lost ${fmtNum(lost.totalDollars)}
                                              {sRef.settledBu > 0 && <> ({fmtCents((lost.totalDollars / sRef.settledBu) * 100)}/bu)</>}
                                              {s && s.items.length === 0 && <span className="text-slate-400"> · not itemized</span>}
                                            </span>
                                          </li>
                                        )
                                      })}
                                    </ul>
                                  </div>
                                ))}
                                {r.unlinked.length > 0 && (
                                  <div>
                                    <div className="text-sm font-medium">Spot / unlinked settlements</div>
                                    <ul className="text-sm space-y-0.5 ml-4 mt-0.5">
                                      {r.unlinked.map(({ settlement: sRef, lost }) => (
                                        <li key={sRef.id}>
                                          <Link href={`/settlements/${sRef.id}`} className="text-brand-deep hover:underline">
                                            {sRef.settlementDate} · {sRef.settlementNumber ? `#${sRef.settlementNumber}` : 'no number'}
                                          </Link>
                                          <span className="text-slate-500">
                                            {' '}· {fmtInt(sRef.settledBu)} bu · lost ${fmtNum(lost.totalDollars)}
                                            {sRef.settledBu > 0 && <> ({fmtCents((lost.totalDollars / sRef.settledBu) * 100)}/bu)</>}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </RowGroup>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {/* ---- Quality-adjusted (secondary detail) ---- */}
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setShowQuality((v) => !v)}
              className="font-semibold text-left"
            >
              {showQuality ? '▾' : '▸'} Quality-adjusted detail
              <span className="text-xs text-slate-500 font-normal ml-2">
                ¢ per point of moisture / per pound of test weight — corrects for the grain each buyer actually saw
              </span>
            </button>
            {showQuality && perCropQuality.map(({ cropId: cid, rows }) => {
              const crop = cropById.get(cid)
              const withRates = rows.filter((r) => r.moistureCentsPerPoint != null || r.testWeightCentsPerLb != null)
              return (
                <div key={`q-${cid}`} className="space-y-1">
                  <h3 className="text-sm font-semibold text-slate-700 mt-2">{crop?.name ?? 'Unassigned crop'}</h3>
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
          </div>

          {/* ---- Published schedules ---- */}
          <div className="space-y-1">
            <h2 className="font-semibold">Published discount schedules</h2>
            <p className="text-xs text-slate-500 max-w-3xl">
              Each buyer&rsquo;s posted sheet, side by side per factor. Schedules live with the buyer (Settings →
              Buyers); they carry effective dates, and the audit below always uses the schedule in force at each
              settlement&rsquo;s date.
            </p>
            {scheduleComparison.length === 0 ? (
              <p className="text-sm text-slate-400 bg-white rounded-xl shadow px-4 py-3">
                No discount schedules uploaded yet — use &ldquo;Upload discount schedule (AI)&rdquo; below or on the buyer&rsquo;s card in Settings → Buyers.
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
        Settlements join a crop, crop year, and contract through their matched loads; unmatched settlements don&rsquo;t
        appear here. Category columns come from itemized discounts (weight-type items categorize the shrink gap without
        double counting); settlements without itemization still count in totals, with their volume gap under Weight
        deduction. Open a settlement to add its discount lines and complete the picture.
      </p>
    </div>
  )
}

// Wrapper so a buyer row + its expansion render as siblings inside <tbody>.
function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
