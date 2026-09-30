'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { reportError } from '@/lib/friendly-error'
import {
  ContractFields,
  contractToForm,
  contractFormToPayload,
  validateContractFields,
  emptyContractForm,
  type ContractFieldErrors,
  type ContractFormState,
} from '@/components/contract-form'
import type { Buyer, Contract, Crop, DeliveryLocation, Entity, FieldPlanting } from '@/lib/types'

export default function EditContractPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const id = params.id

  const [form, setForm] = useState<ContractFormState>(emptyContractForm)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
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
      const [c, b, k, l, en, pl] = await Promise.all([
        supabase.from('contracts').select('*').eq('id', id).single(),
        supabase.from('buyers').select('*').order('name'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('delivery_locations').select('*').order('name'),
        supabase.from('entities').select('*').order('name'),
        fetchAllRows((f, t) => supabase.from('field_plantings').select('season_year').order('id').range(f, t)),
      ])
      if (cancelled) return
      if (c.error || !c.data) { setErr(reportError(c.error, { action: 'open this contract', noun: 'contract' })); return }
      const contract = c.data as Contract & { contract_kind?: string | null }
      // A seed production contract has its own editor — the grain form would
      // overwrite its acres, premiums, and payment terms.
      if (contract.contract_kind === 'seed_production') {
        router.replace(`/contracts/seed/${id}/edit`)
        return
      }
      setForm(contractToForm(contract))
      setBuyers((b.data as Buyer[]) || [])
      setCrops((k.data as Crop[]) || [])
      setLocations((l.data as DeliveryLocation[]) || [])
      setEntities((en.data as Entity[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [id, supabase, router])

  const cropYearOptions = useMemo(
    () => cropYearOptionsFromPlantings(plantings.map((p) => p.season_year), form.crop_year ? Number(form.crop_year) : null),
    [plantings, form.crop_year],
  )

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    const problems = validateContractFields(form)
    setFieldErrors(problems)
    if (Object.keys(problems).length > 0) { setErr('A few things need filling in — see the highlighted fields.'); return }
    setSaving(true)
    setErr(null)
    const { error } = await supabase.from('contracts').update(contractFormToPayload(form)).eq('id', id)
    setSaving(false)
    if (error) { setErr(reportError(error, { action: 'save this contract', noun: 'contract', name: form.contract_number.trim() })); return }
    router.push(`/contracts/${id}`)
    router.refresh()
  }

  if (!loaded) return <div className="text-sm text-slate-500">{err ?? 'Loading…'}</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href={`/contracts/${id}`} className="text-sm text-brand-deep">← Back to contract</Link>
        <h1 className="text-2xl font-bold flex-1">Edit contract</h1>
      </div>

      <form onSubmit={onSave} className="bg-white p-4 rounded-xl shadow space-y-3">
        <ContractFields value={form} onChange={(f) => { setForm(f); if (Object.keys(fieldErrors).length) setFieldErrors(validateContractFields(f)) }} buyers={buyers} crops={crops} locations={locations} entities={entities} cropYearOptions={cropYearOptions}
          errors={fieldErrors}
          onBuyerCreated={(b) => setBuyers((xs) => [...xs, b].sort((a, z) => a.name.localeCompare(z.name)))}
          onLocationCreated={(l) => setLocations((xs) => [...xs, l].sort((a, z) => a.name.localeCompare(z.name)))} />
        {err && <p className="text-sm text-red-700">{err}</p>}
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={saving} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <Link href={`/contracts/${id}`} className="rounded-lg border border-slate-300 px-4 min-h-11 inline-flex items-center font-semibold">Cancel</Link>
        </div>
      </form>
    </div>
  )
}
