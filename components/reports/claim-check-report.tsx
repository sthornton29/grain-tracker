'use client'

// Claim Check (0101) — per insurance unit (insured × county × crop ×
// practice): harvested yield so far vs the trigger yield, whether a claim
// needs opening, where the agent's report and Turnrow disagree, and a reply
// to the agent written from all of it. The math is lib/trigger-yield-check
// over lib/production-report (the Production Report's own engine).

import Link from 'next/link'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { useCottonYields } from '@/lib/use-cotton-yields'
import { useViewerScope, entityOptionsFor, viewerAllEntitiesLabel } from '@/lib/use-viewer-scope'
import { useViewerAssumptions } from '@/lib/use-viewer-assumptions'
import { resolveCropAssumptions } from '@/lib/viewer-assumptions'
import { usePersistentState } from '@/lib/use-persistent-state'
import { useReportCropYear } from '@/lib/report-filters'
import { reportError } from '@/lib/friendly-error'
import { buildProductionReport } from '@/lib/production-report'
import { resolveHarvestPriceByCrop } from '@/lib/crop-insurance'
import {
  buildAgentReply, buildClaimCheck, defaultClaimKeys, practiceWord, WATCH_MARGIN,
  type ClaimCheckUnit, type TriggerYieldRow, type UnitStatus,
} from '@/lib/trigger-yield-check'
import type { ExportPayload } from '@/lib/exports'
import type { CombineEntryLike } from '@/lib/yields'
import type { County, Crop, CropAssumption, CropInsurancePolicy, Entity, Farm, Field, FieldPlanting, HarvestPriceEstimate, LoadSplit } from '@/lib/types'
import {
  EmptyState, ReportHeader, ReportFilterBar, FilterField, SummaryCards, InfoTip,
  theadCls, selectCls, filterSummaryOf, cropYearLabel, toneText, type Tone,
} from '@/components/reports/report-kit'
import ExportBar from '@/components/export-bar'
import { AppModal } from '@/components/app-dialog'
import TriggerReportImport from '@/components/crop-insurance/trigger-report-import'
import type { ProductionLoadRow } from '@/lib/production-report'

const LOAD_SELECT = 'id, date, time, net_weight, moisture, crop_id, dry_bushels_override, crop_year, from_type, from_field_id, practice'

const STATUS_LABEL: Record<UnitStatus, string> = {
  below: 'Below trigger',
  watch: 'Close to trigger',
  above: 'Above trigger',
  not_started: 'Not harvested yet',
  no_coverage: 'No policy',
}
const STATUS_TONE: Record<UnitStatus, Tone> = { below: 'unfavorable', watch: 'warning', above: 'favorable', not_started: 'muted', no_coverage: 'muted' }

const fmt1 = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }))
const fmtSigned = (v: number | null) => (v == null ? '—' : v < 0 ? `(${fmt1(-v)})` : `+${fmt1(v)}`)
const unitName = (u: ClaimCheckUnit) => `${u.countyName} · ${u.cropName} · ${practiceWord(u.practice) === 'irrigated' ? 'Irrigated' : 'Dryland'}`

export default function ClaimCheckReport() {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [crops, setCrops] = useState<Crop[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [landowners, setLandowners] = useState<Array<{ id: string; name: string }>>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [counties, setCounties] = useState<County[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [loads, setLoads] = useState<ProductionLoadRow[]>([])
  const [splits, setSplits] = useState<LoadSplit[]>([])
  const [combineEntries, setCombineEntries] = useState<CombineEntryLike[]>([])
  const [assumptions, setAssumptions] = useState<CropAssumption[]>([])
  const [policies, setPolicies] = useState<CropInsurancePolicy[]>([])
  const [triggers, setTriggers] = useState<TriggerYieldRow[]>([])
  const [estimates, setEstimates] = useState<HarvestPriceEstimate[]>([])

  const loadTriggers = useCallback(async () => {
    const r = await fetchAllRows((f, t) => supabase.from('insurance_trigger_yields').select('*').order('id').range(f, t))
    if (!r.error) setTriggers((r.data as TriggerYieldRow[]) || [])
  }, [supabase])
  const loadPolicies = useCallback(async () => {
    const r = await fetchAllRows((f, t) => supabase.from('crop_insurance_policies').select('*').order('id').range(f, t))
    if (!r.error) setPolicies((r.data as CropInsurancePolicy[]) || [])
  }, [supabase])

  useEffect(() => {
    ;(async () => {
      try {
        const [cr, en, lo, fa, fi, co, pl, ld, sp, ca, ce, es] = await Promise.all([
          supabase.from('crops').select('*').order('name'),
          supabase.from('entities').select('*').order('name'),
          supabase.from('landowners').select('id, name').order('name'),
          supabase.from('farms').select('*').is('archived_at', null),
          supabase.from('fields').select('*').is('archived_at', null),
          supabase.from('counties').select('*').order('state_code').order('name'),
          fetchAllRows((f, t) => supabase.from('field_plantings').select('*').is('archived_at', null).order('id').range(f, t)),
          fetchAllRows((f, t) => supabase.from('loads').select(LOAD_SELECT).order('id').range(f, t)),
          fetchAllRows((f, t) => supabase.from('load_splits').select('*').order('id').range(f, t)),
          supabase.from('crop_assumptions').select('*'),
          fetchAllRows((f, t) => supabase.from('combine_yield_entries').select('id, field_id, crop_id, crop_year, stated_total_bushels, adjusted_total_bushels, adjustment_bu_per_acre, destination_bin_id, harvest_complete, entry_date').order('id').range(f, t)),
          fetchAllRows((f, t) => supabase.from('harvest_price_estimates').select('*').order('id').range(f, t)),
        ])
        const err = cr.error ?? en.error ?? fa.error ?? fi.error ?? pl.error ?? ld.error ?? sp.error
        if (err) throw err
        setCrops((cr.data as Crop[]) || [])
        setEntities((en.data as Entity[]) || [])
        setLandowners((lo.data as Array<{ id: string; name: string }>) || [])
        setFarms((fa.data as Farm[]) || [])
        setFields((fi.data as Field[]) || [])
        setCounties((co.data as County[]) || [])
        setPlantings((pl.data as FieldPlanting[]) || [])
        setLoads((ld.data as ProductionLoadRow[]) || [])
        setSplits((sp.data as LoadSplit[]) || [])
        setAssumptions((ca.data as CropAssumption[]) || [])
        setCombineEntries((ce.data as CombineEntryLike[]) || [])
        setEstimates((es.data as HarvestPriceEstimate[]) || [])
        await Promise.all([loadPolicies(), loadTriggers()])
      } catch (e) {
        setLoadErr(reportError(e as Error, { action: 'load the claim check' }))
      } finally {
        setLoading(false)
      }
    })()
  }, [supabase, loadPolicies, loadTriggers])

  const viewer = useViewerScope(supabase)
  const viewerA = useViewerAssumptions(supabase, viewer)
  const assumptionRes = useMemo(() => resolveCropAssumptions(assumptions, viewerA.overrides), [assumptions, viewerA.overrides])
  const effAssumptions = assumptionRes.rows
  const cottonYields = useCottonYields(supabase, { crops, assumptions: effAssumptions })
  const cotton = cottonYields.model
  const canEdit = !viewer.loading && !viewer.isViewer

  const years = useMemo(() => Array.from(new Set([...plantings.map((p) => p.season_year), ...policies.map((p) => p.crop_year)])), [plantings, policies])
  const [cropYear, setCropYear] = useReportCropYear('claim-check:cropYear', { options: years, loaded: !loading })
  const [entityId, setEntityId] = usePersistentState('claim-check:entityId', '')
  const entityOptions = entityOptionsFor(viewer, entities)
  const allEntitiesLabel = viewerAllEntitiesLabel(viewer, entities) ?? 'All entities'
  const [showImport, setShowImport] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const production = useMemo(() => buildProductionReport({
    cropYear, entityId: '', cropIds: [], plantings, fields, farms, counties, crops, loads, splits, combineEntries,
    assumptions: effAssumptions, cotton, acceptedAsDryland: true,
  }), [cropYear, plantings, fields, farms, counties, crops, loads, splits, combineEntries, effAssumptions, cotton])

  const harvestPriceByCrop = useMemo(() => {
    if (cropYear === '') return new Map<string, number>()
    const res = resolveHarvestPriceByCrop({ cropIds: crops.map((c) => c.id), cropYear, policies: policies.filter((p) => p.crop_year === cropYear), estimates, crops })
    return new Map([...res].map(([id, h]) => [id, h.price]))
  }, [cropYear, crops, policies, estimates])

  const units = useMemo(() => {
    if (cropYear === '' || loading || viewer.loading) return []
    return buildClaimCheck({
      cropYear, resolved: production.resolved, inProgress: production.inProgress,
      fields, farms, entities, landowners, crops, counties,
      cottonCropIds: cotton.cottonCropIds,
      lintEstimated: (p) => {
        const y = cotton.yieldFor(p)
        return !!y && y.estimatedLintLbs > 0
      },
      policies, triggers, harvestPriceByCrop, entityId,
    }).filter((u) => !viewer.isViewer || u.insuredKind === 'entity')
  }, [cropYear, loading, viewer.loading, viewer.isViewer, production, fields, farms, entities, landowners, crops, counties, cotton, policies, triggers, harvestPriceByCrop, entityId])

  const covered = units.filter((u) => u.trigger != null)
  const below = covered.filter((u) => u.status === 'below')
  const watch = covered.filter((u) => u.status === 'watch')
  const pending = covered.filter((u) => !u.final)
  const flagged = units.filter((u) => u.flags.length > 0)
  const hasAgentRows = triggers.some((t) => t.crop_year === cropYear)

  // --- reply ---
  const [replyOpen, setReplyOpen] = useState(false)
  const [claimKeys, setClaimKeys] = useState<Set<string>>(new Set())
  const [includeQuestions, setIncludeQuestions] = useState(true)
  const [greeting, setGreeting] = usePersistentState('claim-check:greeting', '')
  const [signature, setSignature] = usePersistentState('claim-check:signature', '')
  const [replyText, setReplyText] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => { setClaimKeys(defaultClaimKeys(units)) }, [units])
  const generated = useMemo(
    () => buildAgentReply(units, { claimKeys, includeQuestions, greetingName: greeting.trim() || null, signature: signature.trim() || null }),
    [units, claimKeys, includeQuestions, greeting, signature],
  )
  useEffect(() => { setReplyText(generated); setCopied(false) }, [generated])
  async function copyReply() {
    try {
      await navigator.clipboard.writeText(replyText)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const toggleClaim = (key: string, on: boolean) => setClaimKeys((s) => {
    const next = new Set(s)
    if (on) next.add(key); else next.delete(key)
    return next
  })

  // --- one-tap fix: the agent's approved yield onto the policy ---
  const [fixing, setFixing] = useState<string | null>(null)
  const [fixErr, setFixErr] = useState<string | null>(null)
  async function applyAgentApproved(u: ClaimCheckUnit, value: number) {
    if (!u.policy) return
    setFixing(u.key); setFixErr(null)
    const { error } = await supabase.from('crop_insurance_policies').update({ approved_yield: value }).eq('id', u.policy.id)
    if (error) setFixErr(reportError(error, { action: 'update the approved yield', noun: 'policy' }))
    else await loadPolicies()
    setFixing(null)
  }

  const entityLabel = entityId ? entities.find((e) => e.id === entityId)?.name ?? '' : allEntitiesLabel
  const filterSummary = filterSummaryOf(cropYearLabel(cropYear), entityLabel)

  const buildPayload = useCallback((): ExportPayload => ({
    title: 'Claim Check',
    filters: filterSummary,
    summary: [
      { label: 'Units checked', value: String(covered.length) },
      { label: 'Below trigger', value: String(below.length), tone: below.length ? 'unfavorable' : 'favorable' },
      { label: 'Close to trigger', value: String(watch.length), tone: watch.length ? 'warning' : 'neutral' },
      { label: 'Still harvesting', value: String(pending.length) },
    ],
    sections: [{
      columns: [
        { label: 'Insured' }, { label: 'County' }, { label: 'Crop' }, { label: 'Practice' },
        { label: 'Planted ac', align: 'right', format: 'acres' }, { label: 'Harvested ac', align: 'right', format: 'acres' },
        { label: 'Yield so far', align: 'right', format: 'yield' }, { label: 'Trigger', align: 'right', format: 'yield' },
        { label: 'Margin', align: 'right', format: 'yield' }, { label: 'Status' }, { label: 'Notes' },
      ],
      rows: units.map((u) => [
        u.insuredName, u.countyName, u.cropName, practiceWord(u.practice) === 'irrigated' ? 'Irrigated' : 'Dryland',
        u.plantedAcres, u.harvestedAcres, u.yieldToDate ?? '', u.trigger ?? '', u.margin ?? '', STATUS_LABEL[u.status],
        u.flags.map((f) => f.message).join(' '),
      ]),
    }],
  }), [filterSummary, covered.length, below.length, watch.length, pending.length, units])

  if (loading) return <div className="text-slate-500">Loading…</div>
  if (loadErr) return <EmptyState message={loadErr} />

  return (
    <div className="space-y-4">
      <ReportHeader title="Claim Check" filterSummary={filterSummary} actions={<ExportBar buildPayload={buildPayload} />} />
      <ReportFilterBar activeCount={entityId ? 1 : 0}>
        <FilterField label="Crop year">
          <select className={selectCls} value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))}>
            {[...years].sort((a, b) => b - a).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </FilterField>
        <FilterField label="Entity">
          <select className={selectCls} value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">{allEntitiesLabel}</option>
            {entityOptions.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </FilterField>
      </ReportFilterBar>

      <p className="text-sm text-slate-600 max-w-3xl">
        For each insurance unit, your harvested yield so far against its trigger yield. A unit below its trigger may
        need a claim opened — talk to your agent. County-based coverage (ECO, SCO, ARP, AYP) pays on the county’s
        results, so it never needs a claim opened.
      </p>

      <SummaryCards cards={[
        { label: 'Units checked', value: String(covered.length), sub: hasAgentRows ? 'using your agent’s trigger yields' : 'triggers figured from your policies' },
        { label: 'Below trigger', value: String(below.length), tone: below.length ? 'unfavorable' : 'favorable', sub: below.length ? 'talk to your agent about a claim' : 'none' },
        { label: 'Close to trigger', value: String(watch.length), tone: watch.length ? 'warning' : 'neutral', sub: `within ${Math.round(WATCH_MARGIN * 100)}% above it` },
        { label: 'Still harvesting', value: String(pending.length), sub: pending.length ? 'not final yet' : 'every unit is in' },
      ]} />

      <div className="flex flex-wrap gap-2 no-print">
        <button type="button" onClick={() => setReplyOpen(true)} disabled={covered.length === 0} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 text-sm font-semibold disabled:opacity-50">
          Write reply to your agent
        </button>
        {canEdit && (
          <button type="button" onClick={() => setShowImport((v) => !v)} className="rounded-lg border border-slate-300 bg-white px-4 min-h-11 text-sm">
            {showImport ? 'Close' : hasAgentRows ? 'Read an updated agent report' : 'Read your agent’s trigger yield report'}
          </button>
        )}
        <Link href="/reports/crop-insurance-claims" className="rounded-lg border border-slate-300 bg-white px-4 min-h-11 text-sm inline-flex items-center">Claims Monitor (dollars) →</Link>
      </div>

      {showImport && canEdit && (
        <section className="bg-white rounded-xl shadow p-4 no-print">
          <TriggerReportImport
            entities={entities} landowners={landowners} crops={crops} counties={counties}
            defaultYear={cropYear === '' ? new Date().getFullYear() : cropYear}
            onSaved={(y) => { void loadTriggers(); if (y !== cropYear) setCropYear(y) }}
          />
        </section>
      )}
      {fixErr && <p className="text-sm text-red-700" role="alert">{fixErr}</p>}

      {units.length === 0 ? (
        <EmptyState
          message="No insured units for this crop year yet."
          hint="Add your policies, or read your agent’s trigger yield report."
          linkHref="/settings/crop-insurance" linkLabel="Crop insurance settings" role={viewer.role}
        />
      ) : (
        <div className="overflow-x-auto bg-white rounded-xl shadow print-area">
          <table className="min-w-full text-sm border-collapse">
            <thead className={theadCls}>
              <tr>
                <th className="px-3 py-2 text-left">Unit</th>
                <th className="px-3 py-2 text-right">Harvested</th>
                <th className="px-3 py-2 text-right">Yield so far</th>
                <th className="px-3 py-2 text-right">Trigger</th>
                <th className="px-3 py-2 text-right">Margin</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left no-print">Claim?</th>
              </tr>
            </thead>
            <tbody>
              {groupByInsured(units).map(([insured, list]) => (
                <Fragment key={insured}>
                  <tr className="bg-slate-50">
                    <td colSpan={7} className="px-3 py-2 font-semibold text-slate-700">
                      {insured}
                      {list[0].insuredKind === 'landowner' && <span className="ml-2 text-xs font-normal text-slate-500">landowner — their share of your fields</span>}
                    </td>
                  </tr>
                  {list.map((u) => {
                    const isOpen = open.has(u.key)
                    const unitAbbr = u.unit === 'lbs' ? 'lb' : 'bu'
                    return (
                      <Fragment key={u.key}>
                        <tr className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(u.key)) n.delete(u.key); else n.add(u.key); return n })}
                              className="text-left min-h-11 text-brand-deep underline-offset-2 hover:underline"
                              aria-expanded={isOpen}
                            >
                              {unitName(u)}
                            </button>
                            {u.flags.length > 0 && <span className="ml-2 text-xs text-amber-700">{u.flags.length} to check</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                            {fmt1(u.harvestedAcres)} of {fmt1(u.plantedAcres)} ac
                            <div className="text-xs text-slate-500">{u.final ? 'complete' : `${Math.round(u.harvestedShare * 100)}%`}</div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                            {u.yieldToDate == null ? '—' : `${fmt1(u.yieldToDate)} ${unitAbbr}`}
                            {u.lintEstimated && <div className="text-xs text-slate-500">part estimated</div>}
                            {u.splitByAcres && <div className="text-xs text-amber-700">split by acres</div>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                            {fmt1(u.trigger)}
                            {u.triggerSource && <div className="text-xs text-slate-500">{u.triggerSource === 'agent' ? 'agent’s report' : 'from your policy'}</div>}
                          </td>
                          <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${u.margin == null ? '' : toneText(u.margin < 0 ? 'unfavorable' : 'favorable')}`}>{fmtSigned(u.margin)}</td>
                          <td className={`px-3 py-2 whitespace-nowrap font-medium ${toneText(STATUS_TONE[u.status])}`}>
                            {STATUS_LABEL[u.status]}
                            {u.status !== 'no_coverage' && u.status !== 'not_started' && !u.final && <div className="text-xs font-normal text-slate-500">not final</div>}
                          </td>
                          <td className="px-3 py-2 no-print">
                            {u.trigger != null && (
                              <label className="inline-flex items-center gap-2 min-h-11">
                                <input type="checkbox" className="h-5 w-5" checked={claimKeys.has(u.key)} onChange={(e) => toggleClaim(u.key, e.target.checked)} />
                                <span className="text-xs text-slate-600">ask to open</span>
                              </label>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-slate-50/60">
                            <td colSpan={7} className="px-3 py-3 space-y-3">
                              <UnitDetail u={u} canEdit={canEdit} fixing={fixing === u.key} onUseApproved={(v) => applyAgentApproved(u, v)} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {flagged.length > 0 && (
        <p className="text-sm text-slate-600 no-print">
          {flagged.length} unit{flagged.length === 1 ? ' has' : 's have'} something to check — tap a unit to see what and fix it.
        </p>
      )}

      <AppModal open={replyOpen} title="Reply to your agent" onClose={() => setReplyOpen(false)} size="lg">
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm flex flex-col gap-1">
              <span className="text-slate-500">Agent’s first name</span>
              <input value={greeting} onChange={(e) => setGreeting(e.target.value)} className="rounded-lg border border-slate-300 px-3 min-h-11" />
            </label>
            <label className="text-sm flex flex-col gap-1">
              <span className="text-slate-500">Sign as</span>
              <input value={signature} onChange={(e) => setSignature(e.target.value)} className="rounded-lg border border-slate-300 px-3 min-h-11" />
            </label>
          </div>
          <label className="inline-flex items-center gap-2 text-sm min-h-11">
            <input type="checkbox" className="h-5 w-5" checked={includeQuestions} onChange={(e) => setIncludeQuestions(e.target.checked)} />
            Include questions about numbers that don’t match
          </label>
          <p className="text-xs text-slate-500">
            Claims asked for: {claimKeys.size === 0 ? 'none' : covered.filter((u) => claimKeys.has(u.key)).map(unitName).join('; ')}. Change them with the “ask to open” boxes in the table.
            <InfoTip label=" ?">Your yields here are Turnrow’s numbers. Your agent and adjuster make the final call on any claim.</InfoTip>
          </p>
          <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} rows={16} className="w-full rounded-lg border border-slate-300 p-3 text-sm font-mono" aria-label="Reply text" />
          <div className="flex flex-wrap gap-2 justify-end">
            <button type="button" onClick={() => setReplyText(generated)} className="rounded-lg border border-slate-300 px-4 min-h-11 text-sm">Start over</button>
            <button type="button" onClick={copyReply} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 text-sm font-semibold">{copied ? 'Copied' : 'Copy reply'}</button>
          </div>
        </div>
      </AppModal>
    </div>
  )
}

function groupByInsured(units: readonly ClaimCheckUnit[]): Array<[string, ClaimCheckUnit[]]> {
  const m = new Map<string, ClaimCheckUnit[]>()
  for (const u of units) {
    const k = `${u.insuredKind}:${u.insuredName}`
    const arr = m.get(k)
    if (arr) arr.push(u)
    else m.set(k, [u])
  }
  return [...m.values()].map((list) => [list[0].insuredName, list])
}

function UnitDetail({ u, canEdit, fixing, onUseApproved }: { u: ClaimCheckUnit; canEdit: boolean; fixing: boolean; onUseApproved: (v: number) => void }) {
  const unitAbbr = u.unit === 'lbs' ? 'lb' : 'bu'
  const t = u.agentRow
  const statusWord = (s: string) => (s === 'complete' ? 'harvested' : s === 'in_progress' ? 'still harvesting' : 'not started')
  return (
    <div className="space-y-3">
      {u.flags.length > 0 && (
        <ul className="space-y-2">
          {u.flags.map((f, i) => (
            <li key={i} className="text-sm text-amber-800 flex flex-wrap items-center gap-2">
              <span>{f.message}</span>
              {f.kind === 'approved_yield' && f.agentValue != null && canEdit && u.policy && (
                <button type="button" disabled={fixing} onClick={() => onUseApproved(f.agentValue as number)} className="rounded-lg border border-slate-300 bg-white px-3 min-h-11 text-sm text-slate-700">
                  {fixing ? 'Saving…' : `Use your agent’s ${fmt1(f.agentValue)}`}
                </button>
              )}
              {(f.kind === 'insured_acres' || f.kind === 'aph' || f.kind === 'coverage' || f.kind === 'no_policy' || f.kind === 'uninsured') && canEdit && (
                <Link href="/settings/crop-insurance" className="text-brand-deep underline min-h-11 inline-flex items-center">Review the policy</Link>
              )}
              {f.kind === 'split_by_acres' && <Link href="/yields" className="text-brand-deep underline min-h-11 inline-flex items-center">Go to Yields</Link>}
            </li>
          ))}
        </ul>
      )}
      {t && (
        <div className="text-xs text-slate-600">
          Agent’s report{t.report_date ? ` (${t.report_date})` : ''}: {fmt1(Number(t.reported_acres))} ac · APH {fmt1(Number(t.aph_yield))} · approved {fmt1(Number(t.approved_yield))} · trigger {fmt1(Number(t.trigger_yield))}
          {t.expected_county_yield != null && <> · expected county {fmt1(Number(t.expected_county_yield))}</>}
          {t.eco_trigger_yield != null && <> · ECO {fmt1(Number(t.eco_trigger_yield))}</>}
          {t.sco_trigger_yield != null && <> · SCO {fmt1(Number(t.sco_trigger_yield))}</>}
        </div>
      )}
      {u.fields.length > 0 ? (
        <table className="min-w-full text-xs">
          <thead className="text-slate-500 text-left">
            <tr><th className="px-2 py-1">Farm</th><th className="px-2 py-1">Field</th><th className="px-2 py-1 text-right">Acres</th><th className="px-2 py-1 text-right">Production</th><th className="px-2 py-1 text-right">Yield</th><th className="px-2 py-1">Status</th></tr>
          </thead>
          <tbody>
            {u.fields.map((f, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-2 py-1">{f.farmName}</td>
                <td className="px-2 py-1">{f.fieldName}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmt1(f.acres)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{f.status === 'complete' ? `${Math.round(f.production).toLocaleString('en-US')} ${unitAbbr}` : '—'}</td>
                <td className="px-2 py-1 text-right tabular-nums">{f.yieldPerAcre == null ? '—' : fmt1(f.yieldPerAcre)}</td>
                <td className="px-2 py-1">{statusWord(f.status)}{f.splitByAcres ? ' · split by acres' : ''}{f.lintEstimated ? ' · part estimated' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-slate-500">No fields in Turnrow for this unit.</p>
      )}
    </div>
  )
}
