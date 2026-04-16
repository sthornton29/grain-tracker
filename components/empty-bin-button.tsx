'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
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

export default function EmptyBinButton({ binId, binName }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function emptyIt() {
    setErr(null)
    const supabase = createClient()
    setBusy(true)
    try {
      // Pull every load that touches this bin + crop base values — we need the true
      // on-hand regardless of any filter active on the page.
      const [loadsRes, cropsRes] = await Promise.all([
        supabase
          .from('loads')
          .select('net_weight, moisture, crop_id, dry_bushels_override, from_type, from_bin_id, to_type, to_bin_id')
          .or(`from_bin_id.eq.${binId},to_bin_id.eq.${binId}`),
        supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel'),
      ])
      const loads = (loadsRes.data ?? []) as LoadRow[]
      const crops = (cropsRes.data ?? []) as CropRow[]
      const cropById = new Map(crops.map((c) => [c.id, c]))

      // crop_id -> dry bushels currently on hand
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

      const nonZero = [...onHand.entries()].filter(([, v]) => Math.abs(v) > 0.001)
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

      const today = new Date().toISOString().slice(0, 10)
      const ts = Date.now()
      const rows = nonZero.map(([cid, v], i) => ({
        date: today,
        crop_id: cid,
        from_type: 'bin' as const,
        from_bin_id: binId,
        to_type: null,
        dry_bushels_override: Number(v.toFixed(2)),
        ticket_number: `ADJ-${ts}-${i}`,
        bushels: null,
      }))
      const { error } = await supabase.from('loads').insert(rows)
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
