'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'

type Props = { binId: string; binName: string }

type LoadRow = {
  net_weight: number | null
  moisture: number | null
  crop_id: string | null
  dry_bushels_override: number | null
  from_type: string | null
  from_bin_id: string | null
  to_type: string | null
  to_bin_id: string | null
}

type CropRow = { id: string; name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null }

type AdjRow = {
  crop_id: string
  adjustment_type: 'beginning_inventory' | 'empty_bin'
  bushels: number
  as_of_date: string
}

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}

export default function EmptyBinButton({ binId, binName }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function emptyIt() {
    setErr(null)
    const supabase = createClient()
    setBusy(true)
    try {
      const today = todayISO()
      const [loadsRes, cropsRes, adjRes] = await Promise.all([
        fetchAllRows((f, t) => supabase
          .from('loads')
          .select('net_weight, moisture, crop_id, dry_bushels_override, from_type, from_bin_id, to_type, to_bin_id')
          .or(`from_bin_id.eq.${binId},to_bin_id.eq.${binId}`)
          .order('id')
          .range(f, t)),
        supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel'),
        fetchAllRows((f, t) => supabase
          .from('bin_inventory_adjustments')
          .select('crop_id, adjustment_type, bushels, as_of_date')
          .eq('bin_id', binId)
          .lte('as_of_date', today)
          .order('id')
          .range(f, t)),
      ])
      const loads = (loadsRes.data ?? []) as LoadRow[]
      const crops = (cropsRes.data ?? []) as CropRow[]
      const adjs = (adjRes.data ?? []) as AdjRow[]
      const cropById = new Map(crops.map((c) => [c.id, c]))

      const onHand = new Map<string, number>()
      for (const l of loads) {
        if (!l.crop_id) continue
        const crop = cropById.get(l.crop_id)
        const { dryBushels } = computeBushels({
          netWeightLb: l.net_weight,
          moisturePct: l.moisture,
          baseMoisturePct: crop?.base_moisture_pct ?? null,
          baseLbPerBushel: crop?.base_lb_per_bushel ?? null,
          dryBushelsOverride: l.dry_bushels_override,
        })
        if (!dryBushels) continue
        if (l.to_type === 'bin' && l.to_bin_id === binId) {
          onHand.set(l.crop_id, (onHand.get(l.crop_id) ?? 0) + dryBushels)
        }
        if (l.from_type === 'bin' && l.from_bin_id === binId) {
          onHand.set(l.crop_id, (onHand.get(l.crop_id) ?? 0) - dryBushels)
        }
      }
      for (const a of adjs) {
        const sign = a.adjustment_type === 'beginning_inventory' ? 1 : -1
        onHand.set(a.crop_id, (onHand.get(a.crop_id) ?? 0) + sign * Number(a.bushels))
      }

      const nonZero = [...onHand.entries()].filter(([, v]) => v > 0.001)
      if (nonZero.length === 0) {
        setErr('This bin is already empty.')
        setBusy(false)
        return
      }
      const summary = nonZero
        .map(([cid, v]) => `${v.toFixed(2)} bu (${cropById.get(cid)?.name ?? 'unknown crop'})`)
        .join(', ')
      if (!confirm(`Empty bin ${binName}? This will record a cleanout adjustment for: ${summary}.`)) {
        setBusy(false)
        return
      }

      const rows = nonZero.map(([cid, v]) => ({
        bin_id: binId,
        crop_id: cid,
        adjustment_type: 'empty_bin' as const,
        bushels: Number(v.toFixed(2)),
        as_of_date: today,
        notes: 'Cleanout adjustment',
      }))
      const { error } = await supabase.from('bin_inventory_adjustments').insert(rows)
      setBusy(false)
      if (error) { setErr(error.message); return }
      router.refresh()
    } catch (e: any) {
      setBusy(false)
      setErr(e?.message ?? 'Failed to empty bin')
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={emptyIt}
        disabled={busy}
        className="text-xs rounded-lg bg-white border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-50"
        title="Record a cleanout adjustment zeroing out this bin"
      >
        {busy ? 'Emptying…' : 'Empty bin'}
      </button>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  )
}
