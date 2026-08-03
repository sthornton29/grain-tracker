'use client'

// Settings → Crops: manual "physical sales complete" flag per crop × crop
// year (crop_year_sales_status, migration 050). Shrink and small residuals
// keep the computed production-vs-settled check from ever hitting exactly
// zero, so the partner API's /crop-year-status endpoint reports BOTH the
// computed check and this manual flag — this is the only place the flag is
// set. Crops listed = crops planted in the selected year.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type StatusRow = { crop_id: string; physical_sales_complete: boolean }

export default function CropYearSalesStatus() {
  const supabase = useMemo(() => createClient(), [])
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [years, setYears] = useState<number[]>([currentYear])
  const [crops, setCrops] = useState<Array<{ id: string; name: string }>>([])
  const [flags, setFlags] = useState<Map<string, boolean>>(new Map())
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase
        .from('field_plantings')
        .select('season_year')
        .order('season_year', { ascending: false })
      const distinct = [...new Set(((data ?? []) as Array<{ season_year: number }>).map((r) => r.season_year))]
      if (distinct.length > 0) {
        setYears(distinct)
        if (!distinct.includes(currentYear)) setYear(distinct[0])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      setErr(null)
      const [plantingsRes, statusRes] = await Promise.all([
        supabase.from('field_plantings').select('crop_id, crops(id, name)').eq('season_year', year),
        supabase
          .from('crop_year_sales_status')
          .select('crop_id, physical_sales_complete')
          .eq('crop_year', year),
      ])
      if (plantingsRes.error) { setErr(plantingsRes.error.message); setLoading(false); return }
      // PostgREST types the embedded crops relation as object-or-array.
      type CropRef = { id: string; name: string }
      const byId = new Map<string, string>()
      for (const p of (plantingsRes.data ?? []) as unknown as Array<{ crop_id: string; crops: CropRef | CropRef[] | null }>) {
        const crop = Array.isArray(p.crops) ? p.crops[0] : p.crops
        if (crop) byId.set(crop.id, crop.name)
      }
      setCrops([...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)))
      if (statusRes.error) {
        // 42P01 = the table doesn't exist yet.
        setErr(
          statusRes.error.code === '42P01'
            ? 'The crop_year_sales_status table is missing — run migration 050 in the Supabase SQL editor.'
            : statusRes.error.message,
        )
        setFlags(new Map())
      } else {
        setFlags(new Map(((statusRes.data ?? []) as StatusRow[]).map((r) => [r.crop_id, r.physical_sales_complete])))
      }
      setLoading(false)
    })()
  }, [supabase, year])

  async function toggle(cropId: string, complete: boolean) {
    setFlags((m) => new Map(m).set(cropId, complete)) // optimistic
    const { error } = await supabase
      .from('crop_year_sales_status')
      .upsert(
        { crop_id: cropId, crop_year: year, physical_sales_complete: complete },
        { onConflict: 'crop_id,crop_year' },
      )
    if (error) {
      setErr(
        error.code === '42P01'
          ? 'The crop_year_sales_status table is missing — run migration 050 in the Supabase SQL editor.'
          : error.message,
      )
      setFlags((m) => new Map(m).set(cropId, !complete))
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold">Physical sales complete</h2>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="rounded-lg border border-slate-300 px-3 py-1.5 bg-white text-sm"
          aria-label="Crop year"
        >
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <p className="text-sm text-slate-500">
        Marks a crop year&apos;s physical grain/cotton sales finished even when shrink or small
        residuals keep the computed sold-vs-production check from reaching zero. The partner API
        reports both this flag and the computed check.
      </p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <ul className="bg-white rounded-xl shadow divide-y">
        {loading && <li className="px-4 py-4 text-center text-slate-400">Loading…</li>}
        {!loading && crops.length === 0 && (
          <li className="px-4 py-4 text-center text-slate-400">No crops planted in {year}.</li>
        )}
        {!loading && crops.map((c) => (
          <li key={c.id} className="px-4 py-2 flex items-center gap-3">
            <span className="flex-1 font-medium">{c.name}</span>
            <label className="text-sm flex items-center gap-2 text-slate-600">
              <input
                type="checkbox"
                checked={flags.get(c.id) ?? false}
                onChange={(e) => toggle(c.id, e.target.checked)}
                aria-label={`${c.name} ${year} physical sales complete`}
              />
              All physical sales complete
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
