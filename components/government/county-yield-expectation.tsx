'use client'

// County yield expectation — the operator doesn't know the county's actual
// yield mid-season, but knows their own. For each ARC-CO commodity × county
// this control sets the expectation as a % above/below the FSA benchmark
// county yield (−30%..+30%, default 0 = county at benchmark), or as an
// absolute county yield (the two stay in sync). Persisted on the resolved
// arc_benchmark_data row (county_yield_vs_benchmark_pct) so every ARC-CO
// projection — Decision Aid AND Payment Tracker — updates live from the same
// stored value. Shared by both pages.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { resolveArcBenchmark, expectedCountyYield } from '@/lib/government-payments'
import { theadCls, toneText } from '@/components/reports/report-kit'
import type { ArcBenchmarkData, CoveredCommodity, Farm, FarmBaseAcres, County } from '@/lib/types'

export default function CountyYieldExpectation({
  cropYear, commodities, farms, counties, baseAcres, benchmarks, onChanged,
}: {
  cropYear: number
  commodities: CoveredCommodity[]
  farms: Farm[]
  counties: County[]
  baseAcres: FarmBaseAcres[]
  benchmarks: ArcBenchmarkData[]
  onChanged: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [drafts, setDrafts] = useState<Map<string, number>>(new Map()) // benchmark row id -> pct
  const [absDrafts, setAbsDrafts] = useState<Map<string, string>>(new Map())
  const [err, setErr] = useState<string | null>(null)

  const countyNameById = useMemo(() => new Map(counties.map((c) => [c.id, c.name])), [counties])

  // One entry per resolved benchmark row in play: commodity × the counties its
  // base-acre farms sit in (deduped when several counties resolve to the same
  // default row). Commodities with no benchmark row surface a settings hint.
  const entries = useMemo(() => {
    const byRow = new Map<string, { row: ArcBenchmarkData; commodity: CoveredCommodity; counties: Set<string> }>()
    const missing: Array<{ commodity: CoveredCommodity; county: string }> = []
    for (const c of commodities) {
      const farmIds = new Set(baseAcres.filter((b) => !b.is_unassigned && b.commodity_id === c.id).map((b) => b.farm_id))
      if (farmIds.size === 0) continue
      const countyNames = new Set<string>()
      for (const f of farms) {
        if (!farmIds.has(f.id)) continue
        countyNames.add(f.county_id ? (countyNameById.get(f.county_id) ?? '') : '')
      }
      if (countyNames.size === 0) countyNames.add('')
      for (const county of countyNames) {
        const row = resolveArcBenchmark({ commodityId: c.id, cropYear, county: county || null, benchmarks })
        const label = county || 'all counties'
        if (!row) {
          missing.push({ commodity: c, county: label })
          continue
        }
        const hit = byRow.get(row.id)
        if (hit) hit.counties.add(label)
        else byRow.set(row.id, { row, commodity: c, counties: new Set([label]) })
      }
    }
    return { rows: [...byRow.values()], missing }
  }, [commodities, baseAcres, farms, countyNameById, cropYear, benchmarks])

  async function commit(row: ArcBenchmarkData, pct: number) {
    const clamped = Math.max(-30, Math.min(30, Math.round(pct * 10) / 10))
    const { error } = await supabase
      .from('arc_benchmark_data')
      .update({ county_yield_vs_benchmark_pct: clamped, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    if (error) { setErr(`Could not save the county yield expectation: ${error.message}`); return }
    setErr(null)
    setDrafts((m) => { const n = new Map(m); n.delete(row.id); return n })
    setAbsDrafts((m) => { const n = new Map(m); n.delete(row.id); return n })
    onChanged()
  }

  if (entries.rows.length === 0 && entries.missing.length === 0) return null

  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-2 avoid-break">
      <h2 className="font-bold text-lg">County Yield Expectation — ARC-CO</h2>
      <p className="text-xs text-slate-500">
        ARC-CO pays on <b>county</b> revenue. Set how you expect the county’s actual yield to land relative to the FSA
        benchmark yield (0% = at benchmark), or type an absolute county yield — the two stay in sync and every ARC-CO
        projection updates live.
      </p>
      {err && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">{err}</div>}
      {entries.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm border-collapse">
            <thead className={theadCls}>
              <tr>{['Commodity', 'County', 'Benchmark Yield', 'County vs benchmark', 'Expected County Yield'].map((h) => (
                <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {entries.rows.map(({ row, commodity, counties: countySet }) => {
                const benchYield = row.benchmark_yield != null ? Number(row.benchmark_yield) : null
                const pct = drafts.get(row.id) ?? Number(row.county_yield_vs_benchmark_pct ?? 0)
                const absYield = benchYield != null ? expectedCountyYield(benchYield, pct) : null
                return (
                  <tr key={row.id} className="border-t border-slate-100 align-middle">
                    <td className="px-2 py-1.5 font-semibold whitespace-nowrap">{commodity.name}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{[...countySet].join(', ')}{row.county == null && <span className="text-xs text-slate-400"> (default row)</span>}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {benchYield != null ? benchYield.toLocaleString() : <span className={toneText('warning')}>not set</span>}
                    </td>
                    <td className="px-2 py-1.5" style={{ minWidth: 260 }}>
                      <span className="flex items-center gap-2">
                        <input
                          type="range" min={-30} max={30} step={1}
                          value={pct}
                          disabled={benchYield == null}
                          onChange={(e) => setDrafts((m) => new Map(m).set(row.id, Number(e.target.value)))}
                          onMouseUp={() => { const d = drafts.get(row.id); if (d != null) commit(row, d) }}
                          onTouchEnd={() => { const d = drafts.get(row.id); if (d != null) commit(row, d) }}
                          className="flex-1 min-w-[8rem]"
                        />
                        <input
                          type="number" min={-30} max={30} step={0.5}
                          value={pct}
                          disabled={benchYield == null}
                          onChange={(e) => setDrafts((m) => new Map(m).set(row.id, Number(e.target.value)))}
                          onBlur={() => { const d = drafts.get(row.id); if (d != null) commit(row, d) }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                          className="w-16 rounded border border-slate-300 px-1.5 py-1 text-right tabular-nums"
                        />
                        <span className="text-xs text-slate-500">%</span>
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                      {benchYield != null ? (
                        <span className="inline-flex items-center gap-1">
                          <input
                            type="number" step="0.1" min="0"
                            value={absDrafts.get(row.id) ?? (absYield != null ? String(absYield) : '')}
                            onChange={(e) => {
                              setAbsDrafts((m) => new Map(m).set(row.id, e.target.value))
                              const v = Number(e.target.value)
                              if (Number.isFinite(v) && v > 0 && benchYield > 0) {
                                setDrafts((m) => new Map(m).set(row.id, Math.round(((v / benchYield) - 1) * 1000) / 10))
                              }
                            }}
                            onBlur={() => { const d = drafts.get(row.id); if (d != null) commit(row, d) }}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                            className="w-20 rounded border border-slate-300 px-1.5 py-1 text-right tabular-nums"
                          />
                          <span className="text-xs text-slate-500">{commodity.unit === 'pound' ? 'lb/ac' : 'bu/ac'}</span>
                        </span>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {entries.missing.length > 0 && (
        <p className={`text-xs ${toneText('warning')}`}>
          No ARC-CO benchmark data for{' '}
          {entries.missing.map((m) => `${m.commodity.name} (${m.county})`).join(', ')} — add it under Settings →
          Government Payments → ARC-CO Benchmarks (AI lookup available). Until then those rows use the flat $/acre
          fallback.
        </p>
      )}
    </section>
  )
}
