'use client'

// Crop insurance policy form — base MPCI policy plus optional SCO / ECO
// endorsement sub-forms. Holds the editable form state for all three records
// (they live in separate tables but are edited as one unit) and exposes pure
// helpers to map a saved policy ⇄ form ⇄ insert/update payloads. The settings
// page and the AI import screen both drive this.

import { useMemo } from 'react'
import EntitySelect from '@/components/entity-select'
import {
  PLAN_TYPES, PLAN_TYPE_LABEL, UNIT_STRUCTURES, UNIT_STRUCTURE_LABEL,
  PRACTICES, PRACTICE_LABEL, ECO_TRIGGER_LEVELS, guaranteePriceFor, projectedPriceFromEstimates,
  endorsementPremium, type PlanType, type UnitStructure, type Practice,
} from '@/lib/crop-insurance'
import { DEFAULT_SCO_TRIGGER, resolveProgramYearConfig } from '@/lib/program-config'
import { cropToHedgeCommodity } from '@/lib/contracts'
import { fmtPrice } from '@/lib/hedging'
import type {
  Crop, County, Entity, CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco,
  CropInsuranceStax, CropInsuranceMco,
  HarvestPriceEstimate, ProgramYearConfig,
} from '@/lib/types'

export type PolicyFormState = {
  entity_id: string
  crop_id: string
  crop_year: string
  county_id: string
  policy_number: string
  plan_type: PlanType
  practice: Practice
  coverage_level: string // decimal, e.g. '0.80'
  unit_structure: UnitStructure
  aph_yield: string
  projected_price: string
  harvest_price: string
  volatility_factor: string
  insured_acres: string
  premium_per_acre: string
  total_premium: string
  premium_subsidy_pct: string
  notes: string
  covers_all_planted_acres: boolean
  coverage_note: string
  sco_enabled: boolean
  sco_coverage_trigger: string
  sco_expected_county_yield: string
  sco_county_yield_assumption_pct: string
  sco_premium_per_acre: string
  sco_total_premium: string
  eco_enabled: boolean
  eco_trigger_level: string // '0.9' | '0.95'
  eco_expected_county_yield: string
  eco_county_yield_assumption_pct: string
  eco_premium_per_acre: string
  eco_total_premium: string
  // Area-plan fields (ARP/AYP) — RMA expected county figures + protection factor.
  expected_county_yield: string
  expected_county_revenue: string
  protection_factor: string
  // STAX (cotton) endorsement.
  stax_enabled: boolean
  stax_coverage_range_top: string
  stax_coverage_pct: string
  stax_protection_factor: string
  stax_expected_county_revenue: string
  stax_premium_per_acre: string
  stax_total_premium: string
  // MCO (margin) endorsement.
  mco_enabled: boolean
  mco_trigger_level: string // '0.9' | '0.95'
  mco_expected_margin: string
  mco_input_cost_adjustment: string
  mco_expected_county_yield: string
  mco_premium_per_acre: string
  mco_total_premium: string
}

export const COVERAGE_LEVELS = ['0.50', '0.55', '0.60', '0.65', '0.70', '0.75', '0.80', '0.85'] as const

export const emptyPolicyForm: PolicyFormState = {
  entity_id: '',
  crop_id: '',
  crop_year: '',
  county_id: '',
  policy_number: '',
  plan_type: 'RP',
  practice: 'non_irrigated',
  coverage_level: '0.80',
  unit_structure: 'enterprise',
  aph_yield: '',
  projected_price: '',
  harvest_price: '',
  volatility_factor: '',
  insured_acres: '',
  premium_per_acre: '',
  total_premium: '',
  premium_subsidy_pct: '',
  notes: '',
  covers_all_planted_acres: false,
  coverage_note: '',
  sco_enabled: false,
  sco_coverage_trigger: String(DEFAULT_SCO_TRIGGER),
  sco_expected_county_yield: '',
  sco_county_yield_assumption_pct: '0',
  sco_premium_per_acre: '',
  sco_total_premium: '',
  eco_enabled: false,
  eco_trigger_level: '0.9',
  eco_expected_county_yield: '',
  eco_county_yield_assumption_pct: '0',
  eco_premium_per_acre: '',
  eco_total_premium: '',
  expected_county_yield: '',
  expected_county_revenue: '',
  protection_factor: '',
  stax_enabled: false,
  stax_coverage_range_top: '0.9',
  stax_coverage_pct: '0.2',
  stax_protection_factor: '1',
  stax_expected_county_revenue: '',
  stax_premium_per_acre: '',
  stax_total_premium: '',
  mco_enabled: false,
  mco_trigger_level: '0.9',
  mco_expected_margin: '',
  mco_input_cost_adjustment: '0',
  mco_expected_county_yield: '',
  mco_premium_per_acre: '',
  mco_total_premium: '',
}

const numStr = (n: number | null | undefined) => (n == null || !Number.isFinite(Number(n)) ? '' : String(Number(n)))
function num(s: string): number | null {
  if (s == null || s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function policyToForm(p: CropInsurancePolicy, sco?: CropInsuranceSco | null, eco?: CropInsuranceEco | null, stax?: CropInsuranceStax | null, mco?: CropInsuranceMco | null): PolicyFormState {
  return {
    entity_id: p.entity_id ?? '',
    crop_id: p.crop_id,
    crop_year: String(p.crop_year),
    county_id: p.county_id ?? '',
    policy_number: p.policy_number ?? '',
    plan_type: p.plan_type,
    practice: p.practice ?? 'non_irrigated',
    coverage_level: numStr(p.coverage_level) || '0.80',
    unit_structure: p.unit_structure,
    aph_yield: numStr(p.aph_yield),
    projected_price: numStr(p.projected_price),
    harvest_price: numStr(p.harvest_price),
    volatility_factor: numStr(p.volatility_factor),
    insured_acres: numStr(p.insured_acres),
    premium_per_acre: numStr(p.premium_per_acre),
    total_premium: numStr(p.total_premium),
    premium_subsidy_pct: numStr(p.premium_subsidy_pct),
    notes: p.notes ?? '',
    covers_all_planted_acres: !!p.covers_all_planted_acres,
    coverage_note: p.coverage_note ?? '',
    sco_enabled: !!sco,
    sco_coverage_trigger: numStr(sco?.coverage_trigger) || String(DEFAULT_SCO_TRIGGER),
    sco_expected_county_yield: numStr(sco?.expected_county_yield),
    sco_county_yield_assumption_pct: sco ? numStr(sco.county_yield_assumption_pct) || '0' : '0',
    sco_premium_per_acre: numStr(sco?.premium_per_acre),
    sco_total_premium: numStr(sco?.total_premium),
    eco_enabled: !!eco,
    eco_trigger_level: numStr(eco?.eco_trigger_level) || '0.9',
    eco_expected_county_yield: numStr(eco?.expected_county_yield),
    eco_county_yield_assumption_pct: eco ? numStr(eco.county_yield_assumption_pct) || '0' : '0',
    eco_premium_per_acre: numStr(eco?.premium_per_acre),
    eco_total_premium: numStr(eco?.total_premium),
    expected_county_yield: numStr(p.expected_county_yield),
    expected_county_revenue: numStr(p.expected_county_revenue),
    protection_factor: numStr(p.protection_factor),
    stax_enabled: !!stax,
    stax_coverage_range_top: numStr(stax?.coverage_range_top) || '0.9',
    stax_coverage_pct: numStr(stax?.coverage_pct) || '0.2',
    stax_protection_factor: numStr(stax?.protection_factor) || '1',
    stax_expected_county_revenue: numStr(stax?.expected_county_revenue),
    stax_premium_per_acre: numStr(stax?.premium_per_acre),
    stax_total_premium: numStr(stax?.total_premium),
    mco_enabled: !!mco,
    mco_trigger_level: numStr(mco?.trigger_level) || '0.9',
    mco_expected_margin: numStr(mco?.expected_margin),
    mco_input_cost_adjustment: mco ? numStr(mco.input_cost_adjustment) || '0' : '0',
    mco_expected_county_yield: numStr(mco?.expected_county_yield),
    mco_premium_per_acre: numStr(mco?.premium_per_acre),
    mco_total_premium: numStr(mco?.total_premium),
  }
}

export type PolicyPayloads = {
  policy: Record<string, unknown>
  sco: Record<string, unknown> | null
  eco: Record<string, unknown> | null
  stax: Record<string, unknown> | null
  mco: Record<string, unknown> | null
}

// Map the form onto insert/update payloads. total_premium is auto-derived from
// per-acre × acres when left blank, matching the on-screen live total.
export function policyFormToPayloads(form: PolicyFormState, source: 'manual' | 'document_import' = 'manual'): PolicyPayloads {
  const acres = num(form.insured_acres) ?? 0
  const ppa = num(form.premium_per_acre)
  const totalPremium = num(form.total_premium) ?? (ppa != null ? Math.round(ppa * acres * 100) / 100 : null)

  const policy = {
    entity_id: form.entity_id || null,
    crop_id: form.crop_id,
    crop_year: Number(form.crop_year),
    county_id: form.county_id || null,
    policy_number: form.policy_number.trim() || null,
    plan_type: form.plan_type,
    practice: form.practice,
    coverage_level: num(form.coverage_level) ?? 0.8,
    unit_structure: form.unit_structure,
    aph_yield: num(form.aph_yield) ?? 0,
    projected_price: num(form.projected_price) ?? 0,
    harvest_price: num(form.harvest_price),
    volatility_factor: num(form.volatility_factor),
    insured_acres: acres,
    premium_per_acre: ppa,
    total_premium: totalPremium,
    premium_subsidy_pct: num(form.premium_subsidy_pct),
    notes: form.notes.trim() || null,
    covers_all_planted_acres: form.covers_all_planted_acres,
    // Only keep a note when the attestation is on, so an old note can't linger.
    coverage_note: form.covers_all_planted_acres ? (form.coverage_note.trim() || null) : null,
    expected_county_yield: num(form.expected_county_yield),
    expected_county_revenue: num(form.expected_county_revenue),
    protection_factor: num(form.protection_factor),
    source,
  }

  const scoAcres = acres
  const scoPpa = num(form.sco_premium_per_acre)
  const sco = form.sco_enabled
    ? {
        coverage_trigger: num(form.sco_coverage_trigger) ?? DEFAULT_SCO_TRIGGER,
        expected_county_yield: num(form.sco_expected_county_yield) ?? 0,
        county_yield_assumption_pct: num(form.sco_county_yield_assumption_pct) ?? 0,
        premium_per_acre: scoPpa,
        total_premium: num(form.sco_total_premium) ?? (scoPpa != null ? Math.round(scoPpa * scoAcres * 100) / 100 : null),
      }
    : null

  const ecoPpa = num(form.eco_premium_per_acre)
  const eco = form.eco_enabled
    ? {
        eco_trigger_level: num(form.eco_trigger_level) ?? 0.9,
        expected_county_yield: num(form.eco_expected_county_yield) ?? 0,
        county_yield_assumption_pct: num(form.eco_county_yield_assumption_pct) ?? 0,
        premium_per_acre: ecoPpa,
        total_premium: num(form.eco_total_premium) ?? (ecoPpa != null ? Math.round(ecoPpa * scoAcres * 100) / 100 : null),
      }
    : null

  const staxPpa = num(form.stax_premium_per_acre)
  const stax = form.stax_enabled
    ? {
        coverage_range_top: num(form.stax_coverage_range_top) ?? 0.9,
        coverage_pct: num(form.stax_coverage_pct) ?? 0.2,
        protection_factor: num(form.stax_protection_factor) ?? 1,
        expected_county_revenue: num(form.stax_expected_county_revenue),
        premium_per_acre: staxPpa,
        total_premium: num(form.stax_total_premium) ?? (staxPpa != null ? Math.round(staxPpa * scoAcres * 100) / 100 : null),
      }
    : null

  const mcoPpa = num(form.mco_premium_per_acre)
  const mco = form.mco_enabled
    ? {
        trigger_level: num(form.mco_trigger_level) ?? 0.9,
        expected_margin: num(form.mco_expected_margin),
        input_cost_adjustment: num(form.mco_input_cost_adjustment) ?? 0,
        expected_county_yield: num(form.mco_expected_county_yield),
        premium_per_acre: mcoPpa,
        total_premium: num(form.mco_total_premium) ?? (mcoPpa != null ? Math.round(mcoPpa * scoAcres * 100) / 100 : null),
      }
    : null

  return { policy, sco, eco, stax, mco }
}

export function validatePolicyForm(form: PolicyFormState, requireEntity = false): string | null {
  const isArea = form.plan_type === 'ARP' || form.plan_type === 'AYP'
  if (requireEntity && !form.entity_id) return 'Select the entity this policy belongs to.'
  if (!form.crop_id) return 'Pick a crop.'
  if (!form.crop_year || !Number.isFinite(Number(form.crop_year))) return 'Enter a crop year.'
  if ((num(form.coverage_level) ?? 0) <= 0) return 'Pick a coverage level.'
  if (!isArea && (num(form.aph_yield) ?? 0) <= 0) return 'Enter the APH yield (bu/ac).'
  if ((num(form.projected_price) ?? 0) <= 0) return 'Enter the projected price ($/bu grains, $/lb cotton).'
  if ((num(form.insured_acres) ?? 0) <= 0) return 'Enter insured acres.'
  if (isArea && (num(form.expected_county_yield) ?? 0) <= 0 && (num(form.expected_county_revenue) ?? 0) <= 0) {
    return 'ARP/AYP are county-triggered — enter the RMA expected county yield or revenue.'
  }
  if (form.sco_enabled && (num(form.sco_expected_county_yield) ?? 0) <= 0) return 'Enter the SCO expected county yield.'
  if (form.eco_enabled && (num(form.eco_expected_county_yield) ?? 0) <= 0) return 'Enter the ECO expected county yield.'
  if (form.stax_enabled && (num(form.stax_expected_county_revenue) ?? 0) <= 0 && (num(form.expected_county_yield) ?? 0) <= 0) {
    return 'STAX needs the expected county revenue (or the policy expected county yield).'
  }
  if (form.mco_enabled && (num(form.mco_expected_margin) ?? 0) <= 0) return 'MCO needs the expected margin ($/ac, from the policy documents).'
  return null
}

// ---------- UI ----------

const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 text-sm w-full bg-white'
const labelCls = 'text-sm flex flex-col gap-1'
const spanCls = 'text-slate-500'

export function PolicyFields({
  value, onChange, crops, counties, entities, cropYearOptions,
  projectedEstimates = [], programConfigs = [],
}: {
  value: PolicyFormState
  onChange: (next: PolicyFormState) => void
  crops: Crop[]
  counties: County[]
  entities: Entity[]
  cropYearOptions: number[]
  // RMA projected prices (harvest_price_estimates, price_type 'projected') and
  // per-year program parameters — both fetched by the page and used to auto-fill
  // the projected price and the SCO trigger when the crop/year changes.
  projectedEstimates?: HarvestPriceEstimate[]
  programConfigs?: ProgramYearConfig[]
}) {
  // Insurance prices are stored in the policy's NATIVE $ unit — $/bu grains,
  // $/lb cotton (RMA publishes cotton at e.g. 0.68, never ¢/lb). The labels
  // and the looks-like-cents hint below keep cotton entries in dollars.
  const isCotton = cropToHedgeCommodity(crops.find((c) => c.id === value.crop_id)?.name) === 'Cotton'
  const priceUnit = isCotton ? '$/lb' : '$/bu'
  const yieldUnit = isCotton ? 'lbs/ac' : 'bu/ac'
  const looksLikeCents = (s: string) => isCotton && Number(s) > 5

  function set<K extends keyof PolicyFormState>(key: K, v: PolicyFormState[K]) {
    onChange({ ...value, [key]: v })
  }

  // Resolved SCO trigger for a given crop year (from program_year_config).
  function triggerForYear(yearStr: string): number {
    const yr = Number(yearStr)
    if (!Number.isFinite(yr)) return DEFAULT_SCO_TRIGGER
    return resolveProgramYearConfig(yr, programConfigs).scoTrigger
  }

  // When the crop or crop year changes, auto-fill the projected price from the
  // DB estimates if the field is still blank, and keep the SCO trigger in sync
  // with the year's program parameters unless the user has overridden it.
  function applyAuto(next: PolicyFormState, cropId: string, yearStr: string): PolicyFormState {
    const yr = Number(yearStr)
    const auto = cropId && Number.isFinite(yr) ? projectedPriceFromEstimates(projectedEstimates, cropId, yr) : null
    const prevTrig = triggerForYear(value.crop_year)
    const cur = next.sco_coverage_trigger.trim()
    // Treat the trigger as "still automatic" when it's blank or matches the
    // prior year's resolved value; only then re-sync it to the new year.
    const userOverrode = cur !== '' && num(cur) !== prevTrig
    return {
      ...next,
      projected_price: next.projected_price.trim() === '' && auto != null ? String(auto) : next.projected_price,
      sco_coverage_trigger: userOverrode ? next.sco_coverage_trigger : String(triggerForYear(yearStr)),
    }
  }
  function onCropChange(cropId: string) {
    onChange(applyAuto({ ...value, crop_id: cropId }, cropId, value.crop_year))
  }
  function onYearChange(yearStr: string) {
    onChange(applyAuto({ ...value, crop_year: yearStr }, value.crop_id, yearStr))
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <label className={labelCls}>
          <span className={spanCls}>Crop *</span>
          <select value={value.crop_id} onChange={(e) => onCropChange(e.target.value)} className={inputCls}>
            <option value="">— select crop —</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Crop year *</span>
          <input
            list="ci-crop-years"
            type="number"
            value={value.crop_year}
            onChange={(e) => onYearChange(e.target.value)}
            className={inputCls}
          />
          <datalist id="ci-crop-years">
            {cropYearOptions.map((y) => <option key={y} value={y} />)}
          </datalist>
        </label>
        <label className={labelCls}>
          <span className={spanCls}>County</span>
          <select value={value.county_id} onChange={(e) => set('county_id', e.target.value)} className={inputCls}>
            <option value="">— select county —</option>
            {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state_code}</option>)}
          </select>
        </label>
        {/* Crop insurance is carried per entity. Multi-entity operations must
            pick; single-entity ones are auto-assigned through EntitySelect
            (shown pre-filled and disabled — seeing the entity on a policy aids
            confidence) and never blocked. */}
        {entities.length > 0 && (
          <label className={labelCls}>
            <span className={spanCls}>Entity{entities.length > 1 ? ' *' : ''}</span>
            <EntitySelect
              entities={entities}
              value={value.entity_id}
              onChange={(id) => set('entity_id', id)}
              className={`${inputCls} disabled:bg-slate-50 disabled:text-slate-600`}
              placeholder="— select entity —"
              showWhenSingle
            />
          </label>
        )}
        <label className={labelCls}>
          <span className={spanCls}>Policy #</span>
          <input value={value.policy_number} onChange={(e) => set('policy_number', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Plan type *</span>
          <select value={value.plan_type} onChange={(e) => set('plan_type', e.target.value as PlanType)} className={inputCls}>
            {PLAN_TYPES.map((t) => <option key={t} value={t}>{PLAN_TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Practice *</span>
          <select value={value.practice} onChange={(e) => set('practice', e.target.value as Practice)} className={inputCls}>
            {PRACTICES.map((pr) => <option key={pr} value={pr}>{PRACTICE_LABEL[pr]}</option>)}
          </select>
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Coverage level *</span>
          <select value={value.coverage_level} onChange={(e) => set('coverage_level', e.target.value)} className={inputCls}>
            {COVERAGE_LEVELS.map((l) => <option key={l} value={l}>{Math.round(Number(l) * 100)}%</option>)}
          </select>
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Unit structure</span>
          <select value={value.unit_structure} onChange={(e) => set('unit_structure', e.target.value as UnitStructure)} className={inputCls}>
            {UNIT_STRUCTURES.map((u) => <option key={u} value={u}>{UNIT_STRUCTURE_LABEL[u]}</option>)}
          </select>
        </label>
        <label className={labelCls}>
          <span className={spanCls}>APH yield ({yieldUnit}) *</span>
          <input type="number" step="0.1" min="0" inputMode="decimal" value={value.aph_yield} onChange={(e) => set('aph_yield', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Projected price ({priceUnit}) *</span>
          <input type="number" step="0.01" min="0" inputMode="decimal" value={value.projected_price} onChange={(e) => set('projected_price', e.target.value)} className={inputCls} />
          {looksLikeCents(value.projected_price) && (
            <span className="text-xs text-red-600">Looks like ¢/lb — cotton insurance prices are $/lb (e.g. 0.68).</span>
          )}
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Harvest price ({priceUnit})</span>
          <input type="number" step="0.01" min="0" inputMode="decimal" placeholder="set in Oct" value={value.harvest_price} onChange={(e) => set('harvest_price', e.target.value)} className={inputCls} />
          {looksLikeCents(value.harvest_price) && (
            <span className="text-xs text-red-600">Looks like ¢/lb — cotton insurance prices are $/lb (e.g. 0.68).</span>
          )}
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Insured acres *</span>
          <input type="number" step="0.01" min="0" inputMode="decimal" value={value.insured_acres} onChange={(e) => set('insured_acres', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Premium / acre ($)</span>
          <input type="number" step="0.01" min="0" inputMode="decimal" value={value.premium_per_acre} onChange={(e) => set('premium_per_acre', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Total premium ($)</span>
          <input type="number" step="0.01" min="0" inputMode="decimal" placeholder="auto from /acre" value={value.total_premium} onChange={(e) => set('total_premium', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Subsidy %</span>
          <input type="number" step="0.1" min="0" inputMode="decimal" value={value.premium_subsidy_pct} onChange={(e) => set('premium_subsidy_pct', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Volatility factor</span>
          <input type="number" step="0.01" min="0" inputMode="decimal" value={value.volatility_factor} onChange={(e) => set('volatility_factor', e.target.value)} className={inputCls} />
        </label>
      </div>

      <label className={labelCls}>
        <span className={spanCls}>Notes</span>
        <input value={value.notes} onChange={(e) => set('notes', e.target.value)} className={inputCls} />
      </label>

      {/* "Covers all planted acres" attestation */}
      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={value.covers_all_planted_acres}
            onChange={(e) => set('covers_all_planted_acres', e.target.checked)}
          />
          <span>
            <span className="font-medium">This policy covers all planted acres for this entity, crop, county, and practice.</span>
            <span className="block text-xs text-slate-500 mt-0.5">
              Check this if your agent has confirmed all your planted acres are covered, even when planted acres differ
              from the insured acres on the policy. This stops the Coverage Check from flagging an acreage gap for this
              combination.
            </span>
          </span>
        </label>
        {value.covers_all_planted_acres && (
          <label className={labelCls}>
            <span className={spanCls}>Coverage note (optional)</span>
            <input
              value={value.coverage_note}
              onChange={(e) => set('coverage_note', e.target.value)}
              placeholder="e.g. confirmed with agent 6/2026"
              className={inputCls}
            />
          </label>
        )}
      </div>

      {/* Area-plan fields (ARP/AYP) — county-triggered, the farm's yield plays no role. */}
      {(value.plan_type === 'ARP' || value.plan_type === 'AYP') && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-3">
          <div className="font-semibold text-sm text-indigo-900">
            Area plan — county-triggered (your farm yield is not used)
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className={labelCls}>
              <span className={spanCls}>RMA expected county yield (bu/ac)</span>
              <input type="number" step="0.1" value={value.expected_county_yield} onChange={(e) => set('expected_county_yield', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Expected county revenue ($/ac)</span>
              <input type="number" step="0.01" placeholder="auto: yield × price" value={value.expected_county_revenue} onChange={(e) => set('expected_county_revenue', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Protection factor (0.8–1.2)</span>
              <input type="number" step="0.05" placeholder="1.0" value={value.protection_factor} onChange={(e) => set('protection_factor', e.target.value)} className={inputCls} />
            </label>
          </div>
          <p className="text-xs text-slate-500">
            Indemnity comes entirely from the estimated county {value.plan_type === 'AYP' ? 'yield' : 'revenue'} vs the
            trigger (coverage × expected). The estimated county yield uses the shared county assumption from Settings /
            the Claims Monitor.
          </p>
        </div>
      )}

      {/* SCO endorsement */}
      <div className="rounded-lg border border-slate-200 p-3 space-y-3">
        <label className="flex items-center gap-2 font-semibold text-sm">
          <input type="checkbox" checked={value.sco_enabled} onChange={(e) => set('sco_enabled', e.target.checked)} />
          Add SCO (Supplemental Coverage Option)
        </label>
        {value.sco_enabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <label className={labelCls}>
              <span className={spanCls}>Coverage trigger</span>
              <input type="number" step="0.01" value={value.sco_coverage_trigger} onChange={(e) => set('sco_coverage_trigger', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Expected county yield (bu/ac)</span>
              <input type="number" step="0.1" value={value.sco_expected_county_yield} onChange={(e) => set('sco_expected_county_yield', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>SCO premium / acre ($)</span>
              <input type="number" step="0.01" value={value.sco_premium_per_acre} onChange={(e) => set('sco_premium_per_acre', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>SCO total premium ($)</span>
              <input type="number" step="0.01" placeholder="auto from /acre" value={value.sco_total_premium} onChange={(e) => set('sco_total_premium', e.target.value)} className={inputCls} />
            </label>
            <p className="text-xs text-slate-500 sm:col-span-2 lg:col-span-3">
              The estimated county yield comes from the shared &ldquo;My yield vs county&rdquo; differential at the
              top of this page — one assumption drives every county-triggered leg (SCO/ECO/STAX/ARP/AYP/MCO).
            </p>
          </div>
        )}
      </div>

      {/* ECO endorsement */}
      <div className="rounded-lg border border-slate-200 p-3 space-y-3">
        <label className="flex items-center gap-2 font-semibold text-sm">
          <input type="checkbox" checked={value.eco_enabled} onChange={(e) => set('eco_enabled', e.target.checked)} />
          Add ECO (Enhanced Coverage Option)
        </label>
        {value.eco_enabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <label className={labelCls}>
              <span className={spanCls}>Trigger level</span>
              <select value={value.eco_trigger_level} onChange={(e) => set('eco_trigger_level', e.target.value)} className={inputCls}>
                {ECO_TRIGGER_LEVELS.map((l) => <option key={l} value={String(l)}>{Math.round(l * 100)}%</option>)}
              </select>
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Expected county yield (bu/ac)</span>
              <input type="number" step="0.1" value={value.eco_expected_county_yield} onChange={(e) => set('eco_expected_county_yield', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>ECO premium / acre ($)</span>
              <input type="number" step="0.01" value={value.eco_premium_per_acre} onChange={(e) => set('eco_premium_per_acre', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>ECO total premium ($)</span>
              <input type="number" step="0.01" placeholder="auto from /acre" value={value.eco_total_premium} onChange={(e) => set('eco_total_premium', e.target.value)} className={inputCls} />
            </label>
          </div>
        )}
      </div>

      {/* STAX endorsement (upland cotton) */}
      <div className="rounded-lg border border-slate-200 p-3 space-y-3">
        <label className="flex items-center gap-2 font-semibold text-sm">
          <input type="checkbox" checked={value.stax_enabled} onChange={(e) => set('stax_enabled', e.target.checked)} />
          Add STAX (Stacked Income Protection — cotton)
        </label>
        {value.stax_enabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <label className={labelCls}>
              <span className={spanCls}>Coverage range top</span>
              <input type="number" step="0.05" value={value.stax_coverage_range_top} onChange={(e) => set('stax_coverage_range_top', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Coverage % (band depth, ≤ 0.20)</span>
              <select value={value.stax_coverage_pct} onChange={(e) => set('stax_coverage_pct', e.target.value)} className={inputCls}>
                {['0.05', '0.10', '0.15', '0.20'].map((v) => <option key={v} value={v}>{Math.round(Number(v) * 100)}%</option>)}
              </select>
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Protection factor (0.8–1.2)</span>
              <input type="number" step="0.05" value={value.stax_protection_factor} onChange={(e) => set('stax_protection_factor', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Expected county revenue ($/ac)</span>
              <input type="number" step="0.01" value={value.stax_expected_county_revenue} onChange={(e) => set('stax_expected_county_revenue', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>STAX premium / acre ($)</span>
              <input type="number" step="0.01" value={value.stax_premium_per_acre} onChange={(e) => set('stax_premium_per_acre', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>STAX total premium ($)</span>
              <input type="number" step="0.01" placeholder="auto from /acre" value={value.stax_total_premium} onChange={(e) => set('stax_total_premium', e.target.value)} className={inputCls} />
            </label>
            <p className="text-xs text-slate-500 sm:col-span-2 lg:col-span-3">
              Pays when the county revenue factor falls below the range top, scaling through the band × protection
              factor. Note: STAX generally can&apos;t cover acres whose seed-cotton base is enrolled in ARC/PLC.
            </p>
          </div>
        )}
      </div>

      {/* MCO endorsement */}
      <div className="rounded-lg border border-slate-200 p-3 space-y-3">
        <label className="flex items-center gap-2 font-semibold text-sm">
          <input type="checkbox" checked={value.mco_enabled} onChange={(e) => set('mco_enabled', e.target.checked)} />
          Add MCO (Margin Coverage Option)
        </label>
        {value.mco_enabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <label className={labelCls}>
              <span className={spanCls}>Trigger level (band top)</span>
              <select value={value.mco_trigger_level} onChange={(e) => set('mco_trigger_level', e.target.value)} className={inputCls}>
                {['0.9', '0.95'].map((v) => <option key={v} value={v}>{Math.round(Number(v) * 100)}%</option>)}
              </select>
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Expected margin ($/ac, from policy docs)</span>
              <input type="number" step="0.01" value={value.mco_expected_margin} onChange={(e) => set('mco_expected_margin', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Input-cost adjustment ($/ac)</span>
              <input type="number" step="0.01" value={value.mco_input_cost_adjustment} onChange={(e) => set('mco_input_cost_adjustment', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>Expected county yield (bu/ac)</span>
              <input type="number" step="0.1" value={value.mco_expected_county_yield} onChange={(e) => set('mco_expected_county_yield', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>MCO premium / acre ($)</span>
              <input type="number" step="0.01" value={value.mco_premium_per_acre} onChange={(e) => set('mco_premium_per_acre', e.target.value)} className={inputCls} />
            </label>
            <label className={labelCls}>
              <span className={spanCls}>MCO total premium ($)</span>
              <input type="number" step="0.01" placeholder="auto from /acre" value={value.mco_total_premium} onChange={(e) => set('mco_total_premium', e.target.value)} className={inputCls} />
            </label>
            <p className="text-xs text-slate-500 sm:col-span-2 lg:col-span-3">
              Margin band 86% → the trigger. The county-yield side uses the shared county assumption, like SCO/ECO.
            </p>
          </div>
        )}
      </div>

      <PolicyLiveSummary value={value} />
    </div>
  )
}

// Live revenue-guarantee + total-premium readout, recomputed as fields change.
export function PolicyLiveSummary({ value }: { value: PolicyFormState }) {
  const summary = useMemo(() => {
    const aph = num(value.aph_yield) ?? 0
    const cov = num(value.coverage_level) ?? 0
    const proj = num(value.projected_price) ?? 0
    const harv = num(value.harvest_price)
    const acres = num(value.insured_acres) ?? 0
    const gp = guaranteePriceFor(value.plan_type, proj, harv ?? proj)
    const revenueGuarantee = aph * cov * gp * acres

    const basePrem = num(value.total_premium) ?? ((num(value.premium_per_acre) ?? 0) * acres)
    const scoPrem = value.sco_enabled
      ? endorsementPremium({ total_premium: num(value.sco_total_premium), premium_per_acre: num(value.sco_premium_per_acre) }, acres)
      : 0
    const ecoPrem = value.eco_enabled
      ? endorsementPremium({ total_premium: num(value.eco_total_premium), premium_per_acre: num(value.eco_premium_per_acre) }, acres)
      : 0
    const staxPrem = value.stax_enabled
      ? endorsementPremium({ total_premium: num(value.stax_total_premium), premium_per_acre: num(value.stax_premium_per_acre) }, acres)
      : 0
    const mcoPrem = value.mco_enabled
      ? endorsementPremium({ total_premium: num(value.mco_total_premium), premium_per_acre: num(value.mco_premium_per_acre) }, acres)
      : 0
    return { gp, revenueGuarantee, totalPremium: basePrem + scoPrem + ecoPrem + staxPrem + mcoPrem, perAcre: acres > 0 ? revenueGuarantee / acres : 0 }
  }, [value])

  const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm flex flex-wrap gap-x-6 gap-y-1">
      <span><span className="text-slate-500">Guarantee price:</span> <strong>{fmtPrice(summary.gp)}</strong></span>
      <span><span className="text-slate-500">Revenue guarantee:</span> <strong>{usd(summary.revenueGuarantee)}</strong></span>
      <span><span className="text-slate-500">/ acre:</span> <strong>{usd(summary.perAcre)}</strong></span>
      <span><span className="text-slate-500">Total premium:</span> <strong>{usd(summary.totalPremium)}</strong></span>
    </div>
  )
}
