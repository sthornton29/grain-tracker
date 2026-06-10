'use client'

// Crop insurance policy form — base MPCI policy plus optional SCO / ECO
// endorsement sub-forms. Holds the editable form state for all three records
// (they live in separate tables but are edited as one unit) and exposes pure
// helpers to map a saved policy ⇄ form ⇄ insert/update payloads. The settings
// page and the AI import screen both drive this.

import { useMemo } from 'react'
import {
  PLAN_TYPES, PLAN_TYPE_LABEL, UNIT_STRUCTURES, UNIT_STRUCTURE_LABEL,
  ECO_TRIGGER_LEVELS, guaranteePriceFor, projectedPriceFromEstimates,
  endorsementPremium, type PlanType, type UnitStructure,
} from '@/lib/crop-insurance'
import { DEFAULT_SCO_TRIGGER, resolveProgramYearConfig } from '@/lib/program-config'
import { fmtPrice } from '@/lib/hedging'
import type {
  Crop, County, Entity, CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco,
  HarvestPriceEstimate, ProgramYearConfig,
} from '@/lib/types'

export type PolicyFormState = {
  entity_id: string
  crop_id: string
  crop_year: string
  county_id: string
  policy_number: string
  plan_type: PlanType
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
}

export const COVERAGE_LEVELS = ['0.50', '0.55', '0.60', '0.65', '0.70', '0.75', '0.80', '0.85'] as const

export const emptyPolicyForm: PolicyFormState = {
  entity_id: '',
  crop_id: '',
  crop_year: '',
  county_id: '',
  policy_number: '',
  plan_type: 'RP',
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
}

const numStr = (n: number | null | undefined) => (n == null || !Number.isFinite(Number(n)) ? '' : String(Number(n)))
function num(s: string): number | null {
  if (s == null || s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function policyToForm(p: CropInsurancePolicy, sco?: CropInsuranceSco | null, eco?: CropInsuranceEco | null): PolicyFormState {
  return {
    entity_id: p.entity_id ?? '',
    crop_id: p.crop_id,
    crop_year: String(p.crop_year),
    county_id: p.county_id ?? '',
    policy_number: p.policy_number ?? '',
    plan_type: p.plan_type,
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
  }
}

export type PolicyPayloads = {
  policy: Record<string, unknown>
  sco: Record<string, unknown> | null
  eco: Record<string, unknown> | null
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

  return { policy, sco, eco }
}

export function validatePolicyForm(form: PolicyFormState): string | null {
  if (!form.crop_id) return 'Pick a crop.'
  if (!form.crop_year || !Number.isFinite(Number(form.crop_year))) return 'Enter a crop year.'
  if ((num(form.coverage_level) ?? 0) <= 0) return 'Pick a coverage level.'
  if ((num(form.aph_yield) ?? 0) <= 0) return 'Enter the APH yield (bu/ac).'
  if ((num(form.projected_price) ?? 0) <= 0) return 'Enter the projected price ($/bu).'
  if ((num(form.insured_acres) ?? 0) <= 0) return 'Enter insured acres.'
  if (form.sco_enabled && (num(form.sco_expected_county_yield) ?? 0) <= 0) return 'Enter the SCO expected county yield.'
  if (form.eco_enabled && (num(form.eco_expected_county_yield) ?? 0) <= 0) return 'Enter the ECO expected county yield.'
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
        <label className={labelCls}>
          <span className={spanCls}>Entity</span>
          <select value={value.entity_id} onChange={(e) => set('entity_id', e.target.value)} className={inputCls}>
            <option value="">— optional —</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
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
          <span className={spanCls}>APH yield (bu/ac) *</span>
          <input type="number" step="0.1" min="0" inputMode="decimal" value={value.aph_yield} onChange={(e) => set('aph_yield', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Projected price ($/bu) *</span>
          <input type="number" step="0.01" min="0" inputMode="decimal" value={value.projected_price} onChange={(e) => set('projected_price', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          <span className={spanCls}>Harvest price ($/bu)</span>
          <input type="number" step="0.01" min="0" inputMode="decimal" placeholder="set in Oct" value={value.harvest_price} onChange={(e) => set('harvest_price', e.target.value)} className={inputCls} />
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
              <span className={spanCls}>County yield vs yours (%)</span>
              <input type="number" step="1" value={value.sco_county_yield_assumption_pct} onChange={(e) => set('sco_county_yield_assumption_pct', e.target.value)} className={inputCls} />
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
              County yield vs yours: how the county average typically compares to your operation. If county
              yields are typically 10% lower than yours, enter <strong>-10</strong>.
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
              <span className={spanCls}>County yield vs yours (%)</span>
              <input type="number" step="1" value={value.eco_county_yield_assumption_pct} onChange={(e) => set('eco_county_yield_assumption_pct', e.target.value)} className={inputCls} />
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
    return { gp, revenueGuarantee, totalPremium: basePrem + scoPrem + ecoPrem, perAcre: acres > 0 ? revenueGuarantee / acres : 0 }
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
