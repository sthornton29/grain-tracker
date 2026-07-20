'use client'

// Crop Budget Planner — the pre-season "what should I plant next year" tool.
// Scenario-based and editable-everything: budget_scenarios/budget_lines are a
// SANDBOX (never written to crop_assumptions or any actuals). The decision
// surface is the whole-farm allocation table (acres × yield × price × cost →
// profit) with a totals row; beneath it, one SIMPLE price × yield matrix per
// line — pure budget math, no contracts/insurance/government (that in-season
// machinery lives in Income Sensitivity).
//
// Assumption seeds (all editable): yield = acre-weighted APH from the most
// recent year's policies (else the current expected yield); price = the
// budget-year NEW-CROP futures (ZCZ27-style) + the crop's standing assumed
// basis, toggleable to manual; cost = the current year's crop_assumptions
// cost. Cotton prices are stored ¢/lb and displayed/entered as $/lb.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePersistentState } from '@/lib/use-persistent-state'
import { formatCottonPrice, parseCottonPriceInput, fmtPrice } from '@/lib/hedging'
import {
  budgetContractLabel, budgetContractSymbol, budgetLineMath, budgetSeeds,
  buildBudgetMatrix, compareScenarios, duplicateLinesFor, isCottonName,
  lineDesignation, scenarioTotals, BUDGET_PRACTICE_LABEL,
  type BudgetLineMath, type BudgetSeeds,
} from '@/lib/crop-budget'
import { axisValues, closestIndex, defaultPriceStep, defaultYieldStep } from '@/lib/income-sensitivity'
import { EmptyState, theadCls, toneText, signedTone, grandTotalRowCls } from '@/components/reports/report-kit'
import { formatNumber, type ExportPayload, type ExportCell } from '@/lib/exports'
import type { BudgetLine, BudgetScenario, Crop, CropAssumption, CropInsurancePolicy, Entity } from '@/lib/types'

type Props = { onPayloadChange?: (build: () => ExportPayload) => void }

const inputCls = 'rounded border border-slate-300 px-2 py-1 text-right tabular-nums text-sm bg-white w-24'
const btnCls = 'rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50'
const btnGray = 'rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50'
const acres0 = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
const usd0 = (n: number | null | undefined) =>
  n == null ? '—' : `${n < 0 ? '(' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}${n < 0 ? ')' : ''}`
const usd2 = (n: number | null | undefined) =>
  n == null ? '—' : `${n < 0 ? '(' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${n < 0 ? ')' : ''}`

type LivePrice = { price: number; priceDate: string | null; stale: boolean }

// ---------- shared inline editor (save-on-blur, invalid reverts) ----------

function CellInput({ value, onCommit, placeholder, width = 'w-24', title }: {
  value: string
  onCommit: (s: string) => void
  placeholder?: string
  width?: string
  title?: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => {
    if (draft === value) return
    if (draft.trim() !== '' && !Number.isFinite(Number(draft))) { setDraft(value); return }
    onCommit(draft)
  }
  return (
    <input
      type="text" inputMode="decimal" value={draft} placeholder={placeholder} title={title}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className={`rounded border border-slate-300 px-2 py-1 text-right tabular-nums text-sm bg-white ${width}`}
    />
  )
}

// Price display in the crop's display unit: $/bu, or $/lb for cotton (¢ stored).
const fmtPriceFor = (isCotton: boolean, v: number | null | undefined) =>
  v == null ? '—' : isCotton ? formatCottonPrice(v) : fmtPrice(v)
// Stored → input string (cotton ¢ → dollars string).
const priceToInput = (isCotton: boolean, v: number | null | undefined) =>
  v == null ? '' : isCotton ? String(Number(v) / 100) : String(v)
// Input string → stored value (cotton $-entry or legacy ¢ via the guard).
const inputToPrice = (isCotton: boolean, s: string, centsThreshold = 5): number | null => {
  if (s.trim() === '') return null
  if (!isCotton) { const v = Number(s); return Number.isFinite(v) ? v : null }
  return parseCottonPriceInput(s, { centsThreshold })
}

export default function CropBudgetReport({ onPayloadChange }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [scenarios, setScenarios] = useState<BudgetScenario[]>([])
  const [lines, setLines] = useState<BudgetLine[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [policies, setPolicies] = useState<CropInsurancePolicy[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [referenceAcres, setReferenceAcres] = useState<number>(0)
  const [livePrices, setLivePrices] = useState<Map<string, LivePrice>>(new Map())
  const [priceNote, setPriceNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const [scenarioId, setScenarioId] = usePersistentState('crop-budget:scenario', '')
  const [compareId, setCompareId] = useState('')
  const [matrixView, setMatrixView] = usePersistentState<'revenue' | 'profit'>('crop-budget:view', 'profit')

  const currentCropYear = new Date().getFullYear()
  const defaultBudgetYear = currentCropYear + 1

  async function refresh() {
    const [sc, ln, cr, en, po, ca, fi] = await Promise.all([
      supabase.from('budget_scenarios').select('*').order('created_at'),
      supabase.from('budget_lines').select('*').order('sort_order'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('crop_insurance_policies').select('*'),
      supabase.from('crop_assumptions').select('*'),
      supabase.from('fields').select('total_acres'),
    ])
    if (sc.error?.message.includes('does not exist') || sc.error?.code === '42P01') {
      setErr('The budget tables are missing — run supabase/048_crop_budget_planner.sql in the Supabase SQL editor first.')
    }
    setScenarios((sc.data as BudgetScenario[]) || [])
    setLines((ln.data as BudgetLine[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setEntities((en.data as Entity[]) || [])
    setPolicies((po.data as CropInsurancePolicy[]) || [])
    setAssumptions((ca.data as CropAssumption[]) || [])
    setReferenceAcres(((fi.data as Array<{ total_acres: number | null }>) || []).reduce((s, f) => s + Number(f.total_acres ?? 0), 0))
    setLoading(false)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const cropName = (id: string) => cropById.get(id)?.name ?? '—'
  const lineName = (l: BudgetLine) => {
    const d = lineDesignation(l)
    return `${cropName(l.crop_id)}${d ? ` — ${d}` : ''}${l.label ? ` (${l.label})` : ''}`
  }

  const scenario = scenarios.find((s) => s.id === scenarioId) ?? scenarios[0] ?? null
  useEffect(() => {
    if (scenario && scenario.id !== scenarioId) setScenarioId(scenario.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario?.id])

  const scenarioLines = useMemo(
    () => lines.filter((l) => l.scenario_id === scenario?.id).sort((a, b) => a.sort_order - b.sort_order),
    [lines, scenario?.id],
  )

  // ---------- live budget-year quotes (shared market_prices day-cache) ----------

  const neededSymbols = useMemo(() => {
    const out = new Set<string>()
    for (const l of lines) {
      const sc = scenarios.find((s) => s.id === l.scenario_id)
      const sym = budgetContractSymbol(cropById.get(l.crop_id)?.name, sc?.budget_crop_year ?? defaultBudgetYear)
      if (sym) out.add(sym)
    }
    return Array.from(out)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, scenarios, cropById])

  const fetchQuotes = useCallback(async (symbols: string[], force = false) => {
    if (symbols.length === 0) return
    try {
      const res = await fetch('/api/market-prices', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbols, force }),
      })
      const json = await res.json().catch(() => null)
      if (!json) return
      setLivePrices((prev) => {
        const m = new Map(prev)
        for (const p of (json.prices ?? []) as Array<{ symbol: string; price: number | null; price_date: string | null; stale: boolean }>) {
          if (p.price != null) m.set(p.symbol, { price: Number(p.price), priceDate: p.price_date, stale: !!p.stale })
          else m.delete(p.symbol)
        }
        return m
      })
      setPriceNote(typeof json.note === 'string' ? json.note : null)
    } catch {
      setPriceNote('Could not refresh budget-year futures — showing cached quotes; lines without one fall back to manual.')
    }
  }, [])

  useEffect(() => { void fetchQuotes(neededSymbols) }, [neededSymbols, fetchQuotes])

  const quoteDate = useMemo(() => {
    let d: string | null = null
    for (const p of livePrices.values()) if (p.priceDate && (!d || p.priceDate > d)) d = p.priceDate
    return d
  }, [livePrices])

  // ---------- per-line derived math ----------

  type Row = {
    line: BudgetLine
    crop: Crop | undefined
    isCotton: boolean
    symbol: string | null
    live: LivePrice | null
    math: BudgetLineMath
    usedManualFallback: boolean
    seeds: BudgetSeeds
  }

  const rowFor = useCallback((l: BudgetLine, budgetYear: number): Row => {
    const crop = cropById.get(l.crop_id)
    const isCotton = isCottonName(crop?.name)
    const symbol = budgetContractSymbol(crop?.name, budgetYear)
    const live = symbol ? livePrices.get(symbol) ?? null : null
    // A live-mode line with no quote drops to its manual price (with a note)
    // rather than a blank — nothing vanishes because a contract isn't listed.
    const usedManualFallback = l.price_mode === 'live' && live == null && l.manual_price != null
    const math = budgetLineMath(
      usedManualFallback ? { ...l, price_mode: 'manual' } : l,
      live?.price ?? null,
      isCotton,
    )
    const assumption = assumptions.find((a) => a.crop_id === l.crop_id && a.crop_year === currentCropYear)
    return {
      line: l, crop, isCotton, symbol, live, math, usedManualFallback,
      seeds: budgetSeeds({ policies, assumption, cropId: l.crop_id, practice: l.practice, cropping: l.cropping }),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropById, livePrices, policies, assumptions, currentCropYear])

  const rows: Row[] = useMemo(
    () => scenarioLines.map((l) => rowFor(l, scenario?.budget_crop_year ?? defaultBudgetYear)),
    [scenarioLines, rowFor, scenario?.budget_crop_year, defaultBudgetYear],
  )
  const totals = useMemo(() => scenarioTotals(rows.map((r) => ({ acres: r.line.acres, math: r.math }))), [rows])

  // Totals per scenario for the comparison strip.
  const totalsByScenario = useMemo(() => {
    const m = new Map<string, ReturnType<typeof scenarioTotals>>()
    for (const s of scenarios) {
      const rs = lines.filter((l) => l.scenario_id === s.id).map((l) => {
        const r = rowFor(l, s.budget_crop_year)
        return { acres: l.acres, math: r.math }
      })
      m.set(s.id, scenarioTotals(rs))
    }
    return m
  }, [scenarios, lines, rowFor])

  // ---------- scenario CRUD ----------

  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : 'Unexpected error')

  async function createScenario() {
    const name = (prompt('Scenario name:', scenarios.length === 0 ? 'Base plan' : '') ?? '').trim()
    if (!name) return
    try {
      const { data, error } = await supabase.from('budget_scenarios')
        .insert({ name, budget_crop_year: defaultBudgetYear }).select('id').single()
      if (error || !data) throw new Error(error?.message ?? 'insert failed')
      setScenarioId((data as { id: string }).id)
      await refresh()
    } catch (e) { fail(e) }
  }

  async function renameScenario() {
    if (!scenario) return
    const name = (prompt('Scenario name:', scenario.name) ?? '').trim()
    if (!name || name === scenario.name) return
    try {
      const { error } = await supabase.from('budget_scenarios').update({ name, updated_at: new Date().toISOString() }).eq('id', scenario.id)
      if (error) throw new Error(error.message)
      await refresh()
    } catch (e) { fail(e) }
  }

  async function setBudgetYear(yearStr: string) {
    if (!scenario) return
    const y = Number(yearStr)
    if (!Number.isFinite(y) || y < 2000 || y > 2100) return
    try {
      const { error } = await supabase.from('budget_scenarios').update({ budget_crop_year: y, updated_at: new Date().toISOString() }).eq('id', scenario.id)
      if (error) throw new Error(error.message)
      await refresh()
    } catch (e) { fail(e) }
  }

  async function duplicateScenario() {
    if (!scenario) return
    const name = (prompt('Name for the copy:', `${scenario.name} (copy)`) ?? '').trim()
    if (!name) return
    try {
      const { data, error } = await supabase.from('budget_scenarios')
        .insert({ name, budget_crop_year: scenario.budget_crop_year, entity_id: scenario.entity_id, notes: scenario.notes })
        .select('id').single()
      if (error || !data) throw new Error(error?.message ?? 'insert failed')
      const newId = (data as { id: string }).id
      const copies = duplicateLinesFor(scenarioLines, newId)
      if (copies.length > 0) {
        const { error: e2 } = await supabase.from('budget_lines').insert(copies)
        if (e2) throw new Error(e2.message)
      }
      setScenarioId(newId)
      await refresh()
    } catch (e) { fail(e) }
  }

  async function deleteScenario() {
    if (!scenario) return
    if (!confirm(`Delete scenario "${scenario.name}" and its ${scenarioLines.length} lines? This cannot be undone.`)) return
    try {
      const { error } = await supabase.from('budget_scenarios').delete().eq('id', scenario.id)
      if (error) throw new Error(error.message)
      if (compareId === scenario.id) setCompareId('')
      setScenarioId('')
      await refresh()
    } catch (e) { fail(e) }
  }

  // ---------- line CRUD (seeded defaults; sandbox-only writes) ----------

  const [addCropId, setAddCropId] = useState('')
  const [addPractice, setAddPractice] = useState<'' | 'irrigated' | 'non_irrigated'>('')
  const [addCropping, setAddCropping] = useState<'' | 'double_crop'>('')
  const addCropIsDc = cropById.get(addCropId)?.double_crop === true

  async function addLine() {
    if (!scenario || !addCropId) return
    const crop = cropById.get(addCropId)
    const assumption = assumptions.find((a) => a.crop_id === addCropId && a.crop_year === currentCropYear)
    const practice = addPractice || null
    const cropping = addCropIsDc && addCropping === 'double_crop' ? 'double_crop' as const : null
    const seeds = budgetSeeds({ policies, assumption, cropId: addCropId, practice, cropping })
    try {
      const { error } = await supabase.from('budget_lines').insert({
        scenario_id: scenario.id,
        crop_id: addCropId,
        label: null,
        practice,
        cropping,
        acres: null, // the user's core input
        yield_per_acre: seeds.yield,
        price_mode: budgetContractSymbol(crop?.name, scenario.budget_crop_year) ? 'live' : 'manual',
        manual_price: null,
        basis: assumption?.assumed_basis != null ? Number(assumption.assumed_basis) : 0,
        cost_per_acre: seeds.cost,
        sort_order: scenarioLines.length,
      })
      if (error) throw new Error(error.message)
      setAddCropId(''); setAddPractice(''); setAddCropping('')
      await refresh()
    } catch (e) { fail(e) }
  }

  // Changing a line's practice/cropping re-seeds yield and cost ONLY where the
  // current value is still the old seed (or blank) — typed-in numbers survive.
  async function setLineBreakout(r: Row, patch: { practice?: BudgetLine['practice']; cropping?: BudgetLine['cropping'] }) {
    const l = r.line
    const assumption = assumptions.find((a) => a.crop_id === l.crop_id && a.crop_year === currentCropYear)
    const next = budgetSeeds({
      policies, assumption, cropId: l.crop_id,
      practice: 'practice' in patch ? patch.practice ?? null : l.practice,
      cropping: 'cropping' in patch ? patch.cropping ?? null : l.cropping,
    })
    const yieldUntouched = l.yield_per_acre == null || (r.seeds.yield != null && Math.abs(Number(l.yield_per_acre) - r.seeds.yield) < 1e-9)
    const costUntouched = l.cost_per_acre == null || (r.seeds.cost != null && Math.abs(Number(l.cost_per_acre) - r.seeds.cost) < 1e-9)
    await patchLine(l.id, {
      ...patch,
      ...(yieldUntouched ? { yield_per_acre: next.yield } : {}),
      ...(costUntouched ? { cost_per_acre: next.cost } : {}),
    })
  }

  async function patchLine(id: string, patch: Partial<BudgetLine>) {
    try {
      const { error } = await supabase.from('budget_lines').update(patch).eq('id', id)
      if (error) throw new Error(error.message)
      setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)))
    } catch (e) { fail(e) }
  }

  async function removeLine(l: BudgetLine) {
    if (!confirm(`Remove ${cropName(l.crop_id)}${l.label ? ` (${l.label})` : ''} from this scenario?`)) return
    try {
      const { error } = await supabase.from('budget_lines').delete().eq('id', l.id)
      if (error) throw new Error(error.message)
      await refresh()
    } catch (e) { fail(e) }
  }

  async function moveLine(l: BudgetLine, dir: -1 | 1) {
    const idx = scenarioLines.findIndex((x) => x.id === l.id)
    const other = scenarioLines[idx + dir]
    if (!other) return
    try {
      await supabase.from('budget_lines').update({ sort_order: other.sort_order }).eq('id', l.id)
      await supabase.from('budget_lines').update({ sort_order: l.sort_order }).eq('id', other.id)
      await refresh()
    } catch (e) { fail(e) }
  }

  const numOrNull = (s: string): number | null => {
    if (s.trim() === '') return null
    const v = Number(s)
    return Number.isFinite(v) ? v : null
  }

  // ---------- export payload ----------

  const buildExportPayload = useCallback((): ExportPayload => {
    const sections: ExportPayload['sections'] = []
    sections.push({
      title: `Allocation — ${scenario?.name ?? ''} (${scenario?.budget_crop_year ?? defaultBudgetYear} budget)`,
      columns: [
        { label: 'Crop' }, { label: 'Acres', align: 'right', format: 'acres' },
        { label: 'Yield/ac', align: 'right', format: 'yield' },
        { label: 'Price', align: 'right' }, { label: 'Basis', align: 'right' },
        { label: 'Revenue/ac', align: 'right', format: 'usd2' }, { label: 'Cost/ac', align: 'right', format: 'usd2' },
        { label: 'Profit/ac', align: 'right', format: 'usd2' }, { label: 'Total Profit', align: 'right', format: 'usd0' },
      ],
      rows: [
        ...rows.map((r): ExportCell[] => [
          lineName(r.line),
          r.line.acres ?? '',
          r.line.yield_per_acre ?? '',
          r.math.effectivePrice != null ? { v: r.isCotton ? r.math.effectivePrice : r.math.effectivePrice, format: r.isCotton ? 'cents' as const : 'price' as const } : '',
          r.line.basis != null ? { v: r.line.basis, format: r.isCotton ? 'cents' as const : 'price' as const } : '',
          r.math.revenuePerAcre ?? '',
          r.line.cost_per_acre ?? '',
          r.math.profitPerAcre != null ? { v: r.math.profitPerAcre, tone: signedTone(r.math.profitPerAcre) } : '',
          r.math.totalProfit != null ? { v: r.math.totalProfit, tone: signedTone(r.math.totalProfit) } : '',
        ]),
        ['Total', totals.totalAcres, '', '', '', '', '', totals.weightedProfitPerAcre ?? '', { v: totals.totalProfit, tone: signedTone(totals.totalProfit) }],
      ],
      rowMeta: [...rows.map(() => 'data' as const), 'total' as const],
    })
    for (const r of rows) {
      const grid = matrixGridFor(r)
      if (!grid) continue
      sections.push({
        title: `${lineName(r.line)} — price × yield ${matrixView === 'profit' ? 'profit' : 'revenue'}/ac`,
        columns: [
          { label: `Price ${r.isCotton ? '$/lb' : '$/bu'}`, align: 'right', format: r.isCotton ? 'cents' : 'price' },
          ...grid.yieldValues.map((y) => ({ label: `${formatNumber(y, 'yield')} ${r.isCotton ? 'lbs/ac' : 'bu/ac'}`, align: 'right' as const, format: 'usd2' as const })),
        ],
        rows: grid.grid.map((row, ri): ExportCell[] => [
          grid.priceValues[ri],
          ...row.map((cell): ExportCell => {
            const val = matrixView === 'profit' ? cell.profitPerAcre : cell.revenuePerAcre
            return val == null ? '' : { v: val, tone: matrixView === 'profit' ? signedTone(val) : undefined }
          }),
        ]),
      })
    }
    return {
      title: 'Crop Budget Planner',
      filters: [
        `Scenario: ${scenario?.name ?? '—'}`,
        `Budget crop year: ${scenario?.budget_crop_year ?? defaultBudgetYear}`,
        quoteDate ? `Futures quotes as of ${quoteDate}` : 'No live quotes',
        'Pre-season budget — no contracts, insurance, or government payments',
      ].join(' · '),
      sections,
      orientation: 'landscape',
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, totals, scenario, quoteDate, matrixView])

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
  }, [buildExportPayload, onPayloadChange])

  // ---------- matrix axis state (session-local; defaults recenter on the line) ----------

  type AxisCfg = { pc?: string; ps?: string; pn?: string; yc?: string; ys?: string; yn?: string }
  const [axisByLine, setAxisByLine] = useState<Record<string, AxisCfg>>({})
  const setAxis = (lineId: string, patch: Partial<AxisCfg>) =>
    setAxisByLine((m) => ({ ...m, [lineId]: { ...(m[lineId] ?? {}), ...patch } }))

  const parseNum = (s: string | undefined): number | null => {
    if (s == null || s.trim() === '') return null
    const v = Number(s)
    return Number.isFinite(v) ? v : null
  }

  function matrixGridFor(r: Row) {
    const cfg = axisByLine[r.line.id] ?? {}
    const priceCenter = parseNum(cfg.pc) ?? r.math.effectivePrice
    const yieldCenter = parseNum(cfg.yc) ?? (r.line.yield_per_acre != null ? Number(r.line.yield_per_acre) : null)
    if (priceCenter == null || yieldCenter == null || priceCenter <= 0 || yieldCenter <= 0) return null
    const priceStep = parseNum(cfg.ps) ?? defaultPriceStep(r.crop?.name)
    const yieldStep = parseNum(cfg.ys) ?? defaultYieldStep(r.crop?.name)
    const priceSteps = Math.min(10, Math.max(1, Math.round(parseNum(cfg.pn) ?? 4)))
    const yieldSteps = Math.min(10, Math.max(1, Math.round(parseNum(cfg.yn) ?? 4)))
    const priceValues = axisValues({ center: priceCenter, step: priceStep, steps: priceSteps })
    const yieldValues = axisValues({ center: yieldCenter, step: yieldStep, steps: yieldSteps })
    return {
      priceValues, yieldValues,
      grid: buildBudgetMatrix({ priceValues, yieldValues, costPerAcre: r.line.cost_per_acre != null ? Number(r.line.cost_per_acre) : null, isCotton: r.isCotton }),
      hereRow: closestIndex(priceValues, r.math.effectivePrice),
      hereCol: closestIndex(yieldValues, r.line.yield_per_acre != null ? Number(r.line.yield_per_acre) : null),
      priceStep, yieldStep, cfg,
    }
  }

  // ---------- render ----------

  if (loading) return <p className="text-slate-500">Loading…</p>

  return (
    <div className="space-y-4 print-area">
      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Scenario bar */}
      <div className="flex flex-wrap items-end gap-3 no-print">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Scenario</span>
          <select value={scenario?.id ?? ''} onChange={(e) => setScenarioId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 bg-white">
            {scenarios.length === 0 && <option value="">— none yet —</option>}
            {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.budget_crop_year})</option>)}
          </select>
        </label>
        {scenario && (
          <label className="text-sm flex flex-col gap-1">
            <span className="text-slate-500">Budget crop year</span>
            <CellInput value={String(scenario.budget_crop_year)} onCommit={setBudgetYear} width="w-24" />
          </label>
        )}
        {scenario && entities.length > 1 && (
          <label className="text-sm flex flex-col gap-1">
            <span className="text-slate-500">Scope</span>
            <select
              value={scenario.entity_id ?? ''}
              onChange={async (e) => {
                try {
                  const { error } = await supabase.from('budget_scenarios')
                    .update({ entity_id: e.target.value || null, updated_at: new Date().toISOString() }).eq('id', scenario.id)
                  if (error) throw new Error(error.message)
                  await refresh()
                } catch (ex) { fail(ex) }
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 bg-white"
            >
              <option value="">Whole operation</option>
              {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
          </label>
        )}
        <div className="flex gap-2 pb-0.5">
          <button type="button" className={btnCls} onClick={createScenario}>+ New scenario</button>
          {scenario && (
            <>
              <button type="button" className={btnGray} onClick={duplicateScenario} title="Copy this plan, then tweak the copy — the primary workflow.">Duplicate</button>
              <button type="button" className={btnGray} onClick={renameScenario}>Rename</button>
              <button type="button" className="rounded-lg bg-white border border-red-300 text-red-700 px-3 py-1.5 text-sm" onClick={deleteScenario}>Delete</button>
            </>
          )}
        </div>
      </div>

      {priceNote && <p className="text-xs text-amber-700 no-print">{priceNote}</p>}

      {/* Comparison strip */}
      {scenarios.length >= 2 && (
        <div className="flex flex-wrap gap-2 no-print">
          {scenarios.map((s) => {
            const t = totalsByScenario.get(s.id)
            const active = s.id === scenario?.id
            return (
              <button
                key={s.id} type="button" onClick={() => setScenarioId(s.id)}
                className={`rounded-lg border px-3 py-2 text-left ${active ? 'border-green-600 bg-green-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
              >
                <div className="text-xs font-semibold">{s.name}</div>
                <div className="text-xs text-slate-500 tabular-nums">
                  {t ? `${acres0(t.totalAcres)} ac · ${usd0(t.totalProfit)}` : '—'}
                </div>
              </button>
            )
          })}
          <label className="text-xs flex items-center gap-1 text-slate-500 ml-2">
            Compare with
            <select value={compareId} onChange={(e) => setCompareId(e.target.value)} className="rounded border border-slate-300 px-2 py-1 bg-white">
              <option value="">—</option>
              {scenarios.filter((s) => s.id !== scenario?.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
      )}

      {scenarios.length === 0 && (
        <EmptyState
          message="No budget scenarios yet."
          hint={`Create a "Base plan" for ${defaultBudgetYear}, then Duplicate it to explore alternatives.`}
        />
      )}

      {scenario && (
        <>
          {/* ---- The decision surface: whole-farm allocation ---- */}
          <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="font-bold text-lg flex-1">{scenario.name} — {scenario.budget_crop_year} allocation</h2>
              <span className="text-xs text-slate-500">
                {quoteDate ? `Futures as of ${quoteDate}` : 'No live quotes yet'}
              </span>
            </div>
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  {['Crop', 'Acres', 'Yield/ac', 'Price', 'Basis', 'Revenue/ac', 'Cost/ac', 'Profit/ac', 'Total Profit', ''].map((h) => (
                    <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const l = r.line
                  const yieldIsSeed = r.seeds.yield != null && l.yield_per_acre != null && Math.abs(Number(l.yield_per_acre) - r.seeds.yield) < 1e-9
                  const costIsSeed = r.seeds.cost != null && l.cost_per_acre != null && Math.abs(Number(l.cost_per_acre) - r.seeds.cost) < 1e-9
                  const isDcCrop = r.crop?.double_crop === true
                  return (
                    <tr key={l.id} className="border-t border-slate-100 align-middle">
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <div className="font-semibold">{cropName(l.crop_id)}</div>
                        <div className="flex items-center gap-1 mt-0.5 no-print">
                          <select
                            value={l.practice ?? ''} title="Irrigated / dryland breakout — re-seeds untouched yield & cost"
                            onChange={(e) => void setLineBreakout(r, { practice: (e.target.value || null) as BudgetLine['practice'] })}
                            className="rounded border border-slate-200 px-1 py-0.5 text-[11px] bg-white text-slate-600"
                          >
                            <option value="">Blended</option>
                            <option value="irrigated">Irrigated</option>
                            <option value="non_irrigated">Dryland</option>
                          </select>
                          {isDcCrop && (
                            <select
                              value={l.cropping === 'double_crop' ? 'double_crop' : ''} title="Full-season / double-crop — DC seeds from the DC yield & cost breakouts"
                              onChange={(e) => void setLineBreakout(r, { cropping: e.target.value === 'double_crop' ? 'double_crop' : null })}
                              className="rounded border border-slate-200 px-1 py-0.5 text-[11px] bg-white text-slate-600"
                            >
                              <option value="">Full-season</option>
                              <option value="double_crop">Double-crop</option>
                            </select>
                          )}
                        </div>
                        {lineDesignation(l) && <div className="text-[10px] text-slate-500 print-only hidden">{lineDesignation(l)}</div>}
                        <CellInput
                          value={l.label ?? ''} width="w-36"
                          placeholder="label (optional)"
                          onCommit={(s) => patchLine(l.id, { label: s.trim() || null })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <CellInput value={l.acres != null ? String(l.acres) : ''} placeholder="acres" onCommit={(s) => patchLine(l.id, { acres: numOrNull(s) })} width="w-20" />
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <CellInput value={l.yield_per_acre != null ? String(l.yield_per_acre) : ''} placeholder={r.isCotton ? 'lbs/ac' : 'bu/ac'} onCommit={(s) => patchLine(l.id, { yield_per_acre: numOrNull(s) })} width="w-20" />
                        {yieldIsSeed && (
                          <span className="ml-1 text-[10px] rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5 cursor-help"
                            title={r.seeds.yieldSource === 'aph' && r.seeds.aph
                              ? `APH ${r.seeds.aph.yield} — weighted from ${r.seeds.aph.policyCount} ${r.seeds.aph.cropYear}${l.practice ? ` ${BUDGET_PRACTICE_LABEL[l.practice].toLowerCase()}` : ''} ${r.seeds.aph.policyCount === 1 ? 'policy' : 'policies'}`
                              : r.seeds.yieldSource === 'expected_dc'
                                ? `Seeded from your ${currentCropYear} double-crop expected yield${l.practice ? ` (${BUDGET_PRACTICE_LABEL[l.practice].toLowerCase()})` : ''}`
                                : `Seeded from your ${currentCropYear} expected yield${l.practice ? ` (${BUDGET_PRACTICE_LABEL[l.practice].toLowerCase()})` : ''}`}>
                            {r.seeds.yieldSource === 'aph' ? 'APH' : r.seeds.yieldSource === 'expected_dc' ? 'DC exp.' : 'expected'}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className={`text-[10px] rounded-full px-1.5 py-0.5 border ${l.price_mode === 'live' ? 'bg-sky-100 text-sky-800 border-sky-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}
                            title={l.price_mode === 'live' ? 'Live budget-year futures — click for manual' : 'Manual price — click for live futures'}
                            onClick={() => patchLine(l.id, { price_mode: l.price_mode === 'live' ? 'manual' : 'live' })}
                          >
                            {l.price_mode === 'live' ? (r.symbol ?? 'live') : 'manual'}
                          </button>
                          {l.price_mode === 'live' && !r.usedManualFallback ? (
                            <span className="tabular-nums font-mono text-sm" title={r.live ? `${budgetContractLabel(r.crop?.name, scenario.budget_crop_year)} as of ${r.live.priceDate ?? '—'}${r.live.stale ? ' (cached)' : ''}` : undefined}>
                              {r.live ? fmtPriceFor(r.isCotton, r.live.price) : '—'}
                            </span>
                          ) : (
                            <CellInput
                              value={priceToInput(r.isCotton, l.manual_price)}
                              placeholder={r.isCotton ? '$/lb' : '$/bu'}
                              onCommit={(s) => patchLine(l.id, { manual_price: inputToPrice(r.isCotton, s) })}
                              width="w-20"
                            />
                          )}
                          {l.price_mode === 'live' && r.symbol && (
                            <button type="button" className="text-xs text-sky-700" title="Refresh this quote" onClick={() => void fetchQuotes([r.symbol!], true)}>↻</button>
                          )}
                        </div>
                        {r.math.missingPrice && !r.usedManualFallback && (
                          <div className="text-[10px] text-amber-700">{r.symbol ?? 'contract'} not quoted — enter a manual price</div>
                        )}
                        {r.usedManualFallback && (
                          <div className="text-[10px] text-amber-700">{r.symbol} not quoted — using your manual price</div>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <CellInput
                          value={priceToInput(r.isCotton, l.basis)}
                          placeholder={r.isCotton ? '+/− $/lb' : '+/− $/bu'}
                          onCommit={(s) => patchLine(l.id, { basis: inputToPrice(r.isCotton, s, 0.25) ?? 0 })}
                          width="w-20"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{usd2(r.math.revenuePerAcre)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <CellInput value={l.cost_per_acre != null ? String(l.cost_per_acre) : ''} placeholder="$/ac" onCommit={(s) => patchLine(l.id, { cost_per_acre: numOrNull(s) })} width="w-20" />
                        {costIsSeed && (
                          <span className="ml-1 text-[10px] rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5 cursor-help"
                            title={`Seeded from your ${currentCropYear}${r.seeds.costSource === 'assumption_dc' ? ' double-crop' : ''}${l.practice ? ` ${BUDGET_PRACTICE_LABEL[l.practice].toLowerCase()}` : ''} cost/acre — edit freely, the budget never writes back.`}>
                            from {currentCropYear}{r.seeds.costSource === 'assumption_dc' ? ' DC' : ''}
                          </span>
                        )}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${r.math.profitPerAcre != null ? toneText(signedTone(r.math.profitPerAcre)) : 'text-slate-400'}`}>
                        {usd2(r.math.profitPerAcre)}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${r.math.totalProfit != null ? toneText(signedTone(r.math.totalProfit)) : 'text-slate-400'}`}>
                        {usd0(r.math.totalProfit)}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-xs no-print">
                        <button type="button" className="text-slate-400 disabled:opacity-30" disabled={i === 0} onClick={() => moveLine(l, -1)}>↑</button>{' '}
                        <button type="button" className="text-slate-400 disabled:opacity-30" disabled={i === rows.length - 1} onClick={() => moveLine(l, 1)}>↓</button>{' '}
                        <button type="button" className="text-red-600" onClick={() => removeLine(l)}>✕</button>
                      </td>
                    </tr>
                  )
                })}
                <tr className={grandTotalRowCls}>
                  <td className="px-2 py-1.5">Total</td>
                  <td className="px-2 py-1.5 tabular-nums">{acres0(totals.totalAcres)}</td>
                  <td colSpan={5} className="px-2 py-1.5 text-right text-xs font-normal text-slate-500">
                    {totals.incompleteLines > 0 ? `${totals.incompleteLines} line${totals.incompleteLines === 1 ? '' : 's'} missing inputs — excluded from profit` : ''}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${totals.weightedProfitPerAcre != null ? toneText(signedTone(totals.weightedProfitPerAcre)) : ''}`}>
                    {usd2(totals.weightedProfitPerAcre)}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${toneText(signedTone(totals.totalProfit))}`}>{usd0(totals.totalProfit)}</td>
                  <td className="no-print" />
                </tr>
              </tbody>
            </table>
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <span className="tabular-nums">
                Total acres: <strong className="text-slate-700">{acres0(totals.totalAcres)}</strong>
                {referenceAcres > 0 && <> of ~{acres0(referenceAcres)} (your fields&apos; total — context only, not enforced; double-crop legitimately overlaps)</>}
              </span>
              <span className="ml-auto no-print flex items-center gap-2">
                <select value={addCropId} onChange={(e) => { setAddCropId(e.target.value); setAddCropping('') }} className="rounded border border-slate-300 px-2 py-1 bg-white">
                  <option value="">— add a crop line —</option>
                  {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select value={addPractice} onChange={(e) => setAddPractice(e.target.value as typeof addPractice)} className="rounded border border-slate-300 px-2 py-1 bg-white" title="Irrigated / dryland breakout — seeds practice-specific APH and cost">
                  <option value="">Blended</option>
                  <option value="irrigated">Irrigated</option>
                  <option value="non_irrigated">Dryland</option>
                </select>
                {addCropIsDc && (
                  <select value={addCropping} onChange={(e) => setAddCropping(e.target.value as typeof addCropping)} className="rounded border border-slate-300 px-2 py-1 bg-white" title="This crop is designated double-crop — a DC line seeds from your DC yield/cost breakouts">
                    <option value="">Full-season</option>
                    <option value="double_crop">Double-crop</option>
                  </select>
                )}
                <button type="button" className={btnCls} disabled={!addCropId} onClick={addLine}>Add line</button>
              </span>
            </div>
          </section>

          {/* ---- Compare view ---- */}
          {compareId && (() => {
            const other = scenarios.find((s) => s.id === compareId)
            if (!other) return null
            const otherRows = lines.filter((l) => l.scenario_id === other.id).map((l) => {
              const r = rowFor(l, other.budget_crop_year)
              return { cropId: l.crop_id, label: l.label, practice: l.practice, cropping: l.cropping, acres: l.acres, totalProfit: r.math.totalProfit }
            })
            const mineRows = rows.map((r) => ({ cropId: r.line.crop_id, label: r.line.label, practice: r.line.practice, cropping: r.line.cropping, acres: r.line.acres, totalProfit: r.math.totalProfit }))
            const cmp = compareScenarios(mineRows, otherRows)
            const otherTotals = totalsByScenario.get(other.id)
            return (
              <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto space-y-2">
                <h2 className="font-bold text-lg">Compare — {scenario.name} vs {other.name}</h2>
                <table className="min-w-full text-sm border-collapse">
                  <thead className={theadCls}>
                    <tr>
                      <th className="text-left px-2 py-1">Crop</th>
                      <th className="text-right px-2 py-1">{scenario.name} acres</th>
                      <th className="text-right px-2 py-1">{other.name} acres</th>
                      <th className="text-right px-2 py-1">Δ acres</th>
                      <th className="text-right px-2 py-1">{scenario.name} profit</th>
                      <th className="text-right px-2 py-1">{other.name} profit</th>
                      <th className="text-right px-2 py-1">Δ profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cmp.map((c) => (
                      <tr key={c.key} className="border-t border-slate-100 tabular-nums">
                        <td className="px-2 py-1">{cropName(c.cropId)}{lineDesignation(c) ? ` — ${lineDesignation(c)}` : ''}{c.label ? ` (${c.label})` : ''}</td>
                        <td className="px-2 py-1 text-right">{c.aAcres != null ? acres0(c.aAcres) : '—'}</td>
                        <td className="px-2 py-1 text-right">{c.bAcres != null ? acres0(c.bAcres) : '—'}</td>
                        <td className={`px-2 py-1 text-right ${c.acresDelta! > 0 ? 'text-green-700' : c.acresDelta! < 0 ? 'text-red-700' : 'text-slate-400'}`}>{c.acresDelta! > 0 ? '+' : ''}{acres0(c.acresDelta!)}</td>
                        <td className="px-2 py-1 text-right">{usd0(c.aProfit)}</td>
                        <td className="px-2 py-1 text-right">{usd0(c.bProfit)}</td>
                        <td className={`px-2 py-1 text-right font-semibold ${toneText(signedTone(c.profitDelta!))}`}>{usd0(c.profitDelta)}</td>
                      </tr>
                    ))}
                    <tr className={grandTotalRowCls}>
                      <td className="px-2 py-1">Total</td>
                      <td className="px-2 py-1 text-right tabular-nums">{acres0(totals.totalAcres)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{otherTotals ? acres0(otherTotals.totalAcres) : '—'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{otherTotals ? `${otherTotals.totalAcres - totals.totalAcres > 0 ? '+' : ''}${acres0(otherTotals.totalAcres - totals.totalAcres)}` : '—'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{usd0(totals.totalProfit)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{otherTotals ? usd0(otherTotals.totalProfit) : '—'}</td>
                      <td className={`px-2 py-1 text-right tabular-nums font-bold ${otherTotals ? toneText(signedTone(otherTotals.totalProfit - totals.totalProfit)) : ''}`}>
                        {otherTotals ? usd0(otherTotals.totalProfit - totals.totalProfit) : '—'}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="text-xs text-slate-500">Δ = {other.name} − {scenario.name}. Lines missing from one scenario count as zero there.</p>
              </section>
            )
          })()}

          {/* ---- Per-line price × yield matrices ---- */}
          {rows.length > 0 && (
            <div className="flex items-center gap-3 no-print">
              <h2 className="font-semibold text-slate-700 flex-1">Price × yield matrices <span className="font-normal text-sm text-slate-500">— pure budget math per cell</span></h2>
              <span className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
                {(['revenue', 'profit'] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setMatrixView(m)}
                    className={`px-3 py-1.5 text-sm font-semibold ${matrixView === m ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'} ${m === 'profit' ? 'border-l border-slate-300' : ''}`}>
                    {m === 'revenue' ? 'Revenue/acre' : 'Profit/acre'}
                  </button>
                ))}
              </span>
            </div>
          )}
          {rows.map((r) => {
            const grid = matrixGridFor(r)
            const cfg = axisByLine[r.line.id] ?? {}
            return (
              <details key={r.line.id} className="bg-white rounded-xl shadow avoid-break">
                <summary className="cursor-pointer select-none px-4 py-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="font-semibold">{lineName(r.line)}</span>
                  <span className="text-sm text-slate-500 tabular-nums">
                    breakeven price <strong className="text-slate-700">{fmtPriceFor(r.isCotton, r.math.breakevenPrice)}</strong> at {r.line.yield_per_acre ?? '—'} {r.isCotton ? 'lbs' : 'bu'}/ac
                    {' '}· breakeven yield <strong className="text-slate-700">{r.math.breakevenYield != null ? r.math.breakevenYield.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} {r.isCotton ? 'lbs' : 'bu'}/ac</strong> at {fmtPriceFor(r.isCotton, r.math.effectivePrice)}
                  </span>
                </summary>
                <div className="border-t border-slate-100 px-4 py-3 space-y-2">
                  <div className="flex flex-wrap gap-x-6 gap-y-2 no-print text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-600 uppercase tracking-wide">Price axis ({r.isCotton ? '$/lb' : '$/bu'})</span>
                      <CellInput
                        value={r.isCotton && cfg.pc ? String(Number(cfg.pc) / 100) : cfg.pc ?? ''}
                        placeholder={r.math.effectivePrice != null ? (r.isCotton ? (r.math.effectivePrice / 100).toFixed(2) : r.math.effectivePrice.toFixed(2)) : '—'}
                        onCommit={(s) => setAxis(r.line.id, { pc: s.trim() === '' ? undefined : String(inputToPrice(r.isCotton, s) ?? '') })}
                        width="w-20" title="center"
                      />
                      <CellInput
                        value={r.isCotton && cfg.ps ? String(Number(cfg.ps) / 100) : cfg.ps ?? ''}
                        placeholder={(r.isCotton ? defaultPriceStep(r.crop?.name) / 100 : defaultPriceStep(r.crop?.name)).toFixed(2)}
                        onCommit={(s) => setAxis(r.line.id, { ps: s.trim() === '' ? undefined : String(inputToPrice(r.isCotton, s, 0.25) ?? '') })}
                        width="w-16" title="step"
                      />
                      <CellInput value={cfg.pn ?? ''} placeholder="4" onCommit={(s) => setAxis(r.line.id, { pn: s })} width="w-12" title="± steps" />
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-600 uppercase tracking-wide">Yield axis ({r.isCotton ? 'lbs/ac' : 'bu/ac'})</span>
                      <CellInput value={cfg.yc ?? ''} placeholder={r.line.yield_per_acre != null ? String(r.line.yield_per_acre) : '—'} onCommit={(s) => setAxis(r.line.id, { yc: s })} width="w-20" title="center" />
                      <CellInput value={cfg.ys ?? ''} placeholder={String(defaultYieldStep(r.crop?.name))} onCommit={(s) => setAxis(r.line.id, { ys: s })} width="w-16" title="step" />
                      <CellInput value={cfg.yn ?? ''} placeholder="4" onCommit={(s) => setAxis(r.line.id, { yn: s })} width="w-12" title="± steps" />
                    </div>
                  </div>
                  {!grid ? (
                    <p className="text-sm text-amber-700">Enter a price and a yield on the line above to build this matrix.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm border-collapse">
                        <thead className={theadCls}>
                          <tr>
                            <th className="text-right px-2 py-1 whitespace-nowrap">{r.symbol ? `${r.symbol} ` : ''}{r.isCotton ? '$/lb' : '$/bu'} ↓ · {r.isCotton ? 'lbs/ac' : 'bu/ac'} →</th>
                            {grid.yieldValues.map((y, ci) => (
                              <th key={ci} className={`text-right px-2 py-1 tabular-nums ${ci === grid.hereCol ? 'bg-sky-100 text-sky-900' : ''}`}>{y.toLocaleString(undefined, { maximumFractionDigits: 1 })}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {grid.grid.map((row, ri) => (
                            <tr key={ri} className={`border-t border-slate-100 ${ri === grid.hereRow ? 'bg-sky-50/60' : ''}`}>
                              <td className={`px-2 py-1 text-right tabular-nums font-semibold whitespace-nowrap ${ri === grid.hereRow ? 'bg-sky-100 text-sky-900' : 'text-slate-600'}`}>
                                {fmtPriceFor(r.isCotton, grid.priceValues[ri])}
                              </td>
                              {row.map((cell, ci) => {
                                const val = matrixView === 'profit' ? cell.profitPerAcre : cell.revenuePerAcre
                                const here = ri === grid.hereRow && ci === grid.hereCol
                                return (
                                  <td key={ci}
                                    className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${matrixView === 'profit' && val != null ? toneText(signedTone(val)) : ''} ${here ? 'ring-2 ring-inset ring-sky-500 rounded font-bold' : ci === grid.hereCol ? 'bg-sky-50/60' : ''}`}>
                                    {usd2(val)}
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </details>
            )
          })}

          {/* ---- Methodology ---- */}
          <details className="bg-white rounded-xl shadow text-sm no-print">
            <summary className="cursor-pointer select-none px-4 py-3 font-semibold text-slate-700">How this budget is built</summary>
            <div className="border-t border-slate-100 px-4 py-3 space-y-2 text-slate-600">
              <p><strong className="text-slate-700">Defaults are seeds, not gospel</strong> — yield seeds from the
                acre-weighted APH across your most recent year&apos;s crop insurance policies (hover the APH chip for the
                derivation), falling back to the current expected yield; price defaults to the budget year&apos;s
                new-crop futures (DEC corn, NOV soybeans, JUL wheat, DEC cotton — these trade well ahead) plus your
                standing basis, toggleable to a manual price; cost seeds from this year&apos;s cost/acre. Every value is
                editable in place — an edited cell drops its seed chip.</p>
              <p><strong className="text-slate-700">Budgets are a sandbox</strong> — scenarios live in their own tables
                and never write to the marketing assumptions or any actuals. Duplicate a scenario to explore an
                alternative without disturbing the plan you&apos;ve built.</p>
              <p><strong className="text-slate-700">The matrices are pure price × yield</strong> — profit/acre =
                (price + basis) × yield − cost. No contracts, no harvest facts, no insurance floors, no government
                payments: pre-season, nothing is locked. For the in-season version with all of that machinery, use the{' '}
                <Link href="/reports/income-sensitivity" className="text-sky-700 underline">Income Sensitivity Report</Link>.</p>
              <p><strong className="text-slate-700">Reference acreage</strong> — the &quot;of ~X acres&quot; tracker is the sum
                of your fields&apos; total acres, shown for context only. It is deliberately not enforced: double-crop
                acres legitimately exceed it.</p>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
