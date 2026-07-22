'use client'

// Crop Budget Planner — the pre-season "what should I plant next year" tool.
// Scenario-based; budget_scenarios/budget_lines are a SANDBOX (never written
// to crop_assumptions or any actuals).
//
// Presentation follows the app's two established patterns:
//  - OUTPUT leads, Income-Sensitivity style: one full-width section per budget
//    line (or per crop in the Blended view), a compact read-only header of the
//    line's assumptions, and the price × yield matrix OPEN as the section body
//    — the matrix is the product, not a collapsible afterthought.
//  - ASSUMPTIONS live in a slide-over panel, Marketing-Dashboard style:
//    collapsible per-line editors, save-on-blur, the page recalcs live behind
//    the open panel. The main page has NO inline editing except the matrix
//    axis controls; clicking a header value opens the panel on that line.
//
// A page-level Blended | Broken out toggle collapses same-crop lines into one
// acre-weighted section per crop (display-time only — blendBudgetLines; the
// underlying lines are untouched and totals always sum the real lines).
//
// Assumption seeds (all editable): yield = practice-filtered acre-weighted APH
// (else expected-yield breakouts; DC lines seed from the DC breakouts, never
// APH); price = the budget-year NEW-CROP futures (ZCZ27-style) + standing
// basis, toggleable to manual; cost = the current year's cost/acre. Cotton
// prices are stored ¢/lb and displayed/entered as $/lb.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePersistentState } from '@/lib/use-persistent-state'
import { formatCottonPrice, parseCottonPriceInput, fmtPrice } from '@/lib/hedging'
import {
  blendBudgetLines, budgetContractLabel, budgetContractSymbol, budgetLineMath, budgetSeeds,
  buildBudgetMatrix, compareScenarios, duplicateLinesFor, isCottonName,
  lineDesignation, scenarioTotals, BUDGET_PRACTICE_LABEL,
  type BudgetLineMath, type BudgetMatrixCell, type BudgetSeeds,
} from '@/lib/crop-budget'
import { axisValues, closestIndex, defaultPriceStep, defaultYieldStep } from '@/lib/income-sensitivity'
import { EmptyState, theadCls, toneText, signedTone, grandTotalRowCls } from '@/components/reports/report-kit'
import { formatNumber, type ExportPayload, type ExportCell } from '@/lib/exports'
import type { BudgetLine, BudgetScenario, Crop, CropAssumption, CropInsurancePolicy, Entity } from '@/lib/types'

type Props = { onPayloadChange?: (build: () => ExportPayload) => void }

const btnCls = 'rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50'
const btnGray = 'rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50'
const acres0 = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })
const usd0 = (n: number | null | undefined) =>
  n == null ? '—' : `${n < 0 ? '(' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}${n < 0 ? ')' : ''}`
const usd2 = (n: number | null | undefined) =>
  n == null ? '—' : `${n < 0 ? '(' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${n < 0 ? ')' : ''}`

type LivePrice = { price: number; priceDate: string | null; stale: boolean }

type AxisCfg = { pc?: string; ps?: string; pn?: string; yc?: string; ys?: string; yn?: string }

type MatrixGrid = {
  priceValues: number[]
  yieldValues: number[]
  grid: BudgetMatrixCell[][]
  hereRow: number
  hereCol: number
  priceStep: number
  yieldStep: number
  cfg: AxisCfg
}

// ---------- shared inputs (save-on-blur; an unparseable entry reverts) ----------

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

// Module-scope so the input keeps identity/focus across re-renders (the
// income-sensitivity axis-field convention).
function AxisField({ label, value, placeholder, onCommit }: {
  label: string; value: string; placeholder: string; onCommit: (s: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => {
    if (draft === value) return
    if (draft.trim() !== '' && !Number.isFinite(Number(draft))) { setDraft(value); return }
    onCommit(draft)
  }
  return (
    <label className="flex items-center gap-1 text-xs text-slate-500">
      {label}
      <input
        type="text" inputMode="decimal" value={draft} placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="w-20 rounded border border-slate-300 px-2 py-1 text-right tabular-nums text-sm bg-white"
      />
    </label>
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

// ---------- per-line derived row ----------

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

// One rendered section: a real line (broken-out view) or a by-crop blend.
type DisplayRow = {
  key: string
  cropId: string
  crop: Crop | undefined
  isCotton: boolean
  symbol: string | null
  name: string
  /** "1,250 ac blended: 800 irr + 450 dry" for a multi-line blend, else null. */
  composition: string | null
  acres: number | null
  yieldPerAcre: number | null
  costPerAcre: number | null
  math: BudgetLineMath
  quoteDate: string | null
  /** The underlying lines (1 for a real line; 2+ for a blend). */
  lines: Row[]
  priceChip: { label: string; live: boolean; title: string }
  priceNote: string | null
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
  const [breakoutView, setBreakoutView] = usePersistentState<'broken' | 'blended'>('crop-budget:breakout', 'broken')
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelFocusId, setPanelFocusId] = useState<string | null>(null)

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
  // Totals ALWAYS sum the underlying lines — identical in both view modes.
  const totals = useMemo(() => scenarioTotals(rows.map((r) => ({ acres: r.line.acres, math: r.math }))), [rows])
  const missingInputs = useMemo(
    () => rows.filter((r) => r.line.acres == null || r.line.yield_per_acre == null || r.line.cost_per_acre == null).length,
    [rows],
  )
  const anyDesignation = rows.some((r) => r.line.practice != null || r.line.cropping === 'double_crop')
  const anyMultiLineCrop = useMemo(() => {
    const seen = new Set<string>()
    for (const r of rows) { if (seen.has(r.line.crop_id)) return true; seen.add(r.line.crop_id) }
    return false
  }, [rows])
  const showBreakoutToggle = anyDesignation || anyMultiLineCrop

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

  // ---------- display rows (Broken out = one per line; Blended = one per crop) ----------

  const displayRows: DisplayRow[] = useMemo(() => {
    const lineChip = (r: Row): DisplayRow['priceChip'] => ({
      label: r.line.price_mode === 'live' && !r.usedManualFallback ? (r.symbol ?? 'live') : 'manual',
      live: r.line.price_mode === 'live' && !r.usedManualFallback,
      title: r.line.price_mode === 'live'
        ? `${budgetContractLabel(r.crop?.name, scenario?.budget_crop_year ?? defaultBudgetYear) ?? 'Live futures'}${r.live ? ` as of ${r.live.priceDate ?? '—'}${r.live.stale ? ' (cached)' : ''}` : ' — not quoted'}${r.line.basis ? ' + basis' : ''}`
        : 'Manual price',
    })
    const lineNote = (r: Row): string | null =>
      r.usedManualFallback ? `${r.symbol} not quoted — using the manual price`
        : r.math.missingPrice ? `${r.symbol ?? 'contract'} not quoted — enter a manual price in Assumptions` : null

    if (breakoutView === 'broken') {
      return rows.map((r): DisplayRow => ({
        key: r.line.id,
        cropId: r.line.crop_id,
        crop: r.crop,
        isCotton: r.isCotton,
        symbol: r.symbol,
        name: lineName(r.line),
        composition: null,
        acres: r.line.acres != null ? Number(r.line.acres) : null,
        yieldPerAcre: r.line.yield_per_acre != null ? Number(r.line.yield_per_acre) : null,
        costPerAcre: r.line.cost_per_acre != null ? Number(r.line.cost_per_acre) : null,
        math: r.math,
        quoteDate: r.live?.priceDate ?? null,
        lines: [r],
        priceChip: lineChip(r),
        priceNote: lineNote(r),
      }))
    }
    // Blended: group by crop in first-seen sort order; blend is display-time
    // math only — the underlying lines are untouched.
    const order: string[] = []
    const byCrop = new Map<string, Row[]>()
    for (const r of rows) {
      if (!byCrop.has(r.line.crop_id)) { byCrop.set(r.line.crop_id, []); order.push(r.line.crop_id) }
      byCrop.get(r.line.crop_id)!.push(r)
    }
    return order.map((cropId): DisplayRow => {
      const group = byCrop.get(cropId)!
      const first = group[0]
      if (group.length === 1) {
        const r = first
        return {
          key: r.line.id, cropId, crop: r.crop, isCotton: r.isCotton, symbol: r.symbol,
          name: lineName(r.line), composition: null,
          acres: r.line.acres != null ? Number(r.line.acres) : null,
          yieldPerAcre: r.line.yield_per_acre != null ? Number(r.line.yield_per_acre) : null,
          costPerAcre: r.line.cost_per_acre != null ? Number(r.line.cost_per_acre) : null,
          math: r.math, quoteDate: r.live?.priceDate ?? null, lines: [r],
          priceChip: lineChip(r), priceNote: lineNote(r),
        }
      }
      const blend = blendBudgetLines(group.map((r) => ({
        practice: r.line.practice, cropping: r.line.cropping, label: r.line.label,
        acres: r.line.acres != null ? Number(r.line.acres) : null,
        yield_per_acre: r.line.yield_per_acre != null ? Number(r.line.yield_per_acre) : null,
        cost_per_acre: r.line.cost_per_acre != null ? Number(r.line.cost_per_acre) : null,
        effectivePrice: r.math.effectivePrice,
      })))
      const math = budgetLineMath({
        acres: blend.acres, yield_per_acre: blend.yieldPerAcre, price_mode: 'manual',
        manual_price: blend.effectivePrice, basis: 0, cost_per_acre: blend.costPerAcre,
      }, null, first.isCotton)
      const anyMissingPrice = group.some((r) => r.math.effectivePrice == null)
      return {
        key: `crop:${cropId}`, cropId, crop: first.crop, isCotton: first.isCotton, symbol: first.symbol,
        name: cropName(cropId),
        composition: `${blend.acres != null ? acres0(blend.acres) : '—'} ac blended: ${blend.composition}`,
        acres: blend.acres, yieldPerAcre: blend.yieldPerAcre, costPerAcre: blend.costPerAcre,
        math, quoteDate: first.live?.priceDate ?? null, lines: group,
        priceChip: {
          label: 'blended', live: false,
          title: 'Acre-weighted effective price across this crop’s lines (identical when they share the contract).',
        },
        priceNote: anyMissingPrice ? 'A line in this blend has no price yet — set it in Assumptions' : null,
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, breakoutView, scenario?.budget_crop_year, cropById])

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

  async function addLine(cropId: string, practice: BudgetLine['practice'], cropping: BudgetLine['cropping']) {
    if (!scenario || !cropId) return
    const crop = cropById.get(cropId)
    const assumption = assumptions.find((a) => a.crop_id === cropId && a.crop_year === currentCropYear)
    const seeds = budgetSeeds({ policies, assumption, cropId, practice, cropping })
    try {
      const { error } = await supabase.from('budget_lines').insert({
        scenario_id: scenario.id,
        crop_id: cropId,
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

  function openAssumptions(focusLineId?: string) {
    setPanelFocusId(focusLineId ?? null)
    setPanelOpen(true)
  }

  // ---------- matrix axis state (session-local; defaults recenter on the row) ----------

  const [axisByKey, setAxisByKey] = useState<Record<string, AxisCfg>>({})
  const setAxis = (key: string, patch: Partial<AxisCfg>) =>
    setAxisByKey((m) => ({ ...m, [key]: { ...(m[key] ?? {}), ...patch } }))

  const parseNum = (s: string | undefined): number | null => {
    if (s == null || s.trim() === '') return null
    const v = Number(s)
    return Number.isFinite(v) ? v : null
  }

  const matrixGridFor = useCallback((d: DisplayRow): MatrixGrid | null => {
    const cfg = axisByKey[d.key] ?? {}
    const priceCenter = parseNum(cfg.pc) ?? d.math.effectivePrice
    const yieldCenter = parseNum(cfg.yc) ?? d.yieldPerAcre
    if (priceCenter == null || yieldCenter == null || priceCenter <= 0 || yieldCenter <= 0) return null
    const priceStep = parseNum(cfg.ps) ?? defaultPriceStep(d.crop?.name)
    const yieldStep = parseNum(cfg.ys) ?? defaultYieldStep(d.crop?.name)
    const priceSteps = Math.min(10, Math.max(1, Math.round(parseNum(cfg.pn) ?? 4)))
    const yieldSteps = Math.min(10, Math.max(1, Math.round(parseNum(cfg.yn) ?? 4)))
    const priceValues = axisValues({ center: priceCenter, step: priceStep, steps: priceSteps })
    const yieldValues = axisValues({ center: yieldCenter, step: yieldStep, steps: yieldSteps })
    return {
      priceValues, yieldValues,
      grid: buildBudgetMatrix({ priceValues, yieldValues, costPerAcre: d.costPerAcre, isCotton: d.isCotton }),
      hereRow: closestIndex(priceValues, d.math.effectivePrice),
      hereCol: closestIndex(yieldValues, d.yieldPerAcre),
      priceStep, yieldStep, cfg,
    }
  }, [axisByKey])

  // ---------- export payload ----------

  const buildExportPayload = useCallback((): ExportPayload => {
    const viewLabel = breakoutView === 'blended' ? 'Blended by crop' : 'Broken out by practice'
    const sections: ExportPayload['sections'] = []
    sections.push({
      title: `Allocation — ${scenario?.name ?? ''} (${scenario?.budget_crop_year ?? defaultBudgetYear} budget)`,
      columns: [
        { label: 'Crop' }, { label: 'Acres', align: 'right', format: 'acres' },
        { label: 'Yield/ac', align: 'right', format: 'yield' },
        { label: 'Price', align: 'right' },
        { label: 'Revenue/ac', align: 'right', format: 'usd2' }, { label: 'Cost/ac', align: 'right', format: 'usd2' },
        { label: 'Profit/ac', align: 'right', format: 'usd2' }, { label: 'Total Profit', align: 'right', format: 'usd0' },
      ],
      rows: [
        ...displayRows.map((d): ExportCell[] => [
          d.composition ? `${d.name} — ${d.composition}` : d.name,
          d.acres ?? '',
          d.yieldPerAcre != null ? Math.round(d.yieldPerAcre * 10) / 10 : '',
          d.math.effectivePrice != null ? { v: d.math.effectivePrice, format: d.isCotton ? 'cents' as const : 'price' as const } : '',
          d.math.revenuePerAcre ?? '',
          d.costPerAcre != null ? Math.round(d.costPerAcre * 100) / 100 : '',
          d.math.profitPerAcre != null ? { v: d.math.profitPerAcre, tone: signedTone(d.math.profitPerAcre) } : '',
          d.math.totalProfit != null ? { v: d.math.totalProfit, tone: signedTone(d.math.totalProfit) } : '',
        ]),
        ['Total', totals.totalAcres, '', '', '', '', totals.weightedProfitPerAcre ?? '', { v: totals.totalProfit, tone: signedTone(totals.totalProfit) }],
      ],
      rowMeta: [...displayRows.map(() => 'data' as const), 'total' as const],
    })
    for (const d of displayRows) {
      const grid = matrixGridFor(d)
      if (!grid) continue
      sections.push({
        title: `${d.name} — price × yield ${matrixView === 'profit' ? 'profit' : 'revenue'}/ac`,
        columns: [
          { label: `Price ${d.isCotton ? '$/lb' : '$/bu'}`, align: 'right', format: d.isCotton ? 'cents' : 'price' },
          ...grid.yieldValues.map((y) => ({ label: `${formatNumber(y, 'yield')} ${d.isCotton ? 'lbs/ac' : 'bu/ac'}`, align: 'right' as const, format: 'usd2' as const })),
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
        `View: ${viewLabel}`,
        quoteDate ? `Futures quotes as of ${quoteDate}` : 'No live quotes',
        'Pre-season budget — no contracts, insurance, or government payments',
      ].join(' · '),
      summary: [
        { label: 'Total acres', value: acres0(totals.totalAcres) },
        { label: 'Weighted profit/acre', value: usd2(totals.weightedProfitPerAcre), tone: totals.weightedProfitPerAcre != null ? signedTone(totals.weightedProfitPerAcre) : undefined },
        { label: 'Total projected profit', value: usd0(totals.totalProfit), tone: signedTone(totals.totalProfit) },
      ],
      sections,
      orientation: 'landscape',
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRows, totals, scenario, quoteDate, matrixView, breakoutView, matrixGridFor])

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
  }, [buildExportPayload, onPayloadChange])

  // ---------- render ----------

  if (loading) return <p className="text-slate-500">Loading…</p>

  return (
    <div className="space-y-4 print-area">
      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Top bar: scenario mgmt + budget year + Assumptions */}
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
        {scenario && (
          <button
            type="button"
            onClick={() => openAssumptions()}
            className={`relative inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-white shadow-sm ml-auto ${missingInputs > 0 ? 'bg-amber-500 hover:bg-amber-600' : 'bg-sky-700 hover:bg-sky-800'}`}
            title="Edit acres, yield, price, cost, and breakouts for each budget line"
          >
            <span aria-hidden>⚙</span> Assumptions
            {missingInputs > 0 && (
              <span className="rounded-full bg-white/25 text-white text-xs px-1.5 py-0.5 leading-none">
                {missingInputs} missing
              </span>
            )}
          </button>
        )}
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
          {/* Slim summary band — always the sum of the underlying lines,
              identical in both view modes. */}
          <div className="bg-white rounded-xl shadow px-4 py-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <h2 className="font-bold">{scenario.name} — {scenario.budget_crop_year}</h2>
            <div className="text-sm">
              <span className="text-slate-500">Total acres</span>{' '}
              <span className="font-bold tabular-nums">{acres0(totals.totalAcres)}</span>
            </div>
            <div className="text-sm">
              <span className="text-slate-500">Weighted profit/acre</span>{' '}
              <span className={`font-bold tabular-nums ${totals.weightedProfitPerAcre != null ? toneText(signedTone(totals.weightedProfitPerAcre)) : 'text-slate-400'}`}>
                {usd2(totals.weightedProfitPerAcre)}
              </span>
            </div>
            <div className="text-sm">
              <span className="text-slate-500">Total projected profit</span>{' '}
              <span className={`font-bold tabular-nums ${toneText(signedTone(totals.totalProfit))}`}>{usd0(totals.totalProfit)}</span>
            </div>
            <span className="text-xs text-slate-500 tabular-nums">
              {referenceAcres > 0 && <>{acres0(totals.totalAcres)} of ~{acres0(referenceAcres)} reference acres (your fields&apos; total — context only; double-crop legitimately overlaps)</>}
            </span>
            {totals.incompleteLines > 0 && (
              <button type="button" onClick={() => openAssumptions()} className="text-xs text-amber-700 underline decoration-dotted no-print">
                {totals.incompleteLines} line{totals.incompleteLines === 1 ? '' : 's'} missing inputs — excluded from profit
              </button>
            )}
          </div>

          {rows.length === 0 && (
            <div className="bg-white rounded-xl shadow p-8 text-center text-slate-500 space-y-2">
              <p>No budget lines in this scenario yet.</p>
              <button type="button" className={btnCls} onClick={() => openAssumptions()}>Open Assumptions to add crops</button>
            </div>
          )}

          {/* View toggles */}
          {rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 no-print">
              <span className="text-sm text-slate-500">Price × yield matrices — pure budget math per cell</span>
              <span className="ml-auto flex items-center gap-3">
                {showBreakoutToggle && (
                  <span className="inline-flex rounded-lg border border-slate-300 overflow-hidden" title="Blended collapses same-crop lines into one acre-weighted section per crop (display only — the underlying lines are untouched).">
                    {(['blended', 'broken'] as const).map((m) => (
                      <button key={m} type="button" onClick={() => setBreakoutView(m)}
                        className={`px-3 py-1.5 text-sm font-semibold ${breakoutView === m ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'} ${m === 'broken' ? 'border-l border-slate-300' : ''}`}>
                        {m === 'blended' ? 'Blended' : 'Broken out'}
                      </button>
                    ))}
                  </span>
                )}
                <span className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
                  {(['revenue', 'profit'] as const).map((m) => (
                    <button key={m} type="button" onClick={() => setMatrixView(m)}
                      className={`px-3 py-1.5 text-sm font-semibold ${matrixView === m ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'} ${m === 'profit' ? 'border-l border-slate-300' : ''}`}>
                      {m === 'revenue' ? 'Revenue/acre' : 'Profit/acre'}
                    </button>
                  ))}
                </span>
              </span>
            </div>
          )}

          {/* One full-width section per display row, matrices open */}
          {displayRows.map((d) => (
            <BudgetSection
              key={d.key}
              d={d}
              mode={matrixView}
              grid={matrixGridFor(d)}
              onAxis={(patch) => setAxis(d.key, patch)}
              onOpenAssumptions={() => openAssumptions(d.lines[0].line.id)}
            />
          ))}

          {/* Compare view */}
          {compareId && (() => {
            const other = scenarios.find((s) => s.id === compareId)
            if (!other) return null
            type Cmp = { cropId: string; label: string | null; practice?: BudgetLine['practice']; cropping?: BudgetLine['cropping']; acres: number | null; totalProfit: number | null }
            const collapseByCrop = (xs: Cmp[]): Cmp[] => {
              const m = new Map<string, Cmp>()
              for (const x of xs) {
                const cur = m.get(x.cropId)
                if (!cur) m.set(x.cropId, { cropId: x.cropId, label: null, acres: x.acres, totalProfit: x.totalProfit })
                else {
                  cur.acres = cur.acres == null && x.acres == null ? null : (cur.acres ?? 0) + (x.acres ?? 0)
                  cur.totalProfit = cur.totalProfit == null && x.totalProfit == null ? null : (cur.totalProfit ?? 0) + (x.totalProfit ?? 0)
                }
              }
              return [...m.values()]
            }
            let otherRows: Cmp[] = lines.filter((l) => l.scenario_id === other.id).map((l) => {
              const r = rowFor(l, other.budget_crop_year)
              return { cropId: l.crop_id, label: l.label, practice: l.practice, cropping: l.cropping, acres: l.acres, totalProfit: r.math.totalProfit }
            })
            let mineRows: Cmp[] = rows.map((r) => ({ cropId: r.line.crop_id, label: r.line.label, practice: r.line.practice, cropping: r.line.cropping, acres: r.line.acres, totalProfit: r.math.totalProfit }))
            if (breakoutView === 'blended') {
              mineRows = collapseByCrop(mineRows)
              otherRows = collapseByCrop(otherRows)
            }
            const cmp = compareScenarios(mineRows, otherRows)
            const otherTotals = totalsByScenario.get(other.id)
            return (
              <section className="bg-white rounded-xl shadow p-4 avoid-break overflow-x-auto space-y-2">
                <h2 className="font-bold text-lg">Compare — {scenario.name} vs {other.name}
                  {breakoutView === 'blended' && <span className="ml-2 text-xs font-normal text-slate-500">blended by crop</span>}
                </h2>
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
                <p className="text-xs text-slate-500">Δ = {other.name} − {scenario.name}. Lines missing from one scenario count as zero there. Totals always sum the underlying lines.</p>
              </section>
            )
          })()}

          {/* Methodology */}
          <details className="bg-white rounded-xl shadow text-sm no-print">
            <summary className="cursor-pointer select-none px-4 py-3 font-semibold text-slate-700">How this budget is built</summary>
            <div className="border-t border-slate-100 px-4 py-3 space-y-2 text-slate-600">
              <p><strong className="text-slate-700">All assumption entry lives in the Assumptions panel</strong> — acres,
                yield, price (live budget-year futures or manual, plus basis), cost, and the irrigated/dryland and
                full-season/double-crop breakouts. The page behind the panel recalculates live as you type. Defaults are
                seeds, not gospel: yield seeds from the practice-filtered acre-weighted APH across your most recent
                year&apos;s policies (else your expected-yield breakouts; double-crop lines seed from the DC breakouts,
                never APH), price from the budget year&apos;s new-crop futures (DEC corn, NOV soybeans, JUL wheat, DEC
                cotton) plus your standing basis, cost from this year&apos;s cost/acre. An edited value drops its seed chip.</p>
              <p><strong className="text-slate-700">Blended vs Broken out</strong> — Broken out shows each budget line as
                its own section and matrix, exactly as entered. Blended collapses same-crop lines into one section per
                crop: acres summed, yield and cost acre-weighted, and one matrix on the weighted assumptions. Blending is
                display-time math only — the underlying lines are untouched, and the allocation totals and comparison
                strip always sum the real lines, so both views foot identically.</p>
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

      {/* Assumptions slide-over */}
      {panelOpen && scenario && (
        <AssumptionsPanel
          scenario={scenario}
          rows={rows}
          crops={crops}
          currentCropYear={currentCropYear}
          focusId={panelFocusId}
          lineName={lineName}
          onPatch={patchLine}
          onBreakout={setLineBreakout}
          onRemove={removeLine}
          onMove={moveLine}
          onAdd={addLine}
          onRefreshQuote={(sym) => void fetchQuotes([sym], true)}
          onClose={() => { setPanelOpen(false); setPanelFocusId(null) }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One full-width section per display row (Income-Sensitivity layout language):
// read-only assumption header + breakevens, axis controls, and the matrix OPEN
// as the body. Header values click through to the Assumptions panel.
// ---------------------------------------------------------------------------
function BudgetSection({ d, mode, grid, onAxis, onOpenAssumptions }: {
  d: DisplayRow
  mode: 'revenue' | 'profit'
  grid: MatrixGrid | null
  onAxis: (patch: Partial<AxisCfg>) => void
  onOpenAssumptions: () => void
}) {
  const cfg = grid?.cfg ?? {}
  const yUnit = d.isCotton ? 'lbs/ac' : 'bu/ac'
  const stat = (label: string, value: string, tone?: string) => (
    <div className="text-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`font-semibold tabular-nums ${tone ?? ''}`}>{value}</div>
    </div>
  )
  return (
    <section className="bg-white rounded-xl shadow avoid-break">
      <div className="p-4 md:p-5 space-y-3">
        {/* Identity + read-only assumptions (click → Assumptions panel) */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="font-bold text-xl leading-tight">{d.name}</div>
            {d.composition
              ? <div className="text-sm text-slate-500 tabular-nums mt-0.5">{d.composition}</div>
              : <div className="text-sm text-slate-500 tabular-nums mt-0.5">{d.acres != null ? `${acres0(d.acres)} acres` : 'acres not set'}</div>}
          </div>
          <button
            type="button"
            onClick={onOpenAssumptions}
            title="Edit in Assumptions"
            className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg px-2 py-1 -mx-2 hover:bg-slate-50 text-left"
          >
            {stat('Acres', d.acres != null ? acres0(d.acres) : '—')}
            {stat(`Yield (${yUnit})`, d.yieldPerAcre != null ? (Math.round(d.yieldPerAcre * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—')}
            <div className="text-sm">
              <div className="text-xs text-slate-500">Price ({d.isCotton ? '$/lb' : '$/bu'})</div>
              <div className="font-semibold tabular-nums flex items-center gap-1.5">
                {fmtPriceFor(d.isCotton, d.math.effectivePrice)}
                <span
                  className={`text-[10px] rounded-full px-1.5 py-0.5 border font-normal ${d.priceChip.live ? 'bg-sky-100 text-sky-800 border-sky-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}
                  title={d.priceChip.title}
                >
                  {d.priceChip.label}
                </span>
              </div>
              {d.quoteDate && d.priceChip.live && <div className="text-[10px] text-slate-400">as of {d.quoteDate}</div>}
            </div>
            {stat('Cost/ac', d.costPerAcre != null ? usd2(Math.round(d.costPerAcre * 100) / 100) : '—')}
            {stat('Profit/ac', usd2(d.math.profitPerAcre), d.math.profitPerAcre != null ? toneText(signedTone(d.math.profitPerAcre)) : 'text-slate-400')}
            {stat('Total profit', usd0(d.math.totalProfit), d.math.totalProfit != null ? `font-bold ${toneText(signedTone(d.math.totalProfit))}` : 'text-slate-400')}
          </button>
          <span className="text-xs text-slate-500 tabular-nums ml-auto">
            breakeven price <strong className="text-slate-700">{fmtPriceFor(d.isCotton, d.math.breakevenPrice)}</strong> at {d.yieldPerAcre != null ? Math.round(d.yieldPerAcre * 10) / 10 : '—'} {d.isCotton ? 'lbs' : 'bu'}/ac
            {' '}· breakeven yield <strong className="text-slate-700">{d.math.breakevenYield != null ? d.math.breakevenYield.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} {d.isCotton ? 'lbs' : 'bu'}/ac</strong> at {fmtPriceFor(d.isCotton, d.math.effectivePrice)}
          </span>
        </div>

        {d.priceNote && <p className="text-xs text-amber-700">{d.priceNote}</p>}

        {/* Axis controls. Cotton price fields read/accept $/lb; stored ¢. */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 no-print">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Price axis ({d.isCotton ? '$/lb' : '$/bu'})</span>
            <AxisField
              label="center"
              value={d.isCotton && cfg.pc ? String(Number(cfg.pc) / 100) : cfg.pc ?? ''}
              placeholder={d.math.effectivePrice != null ? (d.isCotton ? (d.math.effectivePrice / 100).toFixed(2) : d.math.effectivePrice.toFixed(2)) : '—'}
              onCommit={(s) => onAxis({ pc: s.trim() === '' ? '' : String(inputToPrice(d.isCotton, s) ?? '') })}
            />
            <AxisField
              label="step"
              value={d.isCotton && cfg.ps ? String(Number(cfg.ps) / 100) : cfg.ps ?? ''}
              placeholder={(d.isCotton ? defaultPriceStep(d.crop?.name) / 100 : defaultPriceStep(d.crop?.name)).toFixed(2)}
              onCommit={(s) => onAxis({ ps: s.trim() === '' ? '' : String(inputToPrice(d.isCotton, s, 0.25) ?? '') })}
            />
            <AxisField label="± steps" value={cfg.pn ?? ''} placeholder="4" onCommit={(s) => onAxis({ pn: s })} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Yield axis ({yUnit})</span>
            <AxisField label="center" value={cfg.yc ?? ''} placeholder={d.yieldPerAcre != null ? String(Math.round(d.yieldPerAcre * 10) / 10) : '—'} onCommit={(s) => onAxis({ yc: s })} />
            <AxisField label="step" value={cfg.ys ?? ''} placeholder={String(defaultYieldStep(d.crop?.name))} onCommit={(s) => onAxis({ ys: s })} />
            <AxisField label="± steps" value={cfg.yn ?? ''} placeholder="4" onCommit={(s) => onAxis({ yn: s })} />
          </div>
        </div>

        {/* The matrix — open, the product of this section */}
        {!grid ? (
          <p className="text-sm text-amber-700">
            Set a price and a yield in{' '}
            <button type="button" className="underline" onClick={onOpenAssumptions}>Assumptions</button>
            {' '}to build this matrix.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm border-collapse">
              <thead className={theadCls}>
                <tr>
                  <th className="text-right px-2 py-1 whitespace-nowrap">
                    {d.symbol ? `${d.symbol} futures` : 'Price'} {d.isCotton ? '$/lb' : '$/bu'} ↓
                  </th>
                  {grid.yieldValues.map((y: number, ci: number) => (
                    <th key={ci} className={`text-right px-2 py-1 whitespace-nowrap tabular-nums ${ci === grid.hereCol ? 'bg-sky-100 text-sky-900' : ''}`}
                      title={ci === grid.hereCol ? 'Closest to the budget yield' : undefined}>
                      {y.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th className="text-right px-2 py-0.5 text-[10px] font-normal text-slate-400" colSpan={1 + grid.yieldValues.length}>
                    Yield ({yUnit}) →
                  </th>
                </tr>
              </thead>
              <tbody>
                {grid.grid.map((row, ri: number) => (
                  <tr key={ri} className={`border-t border-slate-100 ${ri === grid.hereRow ? 'bg-sky-50/60' : ''}`}>
                    <td className={`px-2 py-1 text-right tabular-nums font-semibold whitespace-nowrap ${ri === grid.hereRow ? 'bg-sky-100 text-sky-900' : 'text-slate-600'}`}
                      title={ri === grid.hereRow ? 'Closest to the budget price' : undefined}>
                      {fmtPriceFor(d.isCotton, grid.priceValues[ri])}
                    </td>
                    {row.map((cell, ci: number) => {
                      const val = mode === 'profit' ? cell.profitPerAcre : cell.revenuePerAcre
                      const here = ri === grid.hereRow && ci === grid.hereCol
                      return (
                        <td key={ci}
                          className={`px-2 py-1 text-right tabular-nums whitespace-nowrap ${mode === 'profit' && val != null ? toneText(signedTone(val)) : ''} ${here ? 'ring-2 ring-inset ring-sky-500 rounded font-bold' : ci === grid.hereCol ? 'bg-sky-50/60' : ''}`}
                          title={`${fmtPriceFor(d.isCotton, cell.price)} × ${cell.yield.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${yUnit}`}>
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
    </section>
  )
}

// ---------------------------------------------------------------------------
// Assumptions slide-over (Marketing-Dashboard pattern): collapsible per-line
// editors, save-on-blur, live recalc behind the open panel. Add/Remove line
// live here — the main page has no inline editing.
// ---------------------------------------------------------------------------
function AssumptionsPanel({
  scenario, rows, crops, currentCropYear, focusId, lineName,
  onPatch, onBreakout, onRemove, onMove, onAdd, onRefreshQuote, onClose,
}: {
  scenario: BudgetScenario
  rows: Row[]
  crops: Crop[]
  currentCropYear: number
  focusId: string | null
  lineName: (l: BudgetLine) => string
  onPatch: (id: string, patch: Partial<BudgetLine>) => void
  onBreakout: (r: Row, patch: { practice?: BudgetLine['practice']; cropping?: BudgetLine['cropping'] }) => void
  onRemove: (l: BudgetLine) => void
  onMove: (l: BudgetLine, dir: -1 | 1) => void
  onAdd: (cropId: string, practice: BudgetLine['practice'], cropping: BudgetLine['cropping']) => void
  onRefreshQuote: (symbol: string) => void
  onClose: () => void
}) {
  const [openId, setOpenId] = useState<string | null>(focusId ?? rows[0]?.line.id ?? null)
  const [addCropId, setAddCropId] = useState('')
  const [addPractice, setAddPractice] = useState<'' | 'irrigated' | 'non_irrigated'>('')
  const [addCropping, setAddCropping] = useState<'' | 'double_crop'>('')
  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const addCropIsDc = cropById.get(addCropId)?.double_crop === true

  useEffect(() => {
    if (!focusId) return
    setOpenId(focusId)
    // Scroll the focused card into view once the panel has rendered.
    const t = setTimeout(() => document.getElementById(`budget-line-${focusId}`)?.scrollIntoView({ block: 'center' }), 50)
    return () => clearTimeout(t)
  }, [focusId])

  const numOrNull = (s: string): number | null => {
    if (s.trim() === '') return null
    const v = Number(s)
    return Number.isFinite(v) ? v : null
  }

  return (
    <div className="fixed inset-0 z-40 no-print">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-xl bg-slate-50 shadow-xl overflow-y-auto">
        <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <div className="flex-1">
            <h2 className="font-bold">Assumptions — {scenario.name} ({scenario.budget_crop_year} budget)</h2>
            <p className="text-xs text-slate-500">Changes save on blur and recalculate the page live; this panel stays open.</p>
          </div>
          <button onClick={onClose} className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm font-semibold">Done</button>
        </div>
        <div className="p-4 space-y-2">
          {rows.length === 0 && <p className="text-sm text-slate-500">No budget lines yet — add a crop below.</p>}
          {rows.map((r, i) => {
            const l = r.line
            const isOpen = openId === l.id
            const missing: string[] = []
            if (l.acres == null) missing.push('acres')
            if (l.yield_per_acre == null) missing.push('yield')
            if (l.cost_per_acre == null) missing.push('cost')
            const yieldIsSeed = r.seeds.yield != null && l.yield_per_acre != null && Math.abs(Number(l.yield_per_acre) - r.seeds.yield) < 1e-9
            const costIsSeed = r.seeds.cost != null && l.cost_per_acre != null && Math.abs(Number(l.cost_per_acre) - r.seeds.cost) < 1e-9
            const isDcCrop = r.crop?.double_crop === true
            return (
              <div key={l.id} id={`budget-line-${l.id}`} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : l.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left"
                >
                  <span className="text-slate-400">{isOpen ? '▾' : '▸'}</span>
                  <span className="font-semibold flex-1">{lineName(l)}</span>
                  {missing.length > 0
                    ? <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">needs {missing.join(' · ')}</span>
                    : <span className="text-xs text-slate-500 tabular-nums">
                        {acres0(Number(l.acres))} ac · {Number(l.yield_per_acre).toLocaleString(undefined, { maximumFractionDigits: 1 })} {r.isCotton ? 'lbs' : 'bu'} · {usd0(Number(l.cost_per_acre))}/ac
                      </span>}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 border-t border-slate-100 pt-2 space-y-3">
                    <div className="flex flex-wrap gap-x-5 gap-y-2">
                      <label className="text-xs text-slate-500 flex flex-col gap-1">
                        Acres
                        <CellInput value={l.acres != null ? String(l.acres) : ''} placeholder="acres" onCommit={(s) => onPatch(l.id, { acres: numOrNull(s) })} width="w-24" />
                      </label>
                      <label className="text-xs text-slate-500 flex flex-col gap-1">
                        <span>
                          Yield ({r.isCotton ? 'lbs/ac' : 'bu/ac'})
                          {yieldIsSeed && (
                            <span className="ml-1 rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5 cursor-help"
                              title={r.seeds.yieldSource === 'aph' && r.seeds.aph
                                ? `APH ${r.seeds.aph.yield} — weighted from ${r.seeds.aph.policyCount} ${r.seeds.aph.cropYear}${l.practice ? ` ${BUDGET_PRACTICE_LABEL[l.practice].toLowerCase()}` : ''} ${r.seeds.aph.policyCount === 1 ? 'policy' : 'policies'}`
                                : r.seeds.yieldSource === 'expected_dc'
                                  ? `Seeded from your ${currentCropYear} double-crop expected yield${l.practice ? ` (${BUDGET_PRACTICE_LABEL[l.practice].toLowerCase()})` : ''}`
                                  : `Seeded from your ${currentCropYear} expected yield${l.practice ? ` (${BUDGET_PRACTICE_LABEL[l.practice].toLowerCase()})` : ''}`}>
                              {r.seeds.yieldSource === 'aph' ? 'APH' : r.seeds.yieldSource === 'expected_dc' ? 'DC exp.' : 'expected'}
                            </span>
                          )}
                        </span>
                        <CellInput value={l.yield_per_acre != null ? String(l.yield_per_acre) : ''} placeholder={r.isCotton ? 'lbs/ac' : 'bu/ac'} onCommit={(s) => onPatch(l.id, { yield_per_acre: numOrNull(s) })} width="w-24" />
                      </label>
                      <label className="text-xs text-slate-500 flex flex-col gap-1">
                        <span>
                          Cost/acre
                          {costIsSeed && (
                            <span className="ml-1 rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5 cursor-help"
                              title={`Seeded from your ${currentCropYear}${r.seeds.costSource === 'assumption_dc' ? ' double-crop' : ''}${l.practice ? ` ${BUDGET_PRACTICE_LABEL[l.practice].toLowerCase()}` : ''} cost/acre — edit freely, the budget never writes back.`}>
                              from {currentCropYear}{r.seeds.costSource === 'assumption_dc' ? ' DC' : ''}
                            </span>
                          )}
                        </span>
                        <CellInput value={l.cost_per_acre != null ? String(l.cost_per_acre) : ''} placeholder="$/ac" onCommit={(s) => onPatch(l.id, { cost_per_acre: numOrNull(s) })} width="w-24" />
                      </label>
                    </div>

                    <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
                      <div className="text-xs text-slate-500 flex flex-col gap-1">
                        <span>Price</span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className={`text-[10px] rounded-full px-1.5 py-0.5 border ${l.price_mode === 'live' ? 'bg-sky-100 text-sky-800 border-sky-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}
                            title={l.price_mode === 'live' ? 'Live budget-year futures — click for manual' : 'Manual price — click for live futures'}
                            onClick={() => onPatch(l.id, { price_mode: l.price_mode === 'live' ? 'manual' : 'live' })}
                          >
                            {l.price_mode === 'live' ? (r.symbol ?? 'live') : 'manual'}
                          </button>
                          {l.price_mode === 'live' && !r.usedManualFallback ? (
                            <span className="tabular-nums font-mono text-sm text-slate-700" title={r.live ? `${budgetContractLabel(r.crop?.name, scenario.budget_crop_year)} as of ${r.live.priceDate ?? '—'}${r.live.stale ? ' (cached)' : ''}` : undefined}>
                              {r.live ? fmtPriceFor(r.isCotton, r.live.price) : '—'}
                            </span>
                          ) : (
                            <CellInput
                              value={priceToInput(r.isCotton, l.manual_price)}
                              placeholder={r.isCotton ? '$/lb' : '$/bu'}
                              onCommit={(s) => onPatch(l.id, { manual_price: inputToPrice(r.isCotton, s) })}
                              width="w-20"
                            />
                          )}
                          {l.price_mode === 'live' && r.symbol && (
                            <button type="button" className="text-xs text-sky-700" title="Refresh this quote" onClick={() => onRefreshQuote(r.symbol!)}>↻</button>
                          )}
                        </div>
                        {r.math.missingPrice && !r.usedManualFallback && (
                          <span className="text-[10px] text-amber-700">{r.symbol ?? 'contract'} not quoted — enter a manual price</span>
                        )}
                        {r.usedManualFallback && (
                          <span className="text-[10px] text-amber-700">{r.symbol} not quoted — using your manual price</span>
                        )}
                      </div>
                      <label className="text-xs text-slate-500 flex flex-col gap-1">
                        Basis ({r.isCotton ? '+/− $/lb' : '+/− $/bu'})
                        <CellInput
                          value={priceToInput(r.isCotton, l.basis)}
                          placeholder={r.isCotton ? '+/− $/lb' : '+/− $/bu'}
                          onCommit={(s) => onPatch(l.id, { basis: inputToPrice(r.isCotton, s, 0.25) ?? 0 })}
                          width="w-20"
                        />
                      </label>
                      <div className="text-xs text-slate-500 pb-1">
                        = <span className="font-semibold text-slate-700 tabular-nums">{fmtPriceFor(r.isCotton, r.math.effectivePrice)}</span> effective
                      </div>
                    </div>

                    <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
                      <label className="text-xs text-slate-500 flex flex-col gap-1">
                        Practice
                        <select
                          value={l.practice ?? ''} title="Irrigated / dryland breakout — re-seeds untouched yield & cost"
                          onChange={(e) => onBreakout(r, { practice: (e.target.value || null) as BudgetLine['practice'] })}
                          className="rounded border border-slate-300 px-2 py-1 text-sm bg-white"
                        >
                          <option value="">Blended</option>
                          <option value="irrigated">Irrigated</option>
                          <option value="non_irrigated">Dryland</option>
                        </select>
                      </label>
                      {isDcCrop && (
                        <label className="text-xs text-slate-500 flex flex-col gap-1">
                          Cropping
                          <select
                            value={l.cropping === 'double_crop' ? 'double_crop' : ''} title="Full-season / double-crop — DC seeds from the DC yield & cost breakouts"
                            onChange={(e) => onBreakout(r, { cropping: e.target.value === 'double_crop' ? 'double_crop' : null })}
                            className="rounded border border-slate-300 px-2 py-1 text-sm bg-white"
                          >
                            <option value="">Full-season</option>
                            <option value="double_crop">Double-crop</option>
                          </select>
                        </label>
                      )}
                      <label className="text-xs text-slate-500 flex flex-col gap-1">
                        Label (optional)
                        <input
                          type="text" defaultValue={l.label ?? ''} placeholder='e.g. "behind wheat"'
                          onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (l.label ?? null)) onPatch(l.id, { label: v }) }}
                          className="rounded border border-slate-300 px-2 py-1 text-sm bg-white w-40"
                        />
                      </label>
                    </div>

                    <div className="flex items-center gap-2 pt-1 border-t border-slate-100">
                      <button type="button" className="text-slate-400 disabled:opacity-30 text-sm" disabled={i === 0} onClick={() => onMove(l, -1)} title="Move up">↑</button>
                      <button type="button" className="text-slate-400 disabled:opacity-30 text-sm" disabled={i === rows.length - 1} onClick={() => onMove(l, 1)} title="Move down">↓</button>
                      <button type="button" className="ml-auto text-xs text-red-600 hover:underline" onClick={() => onRemove(l)}>Remove line</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* Add line */}
          <div className="bg-white rounded-lg border border-dashed border-slate-300 px-3 py-2 flex flex-wrap items-center gap-2">
            <select value={addCropId} onChange={(e) => { setAddCropId(e.target.value); setAddCropping('') }} className="rounded border border-slate-300 px-2 py-1 bg-white text-sm">
              <option value="">— add a crop line —</option>
              {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={addPractice} onChange={(e) => setAddPractice(e.target.value as typeof addPractice)} className="rounded border border-slate-300 px-2 py-1 bg-white text-sm" title="Irrigated / dryland breakout — seeds practice-specific APH and cost">
              <option value="">Blended</option>
              <option value="irrigated">Irrigated</option>
              <option value="non_irrigated">Dryland</option>
            </select>
            {addCropIsDc && (
              <select value={addCropping} onChange={(e) => setAddCropping(e.target.value as typeof addCropping)} className="rounded border border-slate-300 px-2 py-1 bg-white text-sm" title="This crop is designated double-crop — a DC line seeds from your DC yield/cost breakouts">
                <option value="">Full-season</option>
                <option value="double_crop">Double-crop</option>
              </select>
            )}
            <button
              type="button" className={btnCls} disabled={!addCropId}
              onClick={() => {
                onAdd(addCropId, (addPractice || null) as BudgetLine['practice'], addCropIsDc && addCropping === 'double_crop' ? 'double_crop' : null)
                setAddCropId(''); setAddPractice(''); setAddCropping('')
              }}
            >
              Add line
            </button>
          </div>
          <p className="text-xs text-slate-500">
            New lines seed yield from your practice-filtered APH (or expected-yield breakouts; double-crop from the DC
            breakouts), price from the budget-year new-crop futures + your standing basis, and cost from
            your {currentCropYear} cost/acre — every value editable here. The budget never writes back.
          </p>
        </div>
      </div>
    </div>
  )
}
