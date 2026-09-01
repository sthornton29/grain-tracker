'use client'

// Dedicated entry form for seed production contracts (077) — deliberately
// separate from the grain <ContractFields> form. Carries the agreement terms
// (acres, forecast, elevator, premium schedule from a Bayer-style template,
// staged-payment terms), links the committed plantings, and offers the AI
// upload path (document_type 'seed_contract') that prefills everything for
// review. Dedupe on contract number: an existing seed contract with the same
// number is UPDATED in place, never duplicated.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import { BuyerPicker } from '@/components/buyer-location-pickers'
import EntitySelect from '@/components/entity-select'
import { parseDocumentChunked } from '@/lib/parse-chunked'
import { mergeSeedContracts } from '@/lib/parse-merge'
import { uploadFileToStorage } from '@/lib/pdf-upload'
import type { SeedContractExtraction } from '@/lib/pdf-upload'
import { findBestMatch } from '@/lib/fuzzy'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { varietyKey } from '@/lib/variety-resolution'
import { SEED_OUTCOME_LABEL, defaultFinalSettlementDate } from '@/lib/seed-contracts'
import type { SeedOutcome } from '@/lib/seed-contracts'
import type { Buyer, Crop, Entity } from '@/lib/types'

type PremiumRow = {
  outcome: SeedOutcome
  component: string
  amount_per_bu: string
  applies_to: 'all' | 'irrigated_only'
}

// Bayer-style starting schedule — every row editable, rows add/remove freely.
const PREMIUM_TEMPLATE: PremiumRow[] = [
  { outcome: 'accepted', component: 'Production premium', amount_per_bu: '1.15', applies_to: 'all' },
  { outcome: 'accepted', component: 'Irrigated premium', amount_per_bu: '0.25', applies_to: 'irrigated_only' },
  { outcome: 'released_post_harvest', component: 'Release premium', amount_per_bu: '0.40', applies_to: 'all' },
  { outcome: 'released_pre_harvest', component: 'Release premium', amount_per_bu: '0.20', applies_to: 'all' },
]

type PlantingOption = {
  id: string
  crop_id: string
  season_year: number
  planted_acres: number
  irrigated_acres: number
  fieldName: string
  farmName: string | null
}

export default function SeedContractForm({ editContractId }: { editContractId?: string }) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const isEdit = Boolean(editContractId)

  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [plantings, setPlantings] = useState<PlantingOption[]>([])
  const [plantingYears, setPlantingYears] = useState<Array<number | null>>([])
  const [existingSeed, setExistingSeed] = useState<Array<{ id: string; contract_number: string }>>([])
  const [varietiesForCrop, setVarietiesForCrop] = useState<string[]>([])

  const [contractNumber, setContractNumber] = useState('')
  const [buyerId, setBuyerId] = useState('')
  const [cropId, setCropId] = useState('')
  const [entityId, setEntityId] = useState('')
  const [cropYear, setCropYear] = useState<number>(() => new Date().getFullYear())
  const [productionSite, setProductionSite] = useState('')
  const [brand, setBrand] = useState('')
  const [variety, setVariety] = useState('')
  const [acres, setAcres] = useState('')
  const [forecast, setForecast] = useState('')
  const [elevator, setElevator] = useState('')
  const [deadline, setDeadline] = useState('')
  const [capPerBu, setCapPerBu] = useState('1.40')
  const [storagePay, setStoragePay] = useState('')
  const [storageStart, setStorageStart] = useState('')
  const [usageFee, setUsageFee] = useState('')
  const [expectedOutcome, setExpectedOutcome] = useState<SeedOutcome>('accepted')
  const [settlementDate, setSettlementDate] = useState('')
  const [notes, setNotes] = useState('')
  const [premiums, setPremiums] = useState<PremiumRow[]>(isEdit ? [] : PREMIUM_TEMPLATE)
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set())

  const [aiStage, setAiStage] = useState('')
  const [aiSource, setAiSource] = useState<DocumentSource | null>(null)
  const [aiBanner, setAiBanner] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [b, c, e, py, sc] = await Promise.all([
        supabase.from('buyers').select('id, name').order('name'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('entities').select('id, name, entity_role').order('name'),
        supabase.from('field_plantings').select('season_year'),
        supabase.from('contracts').select('id, contract_number').eq('contract_kind', 'seed_production'),
      ])
      if (!alive) return
      setBuyers((b.data ?? []) as Buyer[])
      const cropList = (c.data ?? []) as Crop[]
      setCrops(cropList)
      setEntities((e.data ?? []) as Entity[])
      setPlantingYears(((py.data ?? []) as Array<{ season_year: number | null }>).map((p) => p.season_year))
      setExistingSeed(((sc.data ?? []) as Array<{ id: string; contract_number: string }>))
      // Seed soybeans first: default the crop to Soybeans when present.
      if (!isEdit) {
        const soy = cropList.find((x) => /soy/i.test(x.name))
        if (soy) setCropId((prev) => prev || soy.id)
      }
    })()
    return () => { alive = false }
  }, [supabase, isEdit])

  // Load the existing contract in edit mode.
  useEffect(() => {
    if (!editContractId) return
    let alive = true
    void (async () => {
      const [cQ, dQ, prQ, jQ] = await Promise.all([
        supabase.from('contracts').select('*').eq('id', editContractId).single(),
        supabase.from('seed_contract_details').select('*').eq('contract_id', editContractId).maybeSingle(),
        supabase.from('seed_contract_premiums').select('*').eq('contract_id', editContractId).order('sort_order'),
        supabase.from('seed_contract_plantings').select('planting_id').eq('contract_id', editContractId),
      ])
      if (!alive || !cQ.data) return
      const c = cQ.data
      setContractNumber(c.contract_number ?? '')
      setBuyerId(c.buyer_id ?? '')
      setCropId(c.crop_id ?? '')
      setEntityId(c.entity_id ?? '')
      if (c.crop_year != null) setCropYear(c.crop_year)
      setNotes(c.notes ?? '')
      const d = dQ.data
      if (d) {
        setProductionSite(d.production_site ?? '')
        setBrand(d.brand ?? '')
        setVariety(d.variety ?? '')
        setAcres(String(d.contract_acres ?? ''))
        setForecast(String(d.forecast_bu_per_acre ?? ''))
        setElevator(d.local_market_elevator ?? '')
        setDeadline(d.pricing_deadline ?? '')
        setCapPerBu(d.premium_cap_per_bu != null ? String(d.premium_cap_per_bu) : '')
        setStoragePay(d.storage_pay_per_bu_month != null ? String(d.storage_pay_per_bu_month) : '')
        setStorageStart(d.storage_pay_start_date ?? '')
        setUsageFee(d.usage_fee_per_bu != null ? String(d.usage_fee_per_bu) : '')
        setExpectedOutcome((d.expected_outcome ?? 'accepted') as SeedOutcome)
        setSettlementDate(d.final_settlement_date ?? '')
      }
      setPremiums(
        ((prQ.data ?? []) as Array<{ outcome: SeedOutcome; component: string; amount_per_bu: number; applies_to: 'all' | 'irrigated_only' }>)
          .map((p) => ({ outcome: p.outcome, component: p.component, amount_per_bu: String(p.amount_per_bu), applies_to: p.applies_to })),
      )
      setLinkedIds(new Set(((jQ.data ?? []) as Array<{ planting_id: string }>).map((j) => j.planting_id)))
    })()
    return () => { alive = false }
  }, [supabase, editContractId])

  // Plantings + known varieties for the chosen crop × year.
  useEffect(() => {
    if (!cropId) { setPlantings([]); setVarietiesForCrop([]); return }
    let alive = true
    void (async () => {
      const [pQ, vQ] = await Promise.all([
        supabase
          .from('field_plantings')
          .select('id, crop_id, season_year, planted_acres, irrigated_acres, field:fields(name_or_number, farm:farms(name))')
          .eq('crop_id', cropId)
          .eq('season_year', cropYear),
        supabase
          .from('field_planting_varieties')
          .select('variety, planting:field_plantings!inner(crop_id)')
          .eq('planting.crop_id', cropId),
      ])
      if (!alive) return
      type Raw = { id: string; crop_id: string; season_year: number; planted_acres: number; irrigated_acres: number; field: { name_or_number: string; farm: { name: string } | null } | null }
      setPlantings(
        (((pQ.data ?? []) as unknown) as Raw[]).map((p) => ({
          id: p.id, crop_id: p.crop_id, season_year: p.season_year,
          planted_acres: Number(p.planted_acres ?? 0), irrigated_acres: Number(p.irrigated_acres ?? 0),
          fieldName: p.field?.name_or_number ?? '—', farmName: p.field?.farm?.name ?? null,
        })),
      )
      const names = new Set<string>()
      for (const v of ((vQ.data ?? []) as Array<{ variety: string }>)) names.add(v.variety)
      setVarietiesForCrop([...names].sort())
    })()
    return () => { alive = false }
  }, [supabase, cropId, cropYear])

  const estimated = (Number(acres) || 0) * (Number(forecast) || 0)
  const linkedAcres = plantings.filter((p) => linkedIds.has(p.id)).reduce((s, p) => s + p.planted_acres, 0)
  const cropYearOptions = cropYearOptionsFromPlantings(plantingYears, cropYear)

  const existingMatch = useMemo(() => {
    const n = contractNumber.trim().toLowerCase()
    if (!n) return null
    return existingSeed.find((c) => c.contract_number.trim().toLowerCase() === n && c.id !== editContractId) ?? null
  }, [contractNumber, existingSeed, editContractId])

  async function onAiSource(src: DocumentSource) {
    setErr(''); setAiBanner('')
    try {
      const { data: x, warning } = await parseDocumentChunked<SeedContractExtraction>(
        src.kind === 'pdf' ? src.file : src.images,
        'seed_contract',
        { onProgress: setAiStage, merge: mergeSeedContracts },
      )
      setAiSource(src)
      if (x.contract_number) setContractNumber(x.contract_number)
      if (x.seed_company) {
        const m = findBestMatch(x.seed_company, buyers, (b) => b.name)
        if (m) setBuyerId(m.id)
      }
      if (x.crop) {
        const m = findBestMatch(x.crop, crops, (c) => c.name)
        if (m) setCropId(m.id)
      }
      if (x.crop_year != null) setCropYear(x.crop_year)
      if (x.brand) setBrand(x.brand)
      if (x.variety) {
        // Variety pipeline: a spelling that normalizes to a known planting
        // variety links to the stored spelling.
        const known = varietiesForCrop.find((v) => varietyKey(v) === varietyKey(x.variety!))
        setVariety(known ?? x.variety)
      }
      if (x.production_site) setProductionSite(x.production_site)
      if (x.contract_acres != null) setAcres(String(x.contract_acres))
      if (x.forecast_bu_per_acre != null) setForecast(String(x.forecast_bu_per_acre))
      else if (x.estimated_bushels != null && x.contract_acres) setForecast(String(x.estimated_bushels / x.contract_acres))
      if (x.local_market_elevator) setElevator(x.local_market_elevator)
      if (x.pricing_deadline) setDeadline(x.pricing_deadline)
      if (x.premium_cap_per_bu != null) setCapPerBu(String(x.premium_cap_per_bu))
      if (x.storage_pay_per_bu_month != null) setStoragePay(String(x.storage_pay_per_bu_month))
      if (x.storage_pay_start_date) setStorageStart(x.storage_pay_start_date)
      if (x.usage_fee_per_bu != null) setUsageFee(String(x.usage_fee_per_bu))
      if (x.final_settlement_date) setSettlementDate(x.final_settlement_date)
      if (x.notes) setNotes(x.notes)
      if (x.premiums.length > 0) {
        setPremiums(
          x.premiums
            .filter((p) => p.component != null && p.amount_per_bu != null)
            .map((p) => ({
              outcome: (p.outcome ?? 'accepted') as SeedOutcome,
              component: p.component as string,
              amount_per_bu: String(p.amount_per_bu),
              applies_to: p.applies_to === 'irrigated_only' ? 'irrigated_only' : 'all',
            })),
        )
      }
      setAiBanner(
        `The document was read${warning ? ` (${warning})` : ''}. Review and edit everything below, then save — the document attaches automatically.`,
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The document could not be read.')
    } finally {
      setAiStage('')
    }
  }

  async function save() {
    setErr('')
    if (!contractNumber.trim()) { setErr('Contract number is required.'); return }
    if (!cropId) { setErr('Pick the crop.'); return }
    if (!(Number(acres) > 0)) { setErr('Enter the contract acres.'); return }
    if (!(Number(forecast) > 0)) { setErr('Enter the forecast bushels per acre.'); return }
    setBusy(true)
    try {
      const targetId = editContractId ?? existingMatch?.id ?? null
      const contractPatch = {
        contract_number: contractNumber.trim(),
        buyer_id: buyerId || null,
        crop_id: cropId,
        entity_id: entityId || null,
        crop_year: cropYear,
        // Informational: the agreement's estimated quantity. Marketing math
        // reads the linked plantings, never this column.
        contracted_bushels: estimated,
        price_per_bushel: null,
        cash_price: null,
        contract_kind: 'seed_production',
        notes: notes.trim() || null,
      }
      let contractId: string
      if (targetId) {
        const { error } = await supabase.from('contracts').update(contractPatch).eq('id', targetId)
        if (error) throw error
        contractId = targetId
      } else {
        const { data, error } = await supabase.from('contracts').insert(contractPatch).select('id').single()
        if (error) throw error
        contractId = data.id as string
      }

      // Variety pipeline: normalize onto a stored spelling when one matches.
      const storedVariety = varietiesForCrop.find((v) => varietyKey(v) === varietyKey(variety)) ?? (variety.trim() || null)

      const detailsPatch = {
        contract_id: contractId,
        production_site: productionSite.trim() || null,
        brand: brand.trim() || null,
        variety: storedVariety,
        contract_acres: Number(acres),
        forecast_bu_per_acre: Number(forecast),
        local_market_elevator: elevator.trim() || null,
        pricing_deadline: deadline || null,
        premium_cap_per_bu: capPerBu !== '' ? Number(capPerBu) : null,
        storage_pay_per_bu_month: storagePay !== '' ? Number(storagePay) : null,
        storage_pay_start_date: storageStart || null,
        usage_fee_per_bu: usageFee !== '' ? Number(usageFee) : 0,
        expected_outcome: expectedOutcome,
        final_settlement_date: settlementDate || defaultFinalSettlementDate(cropYear),
      }
      const { data: existingDetails } = await supabase
        .from('seed_contract_details').select('id').eq('contract_id', contractId).maybeSingle()
      if (existingDetails?.id) {
        const { error } = await supabase.from('seed_contract_details').update(detailsPatch).eq('id', existingDetails.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('seed_contract_details').insert(detailsPatch)
        if (error) throw error
      }

      // Premium schedule: replace wholesale (the rows are the schedule).
      await supabase.from('seed_contract_premiums').delete().eq('contract_id', contractId)
      const premiumRows = premiums
        .filter((p) => p.component.trim() && Number(p.amount_per_bu) >= 0)
        .map((p, i) => ({
          contract_id: contractId, outcome: p.outcome, component: p.component.trim(),
          amount_per_bu: Number(p.amount_per_bu), applies_to: p.applies_to, sort_order: i,
        }))
      if (premiumRows.length > 0) {
        const { error } = await supabase.from('seed_contract_premiums').insert(premiumRows)
        if (error) throw error
      }

      // Linked plantings: replace with the current selection.
      await supabase.from('seed_contract_plantings').delete().eq('contract_id', contractId)
      const junctionRows = [...linkedIds].map((pid) => ({ contract_id: contractId, planting_id: pid }))
      if (junctionRows.length > 0) {
        const { error } = await supabase.from('seed_contract_plantings').insert(junctionRows)
        if (error) throw error
      }

      // Attach the AI-uploaded source document (best effort).
      if (aiSource) {
        try {
          const files = aiSource.kind === 'pdf'
            ? [aiSource.file]
            : aiSource.images.map((img, i) =>
                new File([Uint8Array.from(atob(img.base64), (ch) => ch.charCodeAt(0))], `seed-contract-${i + 1}.jpg`, { type: img.mediaType }))
          for (const f of files) {
            const { publicUrl, path } = await uploadFileToStorage(supabase, f, 'contract-attachments', f.type)
            await supabase.from('contract_attachments').insert({
              contract_id: contractId, file_url: publicUrl, file_path: path,
              file_name: f.name, mime_type: f.type, file_size: f.size,
            })
          }
        } catch { /* attachment is best-effort; the contract is saved */ }
      }

      router.push(`/contracts/${contractId}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the contract.')
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2'
  const labelCls = 'block text-sm'
  const capCls = 'block text-slate-600 text-xs mb-1'

  return (
    <div className="space-y-4 max-w-3xl">
      {err && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}

      {!isEdit && (
        <div className="bg-white rounded-xl shadow p-5 space-y-2">
          <h2 className="font-semibold">Upload the agreement (optional)</h2>
          <p className="text-sm text-slate-500">
            A PDF or photos of the signed agreement — the signature page and the premium/payment terms are read and filled in below for your review.
          </p>
          <DocumentCapture onSource={onAiSource} busy={aiStage !== ''} stageLabel={aiStage} />
          {aiBanner && <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{aiBanner}</div>}
        </div>
      )}

      {existingMatch && !isEdit && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Seed contract #{contractNumber.trim()} already exists — saving updates it (never duplicated).
        </div>
      )}

      <div className="bg-white rounded-xl shadow p-5 space-y-3">
        <h2 className="font-semibold">Agreement</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelCls}><span className={capCls}>Contract #*</span>
            <input value={contractNumber} onChange={(e) => setContractNumber(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Seed company (buyer)</span>
            <BuyerPicker value={buyerId} onChange={setBuyerId} buyers={buyers} onCreated={(b) => setBuyers((prev) => [...prev, b].sort((x, y) => x.name.localeCompare(y.name)))} className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Crop</span>
            <select value={cropId} onChange={(e) => setCropId(e.target.value)} className={inputCls}>
              <option value="">— crop —</option>
              {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className={labelCls}><span className={capCls}>Crop year</span>
            <select value={cropYear} onChange={(e) => setCropYear(Number(e.target.value))} className={inputCls}>
              {cropYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className={labelCls}><span className={capCls}>Entity</span>
            <EntitySelect entities={entities} value={entityId} onChange={setEntityId} className={inputCls} showWhenSingle />
          </label>
          <label className={labelCls}><span className={capCls}>Production site</span>
            <input value={productionSite} onChange={(e) => setProductionSite(e.target.value)} placeholder="Hurt Seed Company, Halls TN" className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Brand</span>
            <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Asgrow" className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Variety</span>
            <input value={variety} onChange={(e) => setVariety(e.target.value)} placeholder="AG55XF5" list="seed-variety-options" className={inputCls} />
            <datalist id="seed-variety-options">
              {varietiesForCrop.map((v) => <option key={v} value={v} />)}
            </datalist>
          </label>
          <label className={labelCls}><span className={capCls}>Contract acres*</span>
            <input inputMode="decimal" value={acres} onChange={(e) => setAcres(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Forecast bu/acre*</span>
            <input inputMode="decimal" value={forecast} onChange={(e) => setForecast(e.target.value)} className={inputCls} />
          </label>
          <div className="text-sm self-end pb-2 text-slate-600">
            Estimated quantity: <span className="font-semibold">{estimated > 0 ? estimated.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} bu</span>
          </div>
          <label className={labelCls}><span className={capCls}>Local market for pricing</span>
            <input value={elevator} onChange={(e) => setElevator(e.target.value)} placeholder="Bunge Decatur AL" className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Price everything by (Selection Date)</span>
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Premium cap $/bu</span>
            <input inputMode="decimal" value={capPerBu} onChange={(e) => setCapPerBu(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Usage fee $/bu</span>
            <input inputMode="decimal" value={usageFee} onChange={(e) => setUsageFee(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Storage pay $/bu/month</span>
            <input inputMode="decimal" value={storagePay} onChange={(e) => setStoragePay(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Storage pay starts</span>
            <input type="date" value={storageStart} onChange={(e) => setStorageStart(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Final settlement (est.)</span>
            <input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}><span className={capCls}>Expected outcome (drives projections)</span>
            <select value={expectedOutcome} onChange={(e) => setExpectedOutcome(e.target.value as SeedOutcome)} className={inputCls}>
              {(Object.keys(SEED_OUTCOME_LABEL) as SeedOutcome[]).map((o) => (
                <option key={o} value={o}>{SEED_OUTCOME_LABEL[o]}</option>
              ))}
            </select>
          </label>
        </div>
        <label className={labelCls}><span className={capCls}>Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} />
        </label>
      </div>

      <div className="bg-white rounded-xl shadow p-5 space-y-3">
        <h2 className="font-semibold">Premium schedule</h2>
        <p className="text-sm text-slate-500">
          What the seed company pays on top of the elected price, per outcome. Premiums are assumptions until the crop is accepted.
        </p>
        <div className="space-y-2">
          {premiums.map((p, i) => (
            <div key={i} className="flex items-end gap-2 flex-wrap">
              <label className="text-sm"><span className={capCls}>If the crop is…</span>
                <select
                  value={p.outcome}
                  onChange={(e) => setPremiums((rows) => rows.map((r, j) => j === i ? { ...r, outcome: e.target.value as SeedOutcome } : r))}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                >
                  {(Object.keys(SEED_OUTCOME_LABEL) as SeedOutcome[]).map((o) => (
                    <option key={o} value={o}>{SEED_OUTCOME_LABEL[o]}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm flex-1 min-w-[10rem]"><span className={capCls}>Premium</span>
                <input
                  value={p.component}
                  onChange={(e) => setPremiums((rows) => rows.map((r, j) => j === i ? { ...r, component: e.target.value } : r))}
                  className={inputCls}
                />
              </label>
              <label className="text-sm"><span className={capCls}>$/bu</span>
                <input
                  inputMode="decimal"
                  value={p.amount_per_bu}
                  onChange={(e) => setPremiums((rows) => rows.map((r, j) => j === i ? { ...r, amount_per_bu: e.target.value } : r))}
                  className="w-24 rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>
              <label className="text-sm"><span className={capCls}>Applies to</span>
                <select
                  value={p.applies_to}
                  onChange={(e) => setPremiums((rows) => rows.map((r, j) => j === i ? { ...r, applies_to: e.target.value as 'all' | 'irrigated_only' } : r))}
                  className="rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="all">All bushels</option>
                  <option value="irrigated_only">Irrigated only</option>
                </select>
              </label>
              <button onClick={() => setPremiums((rows) => rows.filter((_, j) => j !== i))} className="text-red-700 text-sm pb-2 hover:underline">✕</button>
            </div>
          ))}
        </div>
        <button
          onClick={() => setPremiums((rows) => [...rows, { outcome: 'accepted', component: '', amount_per_bu: '', applies_to: 'all' }])}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          + Add premium row
        </button>
      </div>

      <div className="bg-white rounded-xl shadow p-5 space-y-3">
        <h2 className="font-semibold">Committed fields</h2>
        <p className="text-sm text-slate-500">
          Link the planted fields growing this seed — everything they produce counts as committed to this contract in the marketing reports.
        </p>
        {plantings.length === 0
          ? <p className="text-sm text-slate-400">No {cropYear} plantings for this crop yet — add them under Settings → Plantings, then link them here.</p>
          : (
            <div className="grid gap-1 sm:grid-cols-2">
              {plantings.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={linkedIds.has(p.id)}
                    onChange={(e) => setLinkedIds((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(p.id)
                      else next.delete(p.id)
                      return next
                    })}
                  />
                  <span className="font-medium">{p.fieldName}</span>
                  {p.farmName && <span className="text-slate-500">{p.farmName}</span>}
                  <span className="ml-auto text-slate-600">{p.planted_acres.toLocaleString(undefined, { maximumFractionDigits: 1 })} ac</span>
                </label>
              ))}
            </div>
          )}
        {linkedIds.size > 0 && (
          <p className="text-sm text-slate-600">
            {linkedAcres.toLocaleString(undefined, { maximumFractionDigits: 1 })} acres linked
            {Number(acres) > 0 ? ` of ${Number(acres).toLocaleString(undefined, { maximumFractionDigits: 1 })} contracted` : ''}.
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <button onClick={save} disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50">
          {busy ? 'Saving…' : isEdit ? 'Save changes' : existingMatch ? 'Update existing contract' : 'Add seed contract'}
        </button>
        <button onClick={() => router.back()} className="rounded-lg border border-slate-300 px-4 py-2 text-slate-600 hover:bg-slate-50">Cancel</button>
      </div>
    </div>
  )
}
