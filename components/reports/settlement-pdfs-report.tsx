'use client'

// Settlement PDFs export for crop-insurance audits.
//
// Crop-insurance agents need the buyer's settlement statements to verify the
// farmer's self-reported production. This report packs every settlement PDF
// linked to loads of a given crop + crop_year into a single zip download.
//
// Settlement → crop/year is derived from settlement_lines: each matched line
// points at a load, and the load carries crop_id + crop_year. A settlement is
// included when any of its lines match the filter. We surface (but don't
// auto-include) settlements that match the filter but have no PDF attached
// yet, so the user can go back and attach them.

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import ExportBar from '@/components/export-bar'
import type { ExportPayload } from '@/lib/exports'
import type { Crop, FieldPlanting } from '@/lib/types'

type SettlementRow = {
  id: string
  settlement_date: string
  settlement_number: string | null
  source_pdf_url: string | null
  buyer: { name: string | null } | null
  settlement_lines: Array<{
    load: { crop_id: string | null; crop_year: number | null } | null
  }>
}

type Eligible = {
  id: string
  settlement_date: string
  settlement_number: string | null
  buyerName: string
  source_pdf_url: string | null
  matchingLineCount: number
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled'
}

function pdfFilename(e: Eligible, taken: Set<string>): string {
  const parts = [
    e.settlement_date,
    slug(e.buyerName || 'no-buyer'),
    e.settlement_number ? slug(e.settlement_number) : e.id.slice(0, 8),
  ]
  let base = parts.join('_')
  let name = `${base}.pdf`
  let n = 2
  while (taken.has(name)) {
    name = `${base}_${n}.pdf`
    n++
  }
  taken.add(name)
  return name
}

export default function SettlementPdfsReport() {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [crops, setCrops] = useState<Crop[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [settlements, setSettlements] = useState<SettlementRow[]>([])

  const [cropId, setCropId] = useState('')
  const [cropYear, setCropYear] = useState<number | ''>('')

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const [cr, pl, st] = await Promise.all([
        supabase.from('crops').select('*').order('name'),
        fetchAllRows((f, t) => supabase.from('field_plantings').select('season_year').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase
          .from('settlements')
          .select(`
            id, settlement_date, settlement_number, source_pdf_url,
            buyer:buyers(name),
            settlement_lines(
              load:loads(crop_id, crop_year)
            )
          `)
          .order('settlement_date', { ascending: false })
          .order('id')
          .range(f, t)),
      ])
      setCrops((cr.data as Crop[]) || [])
      setPlantings(((pl.data as Pick<FieldPlanting, 'season_year'>[]) || []) as FieldPlanting[])
      setSettlements((st.data as unknown as SettlementRow[]) || [])
      const yrs = (pl.data as Array<{ season_year: number }> | null)?.map((p) => p.season_year) ?? []
      if (yrs.length > 0) setCropYear(Math.max(...yrs))
      setLoading(false)
    })()
  }, [supabase])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(
      plantings.map((p) => p.season_year),
      cropYear === '' ? null : cropYear,
    ),
    [plantings, cropYear],
  )

  const eligible: Eligible[] = useMemo(() => {
    if (!cropId || cropYear === '') return []
    const rows: Eligible[] = []
    for (const s of settlements) {
      const matches = (s.settlement_lines ?? []).filter(
        (l) => l.load?.crop_id === cropId && l.load?.crop_year === cropYear,
      ).length
      if (matches === 0) continue
      rows.push({
        id: s.id,
        settlement_date: s.settlement_date,
        settlement_number: s.settlement_number,
        buyerName: s.buyer?.name ?? '',
        source_pdf_url: s.source_pdf_url,
        matchingLineCount: matches,
      })
    }
    return rows
  }, [settlements, cropId, cropYear])

  const withPdf = eligible.filter((e) => !!e.source_pdf_url)

  // A structured index of the bundled settlements (mirrors the eligible list),
  // to accompany the zip of PDFs for the audit.
  function buildPayload(): ExportPayload {
    return {
      title: 'Bundled Settlement Statements',
      filters: `${cropName || 'Crop'} · ${cropYear || '—'} crop`,
      summary: [
        { label: 'Eligible settlements', value: String(eligible.length) },
        { label: 'With PDF (zipped)', value: String(withPdf.length) },
        { label: 'Missing PDF', value: String(eligible.length - withPdf.length) },
      ],
      sections: [{
        title: 'Settlements',
        columns: [
          { label: 'Date' }, { label: 'Settlement #' }, { label: 'Buyer' },
          { label: 'Matched lines', align: 'right', format: 'int' }, { label: 'PDF' },
        ],
        rows: eligible.map((e) => [e.settlement_date, e.settlement_number ?? '', e.buyerName, e.matchingLineCount, e.source_pdf_url ? 'Yes' : 'Missing']),
      }],
    }
  }
  const missingPdf = eligible.filter((e) => !e.source_pdf_url)
  const cropName = crops.find((c) => c.id === cropId)?.name ?? ''

  async function onDownload() {
    if (withPdf.length === 0) return
    setErr(null)
    setBusy(true)
    setProgress({ done: 0, total: withPdf.length })
    try {
      const JSZipMod = await import('jszip')
      const JSZip = (JSZipMod as { default: typeof import('jszip') }).default ?? JSZipMod
      const zip = new (JSZip as unknown as { new (): InstanceType<typeof import('jszip')> })()
      const taken = new Set<string>()
      for (let i = 0; i < withPdf.length; i++) {
        const e = withPdf[i]
        // We know source_pdf_url is non-null here (we filtered).
        const res = await fetch(e.source_pdf_url as string)
        if (!res.ok) throw new Error(`Could not download PDF for settlement ${e.settlement_number ?? e.id.slice(0, 8)} (status ${res.status}).`)
        const blob = await res.blob()
        zip.file(pdfFilename(e, taken), blob)
        setProgress({ done: i + 1, total: withPdf.length })
      }
      const out = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(out)
      const a = document.createElement('a')
      a.href = url
      a.download = `settlements-${slug(cropName || 'crop')}-${cropYear}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr((e as Error)?.message ?? 'Could not build zip.')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const inputCls = 'rounded-lg border border-slate-300 px-3 py-2'

  if (loading) return <p className="text-slate-500">Loading…</p>

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 max-w-3xl">
        Crop-insurance audits require the buyer&apos;s settlement statements to verify the
        production you self-reported. Pick a crop and crop year — every settlement with
        a matching load gets bundled into a single zip of PDFs you can hand to the agent.
      </p>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop *</span>
          <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
            <option value="">— pick a crop —</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-sm flex flex-col gap-1">
          <span className="text-slate-500">Crop year *</span>
          <select
            value={cropYear}
            onChange={(e) => setCropYear(e.target.value === '' ? '' : Number(e.target.value))}
            className={inputCls}
          >
            <option value="">— pick a crop year —</option>
            {cropYearOptions.map((y) => <option key={y} value={y}>{y} crop</option>)}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          {eligible.length > 0 && <ExportBar buildPayload={buildPayload} />}
          <button
            type="button"
            onClick={onDownload}
            disabled={busy || withPdf.length === 0}
            className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {busy
              ? progress
                ? `Bundling… (${progress.done}/${progress.total})`
                : 'Bundling…'
              : withPdf.length > 0
              ? `Download ZIP (${withPdf.length})`
              : 'Download ZIP'}
          </button>
        </div>
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}

      {(!cropId || cropYear === '') && (
        <p className="text-amber-700 text-sm">Pick a crop and crop year to see eligible settlements.</p>
      )}

      {cropId && cropYear !== '' && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat label="Settlements matching" value={String(eligible.length)} />
            <Stat label="With PDF (will be zipped)" value={String(withPdf.length)} tone="green" />
            <Stat
              label="Missing PDF"
              value={String(missingPdf.length)}
              tone={missingPdf.length > 0 ? 'amber' : 'slate'}
            />
          </div>

          {missingPdf.length > 0 && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
              {missingPdf.length} settlement{missingPdf.length === 1 ? '' : 's'} match{missingPdf.length === 1 ? 'es' : ''} this
              crop &amp; year but {missingPdf.length === 1 ? 'has' : 'have'} no PDF attached.
              Open each settlement below to attach the buyer&apos;s PDF before re-running.
            </div>
          )}

          {eligible.length === 0 ? (
            <p className="text-sm text-slate-500">
              No settlements have lines matched to {cropName} loads for {cropYear}. If you
              expected results, make sure the relevant settlement lines are matched to loads
              (matched lines drive crop &amp; year detection).
            </p>
          ) : (
            <div className="overflow-x-auto bg-white rounded-xl shadow">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    {['Date', 'Settlement #', 'Buyer', 'Matching loads', 'PDF', '']
                      .map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {eligible.map((e) => (
                    <tr key={e.id} className={`border-t border-slate-100 ${!e.source_pdf_url ? 'bg-amber-50' : ''}`}>
                      <td className="px-3 py-2">{e.settlement_date}</td>
                      <td className="px-3 py-2 font-semibold">{e.settlement_number ?? '—'}</td>
                      <td className="px-3 py-2">{e.buyerName}</td>
                      <td className="px-3 py-2 text-right">{e.matchingLineCount}</td>
                      <td className="px-3 py-2">
                        {e.source_pdf_url ? (
                          <a href={e.source_pdf_url} target="_blank" rel="noreferrer" className="text-brand-deep">View ↗</a>
                        ) : (
                          <span className="text-amber-800 font-semibold">Missing</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Link href={`/settlements/${e.id}`} className="text-brand-deep">Open →</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Stat({ label, value, tone = 'slate' }: { label: string; value: string; tone?: 'slate' | 'green' | 'amber' }) {
  const color =
    tone === 'green' ? 'text-green-700'
    : tone === 'amber' ? 'text-amber-700'
    : 'text-slate-700'
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
    </div>
  )
}
