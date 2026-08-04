'use client'

// Cotton yields section — mounted on the Yields page and the Season Summary
// when the Cotton module is enabled (it self-checks the flag and renders
// nothing otherwise). Cotton yields are LBS OF LINT PER ACRE (Σ bale net
// weights of the field's receipts ÷ planted acres) with seed cotton lbs/ac
// and lint turnout % as companions — no moisture/shrink math. A field with
// gin receipts and an empty yard is harvest-complete; loads still on the
// yard mark it in-progress with the awaiting-gin poundage shown.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cottonFieldYields, type CottonFieldYield } from '@/lib/cotton'
import { theadCls, grandTotalRowCls } from '@/components/reports/report-kit'
import type { CottonLoad, GinReceipt, CottonBale, Farm, Field, FieldPlanting, Crop } from '@/lib/types'

const lbs = (n: number | null | undefined) => (n == null ? '—' : Math.round(Number(n)).toLocaleString())

export default function CottonYieldsSection({ year, entityId = '' }: { year: number | ''; entityId?: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [enabled, setEnabled] = useState(false)
  const [loads, setLoads] = useState<CottonLoad[]>([])
  const [receipts, setReceipts] = useState<GinReceipt[]>([])
  const [bales, setBales] = useState<CottonBale[]>([])
  const [ginnedIds, setGinnedIds] = useState<Set<string>>(new Set())
  const [farms, setFarms] = useState<Farm[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [crops, setCrops] = useState<Crop[]>([])

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('app_settings').select('cotton_module_enabled').eq('id', 1).maybeSingle()
      if (!(data as { cotton_module_enabled?: boolean } | null)?.cotton_module_enabled) return
      setEnabled(true)
      const [l, r, b, jr, f, fl, pl, cr] = await Promise.all([
        supabase.from('cotton_loads').select('*'),
        supabase.from('gin_receipts').select('*'),
        supabase.from('cotton_bales').select('*'),
        supabase.from('gin_receipt_loads').select('cotton_load_id'),
        supabase.from('farms').select('*'),
        supabase.from('fields').select('*'),
        supabase.from('field_plantings').select('*'),
        supabase.from('crops').select('*'),
      ])
      setLoads((l.data as CottonLoad[]) || [])
      setReceipts((r.data as GinReceipt[]) || [])
      setBales((b.data as CottonBale[]) || [])
      setGinnedIds(new Set(((jr.data as { cotton_load_id: string }[]) || []).map((x) => x.cotton_load_id)))
      setFarms((f.data as Farm[]) || [])
      setFields((fl.data as Field[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setCrops((cr.data as Crop[]) || [])
    })()
  }, [supabase])

  const rows = useMemo(() => {
    if (year === '') return [] as Array<CottonFieldYield & { farmName: string; fieldName: string }>
    const yLoads = loads.filter((l) => l.crop_year === year)
    const yReceipts = receipts.filter((r) => r.crop_year === year)
    const cottonCropIds = new Set(crops.filter((c) => /cotton/i.test(c.name)).map((c) => c.id))
    // Planted acres: the field's cotton planting for the season; fall back to
    // the field's total acres when no planting row exists.
    let fieldIds = new Set<string>([
      ...yLoads.map((l) => l.field_id).filter((x): x is string => !!x),
      ...yReceipts.map((r) => r.field_id).filter((x): x is string => !!x),
    ])
    // Entity filter (Season Summary): keep only fields on the entity's farms.
    if (entityId) {
      const entityFarms = new Set(farms.filter((f) => f.entity_id === entityId).map((f) => f.id))
      const entityFields = new Set(fields.filter((f) => f.farm_id != null && entityFarms.has(f.farm_id)).map((f) => f.id))
      fieldIds = new Set([...fieldIds].filter((fid) => entityFields.has(fid)))
    }
    const fieldInputs = Array.from(fieldIds).map((fid) => {
      const planting = plantings.find((p) => p.field_id === fid && p.season_year === year && cottonCropIds.has(p.crop_id))
      const field = fields.find((f) => f.id === fid)
      return { fieldId: fid, plantedAcres: Number(planting?.planted_acres ?? field?.total_acres ?? 0) }
    })
    const computed = cottonFieldYields({
      fields: fieldInputs, receipts: yReceipts, bales, loads: yLoads, ginnedLoadIds: ginnedIds,
    })
    return computed
      .filter((r) => r.status !== 'unharvested')
      .map((r) => {
        const field = fields.find((f) => f.id === r.fieldId)
        const farm = field?.farm_id ? farms.find((f) => f.id === field.farm_id) : null
        return { ...r, farmName: farm?.name ?? '—', fieldName: field?.name_or_number ?? '—' }
      })
      .sort((a, b) => a.farmName.localeCompare(b.farmName) || a.fieldName.localeCompare(b.fieldName))
  }, [year, entityId, loads, receipts, bales, ginnedIds, farms, fields, plantings, crops])

  if (!enabled || rows.length === 0) return null

  const totals = rows.reduce(
    (t, r) => ({ acres: t.acres + r.plantedAcres, lint: t.lint + r.lintLbs, seed: t.seed + r.seedCottonLbs, bales: t.bales + r.bales, yard: t.yard + r.yardSeedLbs }),
    { acres: 0, lint: 0, seed: 0, bales: 0, yard: 0 },
  )

  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-2 avoid-break">
      <h2 className="font-bold text-lg">
        Cotton (lint) — {year}
        <span className="ml-2 text-sm font-normal text-slate-500">lbs lint/acre from gin receipts · no shrink math</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead className={theadCls}>
            <tr>{['Farm', 'Field', 'Acres', 'Bales', 'Lint lbs', 'Lint lbs/ac', 'Seed cotton lbs/ac', 'Turnout %', 'Status'].map((h, i) => (
              <th key={h} className={`${i >= 2 && i <= 7 ? 'text-right' : 'text-left'} px-2 py-1.5 whitespace-nowrap`}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.fieldId} className="border-t border-slate-100">
                <td className="px-2 py-1.5">{r.farmName}</td>
                <td className="px-2 py-1.5 font-semibold">{r.fieldName}</td>
                <td className="px-2 py-1.5 text-right">{r.plantedAcres.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                <td className="px-2 py-1.5 text-right">{r.bales}</td>
                <td className="px-2 py-1.5 text-right font-mono">{lbs(r.lintLbs)}</td>
                <td className="px-2 py-1.5 text-right font-mono font-semibold">{r.lintPerAcre != null ? r.lintPerAcre.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'}</td>
                <td className="px-2 py-1.5 text-right font-mono">{r.seedPerAcre != null ? r.seedPerAcre.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'}</td>
                <td className="px-2 py-1.5 text-right">{r.turnoutPct != null ? `${r.turnoutPct}%` : '—'}</td>
                <td className="px-2 py-1.5">
                  {r.status === 'complete'
                    ? <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">complete</span>
                    : <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5" title="Seed cotton delivered but not yet on a gin receipt — lint yield is partial until ginned.">on yard awaiting gin: {lbs(r.yardSeedLbs)} lbs</span>}
                </td>
              </tr>
            ))}
            <tr className={grandTotalRowCls}>
              <td className="px-2 py-1.5" colSpan={2}>Total</td>
              <td className="px-2 py-1.5 text-right">{totals.acres.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
              <td className="px-2 py-1.5 text-right">{totals.bales}</td>
              <td className="px-2 py-1.5 text-right font-mono">{lbs(totals.lint)}</td>
              <td className="px-2 py-1.5 text-right font-mono">{totals.acres > 0 && totals.lint > 0 ? Math.round((totals.lint / totals.acres) * 10) / 10 : '—'}</td>
              <td className="px-2 py-1.5 text-right font-mono">{totals.acres > 0 && totals.seed > 0 ? Math.round((totals.seed / totals.acres) * 10) / 10 : '—'}</td>
              <td className="px-2 py-1.5 text-right">{totals.seed > 0 ? `${Math.round((totals.lint / totals.seed) * 10000) / 100}%` : '—'}</td>
              <td className="px-2 py-1.5">{totals.yard > 0 ? <span className="text-xs text-amber-700">{lbs(totals.yard)} lbs on yard</span> : null}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}
