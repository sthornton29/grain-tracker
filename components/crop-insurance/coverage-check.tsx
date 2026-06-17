'use client'

// Acreage Coverage Check — reconciles INSURED acres (from policies) against
// PLANTED acres (from field_plantings, split irrigated vs dryland) for a crop
// year, per crop × county × practice. Surfaces uninsured exposure: planted acres
// with no policy, or fewer insured acres than planted. The reverse gap (policies
// with no plantings) is shown separately. The math lives in lib/crop-insurance
// (reconcileAcreage); this component just builds the inputs and renders.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  reconcileAcreage, PRACTICE_LABEL,
  type CoveragePlantingInput, type CoveragePolicyInput, type CoverageRow, type CoverageStatus,
} from '@/lib/crop-insurance'
import type { Crop, County, FieldPlanting, CropInsurancePolicy, Field, Farm } from '@/lib/types'

const STATUS_META: Record<CoverageStatus, { label: string; dot: string; cls: string }> = {
  matched:             { label: 'Matched',             dot: '🟢', cls: 'text-green-700' },
  under_insured:       { label: 'Under-insured',       dot: '🟡', cls: 'text-amber-700' },
  over_reported:       { label: 'Over-reported',       dot: '🟡', cls: 'text-amber-700' },
  no_policy:           { label: 'No policy',           dot: '🔴', cls: 'text-red-700 font-semibold' },
  insured_not_planted: { label: 'Insured, not planted', dot: '🟡', cls: 'text-amber-700' },
}

const ac = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 })

export default function CoverageCheck({
  crops, counties, plantings, policies, cropYearOptions, defaultYear,
}: {
  crops: Crop[]
  counties: County[]
  plantings: FieldPlanting[]
  policies: CropInsurancePolicy[]
  cropYearOptions: number[]
  defaultYear: number
}) {
  const supabase = useMemo(() => createClient(), [])
  const [fields, setFields] = useState<Field[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [cropYear, setCropYear] = useState<number | ''>('')

  // Fields + farms map a planting to its county (field's own county, else the
  // farm's). Fetched here so the component is self-contained.
  useEffect(() => {
    ;(async () => {
      const [fi, fa] = await Promise.all([
        supabase.from('fields').select('id, farm_id, county_id'),
        supabase.from('farms').select('id, county_id'),
      ])
      setFields((fi.data as Field[]) ?? [])
      setFarms((fa.data as Farm[]) ?? [])
    })()
  }, [supabase])

  useEffect(() => {
    setCropYear((cy) => (cy === '' && defaultYear ? defaultYear : cy))
  }, [defaultYear])

  const cropName = (id: string) => crops.find((c) => c.id === id)?.name ?? '—'
  const countyName = (id: string | null) => {
    if (!id) return 'No county'
    const c = counties.find((x) => x.id === id)
    return c ? `${c.name}, ${c.state_code}` : '—'
  }

  const fieldCounty = useMemo(() => {
    const farmCounty = new Map(farms.map((f) => [f.id, f.county_id]))
    return new Map(fields.map((f) => [f.id, f.county_id ?? (f.farm_id ? farmCounty.get(f.farm_id) ?? null : null)]))
  }, [fields, farms])

  const result = useMemo(() => {
    if (cropYear === '') return null
    const plantingInputs: CoveragePlantingInput[] = []
    for (const p of plantings) {
      if (p.season_year !== cropYear) continue
      const countyId = fieldCounty.get(p.field_id) ?? null
      const irr = Number(p.irrigated_acres) || 0
      const dry = Number(p.dryland_acres) || 0
      if (irr > 0) plantingInputs.push({ cropId: p.crop_id, countyId, practice: 'irrigated', plantedAcres: irr })
      if (dry > 0) plantingInputs.push({ cropId: p.crop_id, countyId, practice: 'non_irrigated', plantedAcres: dry })
    }
    const policyInputs: CoveragePolicyInput[] = policies
      .filter((pol) => pol.crop_year === cropYear)
      .map((pol) => ({ cropId: pol.crop_id, countyId: pol.county_id, practice: pol.practice ?? 'non_irrigated', insuredAcres: Number(pol.insured_acres) || 0 }))
    return reconcileAcreage({ plantings: plantingInputs, policies: policyInputs })
  }, [cropYear, plantings, policies, fieldCounty])

  // Sort rows for the grouped table: crop, then county, then practice (irr first).
  const sortRows = (rows: CoverageRow[]) =>
    [...rows].sort((a, b) =>
      cropName(a.cropId).localeCompare(cropName(b.cropId))
      || countyName(a.countyId).localeCompare(countyName(b.countyId))
      || a.practice.localeCompare(b.practice))

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white'

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">Coverage Check</h2>
          <p className="text-xs text-slate-500">Reconciles insured acres against planted acres, by crop · county · practice.</p>
        </div>
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year *</span>
          <select value={cropYear} onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
            <option value="">— pick a crop year —</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </label>
      </div>

      {cropYear === '' && <p className="text-sm text-amber-700">Pick a crop year to check coverage.</p>}

      {result && result.rows.length === 0 && result.insuredNotPlanted.length === 0 && (
        <p className="text-sm text-slate-400">No plantings or policies for {cropYear}.</p>
      )}

      {result && (result.rows.length > 0 || result.insuredNotPlanted.length > 0) && (
        <>
          {/* Summary bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Planted acres" value={ac(result.summary.totalPlanted)} />
            <Stat label="Insured acres" value={ac(result.summary.totalInsured)} />
            <Stat
              label="Uninsured acres"
              value={ac(result.summary.uninsuredAcres)}
              tone={result.summary.uninsuredAcres > 0 ? 'bad' : 'good'}
              sub="planted with no/short policy"
            />
            <Stat
              label="Flagged"
              value={String(result.summary.flaggedCount)}
              tone={result.summary.flaggedCount > 0 ? 'warn' : 'good'}
              sub="combinations needing review"
            />
          </div>

          {result.summary.uninsuredAcres > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              <strong>{ac(result.summary.uninsuredAcres)}</strong> planted acres are uninsured (no policy, or fewer
              insured acres than planted at that practice). A loss on those acres isn&rsquo;t covered.
            </div>
          )}

          {/* Reconciliation table */}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm border-collapse">
              <thead className="bg-slate-100 text-slate-700">
                <tr>
                  {['Crop', 'County', 'Practice', 'Planted ac', 'Insured ac', 'Policies', 'Variance', 'Status'].map((h, i) => (
                    <th key={h} className={`px-2 py-1.5 whitespace-nowrap ${i < 3 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortRows(result.rows).map((r) => {
                  const m = STATUS_META[r.status]
                  return (
                    <tr key={`${r.cropId}|${r.countyId}|${r.practice}`} className="border-t border-slate-100">
                      <td className="px-2 py-1.5 font-semibold whitespace-nowrap">{cropName(r.cropId)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{countyName(r.countyId)}</td>
                      <td className="px-2 py-1.5">{PRACTICE_LABEL[r.practice]}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{ac(r.plantedAcres)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{ac(r.insuredAcres)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.policyCount || '—'}</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${r.variance < 0 ? 'text-red-700' : r.variance > 0 ? 'text-amber-700' : 'text-slate-500'}`}>
                        {r.variance > 0 ? '+' : ''}{ac(r.variance)}
                      </td>
                      <td className={`px-2 py-1.5 text-right whitespace-nowrap ${m.cls}`}>{m.dot} {m.label}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">
            Tolerance is the greater of 0.5 acres or 1% of planted, so trivial rounding isn&rsquo;t flagged.
            <span className="text-red-700"> 🔴 No policy</span> = uninsured;
            <span className="text-amber-700"> 🟡 Under-insured / Over-reported</span> = review;
            <span className="text-green-700"> 🟢 Matched</span>.
          </p>

          {/* Reverse gap: policies with no plantings this year */}
          {result.insuredNotPlanted.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
              <div className="text-sm font-semibold text-amber-900">
                Insured but not planted — {result.insuredNotPlanted.length} policy combination{result.insuredNotPlanted.length === 1 ? '' : 's'}
              </div>
              <p className="text-xs text-amber-800">
                A policy covers this crop · county · practice but there are no plantings for {cropYear}. Confirm whether a
                planting is missing from the data, or the policy covers acres tracked elsewhere.
              </p>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-amber-900">
                    <tr>{['Crop', 'County', 'Practice', 'Insured ac', 'Policies'].map((h, i) => (
                      <th key={h} className={`px-2 py-1 ${i < 3 ? 'text-left' : 'text-right'}`}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {sortRows(result.insuredNotPlanted).map((r) => (
                      <tr key={`${r.cropId}|${r.countyId}|${r.practice}`} className="border-t border-amber-200">
                        <td className="px-2 py-1 font-semibold whitespace-nowrap">{cropName(r.cropId)}</td>
                        <td className="px-2 py-1 whitespace-nowrap">{countyName(r.countyId)}</td>
                        <td className="px-2 py-1">{PRACTICE_LABEL[r.practice]}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{ac(r.insuredAcres)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{r.policyCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad' }) {
  const cls = tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-green-700' : 'text-slate-900'
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  )
}
