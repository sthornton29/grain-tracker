'use client'

// AI import for FSA base-acre documents (Form 156EZ, Base & Yield Notice, Base
// Allocation Summary). Matches each FSA farm number to an existing farm, maps
// commodities to covered_commodities, flags duplicates against existing
// farm_base_acres, and lets the user review/edit before saving. Optionally
// records the ARC/PLC election shown on the document for the selected year.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { findBestMatch } from '@/lib/fuzzy'
import { PdfTooLargeError, parseDocument, type FsaFarmExtraction } from '@/lib/pdf-upload'
import { splitPdfIntoBatches } from '@/lib/pdf-split'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import type { Farm, CoveredCommodity, FarmBaseAcres, ArcPlcElectionType } from '@/lib/types'

type Props = {
  farms: Farm[]
  commodities: CoveredCommodity[]
  existingBaseAcres: FarmBaseAcres[]
  cropYear: number
  onImported: () => void
}

type CommodityRow = {
  commodity_id: string
  raw_name: string | null
  base_acres: string
  plc_yield: string
  election: '' | ArcPlcElectionType
  include: boolean
}
type FarmRow = {
  farm_id: string
  raw_fsa: string | null
  raw_location: string | null
  matched: boolean
  commodities: CommodityRow[]
}

const numStr = (n: number | null | undefined) => (n == null || !Number.isFinite(Number(n)) ? '' : String(Number(n)))
const num = (s: string): number | null => {
  if (s == null || s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function normalizeElection(raw: string | null | undefined): '' | ArcPlcElectionType {
  if (!raw) return ''
  const s = raw.trim().toUpperCase().replace(/[\s_-]+/g, '')
  if (s === 'PLC') return 'PLC'
  if (s === 'ARCCO' || s === 'ARC') return 'ARC_CO'
  if (s === 'ARCIC') return 'ARC_IC'
  return ''
}

export default function FsaBaseAcresImport({ farms, commodities, existingBaseAcres, cropYear, onImported }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [rows, setRows] = useState<FarmRow[]>([])
  const [saving, setSaving] = useState(false)

  const existingKeys = useMemo(
    () => new Set(existingBaseAcres.map((b) => `${b.farm_id}|${b.commodity_id}`)),
    [existingBaseAcres],
  )

  function extractionToRow(f: FsaFarmExtraction): FarmRow {
    const farm = f.fsa_farm_number ? findBestMatch(f.fsa_farm_number, farms, (x) => x.fsa_number ?? '') : null
    const cmds: CommodityRow[] = (f.commodities ?? []).map((c) => {
      const commodity = findBestMatch(c.commodity_name, commodities, (x) => x.name)
      const acres = c.total_base_acres ?? c.base_acres
      return {
        commodity_id: commodity?.id ?? '',
        raw_name: c.commodity_name,
        base_acres: numStr(acres),
        plc_yield: numStr(c.plc_yield),
        election: normalizeElection(c.arc_plc_election),
        include: true,
      }
    })
    return {
      farm_id: farm?.id ?? '',
      raw_fsa: f.fsa_farm_number,
      raw_location: [f.county, f.state].filter(Boolean).join(', ') || null,
      matched: !!farm,
      commodities: cmds,
    }
  }

  async function onSource(src: DocumentSource) {
    setErr(null); setBanner(null); setSource(src); setRows([])
    setStage('Reading FSA document…')
    try {
      await new Promise((r) => setTimeout(r, 200))
      // A whole 156EZ packet is many pages; one Anthropic call over all of them
      // can time out (504). Split the PDF into small page-batches, parse each
      // under the limit, and merge the farms. Photos go in a single call.
      const extracted: FsaFarmExtraction[] = []
      if (src.kind === 'pdf') {
        let batches: File[] = [src.file]
        try { batches = await splitPdfIntoBatches(src.file, 4) } catch { batches = [src.file] }
        for (let i = 0; i < batches.length; i++) {
          setStage(batches.length > 1 ? `Extracting base acres (batch ${i + 1} of ${batches.length})…` : 'Extracting base acres…')
          const data = await parseDocument(batches[i], 'fsa_base_acres')
          if (Array.isArray(data.farms)) extracted.push(...data.farms)
        }
      } else {
        setStage('Extracting base acres…')
        const data = await parseDocument(src.images, 'fsa_base_acres')
        if (Array.isArray(data.farms)) extracted.push(...data.farms)
      }
      if (extracted.length === 0) {
        setErr('No farms found in this document. The scan may be unclear or the format may not be readable.')
        return
      }
      const next = extracted.map(extractionToRow)
      setRows(next)
      const totalCmds = next.reduce((s, r) => s + r.commodities.length, 0)
      setBanner(`AI extracted ${next.length} farm${next.length === 1 ? '' : 's'} with ${totalCmds} commodity line${totalCmds === 1 ? '' : 's'}. Review before saving.`)
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else if (e?.message?.includes('504') || e?.message?.toLowerCase?.().includes('timeout')) {
        setErr("That document took too long to read in one pass. Try uploading fewer farms at a time, or use clearer photos of each page.")
      } else setErr(e?.message ? `Couldn't read this document: ${e.message}.` : "Couldn't read this document.")
    } finally {
      setStage(null)
    }
  }

  function setFarm(i: number, farm_id: string) {
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, farm_id, matched: !!farm_id } : r)))
  }
  function setCommodity(i: number, ci: number, patch: Partial<CommodityRow>) {
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, commodities: r.commodities.map((c, k) => (k === ci ? { ...c, ...patch } : c)) } : r)))
  }
  function discard() { setSource(null); setRows([]); setBanner(null); setErr(null) }

  function isDup(farm_id: string, commodity_id: string): boolean {
    return !!farm_id && !!commodity_id && existingKeys.has(`${farm_id}|${commodity_id}`)
  }

  async function saveAll() {
    setErr(null)
    const baseInserts: Array<{ farm_id: string; commodity_id: string; base_acres: number; plc_yield: number; source: string }> = []
    const electionUpserts: Array<{ farm_id: string; commodity_id: string; crop_year: number; election: ArcPlcElectionType }> = []
    for (const r of rows) {
      if (!r.farm_id) continue
      for (const c of r.commodities) {
        if (!c.include || !c.commodity_id) continue
        baseInserts.push({
          farm_id: r.farm_id,
          commodity_id: c.commodity_id,
          base_acres: num(c.base_acres) ?? 0,
          plc_yield: num(c.plc_yield) ?? 0,
          source: 'document_import',
        })
        if (c.election) electionUpserts.push({ farm_id: r.farm_id, commodity_id: c.commodity_id, crop_year: cropYear, election: c.election })
      }
    }
    if (baseInserts.length === 0) {
      setErr('Nothing to save — each line needs a matched farm and commodity.')
      return
    }
    setSaving(true)
    try {
      // Upsert by (farm_id, commodity_id) so re-importing updates in place.
      const { error } = await supabase.from('farm_base_acres').upsert(
        baseInserts.map((b) => ({ ...b, updated_at: new Date().toISOString() })),
        { onConflict: 'farm_id,commodity_id' },
      )
      if (error) throw new Error(error.message)
      if (electionUpserts.length > 0) {
        const { error: e2 } = await supabase.from('arc_plc_elections').upsert(electionUpserts, { onConflict: 'farm_id,commodity_id,crop_year' })
        if (e2) throw new Error(e2.message)
      }
      setBanner(`Saved base acres for ${baseInserts.length} commodity line${baseInserts.length === 1 ? '' : 's'}.`)
      setRows([]); setSource(null)
      onImported()
    } catch (e: any) {
      setErr(`Could not save: ${e?.message ?? 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'rounded-lg border border-slate-300 px-2 py-1 text-sm bg-white'

  return (
    <div className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold flex-1">Upload FSA Documents (AI)</h2>
        {source && !stage && <button type="button" onClick={discard} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">Discard</button>}
      </div>
      <p className="text-sm text-slate-500">
        Photograph or upload a Form 156EZ, Base &amp; Yield Notice, or Base Allocation Summary. Each farm is matched to
        your records by FSA number; base acres, PLC yields, and any election are pulled in for review. Elections save to
        the {cropYear} crop year.
      </p>

      <DocumentCapture onSource={onSource} busy={stage != null} stageLabel={stage} pdfLabel="Upload FSA PDF or Photo (AI)" />

      {banner && <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">{banner}</div>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {(source || rows.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="space-y-3">
            {rows.length === 0 && <p className="text-sm text-slate-400">{stage ? 'Working…' : 'No farms extracted yet.'}</p>}
            {rows.map((r, i) => (
              <div key={i} className="rounded-lg border border-slate-300 p-3 space-y-2">
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-mono text-slate-600">FSA #{r.raw_fsa ?? '—'}</span>
                  {r.raw_location && <span className="text-xs text-slate-400">{r.raw_location}</span>}
                  {r.matched
                    ? <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">Matched</span>
                    : <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Pick a farm</span>}
                  <select value={r.farm_id} onChange={(e) => setFarm(i, e.target.value)} className={`${inputCls} ml-auto`}>
                    <option value="">— select farm —</option>
                    {farms.map((f) => <option key={f.id} value={f.id}>{f.name}{f.fsa_number ? ` (#${f.fsa_number})` : ''}</option>)}
                  </select>
                </div>
                <table className="min-w-full text-xs">
                  <thead className="text-slate-500">
                    <tr>{['', 'Commodity', 'Base acres', 'PLC yield', 'Election', ''].map((h) => <th key={h} className="text-left px-1 py-1">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {r.commodities.map((c, ci) => {
                      const dup = isDup(r.farm_id, c.commodity_id)
                      return (
                        <tr key={ci} className="border-t border-slate-100">
                          <td className="px-1 py-1"><input type="checkbox" checked={c.include} onChange={(e) => setCommodity(i, ci, { include: e.target.checked })} /></td>
                          <td className="px-1 py-1">
                            <select value={c.commodity_id} onChange={(e) => setCommodity(i, ci, { commodity_id: e.target.value })} className={inputCls}>
                              <option value="">— commodity —</option>
                              {commodities.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>
                            {!c.commodity_id && c.raw_name && <div className="text-amber-700">AI: “{c.raw_name}”</div>}
                            {dup && <div className="text-slate-400">updates existing</div>}
                          </td>
                          <td className="px-1 py-1"><input type="number" step="0.01" value={c.base_acres} onChange={(e) => setCommodity(i, ci, { base_acres: e.target.value })} className={`${inputCls} w-20`} /></td>
                          <td className="px-1 py-1"><input type="number" step="0.1" value={c.plc_yield} onChange={(e) => setCommodity(i, ci, { plc_yield: e.target.value })} className={`${inputCls} w-20`} /></td>
                          <td className="px-1 py-1">
                            <select value={c.election} onChange={(e) => setCommodity(i, ci, { election: e.target.value as '' | ArcPlcElectionType })} className={inputCls}>
                              <option value="">—</option>
                              <option value="PLC">PLC</option>
                              <option value="ARC_CO">ARC-CO</option>
                              <option value="ARC_IC">ARC-IC</option>
                            </select>
                          </td>
                          <td className="px-1 py-1">
                            <button type="button" onClick={() => setCommodity(i, ci, { include: false })} className="text-red-600">✕</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <div className="xl:sticky xl:top-3 self-start h-[60vh] min-h-[320px]">
            <div className="text-xs text-slate-500 mb-1">Source document — cross-reference while reviewing</div>
            <SourcePreview source={source} className="h-full" title="FSA document" />
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="flex justify-end border-t border-slate-100 pt-3">
          <button type="button" onClick={saveAll} disabled={saving}
            className="rounded-lg bg-green-700 text-white px-4 py-2 font-semibold disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Base Acres'}
          </button>
        </div>
      )}
    </div>
  )
}
