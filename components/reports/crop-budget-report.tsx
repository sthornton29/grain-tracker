'use client'

// Crop Budget Planner — the pre-season "what should I plant next year" tool.
// ONE budget per budget crop year (scenario management removed from the UI; a
// single implicit default scenario per year persists underneath — no
// destructive migration). budget_scenarios/budget_lines stay a SANDBOX (never
// written to crop_assumptions or any actuals).
//
// Presentation follows the app's two established patterns:
//  - OUTPUT leads, Income-Sensitivity style: one full-width section per
//    breakout row with acres (or per crop in the Blended view), a compact
//    read-only header of the row's assumptions, and the price × yield matrix
//    OPEN as the section body.
//  - ASSUMPTIONS mirror the Marketing Dashboard editor: a slide-over panel
//    with one collapsible section per crop, and inside it the FIXED breakout
//    grid — an Overall row plus the Full-season/Double-crop × Irrigated/
//    Dryland rows relevant to the crop's DC designation, with Acres / Yield /
//    Cost columns. Users type into the rows that apply; a blank breakout cell
//    falls back to the Overall row. No add/remove-line — the structure is
//    already there. Crops shown: everything planted this year plus an "Add
//    crop" picker for planning a new one.
//
// Price is EDIT-IN-PLACE per crop: the live budget-year new-crop quote is the
// default; typing over it flips the crop to manual (chip live → manual) and ↻
// restores the quote. Basis stays its own field. Same price_mode/manual_price
// fields as before.
//
// Assumption seeds (all editable): yield = practice-filtered acre-weighted APH
// (else expected-yield breakouts; DC rows seed from the DC breakouts, never
// APH); cost = the current year's per-practice cost/acre. Derivation chips
// show until a cell is edited. Cotton prices are stored ¢/lb, shown $/lb.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { usePersistentState } from '@/lib/use-persistent-state'
import { formatCottonPrice, parseCottonPriceInput, fmtPrice } from '@/lib/hedging'
import {
  blendBudgetLines, breakoutFields, breakoutKeyOf, breakoutKeysFor, budgetContractLabel,
  budgetContractSymbol, budgetLineMath, budgetSeeds, buildBudgetMatrix, effectiveBudgetRows,
  gridCellPlan, gridFromLines, isCottonName, priceEditPatch, scenarioTotals, livePricePatch,
  BREAKOUT_LABEL, BREAKOUT_ORDER, BUDGET_PRACTICE_LABEL,
  type BreakoutKey, type BudgetLineMath, type BudgetMatrixCell, type BudgetSeeds,
  type CropBudgetGrid, type EffectiveBudgetRow, type GridCellField,
} from '@/lib/crop-budget'
import { axisValues, closestIndex, defaultPriceStep, defaultYieldStep } from '@/lib/income-sensitivity'
import { theadCls, toneText, signedTone } from '@/components/reports/report-kit'
import { formatNumber, type ExportPayload, type ExportCell } from '@/lib/exports'
import type { BudgetLine, BudgetScenario, Crop, CropAssumption, CropInsurancePolicy, FieldPlanting } from '@/lib/types'

type Props = { onPayloadChange?: (build: () => ExportPayload) => void }

const btnCls = 'rounded-lg bg-green-700 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50'
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

// Row label for a grid/breakout key: full "Full-season · Irrigated" once a DC
// crop needs the distinction; plain Irrigated/Dryland otherwise.
function keyLabel(key: BreakoutKey | 'overall', isDc: boolean): string {
  if (key === 'overall') return 'Overall'
  if (isDc) return BREAKOUT_LABEL[key]
  return key === 'fs_irr' ? BUDGET_PRACTICE_LABEL.irrigated : BUDGET_PRACTICE_LABEL.non_irrigated
}

// ---------- shared inputs (save-on-blur; an unparseable entry reverts) ----------

function CellInput({ value, onCommit, placeholder, width = 'w-24', title, chip }: {
  value: string
  onCommit: (s: string) => void
  placeholder?: string
  width?: string
  title?: string
  /** Renders the seed/inherit ring on the input. */
  chip?: boolean
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
      className={`rounded border px-2 py-1 text-right tabular-nums text-sm bg-white ${chip ? 'border-sky-200 text-sky-900' : 'border-slate-300'} ${width}`}
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

// ---------- per-crop card (drives both the page sections and the panel) ----------

type CropCard = {
  cropId: string
  crop: Crop | undefined
  isCotton: boolean
  isDc: boolean
  symbol: string | null
  live: LivePrice | null
  /** The line carrying the crop's price/basis: the Overall line, else the
   *  first line on file. null until the crop has any line. */
  carrier: BudgetLine | null
  grid: CropBudgetGrid<BudgetLine>
  /** Grid rows offered: the DC-designation keys plus any key present in data. */
  keys: readonly BreakoutKey[]
  seedsByKey: Record<'overall' | BreakoutKey, BudgetSeeds>
  effRows: EffectiveBudgetRow<BudgetLine>[]
  hasLines: boolean
  usedManualFallback: boolean
}

// One rendered output row: an effective breakout row (Broken-out) or the
// acre-weighted crop blend (Blended).
type DisplayRow = {
  key: string
  cropId: string
  crop: Crop | undefined
  isCotton: boolean
  symbol: string | null
  name: string
  /** "1,250 ac blended: 800 irr + 450 dry" for a multi-row blend, else null. */
  composition: string | null
  acres: number | null
  yieldPerAcre: number | null
  costPerAcre: number | null
  math: BudgetLineMath
  quoteDate: string | null
  priceChip: { label: string; live: boolean; title: string }
  priceNote: string | null
}

export default function CropBudgetReport({ onPayloadChange }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [scenarios, setScenarios] = useState<BudgetScenario[]>([])
  const [lines, setLines] = useState<BudgetLine[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [policies, setPolicies] = useState<CropInsurancePolicy[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [referenceAcres, setReferenceAcres] = useState<number>(0)
  const [livePrices, setLivePrices] = useState<Map<string, LivePrice>>(new Map())
  const [priceNote, setPriceNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const [budgetYear, setBudgetYear] = usePersistentState<number | ''>('crop-budget:year', '')
  const [matrixView, setMatrixView] = usePersistentState<'revenue' | 'profit'>('crop-budget:view', 'profit')
  const [breakoutView, setBreakoutView] = usePersistentState<'broken' | 'blended'>('crop-budget:breakout', 'broken')
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelFocusCropId, setPanelFocusCropId] = useState<string | null>(null)

  const currentCropYear = new Date().getFullYear()
  const defaultBudgetYear = currentCropYear + 1

  async function refresh() {
    const [sc, ln, cr, po, ca, pl, fi] = await Promise.all([
      supabase.from('budget_scenarios').select('*').order('created_at'),
      supabase.from('budget_lines').select('*').order('sort_order'),
      supabase.from('crops').select('*').order('name'),
      supabase.from('crop_insurance_policies').select('*'),
      supabase.from('crop_assumptions').select('*'),
      supabase.from('field_plantings').select('*'),
      supabase.from('fields').select('total_acres'),
    ])
    if (sc.error?.message.includes('does not exist') || sc.error?.code === '42P01') {
      setErr('The budget tables are missing — run supabase/048_crop_budget_planner.sql in the Supabase SQL editor first.')
    }
    setScenarios((sc.data as BudgetScenario[]) || [])
    setLines((ln.data as BudgetLine[]) || [])
    setCrops((cr.data as Crop[]) || [])
    setPolicies((po.data as CropInsurancePolicy[]) || [])
    setAssumptions((ca.data as CropAssumption[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setReferenceAcres(((fi.data as Array<{ total_acres: number | null }>) || []).reduce((s, f) => s + Number(f.total_acres ?? 0), 0))
    setLoading(false)
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const cropName = (id: string) => cropById.get(id)?.name ?? '—'

  // ---------- one budget per year: resolve/auto-create the implicit scenario ----------

  const yearOptions = useMemo(() => {
    const ys = new Set<number>(scenarios.map((s) => s.budget_crop_year))
    ys.add(defaultBudgetYear)
    ys.add(defaultBudgetYear + 1)
    return Array.from(ys).sort((a, b) => a - b)
  }, [scenarios, defaultBudgetYear])

  useEffect(() => {
    if (loading || budgetYear !== '') return
    // First visit: land on the most recent budget on file, else next year.
    const latest = scenarios.length > 0 ? Math.max(...scenarios.map((s) => s.budget_crop_year)) : defaultBudgetYear
    setBudgetYear(latest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, budgetYear, scenarios])

  // The year's budget = its first-created scenario (legacy years with several
  // scenarios keep them in the DB; the first one is the budget shown).
  const scenario = useMemo(() => {
    if (budgetYear === '') return null
    const mine = scenarios.filter((s) => s.budget_crop_year === budgetYear)
    return mine.length > 0 ? mine.reduce((a, b) => (a.created_at <= b.created_at ? a : b)) : null
  }, [scenarios, budgetYear])

  const creatingYear = useRef<number | null>(null)
  useEffect(() => {
    if (loading || err || budgetYear === '' || scenario || creatingYear.current === budgetYear) return
    creatingYear.current = budgetYear
    ;(async () => {
      const { error } = await supabase.from('budget_scenarios')
        .insert({ name: `${budgetYear} budget`, budget_crop_year: budgetYear })
      if (!error) await refresh()
      creatingYear.current = null
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, err, budgetYear, scenario])

  const scenarioLines = useMemo(
    () => lines.filter((l) => l.scenario_id === scenario?.id).sort((a, b) => a.sort_order - b.sort_order),
    [lines, scenario?.id],
  )

  // ---------- live budget-year quotes (shared market_prices day-cache) ----------

  const plantedCropIds = useMemo(() => {
    const s = new Set<string>()
    for (const p of plantings) if (p.season_year === currentCropYear) s.add(p.crop_id)
    return s
  }, [plantings, currentCropYear])

  // Crops in play: budget lines + this year's plantings (both need quotes).
  const activeCropIds = useMemo(() => {
    const s = new Set<string>(plantedCropIds)
    for (const l of scenarioLines) s.add(l.crop_id)
    return Array.from(s)
  }, [plantedCropIds, scenarioLines])

  const neededSymbols = useMemo(() => {
    if (budgetYear === '') return []
    const out = new Set<string>()
    for (const id of activeCropIds) {
      const sym = budgetContractSymbol(cropById.get(id)?.name, budgetYear)
      if (sym) out.add(sym)
    }
    return Array.from(out)
  }, [activeCropIds, budgetYear, cropById])

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
      setPriceNote('Could not refresh budget-year futures — showing cached quotes; crops without one fall back to manual.')
    }
  }, [])

  useEffect(() => { void fetchQuotes(neededSymbols) }, [neededSymbols, fetchQuotes])

  const quoteDate = useMemo(() => {
    let d: string | null = null
    for (const p of livePrices.values()) if (p.priceDate && (!d || p.priceDate > d)) d = p.priceDate
    return d
  }, [livePrices])

  // ---------- per-crop cards ----------

  const cards: CropCard[] = useMemo(() => {
    if (budgetYear === '') return []
    // Crop order: line-bearing crops by first line's sort order, then planted
    // crops without lines (alphabetical).
    const order: string[] = []
    const byCrop = new Map<string, BudgetLine[]>()
    for (const l of scenarioLines) {
      if (!byCrop.has(l.crop_id)) { byCrop.set(l.crop_id, []); order.push(l.crop_id) }
      byCrop.get(l.crop_id)!.push(l)
    }
    const plantedOnly = Array.from(plantedCropIds)
      .filter((id) => !byCrop.has(id))
      .sort((a, b) => cropName(a).localeCompare(cropName(b)))
    for (const id of plantedOnly) order.push(id)

    return order.map((cropId): CropCard => {
      const crop = cropById.get(cropId)
      const isCotton = isCottonName(crop?.name)
      const isDc = crop?.double_crop === true
      const symbol = budgetContractSymbol(crop?.name, budgetYear)
      const live = symbol ? livePrices.get(symbol) ?? null : null
      const cropLines = byCrop.get(cropId) ?? []
      const grid = gridFromLines(cropLines)
      const dataKeys = cropLines.map((l) => breakoutKeyOf(l)).filter((k): k is BreakoutKey => k !== 'overall')
      const keys = BREAKOUT_ORDER.filter((k) => breakoutKeysFor(isDc).includes(k) || dataKeys.includes(k))
      const carrier = grid.overall ?? cropLines[0] ?? null
      const assumption = assumptions.find((a) => a.crop_id === cropId && a.crop_year === currentCropYear)
      const seedsFor = (key: 'overall' | BreakoutKey): BudgetSeeds => {
        const f = key === 'overall' ? { practice: null, cropping: null } : breakoutFields(key)
        return budgetSeeds({ policies, assumption, cropId, practice: f.practice, cropping: f.cropping })
      }
      const seedsByKey = {
        overall: seedsFor('overall'),
        fs_irr: seedsFor('fs_irr'), fs_dry: seedsFor('fs_dry'),
        dc_irr: seedsFor('dc_irr'), dc_dry: seedsFor('dc_dry'),
      }
      const usedManualFallback = carrier?.price_mode === 'live' && live == null && carrier?.manual_price != null
      return {
        cropId, crop, isCotton, isDc, symbol, live, carrier, grid, keys, seedsByKey,
        effRows: effectiveBudgetRows(grid, keys),
        hasLines: cropLines.length > 0,
        usedManualFallback,
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioLines, plantedCropIds, cropById, livePrices, assumptions, policies, budgetYear, currentCropYear])

  // Math for one effective row, priced at the crop's carrier line.
  const rowMath = useCallback((card: CropCard, r: EffectiveBudgetRow<BudgetLine>): BudgetLineMath => {
    const c = card.carrier
    return budgetLineMath({
      acres: r.acres,
      yield_per_acre: r.yieldPerAcre,
      price_mode: card.usedManualFallback ? 'manual' : (c?.price_mode ?? 'live'),
      manual_price: c?.manual_price ?? null,
      basis: c?.basis ?? 0,
      cost_per_acre: r.costPerAcre,
    }, card.live?.price ?? null, card.isCotton)
  }, [])

  // Totals ALWAYS sum the effective rows — identical in both view modes.
  const totals = useMemo(() => scenarioTotals(
    cards.flatMap((card) => card.effRows.map((r) => ({ acres: r.acres, math: rowMath(card, r) }))),
  ), [cards, rowMath])

  const missingInputs = useMemo(() => cards.reduce((n, card) =>
    n + card.effRows.filter((r) => r.acres == null || r.yieldPerAcre == null || r.costPerAcre == null).length, 0),
    [cards])

  const showBreakoutToggle = cards.some((c) => c.effRows.length > 1)

  // ---------- display rows (Broken out = one per effective row; Blended = one per crop) ----------

  const displayRows: DisplayRow[] = useMemo(() => {
    const outputCards = cards.filter((c) => c.effRows.length > 0)
    const chipFor = (card: CropCard): DisplayRow['priceChip'] => {
      const liveMode = (card.carrier?.price_mode ?? 'live') === 'live' && !card.usedManualFallback
      return {
        label: liveMode ? (card.symbol ?? 'live') : 'manual',
        live: liveMode,
        title: liveMode
          ? `${budgetContractLabel(card.crop?.name, budgetYear === '' ? defaultBudgetYear : budgetYear) ?? 'Live futures'}${card.live ? ` as of ${card.live.priceDate ?? '—'}${card.live.stale ? ' (cached)' : ''}` : ' — not quoted'}${card.carrier?.basis ? ' + basis' : ''}`
          : 'Manual price — ↻ in Assumptions restores the live quote',
      }
    }
    const noteFor = (card: CropCard, math: BudgetLineMath): string | null =>
      card.usedManualFallback ? `${card.symbol} not quoted — using the manual price`
        : math.missingPrice ? `${card.symbol ?? 'contract'} not quoted — type a price in Assumptions` : null

    if (breakoutView === 'broken') {
      return outputCards.flatMap((card) => card.effRows.map((r): DisplayRow => {
        const math = rowMath(card, r)
        const label = r.key === 'overall' ? '' : ` — ${keyLabel(r.key, card.isDc)}`
        return {
          key: r.line.id,
          cropId: card.cropId, crop: card.crop, isCotton: card.isCotton, symbol: card.symbol,
          name: `${cropName(card.cropId)}${label}`,
          composition: null,
          acres: r.acres, yieldPerAcre: r.yieldPerAcre, costPerAcre: r.costPerAcre,
          math, quoteDate: card.live?.priceDate ?? null,
          priceChip: chipFor(card), priceNote: noteFor(card, math),
        }
      }))
    }
    // Blended: one acre-weighted section per crop (display-time only).
    return outputCards.map((card): DisplayRow => {
      if (card.effRows.length === 1) {
        const r = card.effRows[0]
        const math = rowMath(card, r)
        const label = r.key === 'overall' ? '' : ` — ${keyLabel(r.key, card.isDc)}`
        return {
          key: r.line.id, cropId: card.cropId, crop: card.crop, isCotton: card.isCotton, symbol: card.symbol,
          name: `${cropName(card.cropId)}${label}`, composition: null,
          acres: r.acres, yieldPerAcre: r.yieldPerAcre, costPerAcre: r.costPerAcre,
          math, quoteDate: card.live?.priceDate ?? null,
          priceChip: chipFor(card), priceNote: noteFor(card, math),
        }
      }
      const maths = card.effRows.map((r) => rowMath(card, r))
      const blend = blendBudgetLines(card.effRows.map((r, i) => ({
        practice: r.line.practice, cropping: r.line.cropping, label: null,
        acres: r.acres, yield_per_acre: r.yieldPerAcre, cost_per_acre: r.costPerAcre,
        effectivePrice: maths[i].effectivePrice,
      })))
      const math = budgetLineMath({
        acres: blend.acres, yield_per_acre: blend.yieldPerAcre, price_mode: 'manual',
        manual_price: blend.effectivePrice, basis: 0, cost_per_acre: blend.costPerAcre,
      }, null, card.isCotton)
      const anyMissingPrice = maths.some((m) => m.effectivePrice == null)
      return {
        key: `crop:${card.cropId}`, cropId: card.cropId, crop: card.crop, isCotton: card.isCotton, symbol: card.symbol,
        name: cropName(card.cropId),
        composition: `${blend.acres != null ? acres0(blend.acres) : '—'} ac blended: ${blend.composition}`,
        acres: blend.acres, yieldPerAcre: blend.yieldPerAcre, costPerAcre: blend.costPerAcre,
        math, quoteDate: card.live?.priceDate ?? null,
        priceChip: chipFor(card),
        priceNote: anyMissingPrice ? 'A row in this blend has no price yet — set it in Assumptions' : null,
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, breakoutView, rowMath, budgetYear])

  // ---------- writes (sandbox-only) ----------

  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : 'Unexpected error')

  async function insertLine(cropId: string, values: Partial<BudgetLine>) {
    if (!scenario) return
    const maxSort = scenarioLines.reduce((m, l) => Math.max(m, l.sort_order), -1)
    const assumption = assumptions.find((a) => a.crop_id === cropId && a.crop_year === currentCropYear)
    try {
      const { error } = await supabase.from('budget_lines').insert({
        scenario_id: scenario.id,
        crop_id: cropId,
        label: null,
        practice: null,
        cropping: null,
        acres: null,
        yield_per_acre: null,
        price_mode: budgetContractSymbol(cropById.get(cropId)?.name, scenario.budget_crop_year) ? 'live' : 'manual',
        manual_price: null,
        basis: assumption?.assumed_basis != null ? Number(assumption.assumed_basis) : 0,
        cost_per_acre: null,
        sort_order: maxSort + 1,
        ...values,
      })
      if (error) throw new Error(error.message)
      await refresh()
    } catch (e) { fail(e) }
  }

  async function patchLine(id: string, patch: Partial<BudgetLine>) {
    try {
      const { error } = await supabase.from('budget_lines').update(patch).eq('id', id)
      if (error) throw new Error(error.message)
      setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)))
    } catch (e) { fail(e) }
  }

  // One grid cell commits: update the row's line, or create it (seeded) on
  // first entry.
  async function commitCell(card: CropCard, key: BreakoutKey | 'overall', field: GridCellField, value: number | null) {
    const existing = key === 'overall' ? card.grid.overall : card.grid.byKey[key] ?? null
    const plan = gridCellPlan({ existing, key, field, value, seeds: card.seedsByKey[key] })
    if (plan.op === 'noop') return
    if (plan.op === 'update') await patchLine(plan.id, plan.patch)
    else await insertLine(card.cropId, plan.values)
  }

  // Edit-in-place price: typing flips the crop to manual; blank restores live.
  async function commitPrice(card: CropCard, input: string) {
    const value = inputToPrice(card.isCotton, input)
    const patch = priceEditPatch({
      value,
      currentMode: (card.carrier?.price_mode ?? 'live') as 'live' | 'manual',
      livePrice: card.live?.price ?? null,
    })
    if (!patch) return
    if (card.carrier) await patchLine(card.carrier.id, patch)
    else await insertLine(card.cropId, patch)
  }

  async function commitBasis(card: CropCard, input: string) {
    const value = inputToPrice(card.isCotton, input, 0.25) ?? 0
    if (card.carrier) await patchLine(card.carrier.id, { basis: value })
    else await insertLine(card.cropId, { basis: value })
  }

  async function useLivePrice(card: CropCard) {
    if (!card.carrier) return
    await patchLine(card.carrier.id, livePricePatch())
    if (card.symbol) void fetchQuotes([card.symbol], true)
  }

  // "Add crop" (planning a crop with no plantings this year): the Overall line
  // is created seeded, which makes the card persistent.
  async function addCrop(cropId: string) {
    const seeds = budgetSeeds({
      policies,
      assumption: assumptions.find((a) => a.crop_id === cropId && a.crop_year === currentCropYear),
      cropId, practice: null, cropping: null,
    })
    await insertLine(cropId, { yield_per_acre: seeds.yield, cost_per_acre: seeds.cost })
  }

  async function removeCrop(card: CropCard) {
    if (!scenario) return
    if (!confirm(`Remove ${cropName(card.cropId)} from the ${scenario.budget_crop_year} budget? Its typed-in acres/yield/cost are deleted.`)) return
    try {
      const { error } = await supabase.from('budget_lines').delete()
        .eq('scenario_id', scenario.id).eq('crop_id', card.cropId)
      if (error) throw new Error(error.message)
      await refresh()
    } catch (e) { fail(e) }
  }

  function openAssumptions(focusCropId?: string) {
    setPanelFocusCropId(focusCropId ?? null)
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
    const year = budgetYear === '' ? defaultBudgetYear : budgetYear
    const viewLabel = breakoutView === 'blended' ? 'Blended by crop' : 'Broken out by practice'
    const sections: ExportPayload['sections'] = []
    sections.push({
      title: `Allocation — ${year} budget`,
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
        `Budget crop year: ${year}`,
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
  }, [displayRows, totals, budgetYear, quoteDate, matrixView, breakoutView, matrixGridFor])

  useEffect(() => {
    if (!onPayloadChange) return
    onPayloadChange(() => buildExportPayload())
  }, [buildExportPayload, onPayloadChange])

  // ---------- render ----------

  if (loading) return <p className="text-slate-500">Loading…</p>

  const anyValues = cards.some((c) => c.effRows.some((r) => r.acres != null || r.yieldPerAcre != null))

  return (
    <div className="space-y-4 print-area">
      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Header: just the budget year + Assumptions */}
      <div className="flex flex-wrap items-end gap-3 no-print">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Budget crop year</span>
          <select
            value={budgetYear === '' ? '' : String(budgetYear)}
            onChange={(e) => setBudgetYear(Number(e.target.value))}
            className="rounded-lg border border-slate-300 px-3 py-2 bg-white"
          >
            {yearOptions.map((y) => <option key={y} value={y}>{y} budget</option>)}
          </select>
        </label>
        <button
          type="button"
          onClick={() => openAssumptions()}
          className={`relative inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-white shadow-sm ml-auto ${missingInputs > 0 ? 'bg-amber-500 hover:bg-amber-600' : 'bg-sky-700 hover:bg-sky-800'}`}
          title="Acres, yield, cost per breakout row, and the price/basis per crop"
        >
          <span aria-hidden>⚙</span> Assumptions
          {missingInputs > 0 && (
            <span className="rounded-full bg-white/25 text-white text-xs px-1.5 py-0.5 leading-none">
              {missingInputs} missing
            </span>
          )}
        </button>
      </div>

      {priceNote && <p className="text-xs text-amber-700 no-print">{priceNote}</p>}

      {scenario && (
        <>
          {/* Slim summary band — always the sum of the effective rows,
              identical in both view modes. */}
          <div className="bg-white rounded-xl shadow px-4 py-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <h2 className="font-bold">{scenario.budget_crop_year} budget</h2>
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
                {totals.incompleteLines} row{totals.incompleteLines === 1 ? '' : 's'} missing inputs — excluded from profit
              </button>
            )}
          </div>

          {!anyValues && (
            <div className="bg-white rounded-xl shadow p-8 text-center text-slate-500 space-y-2">
              <p>Nothing budgeted for {scenario.budget_crop_year} yet.</p>
              <button type="button" className={btnCls} onClick={() => openAssumptions()}>Open Assumptions to enter acres</button>
            </div>
          )}

          {/* View toggles */}
          {displayRows.length > 0 && anyValues && (
            <div className="flex flex-wrap items-center gap-3 no-print">
              <span className="text-sm text-slate-500">Price × yield matrices — pure budget math per cell</span>
              <span className="ml-auto flex items-center gap-3">
                {showBreakoutToggle && (
                  <span className="inline-flex rounded-lg border border-slate-300 overflow-hidden" title="Blended collapses a crop's breakout rows into one acre-weighted section (display only — the underlying rows are untouched).">
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
          {anyValues && displayRows.map((d) => (
            <BudgetSection
              key={d.key}
              d={d}
              mode={matrixView}
              grid={matrixGridFor(d)}
              onAxis={(patch) => setAxis(d.key, patch)}
              onOpenAssumptions={() => openAssumptions(d.cropId)}
            />
          ))}

          {/* Methodology */}
          <details className="bg-white rounded-xl shadow text-sm no-print">
            <summary className="cursor-pointer select-none px-4 py-3 font-semibold text-slate-700">How this budget is built</summary>
            <div className="border-t border-slate-100 px-4 py-3 space-y-2 text-slate-600">
              <p><strong className="text-slate-700">One budget per crop year.</strong> Pick the year in the header; all
                assumption entry lives in the Assumptions panel — per crop, an Overall row plus the irrigated/dryland
                (and, for double-crop-designated crops, full-season/double-crop) breakout rows, with acres, yield, and
                cost per row, exactly like the Marketing Dashboard&apos;s editor. A blank breakout cell falls back to the
                Overall row. The page behind the panel recalculates live as you type.</p>
              <p><strong className="text-slate-700">Prices are edit-in-place</strong> — each crop defaults to the budget
                year&apos;s new-crop futures (DEC corn, NOV soybeans, JUL wheat, DEC cotton). Typing over the quote
                switches the crop to your manual price; ↻ restores the live quote. Basis is its own field.</p>
              <p><strong className="text-slate-700">Defaults are seeds, not gospel</strong>: yield seeds from the
                practice-filtered acre-weighted APH across your most recent year&apos;s policies (else your
                expected-yield breakouts; double-crop rows seed from the DC breakouts, never APH), cost from this
                year&apos;s per-practice cost/acre. An edited value drops its derivation chip.</p>
              <p><strong className="text-slate-700">Blended vs Broken out</strong> — Broken out shows each breakout row
                with acres as its own section and matrix. Blended collapses a crop&apos;s rows into one section: acres
                summed, yield and cost acre-weighted. Blending is display-time math only — totals always sum the real
                rows, so both views foot identically.</p>
              <p><strong className="text-slate-700">The matrices are pure price × yield</strong> — profit/acre =
                (price + basis) × yield − cost. No contracts, no harvest facts, no insurance floors, no government
                payments: pre-season, nothing is locked. For the in-season version with all of that machinery, use the{' '}
                <Link href="/reports/income-sensitivity" className="text-sky-700 underline">Income Sensitivity Report</Link>.</p>
              <p><strong className="text-slate-700">Budgets are a sandbox</strong> — they live in their own tables and
                never write to the marketing assumptions or any actuals. <strong className="text-slate-700">Reference
                acreage</strong> is the sum of your fields&apos; total acres, context only — double-crop acres
                legitimately exceed it.</p>
            </div>
          </details>
        </>
      )}

      {/* Assumptions slide-over */}
      {panelOpen && scenario && (
        <AssumptionsPanel
          year={scenario.budget_crop_year}
          cards={cards}
          crops={crops}
          currentCropYear={currentCropYear}
          focusCropId={panelFocusCropId}
          cropName={cropName}
          onCell={commitCell}
          onPrice={commitPrice}
          onBasis={commitBasis}
          onUseLive={useLivePrice}
          onRefreshQuote={(sym) => void fetchQuotes([sym], true)}
          onAddCrop={addCrop}
          onRemoveCrop={removeCrop}
          onClose={() => { setPanelOpen(false); setPanelFocusCropId(null) }}
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
// Assumptions slide-over — the Marketing Dashboard editor pattern: one
// collapsible section per crop with a collapsed summary line, and inside it
// the fixed breakout grid (Overall + the relevant Full-season/Double-crop ×
// Irrigated/Dryland rows) with Acres / Yield / Cost columns. Save-on-blur;
// the page recalculates live behind the panel. No add/remove-line — the
// structure is already there; "Add crop" covers planning a new crop.
// ---------------------------------------------------------------------------
function AssumptionsPanel({
  year, cards, crops, currentCropYear, focusCropId, cropName,
  onCell, onPrice, onBasis, onUseLive, onRefreshQuote, onAddCrop, onRemoveCrop, onClose,
}: {
  year: number
  cards: CropCard[]
  crops: Crop[]
  currentCropYear: number
  focusCropId: string | null
  cropName: (id: string) => string
  onCell: (card: CropCard, key: BreakoutKey | 'overall', field: GridCellField, value: number | null) => void
  onPrice: (card: CropCard, input: string) => void
  onBasis: (card: CropCard, input: string) => void
  onUseLive: (card: CropCard) => void
  onRefreshQuote: (symbol: string) => void
  onAddCrop: (cropId: string) => void
  onRemoveCrop: (card: CropCard) => void
  onClose: () => void
}) {
  const [openCrop, setOpenCrop] = useState<string | null>(focusCropId ?? cards[0]?.cropId ?? null)
  const [addCropId, setAddCropId] = useState('')

  useEffect(() => {
    if (!focusCropId) return
    setOpenCrop(focusCropId)
    const t = setTimeout(() => document.getElementById(`budget-crop-${focusCropId}`)?.scrollIntoView({ block: 'center' }), 50)
    return () => clearTimeout(t)
  }, [focusCropId])

  const numOrNull = (s: string): number | null => {
    if (s.trim() === '') return null
    const v = Number(s)
    return Number.isFinite(v) ? v : null
  }

  const shownIds = new Set(cards.map((c) => c.cropId))
  const addable = crops.filter((c) => !shownIds.has(c.id))

  return (
    <div className="fixed inset-0 z-40 no-print">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-xl bg-slate-50 shadow-xl overflow-y-auto">
        <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <div className="flex-1">
            <h2 className="font-bold">Assumptions — {year} budget</h2>
            <p className="text-xs text-slate-500">Changes save on blur and recalculate the page live; this panel stays open.</p>
          </div>
          <button onClick={onClose} className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm font-semibold">Done</button>
        </div>
        <div className="p-4 space-y-2">
          <p className="text-xs text-slate-500">
            Type acres into the rows you&apos;re planting — Overall alone for a single-practice crop, or the breakout
            rows. A blank breakout yield/cost cell falls back to the Overall row. Yield and cost start on seeded
            values (APH / your {currentCropYear} breakouts) until you edit them.
          </p>
          {cards.length === 0 && <p className="text-sm text-slate-500">No crops planted this year — add one below.</p>}
          {cards.map((card) => (
            <CropAssumptionCard
              key={card.cropId}
              card={card}
              year={year}
              name={cropName(card.cropId)}
              isOpen={openCrop === card.cropId}
              onToggle={() => setOpenCrop(openCrop === card.cropId ? null : card.cropId)}
              numOrNull={numOrNull}
              onCell={onCell}
              onPrice={onPrice}
              onBasis={onBasis}
              onUseLive={onUseLive}
              onRefreshQuote={onRefreshQuote}
              onRemoveCrop={onRemoveCrop}
            />
          ))}

          {/* Add crop (planning a crop with no plantings this year) */}
          {addable.length > 0 && (
            <div className="bg-white rounded-lg border border-dashed border-slate-300 px-3 py-2 flex flex-wrap items-center gap-2">
              <select value={addCropId} onChange={(e) => setAddCropId(e.target.value)} className="rounded border border-slate-300 px-2 py-1 bg-white text-sm">
                <option value="">— add a crop —</option>
                {addable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button
                type="button" className={btnCls} disabled={!addCropId}
                onClick={() => { onAddCrop(addCropId); setAddCropId('') }}
              >
                Add crop
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CropAssumptionCard({
  card, year, name, isOpen, onToggle, numOrNull,
  onCell, onPrice, onBasis, onUseLive, onRefreshQuote, onRemoveCrop,
}: {
  card: CropCard
  year: number
  name: string
  isOpen: boolean
  onToggle: () => void
  numOrNull: (s: string) => number | null
  onCell: (card: CropCard, key: BreakoutKey | 'overall', field: GridCellField, value: number | null) => void
  onPrice: (card: CropCard, input: string) => void
  onBasis: (card: CropCard, input: string) => void
  onUseLive: (card: CropCard) => void
  onRefreshQuote: (symbol: string) => void
  onRemoveCrop: (card: CropCard) => void
}) {
  const yUnit = card.isCotton ? 'lbs/ac' : 'bu/ac'
  const carrier = card.carrier
  const liveMode = (carrier?.price_mode ?? 'live') === 'live' && !card.usedManualFallback

  // Collapsed summary: "Soybean — 50.8 bu/ac · $631/ac" from the effective
  // rows' acre-weighted blend (or the Overall row before acres exist).
  const blend = card.effRows.length > 0
    ? blendBudgetLines(card.effRows.map((r) => ({
        practice: r.line.practice, cropping: r.line.cropping, label: null,
        acres: r.acres, yield_per_acre: r.yieldPerAcre, cost_per_acre: r.costPerAcre,
      })))
    : null
  const summaryYield = blend?.yieldPerAcre ?? (card.grid.overall?.yield_per_acre != null ? Number(card.grid.overall.yield_per_acre) : card.seedsByKey.overall.yield)
  const summaryCost = blend?.costPerAcre ?? (card.grid.overall?.cost_per_acre != null ? Number(card.grid.overall.cost_per_acre) : card.seedsByKey.overall.cost)
  const totalAcres = card.effRows.reduce((s, r) => s + (r.acres ?? 0), 0)

  // The displayed price value (input): live quote or the manual price.
  const priceValue = liveMode
    ? (card.live ? priceToInput(card.isCotton, card.live.price) : '')
    : priceToInput(card.isCotton, carrier?.manual_price)

  const breakoutHasAcres = card.keys.some((k) => Number(card.grid.byKey[k]?.acres ?? 0) > 0)

  const seedChipTitle = (key: 'overall' | BreakoutKey, field: 'yield' | 'cost'): string => {
    const seeds = card.seedsByKey[key]
    if (field === 'yield') {
      return seeds.yieldSource === 'aph' && seeds.aph
        ? `Seeded: APH ${seeds.aph.yield} — weighted from ${seeds.aph.policyCount} ${seeds.aph.cropYear} ${seeds.aph.policyCount === 1 ? 'policy' : 'policies'}. Edit freely — the budget never writes back.`
        : seeds.yieldSource === 'expected_dc'
          ? 'Seeded from your double-crop expected yield. Edit freely.'
          : 'Seeded from your expected yield. Edit freely.'
    }
    return `Seeded from your ${seeds.costSource === 'assumption_dc' ? 'double-crop ' : ''}cost/acre. Edit freely.`
  }

  const cellCls = 'px-1 py-1'
  return (
    <div id={`budget-crop-${card.cropId}`} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <span className="text-slate-400">{isOpen ? '▾' : '▸'}</span>
        <span className="font-semibold flex-1">{name}</span>
        {summaryYield != null || summaryCost != null || totalAcres > 0
          ? <span className="text-xs text-slate-500 tabular-nums">
              {totalAcres > 0 ? `${acres0(totalAcres)} ac · ` : ''}
              {summaryYield != null ? `${(Math.round(summaryYield * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${yUnit}` : '—'}
              {summaryCost != null ? ` · ${usd0(Math.round(summaryCost))}/ac` : ''}
            </span>
          : <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">not budgeted</span>}
      </button>
      {isOpen && (
        <div className="px-3 pb-3 border-t border-slate-100 pt-2 space-y-3">
          {/* Price — edit-in-place over the live quote; basis separate */}
          <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
            <div className="text-xs text-slate-500 flex flex-col gap-1">
              <span>Price ({card.isCotton ? '$/lb' : '$/bu'})</span>
              <div className="flex items-center gap-1.5">
                <span
                  className={`text-[10px] rounded-full px-1.5 py-0.5 border ${liveMode ? 'bg-sky-100 text-sky-800 border-sky-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}
                  title={liveMode
                    ? `${budgetContractLabel(card.crop?.name, year) ?? 'Live futures'}${card.live ? ` as of ${card.live.priceDate ?? '—'}${card.live.stale ? ' (cached)' : ''}` : ' — not quoted'}`
                    : 'Manual price — ↻ restores the live quote'}
                >
                  {liveMode ? (card.symbol ?? 'live') : 'manual'}
                </span>
                <CellInput
                  value={priceValue}
                  placeholder={card.isCotton ? '$/lb' : '$/bu'}
                  title={liveMode ? 'Type over the live quote to switch to a manual price' : 'Manual price'}
                  onCommit={(s) => onPrice(card, s)}
                  width="w-20"
                />
                {liveMode && card.symbol ? (
                  <button type="button" className="text-xs text-sky-700" title="Refresh this quote" onClick={() => onRefreshQuote(card.symbol!)}>↻</button>
                ) : !liveMode ? (
                  <button type="button" className="text-xs text-sky-700" title="Use the live quote" onClick={() => onUseLive(card)}>↻ live</button>
                ) : null}
              </div>
              {liveMode && card.live == null && (
                <span className="text-[10px] text-amber-700">{card.symbol ?? 'contract'} not quoted — type a price</span>
              )}
              {card.usedManualFallback && (
                <span className="text-[10px] text-amber-700">{card.symbol} not quoted — using your manual price</span>
              )}
            </div>
            <label className="text-xs text-slate-500 flex flex-col gap-1">
              Basis ({card.isCotton ? '+/− $/lb' : '+/− $/bu'})
              <CellInput
                value={priceToInput(card.isCotton, carrier?.basis)}
                placeholder={card.isCotton ? '+/− $/lb' : '+/− $/bu'}
                onCommit={(s) => onBasis(card, s)}
                width="w-20"
              />
            </label>
          </div>

          {/* The breakout grid — Overall + the crop's relevant rows */}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500">
                <th className={`${cellCls} text-left font-normal`}></th>
                <th className={`${cellCls} text-right font-normal`}>Acres</th>
                <th className={`${cellCls} text-right font-normal`}>Yield {yUnit}</th>
                <th className={`${cellCls} text-right font-normal`}>Cost/ac</th>
              </tr>
            </thead>
            <tbody>
              {(['overall', ...card.keys] as const).map((key) => {
                const line = key === 'overall' ? card.grid.overall : card.grid.byKey[key]
                const seeds = card.seedsByKey[key]
                const yieldVal = line?.yield_per_acre != null ? String(line.yield_per_acre) : ''
                const costVal = line?.cost_per_acre != null ? String(line.cost_per_acre) : ''
                const yieldIsSeed = line?.yield_per_acre != null && seeds.yield != null && Math.abs(Number(line.yield_per_acre) - seeds.yield) < 1e-9
                const costIsSeed = line?.cost_per_acre != null && seeds.cost != null && Math.abs(Number(line.cost_per_acre) - seeds.cost) < 1e-9
                const overall = card.grid.overall
                // Blank breakout cells fall back to Overall; before a row's
                // line exists its placeholder previews the seed it will get.
                const yieldPh = key === 'overall'
                  ? (seeds.yield != null ? String(seeds.yield) : yUnit)
                  : line
                    ? (overall?.yield_per_acre != null ? `↖ ${overall.yield_per_acre}` : yUnit)
                    : (seeds.yield != null ? String(seeds.yield) : (overall?.yield_per_acre != null ? `↖ ${overall.yield_per_acre}` : yUnit))
                const costPh = key === 'overall'
                  ? (seeds.cost != null ? String(seeds.cost) : '$/ac')
                  : line
                    ? (overall?.cost_per_acre != null ? `↖ ${overall.cost_per_acre}` : '$/ac')
                    : (seeds.cost != null ? String(seeds.cost) : (overall?.cost_per_acre != null ? `↖ ${overall.cost_per_acre}` : '$/ac'))
                const overallAcresLocked = key === 'overall' && breakoutHasAcres
                return (
                  <tr key={key}>
                    <td className={`${cellCls} text-slate-600 ${key === 'overall' ? 'font-medium' : ''}`}>{keyLabel(key, card.isDc)}</td>
                    <td className={`${cellCls} text-right`}>
                      {overallAcresLocked
                        ? <span className="font-mono text-slate-500 pr-2" title="Sum of the breakout rows' acres">{acres0(totalAcres)}</span>
                        : <CellInput
                            value={line?.acres != null ? String(line.acres) : ''}
                            placeholder="acres"
                            onCommit={(s) => onCell(card, key, 'acres', numOrNull(s))}
                            width="w-20"
                          />}
                    </td>
                    <td className={`${cellCls} text-right`}>
                      <CellInput
                        value={yieldVal}
                        placeholder={yieldPh}
                        chip={yieldIsSeed}
                        title={yieldIsSeed ? seedChipTitle(key, 'yield') : key !== 'overall' && line && line.yield_per_acre == null ? 'Blank — inherits the Overall yield' : undefined}
                        onCommit={(s) => onCell(card, key, 'yield', numOrNull(s))}
                        width="w-20"
                      />
                    </td>
                    <td className={`${cellCls} text-right`}>
                      <CellInput
                        value={costVal}
                        placeholder={costPh}
                        chip={costIsSeed}
                        title={costIsSeed ? seedChipTitle(key, 'cost') : key !== 'overall' && line && line.cost_per_acre == null ? 'Blank — inherits the Overall cost' : undefined}
                        onCommit={(s) => onCell(card, key, 'cost', numOrNull(s))}
                        width="w-20"
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="flex items-center">
            <span className="text-[10px] text-slate-400">
              Rows with acres drive the budget; without any breakout acres the Overall row is the budget line.
            </span>
            {card.hasLines && (
              <button type="button" className="ml-auto text-xs text-red-600 hover:underline" onClick={() => onRemoveCrop(card)}>
                Remove from budget
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
