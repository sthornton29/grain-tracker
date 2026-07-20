'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { usePersistentState } from '@/lib/use-persistent-state'
import EntityFilter from '@/components/entity-filter'
import {
  PolicyFields, emptyPolicyForm, policyToForm, policyFormToPayloads, validatePolicyForm,
  type PolicyFormState,
} from '@/components/crop-insurance/policy-form'
import PolicyAiImport from '@/components/crop-insurance/policy-ai-import'
import CoverageCheck from '@/components/crop-insurance/coverage-check'
import { PLAN_TYPE_SHORT, PRACTICE_LABEL, isAreaPlan, stackingWarnings } from '@/lib/crop-insurance'
import { fmtPrice } from '@/lib/hedging'
import ProjectedPricesEditor from '@/components/crop-insurance/projected-prices-editor'
import { CountyAssumptionControl } from '@/components/crop-insurance/county-assumption-editor'
import type {
  Crop, County, Entity, FieldPlanting, CropInsurancePolicy, CropInsuranceSco, CropInsuranceEco,
  CropInsuranceStax, CropInsuranceMco, CountyYieldAssumption,
  HarvestPriceEstimate, ProgramYearConfig,
} from '@/lib/types'

export default function CropInsuranceSettingsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [crops, setCrops] = useState<Crop[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [policies, setPolicies] = useState<CropInsurancePolicy[]>([])
  const [scos, setScos] = useState<CropInsuranceSco[]>([])
  const [ecos, setEcos] = useState<CropInsuranceEco[]>([])
  const [staxes, setStaxes] = useState<CropInsuranceStax[]>([])
  const [mcos, setMcos] = useState<CropInsuranceMco[]>([])
  const [countyAssumptions, setCountyAssumptions] = useState<CountyYieldAssumption[]>([])
  const [estimates, setEstimates] = useState<HarvestPriceEstimate[]>([])
  const [programConfigs, setProgramConfigs] = useState<ProgramYearConfig[]>([])

  const [form, setForm] = useState<PolicyFormState>(emptyPolicyForm)
  const [showAdd, setShowAdd] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<PolicyFormState>(emptyPolicyForm)
  const [err, setErr] = useState<string | null>(null)
  const [entityFilter, setEntityFilter] = usePersistentState('crop-insurance-settings:entity', '')

  async function refresh() {
    const [cr, co, en, pl, po, sc, ec, hp, pc, sx, mc, ca] = await Promise.all([
      supabase.from('crops').select('*').order('name'),
      supabase.from('counties').select('*').order('state_code').order('name'),
      supabase.from('entities').select('*').order('name'),
      supabase.from('field_plantings').select('*'),
      supabase.from('crop_insurance_policies').select('*').order('crop_year', { ascending: false }),
      supabase.from('crop_insurance_sco').select('*'),
      supabase.from('crop_insurance_eco').select('*'),
      supabase.from('harvest_price_estimates').select('*'),
      supabase.from('program_year_config').select('*').order('crop_year', { ascending: false }),
      // 045 tables — tolerate the migration not being applied yet.
      supabase.from('crop_insurance_stax').select('*'),
      supabase.from('crop_insurance_mco').select('*'),
      supabase.from('county_yield_assumptions').select('*'),
    ])
    setCrops((cr.data as Crop[]) || [])
    setCounties((co.data as County[]) || [])
    setEntities((en.data as Entity[]) || [])
    setPlantings((pl.data as FieldPlanting[]) || [])
    setPolicies((po.data as CropInsurancePolicy[]) || [])
    setScos((sc.data as CropInsuranceSco[]) || [])
    setEcos((ec.data as CropInsuranceEco[]) || [])
    setEstimates((hp.data as HarvestPriceEstimate[]) || [])
    setProgramConfigs((pc.data as ProgramYearConfig[]) || [])
    setStaxes((sx.data as CropInsuranceStax[]) || [])
    setMcos((mc.data as CropInsuranceMco[]) || [])
    setCountyAssumptions((ca.data as CountyYieldAssumption[]) || [])
  }
  useEffect(() => { refresh() /* eslint-disable-line */ }, [])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings([
      ...plantings.map((p) => p.season_year),
      ...policies.map((p) => p.crop_year),
      new Date().getFullYear(),
    ]),
    [plantings, policies],
  )
  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const countyById = useMemo(() => new Map(counties.map((c) => [c.id, c])), [counties])
  const scoByPolicy = useMemo(() => new Map(scos.map((s) => [s.policy_id, s])), [scos])
  const ecoByPolicy = useMemo(() => new Map(ecos.map((e) => [e.policy_id, e])), [ecos])

  // Default the new-policy form's year to the latest available option.
  useEffect(() => {
    if (cropYearOptions.length > 0) {
      setForm((f) => (f.crop_year === '' ? { ...f, crop_year: String(cropYearOptions[0]) } : f))
    }
  }, [cropYearOptions])

  // Write endorsement sub-records for a policy: upsert when enabled, delete when off.
  async function syncEndorsements(
    policyId: string,
    sco: Record<string, unknown> | null,
    eco: Record<string, unknown> | null,
    stax?: Record<string, unknown> | null,
    mco?: Record<string, unknown> | null,
  ) {
    const pairs: Array<[string, Record<string, unknown> | null | undefined, string]> = [
      ['crop_insurance_sco', sco, 'SCO'],
      ['crop_insurance_eco', eco, 'ECO'],
      ['crop_insurance_stax', stax, 'STAX'],
      ['crop_insurance_mco', mco, 'MCO'],
    ]
    for (const [table, payload, label] of pairs) {
      if (payload) {
        const { error } = await supabase.from(table).upsert({ ...payload, policy_id: policyId }, { onConflict: 'policy_id' })
        if (error) throw new Error(`${label}: ${error.message}`)
      } else {
        await supabase.from(table).delete().eq('policy_id', policyId)
      }
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const v = validatePolicyForm(form, entities.length > 1)
    if (v) { setErr(v); return }
    setErr(null)
    const { policy, sco, eco, stax, mco } = policyFormToPayloads(form, 'manual')
    const { data, error } = await supabase.from('crop_insurance_policies').insert(policy).select('id').single()
    if (error || !data) { setErr(error?.message ?? 'Insert failed.'); return }
    try {
      await syncEndorsements((data as { id: string }).id, sco, eco, stax, mco)
    } catch (e2: any) { setErr(e2?.message ?? 'Saving endorsements failed.'); refresh(); return }
    setForm({ ...emptyPolicyForm, crop_year: form.crop_year, entity_id: form.entity_id })
    setShowAdd(false)
    refresh()
  }

  async function save(id: string) {
    const v = validatePolicyForm(editForm, entities.length > 1)
    if (v) { setErr(v); return }
    setErr(null)
    const { policy, sco, eco, stax, mco } = policyFormToPayloads(editForm, 'manual')
    const { error } = await supabase.from('crop_insurance_policies').update(policy).eq('id', id)
    if (error) { setErr(error.message); return }
    try {
      await syncEndorsements(id, sco, eco, stax, mco)
    } catch (e2: any) { setErr(e2?.message ?? 'Saving endorsements failed.'); refresh(); return }
    setEditingId(null)
    refresh()
  }

  async function remove(id: string) {
    if (!confirm('Delete this policy and its SCO/ECO endorsements?')) return
    const { error } = await supabase.from('crop_insurance_policies').delete().eq('id', id)
    if (error) { setErr(error.message); return }
    refresh()
  }

  const staxByPolicy = useMemo(() => new Map(staxes.map((s) => [s.policy_id, s])), [staxes])
  const mcoByPolicy = useMemo(() => new Map(mcos.map((m) => [m.policy_id, m])), [mcos])

  // Stacking conflicts (warn, never block — the agent is the authority).
  const conflicts = useMemo(() => stackingWarnings({
    policies,
    ecoPolicyIds: new Set(ecos.map((e) => e.policy_id)),
    staxPolicyIds: new Set(staxes.map((s) => s.policy_id)),
    mcoPolicyIds: new Set(mcos.map((m) => m.policy_id)),
    cropName: (id) => cropById.get(id)?.name ?? 'crop',
  }), [policies, ecos, staxes, mcos, cropById])

  function startEdit(p: CropInsurancePolicy) {
    setEditingId(p.id)
    setEditForm(policyToForm(p, scoByPolicy.get(p.id), ecoByPolicy.get(p.id), staxByPolicy.get(p.id), mcoByPolicy.get(p.id)))
    setErr(null)
  }

  const cropName = (id: string) => cropById.get(id)?.name ?? '—'
  const countyName = (id: string | null) => {
    if (!id) return 'No county'
    const c = countyById.get(id)
    return c ? `${c.name}, ${c.state_code}` : '—'
  }
  const entityName = (id: string | null) => (id ? entities.find((e) => e.id === id)?.name ?? '' : '')

  // Policies shown in the list, scoped to the selected entity.
  const visiblePolicies = useMemo(
    () => (entityFilter ? policies.filter((p) => p.entity_id === entityFilter) : policies),
    [policies, entityFilter],
  )
  // New policies default to the selected entity.
  useEffect(() => {
    if (entityFilter) setForm((f) => ({ ...f, entity_id: entityFilter }))
  }, [entityFilter])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold flex-1">Crop Insurance Policies</h1>
        <Link href="/reports/crop-insurance-claims" className="text-sm rounded-lg bg-slate-700 text-white px-3 py-2 font-semibold">
          Claims Monitor →
        </Link>
      </div>
      <p className="text-sm text-slate-600 max-w-3xl">
        Enter your MPCI policies (RP / RP-HPE / YP) with optional SCO and ECO endorsements, or upload a coverage
        summary and let AI fill them in. These feed the Crop Insurance Claims Monitor and the Revenue Projections report.
      </p>

      <p className="text-xs text-amber-700 max-w-3xl">
        Policies now track <strong>practice</strong> (Irrigated / Dryland). Existing and imported policies default to
        <strong> Dryland</strong> — review and switch any irrigated policies to <strong>Irrigated</strong> so the
        Coverage Check and per-practice indemnity line up.
      </p>

      {conflicts.length > 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm text-amber-900 space-y-0.5 max-w-3xl">
          <div className="font-semibold">Stacking review (warnings only — your agent is the authority):</div>
          {conflicts.map((w) => <div key={w.key}>· {w.message}</div>)}
        </div>
      )}

      {/* Unified county-yield assumption (045): ONE source for every county-
          triggered plan (SCO/ECO/STAX/ARP/AYP/MCO). Separate from ARC-CO. */}
      <div className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">My yield vs county (insurance)</h2>
        <p className="text-xs text-slate-500 max-w-3xl">
          The stable relationship between your yields and the county average — &ldquo;I typically run 15 bu/ac better
          than the county&rdquo;. Estimated county yield = your expected/actual yield minus this differential; it drives
          every county-triggered calculation (SCO/ECO/STAX/ARP/AYP/MCO). This is a
          <strong> separate assumption from the ARC-CO expectation</strong>: ARC uses FSA benchmarks.
        </p>
        <div className="space-y-1">
          {Array.from(new Map(policies.map((p) => [`${p.crop_id}|${p.county_id ?? ''}|${p.crop_year}`, p])).values()).map((p) => (
            <div key={`${p.crop_id}|${p.county_id ?? ''}|${p.crop_year}`} className="flex items-center gap-2 flex-wrap text-sm">
              <span className="font-medium w-56 truncate">{cropName(p.crop_id)} · {countyName(p.county_id)} · {p.crop_year}</span>
              <CountyAssumptionControl
                cropId={p.crop_id}
                countyId={p.county_id}
                cropYear={p.crop_year}
                assumption={countyAssumptions.find((a) => a.crop_id === p.crop_id && a.crop_year === p.crop_year && (a.county_id ?? '') === (p.county_id ?? '')) ?? null}
                yieldUnit={/cotton/i.test(cropName(p.crop_id)) ? 'lbs/ac' : 'bu/ac'}
                onChanged={refresh}
              />
            </div>
          ))}
          {policies.length === 0 && <p className="text-sm text-slate-400">Assumptions appear here once policies exist.</p>}
        </div>
      </div>

      <EntityFilter entities={entities} value={entityFilter} onChange={setEntityFilter} />

      <div id="coverage-check" className="scroll-mt-4">
        <CoverageCheck
          crops={crops}
          counties={counties}
          entities={entities}
          plantings={plantings}
          policies={policies}
          cropYearOptions={cropYearOptions}
          defaultYear={cropYearOptions[0] ?? new Date().getFullYear()}
          onChanged={refresh}
        />
      </div>

      <ProjectedPricesEditor crops={crops} estimates={estimates} onChange={refresh} />

      <PolicyAiImport
        crops={crops}
        counties={counties}
        entities={entities}
        existingPolicies={policies}
        existingScos={scos}
        existingEcos={ecos}
        defaultYear={cropYearOptions[0] ?? new Date().getFullYear()}
        defaultEntityId={entityFilter || form.entity_id}
        projectedEstimates={estimates}
        programConfigs={programConfigs}
        onImported={refresh}
      />

      {/* Manual add */}
      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <button
          type="button"
          onClick={() => setShowAdd((s) => !s)}
          className="font-semibold flex items-center gap-2"
        >
          <span className="text-slate-400">{showAdd ? '▾' : '▸'}</span> Add a policy manually
        </button>
        {showAdd && (
          <form onSubmit={add} className="space-y-3">
            <PolicyFields value={form} onChange={setForm} crops={crops} counties={counties} entities={entities} cropYearOptions={cropYearOptions} projectedEstimates={estimates} programConfigs={programConfigs} />
            <button className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold">Add Policy</button>
          </form>
        )}
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* List */}
      <ul className="bg-white rounded-xl shadow divide-y">
        {visiblePolicies.length === 0 && <li className="px-4 py-6 text-center text-slate-400">{policies.length === 0 ? 'No policies yet.' : 'No policies for this entity.'}</li>}
        {visiblePolicies.map((p) => {
          const sco = scoByPolicy.get(p.id)
          const eco = ecoByPolicy.get(p.id)
          return (
            <li key={p.id} className="px-4 py-3 space-y-2">
              {editingId === p.id ? (
                <>
                  <PolicyFields value={editForm} onChange={setEditForm} crops={crops} counties={counties} entities={entities} cropYearOptions={cropYearOptions} projectedEstimates={estimates} programConfigs={programConfigs} />
                  <div className="flex gap-3">
                    <button onClick={() => save(p.id)} className="text-green-700 font-semibold">Save</button>
                    <button onClick={() => setEditingId(null)} className="text-slate-500">Cancel</button>
                  </div>
                </>
              ) : (
                <div className="flex items-start gap-2 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold flex items-center gap-2 flex-wrap">
                      {cropName(p.crop_id)} · {countyName(p.county_id)}
                      <span className="text-xs rounded-full bg-slate-200 text-slate-700 px-2 py-0.5">{PLAN_TYPE_SHORT[p.plan_type]} {Math.round(Number(p.coverage_level) * 100)}%</span>
                      <span className="text-xs rounded-full bg-slate-100 text-slate-600 px-2 py-0.5">{PRACTICE_LABEL[p.practice ?? 'non_irrigated']}</span>
                      <span className="text-xs text-slate-500">{p.crop_year} crop</span>
                      {p.entity_id && <span className="text-xs text-slate-500">· {entityName(p.entity_id)}</span>}
                      {sco && <span className="text-xs rounded-full bg-sky-100 text-sky-800 px-2 py-0.5">SCO</span>}
                      {eco && <span className="text-xs rounded-full bg-indigo-100 text-indigo-800 px-2 py-0.5">ECO</span>}
                      {staxByPolicy.get(p.id) && <span className="text-xs rounded-full bg-teal-100 text-teal-800 px-2 py-0.5">STAX</span>}
                      {mcoByPolicy.get(p.id) && <span className="text-xs rounded-full bg-purple-100 text-purple-800 px-2 py-0.5">MCO</span>}
                      {isAreaPlan(p.plan_type) && <span className="text-xs rounded-full bg-indigo-100 text-indigo-800 px-2 py-0.5">county-triggered</span>}
                      {p.source === 'document_import' && <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">imported</span>}
                    </div>
                    <div className="text-sm text-slate-500">
                      APH {Number(p.aph_yield)} bu/ac · Projected {fmtPrice(p.projected_price)}
                      {p.harvest_price != null && <> · Harvest {fmtPrice(p.harvest_price)}</>}
                      {' · '}{Number(p.insured_acres).toLocaleString()} ac
                      {p.policy_number && <> · #{p.policy_number}</>}
                      {p.total_premium != null && <> · premium ${Number(p.total_premium).toLocaleString()}</>}
                    </div>
                  </div>
                  <button onClick={() => startEdit(p)} className="text-sky-700">Edit</button>
                  <button onClick={() => remove(p.id)} className="text-red-600">Delete</button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
