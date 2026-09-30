'use client'

// New grain contract — the one-at-a-time form the tracker's "New Contract"
// button opens. Same fields as the editor; Settings → Contracts keeps the
// bulk paths (spreadsheet, document upload).

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { reportError } from '@/lib/friendly-error'
import {
  ContractFields,
  contractFormToPayload,
  validateContractFields,
  emptyContractForm,
  type ContractFieldErrors,
  type ContractFormState,
} from '@/components/contract-form'
import type { Buyer, Crop, DeliveryLocation, Entity, FieldPlanting } from '@/lib/types'

export default function NewContractPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [form, setForm] = useState<ContractFormState>(emptyContractForm)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [err, setErr] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<ContractFieldErrors>({})

  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [locations, setLocations] = useState<DeliveryLocation[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [b, k, l, en, pl] = await Promise.all([
        supabase.from('buyers').select('*').order('name'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('delivery_locations').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        fetchAllRows((f, t) => supabase.from('field_plantings').select('season_year').order('id').range(f, t)),
      ])
      if (cancelled) return
      setBuyers((b.data as Buyer[]) || [])
      setCrops((k.data as Crop[]) || [])
      setLocations((l.data as DeliveryLocation[]) || [])
      setEntities((en.data as Entity[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
    })()
    return () => { cancelled = true }
  }, [supabase])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(plantings.map((p) => p.season_year)),
    [plantings],
  )

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    // A double tap on Save must never create two contracts.
    if (savingRef.current) return
    const problems = validateContractFields(form)
    setFieldErrors(problems)
    if (Object.keys(problems).length > 0) { setErr('A few things need filling in — see the highlighted fields.'); return }
    savingRef.current = true
    setSaving(true)
    setErr(null)
    const { data, error } = await supabase.from('contracts').insert(contractFormToPayload(form)).select('id').single()
    if (error || !data) {
      savingRef.current = false
      setSaving(false)
      setErr(reportError(error, { action: 'save this contract', noun: 'contract', name: form.contract_number.trim() }))
      return
    }
    router.push(`/contracts/${(data as { id: string }).id}`)
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/contracts" className="text-sm text-brand-deep">← Back to contracts</Link>
        <h1 className="text-2xl font-bold flex-1">New contract</h1>
      </div>
      <p className="text-sm text-slate-600 max-w-3xl">
        A grain sale to a buyer. Have several to enter at once, or a contract document to read in?{' '}
        <Link href="/settings/contracts" className="text-brand-deep underline">Settings → Contracts</Link> does both.
      </p>

      <form onSubmit={onSave} className="bg-white p-4 rounded-xl shadow space-y-3">
        <ContractFields
          value={form}
          onChange={(f) => { setForm(f); if (Object.keys(fieldErrors).length) setFieldErrors(validateContractFields(f)) }}
          buyers={buyers} crops={crops} locations={locations} entities={entities} cropYearOptions={cropYearOptions}
          errors={fieldErrors}
          onBuyerCreated={(b) => setBuyers((xs) => [...xs, b].sort((a, z) => a.name.localeCompare(z.name)))}
          onLocationCreated={(l) => setLocations((xs) => [...xs, l].sort((a, z) => a.name.localeCompare(z.name)))}
        />
        {err && <p className="text-sm text-red-700">{err}</p>}
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={saving} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">
            {saving ? 'Saving…' : 'Save contract'}
          </button>
          <Link href="/contracts" className="rounded-lg border border-slate-300 px-4 min-h-11 inline-flex items-center font-semibold">Cancel</Link>
        </div>
      </form>
    </div>
  )
}
