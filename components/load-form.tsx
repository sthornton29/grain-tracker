'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { allocateSplits, validateSplitDrafts, type SplitDraft } from '@/lib/load-splits'
import { practiceOf } from '@/lib/yields'
import { rememberHarvestEntryPath } from '@/lib/harvest-entry-path'
import { relinkSettlementLinesForLoad } from '@/lib/settlement-link'
import { getOrgId } from '@/lib/org'
import { externalTruckInsert, truckLabelForSave } from '@/lib/trucks'
import {
  LAST_LOAD_DEFAULTS_SELECT,
  applyLastLoadDefaults,
  dateDefaultNote,
  pickLastLoadDefaults,
  pickPerUserLastLoadDefaults,
  saveAndNewPatch,
  type LastLoadDefaultsSource,
} from '@/lib/load-defaults'
import { contractDeliveredTotals, contractProgress } from '@/lib/contract-progress'
import { HaulerTruckField, TruckPicker, findExternalTruck } from '@/components/truck-picker'
import { FieldPicker } from '@/components/field-picker'
import { lowTareWarning, truckTareKey, truckTareStats, type TareHistoryLoad } from '@/lib/truck-tare'
import { fetchTruckTareHistory } from '@/lib/truck-tare-fetch'
import type { Bin, Buyer, Contract, Crop, ExternalTruck, Farm, Field, FieldPlanting, Load, LoadSplit, Truck } from '@/lib/types'

type Props = {
  initial?: Partial<Load>
  initialSplits?: LoadSplit[]
  mode: 'create' | 'edit'
}

type PracticeChoice = '' | 'irrigated' | 'dryland'

type SplitRow = { field_id: string; weight: string; practice: PracticeChoice }

type FormState = {
  date: string
  time: string
  truck_id: string
  /** Hauler's truck (free text) on a pickup-contract load. */
  hauler_truck: string
  crop_id: string
  crop_year: string
  gross_weight: string
  tare_weight: string
  net_weight: string
  moisture: string
  test_weight: string
  dry_bushels_override: string
  from_type: '' | 'field' | 'bin'
  from_field_id: string
  from_bin_id: string
  to_type: '' | 'bin' | 'buyer'
  to_bin_id: string
  to_buyer_id: string
  contract_id: string
  ticket_number: string
  practice: PracticeChoice
}

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}
function nowHHMM() {
  const d = new Date()
  return d.toTimeString().slice(0, 5)
}

function toForm(initial?: Partial<Load>): FormState {
  return {
    date: initial?.date ?? todayISO(),
    time: initial?.time ?? nowHHMM(),
    truck_id: initial?.truck_id ?? '',
    hauler_truck: initial?.hauler_truck ?? '',
    crop_id: initial?.crop_id ?? '',
    crop_year: initial?.crop_year != null ? String(initial.crop_year) : '',
    gross_weight: initial?.gross_weight?.toString() ?? '',
    tare_weight: initial?.tare_weight?.toString() ?? '',
    net_weight: initial?.net_weight?.toString() ?? '',
    moisture: initial?.moisture?.toString() ?? '',
    test_weight: initial?.test_weight?.toString() ?? '',
    dry_bushels_override: initial?.dry_bushels_override?.toString() ?? '',
    from_type: (initial?.from_type as any) ?? '',
    from_field_id: initial?.from_field_id ?? '',
    from_bin_id: initial?.from_bin_id ?? '',
    to_type: (initial?.to_type as any) ?? '',
    to_bin_id: initial?.to_bin_id ?? '',
    to_buyer_id: initial?.to_buyer_id ?? '',
    contract_id: initial?.contract_id ?? '',
    ticket_number: initial?.ticket_number ?? '',
    practice: (initial?.practice as PracticeChoice) ?? '',
  }
}

function num(s: string): number | null {
  if (s === '' || s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function fmt(n: number | null): string {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export default function LoadForm({ initial, initialSplits, mode }: Props) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [form, setForm] = useState<FormState>(toForm(initial))
  const [splitMode, setSplitMode] = useState<boolean>(() => (initialSplits?.length ?? 0) > 0)
  const [splitEntryMode, setSplitEntryMode] = useState<'weight' | 'percentage'>('weight')
  const [splits, setSplits] = useState<SplitRow[]>(() =>
    initialSplits && initialSplits.length > 0
      ? initialSplits.map((s) => ({
          field_id: s.field_id,
          weight: String(s.net_weight),
          practice: (s.practice as PracticeChoice) ?? '',
        }))
      : [],
  )
  // Tracks whether the user has manually typed into the last split row. When
  // false, the last row auto-fills as (total net − sum of earlier rows). On
  // edit-load (splits pre-populated), every row is user-set, so this is true.
  const [lastSplitManual, setLastSplitManual] = useState<boolean>(
    () => (initialSplits?.length ?? 0) > 0,
  )
  const [trucks, setTrucks] = useState<Truck[]>([])
  const [externalTrucks, setExternalTrucks] = useState<ExternalTruck[]>([])
  // "Save this truck" on a typed hauler truck — inserted on submit.
  const [saveHaulerTruck, setSaveHaulerTruck] = useState(false)
  const [crops, setCrops] = useState<Crop[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [farms, setFarms] = useState<Farm[]>([])
  const [bins, setBins] = useState<Bin[]>([])
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [plantings, setPlantings] = useState<FieldPlanting[]>([])
  const [refsLoaded, setRefsLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const submittingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  // "Save & New": set by the button's click (fires before submit), read once
  // after a successful save; the flash confirms the save without navigating.
  const saveAndNewRef = useRef(false)
  const [justSaved, setJustSaved] = useState<string | null>(null)
  const [tareRefresh, setTareRefresh] = useState(0)
  useEffect(() => {
    if (!justSaved) return
    const t = setTimeout(() => setJustSaved(null), 5000)
    return () => clearTimeout(t)
  }, [justSaved])
  // Last-load date default (create mode): which date the seam applied, and
  // whether the user touched the date before the default could land.
  const [defaultedDate, setDefaultedDate] = useState<string | null>(null)
  const dateTouchedRef = useRef(false)
  // Delivered-so-far (dry bushels) on the selected contract, for the fill
  // progress widget. Excludes the load being edited (added back live below).
  const [contractDelivered, setContractDelivered] = useState<{ dryBu: number; count: number } | null>(null)
  const [contractProgressLoading, setContractProgressLoading] = useState(false)
  // Bumped after each Save & New so the tracker refetches WITH the load just
  // saved — without it the delivered total was fetched once per contract
  // selection and overstated remaining for the rest of the session.
  const [contractRefresh, setContractRefresh] = useState(0)
  // The selected truck's tare history (lib/truck-tare) — feeds the low-tare
  // warning and the "Use last tare" shortcut. Keyed so a stale fetch for a
  // previously selected truck can't land on the current one.
  const [tareHistory, setTareHistory] = useState<{ key: string; loads: TareHistoryLoad[] } | null>(null)

  const isPickupForTare = !!form.contract_id && contracts.find((c) => c.id === form.contract_id)?.delivery_type === 'pickup'
  const tareKey = truckTareKey(isPickupForTare && !form.truck_id ? { hauler_truck: form.hauler_truck } : { truck_id: form.truck_id })
  useEffect(() => {
    if (!tareKey) { setTareHistory(null); return }
    let cancelled = false
    // Hauler names are typed freely — wait for a pause before asking.
    const delay = tareKey.startsWith('hauler:') ? 400 : 0
    const t = setTimeout(async () => {
      const loads = await fetchTruckTareHistory(
        supabase,
        tareKey.startsWith('own:') ? { truck_id: tareKey.slice(4) } : { hauler_truck: form.hauler_truck },
      )
      if (!cancelled) setTareHistory({ key: tareKey, loads })
    }, delay)
    return () => { cancelled = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tareKey, supabase, tareRefresh])
  const tareStats = useMemo(
    () => (tareHistory && tareHistory.key === tareKey
      ? truckTareStats(tareHistory.loads, tareKey, { excludeLoadId: mode === 'edit' ? initial?.id ?? null : null })
      : null),
    [tareHistory, tareKey, mode, initial?.id],
  )
  const tareWarning = lowTareWarning(num(form.tare_weight), tareStats)
  // "Use last tare" — a deliberate tap, never an auto-fill (weighing the
  // empty truck is the accurate path). Hidden when the field already holds it.
  const lastTareOffer =
    mode === 'create' && tareStats?.lastTare != null && num(form.tare_weight) !== tareStats.lastTare
      ? { tare: tareStats.lastTare, date: tareStats.lastTareDate }
      : null

  useEffect(() => {
    ;(async () => {
      const [t, c, f, fa, b, by, ct, pl, xt] = await Promise.all([
        supabase.from('trucks').select('*').order('name_or_number'),
        supabase.from('crops').select('*').order('name'),
        supabase.from('fields').select('*').order('name_or_number'),
        // Farms group the field picker and power its farm-name search.
        supabase.from('farms').select('*').order('name'),
        supabase.from('bins').select('*').order('name_or_number'),
        supabase.from('buyers').select('*').order('name'),
        fetchAllRows((f, t) => supabase.from('contracts').select('*').order('contract_number').order('id').range(f, t)),
        fetchAllRows((f, t) => supabase.from('field_plantings').select('*').order('id').range(f, t)),
        // Saved hauler trucks for pickup contracts. Tolerates a missing table
        // (067 not applied yet) — the picker just offers free text.
        supabase.from('external_trucks').select('*').order('name'),
      ])
      setTrucks((t.data as Truck[]) || [])
      setExternalTrucks((xt.data as ExternalTruck[]) || [])
      setCrops((c.data as Crop[]) || [])
      setFields((f.data as Field[]) || [])
      setFarms((fa.data as Farm[]) || [])
      setBins((b.data as Bin[]) || [])
      setBuyers((by.data as Buyer[]) || [])
      setContracts((ct.data as Contract[]) || [])
      setPlantings((pl.data as FieldPlanting[]) || [])
      setRefsLoaded(true)
    })()
  }, [supabase])

  // On create, pre-fill date + crop + from/to + contract selections from the
  // most recently ENTERED load (lib/load-defaults — the one seam for every
  // source/destination shape, bin→buyer included; transfers skipped).
  useEffect(() => {
    if (mode !== 'create' || !refsLoaded) return
    ;(async () => {
      // created_at, not the load's date: a session resumed the next morning
      // must key off last night's entries. limit(10) leaves room to skip
      // bin→bin transfer rows.
      //
      // PER-USER (073): my own last-entered load wins — two people entering
      // different load types must not stomp each other's pre-fills. The org
      // tier is the fallback when I have no loads yet (or when created_by
      // isn't applied yet — the mine-query errors and we degrade to org).
      const { data: { user } } = await supabase.auth.getUser()
      let mine: LastLoadDefaultsSource[] = []
      if (user?.id) {
        const res = await supabase
          .from('loads')
          .select(LAST_LOAD_DEFAULTS_SELECT)
          .eq('created_by', user.id)
          .order('created_at', { ascending: false })
          .limit(10)
        if (!res.error) mine = (res.data ?? []) as LastLoadDefaultsSource[]
      }
      let org: LastLoadDefaultsSource[] = []
      if (pickLastLoadDefaults(mine) == null) {
        const { data } = await supabase
          .from('loads')
          .select(LAST_LOAD_DEFAULTS_SELECT)
          .order('created_at', { ascending: false })
          .limit(10)
        org = (data ?? []) as LastLoadDefaultsSource[]
      }
      const recent = pickPerUserLastLoadDefaults({ mine, org })
      if (!recent) return
      const dateUntouched = !dateTouchedRef.current
      if (dateUntouched && recent.date) setDefaultedDate(recent.date)
      setForm((f) => applyLastLoadDefaults(f, recent, { dateUntouched }).form)
    })()
  }, [refsLoaded, mode, supabase])

  // Auto-compute net = gross - tare whenever either changes (user can still override).
  useEffect(() => {
    const g = num(form.gross_weight)
    const t = num(form.tare_weight)
    if (g != null && t != null) {
      const net = +(g - t).toFixed(2)
      setForm((f) => (f.net_weight === String(net) ? f : { ...f, net_weight: String(net) }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.gross_weight, form.tare_weight])

  const selectedCrop = crops.find((c) => c.id === form.crop_id)
  const { wetBushels, dryBushels, computedDryBushels, overridden } = computeBushels({
    netWeightLb: num(form.net_weight),
    moisturePct: num(form.moisture),
    baseMoisturePct: selectedCrop?.base_moisture_pct ?? null,
    baseLbPerBushel: selectedCrop?.base_lb_per_bushel ?? null,
    dryBushelsOverride: num(form.dry_bushels_override),
  })
  const shrinkBu =
    wetBushels != null && dryBushels != null ? wetBushels - dryBushels : null

  // Contracts must match the picked buyer + crop AND the picked crop year.
  // When no crop year is picked yet, show no contracts (the dropdown asks for
  // a year first) so users don't accidentally attach a load to the wrong year.
  const cropYearNum = form.crop_year === '' ? null : Number(form.crop_year)
  const buyerContracts =
    cropYearNum == null
      ? []
      : contracts.filter(
          (c) =>
            (!form.to_buyer_id || c.buyer_id === form.to_buyer_id) &&
            (!form.crop_id || c.crop_id === form.crop_id) &&
            c.crop_year === cropYearNum
        )

  const cropById = useMemo(() => new Map(crops.map((c) => [c.id, c])), [crops])
  const buyerName = (id: string | null) => (id ? buyers.find((b) => b.id === id)?.name ?? '' : '')
  const selectedContract = contracts.find((c) => c.id === form.contract_id) ?? null
  // Pickup contract: the buyer's trucks load at the farm, so the Truck field
  // switches to the hauler-truck flow (free text + saved external trucks).
  const isPickup = selectedContract?.delivery_type === 'pickup'

  // Fetch the contract's delivered dry bushels whenever the selection changes
  // — and again after every Save & New (contractRefresh), so loads saved
  // earlier in THIS session always count. A mid-session contract switch takes
  // the contract_id branch and fetches that contract's true current total.
  useEffect(() => {
    if (!form.contract_id) { setContractDelivered(null); return }
    let cancelled = false
    setContractProgressLoading(true)
    ;(async () => {
      let q = supabase
        .from('loads')
        .select('id, net_weight, moisture, crop_id, dry_bushels_override')
        .eq('contract_id', form.contract_id)
      if (mode === 'edit' && initial?.id) q = q.neq('id', initial.id)
      const { data } = await q
      if (cancelled) return
      setContractDelivered(contractDeliveredTotals((data ?? []) as Parameters<typeof contractDeliveredTotals>[0], cropById))
      setContractProgressLoading(false)
    })()
    return () => { cancelled = true }
  }, [form.contract_id, mode, initial?.id, supabase, cropById, contractRefresh])

  // Contract fill progress: delivered + this (unsaved/edited) load vs contracted.
  const contractTotal = selectedContract ? Number(selectedContract.contracted_bushels) : 0
  const deliveredBu = contractDelivered?.dryBu ?? 0
  const thisLoadBu = dryBushels ?? 0
  const { projectedBu, remainingBu, pctDelivered, pctThisLoad } = contractProgress({
    contractedBu: contractTotal,
    deliveredBu,
    thisLoadBu,
  })

  // Only hide bins designated to a DIFFERENT crop; undesignated bins always
  // show. Filtering undesignated bins out looked harmless, but it wiped the
  // last-load defaults on bin-source loads: the seam would set crop +
  // from_bin together, then the selection-drop effect below cleared the bin
  // because an undesignated bin never matched the crop — the reason bin→buyer
  // loads came up with an empty From while field-source defaults (backed by
  // plantings) survived.
  const filteredBins = useMemo(() => {
    if (!form.crop_id) return bins
    return bins.filter((b) => b.crop_id == null || b.crop_id === form.crop_id)
  }, [bins, form.crop_id])

  // Only show fields with a planting that matches BOTH the selected crop and
  // the selected crop year. Filtering on crop alone surfaced last year's wheat
  // fields when entering 2026 wheat loads.
  const filteredFields = useMemo(() => {
    if (!form.crop_id) return fields
    const yearNum = form.crop_year === '' ? null : Number(form.crop_year)
    const plantedFieldIds = new Set(
      plantings
        .filter((p) => p.crop_id === form.crop_id && (yearNum == null || p.season_year === yearNum))
        .map((p) => p.field_id),
    )
    return fields.filter((f) => plantedFieldIds.has(f.id))
  }, [fields, plantings, form.crop_id, form.crop_year])

  // Planting for a field under the selected crop (+ crop year when picked).
  // Used to detect mixed-practice fields: only those get the optional
  // Irrigated/Dryland toggle — a pure field's practice is implied by its
  // planting, so we never ask.
  const plantingFor = (fieldId: string): FieldPlanting | null => {
    if (!fieldId || !form.crop_id) return null
    const matches = plantings.filter(
      (p) =>
        p.field_id === fieldId &&
        p.crop_id === form.crop_id &&
        (cropYearNum == null || p.season_year === cropYearNum),
    )
    if (matches.length === 0) return null
    return matches.sort((a, b) => b.season_year - a.season_year)[0]
  }
  const isMixedField = (fieldId: string): boolean => {
    const p = plantingFor(fieldId)
    return p != null && practiceOf(p) === 'mixed'
  }

  const seasonYearOptions = useMemo(
    () =>
      cropYearOptionsFromPlantings(
        plantings.map((p) => p.season_year),
        form.crop_year === '' ? null : Number(form.crop_year),
      ),
    [plantings, form.crop_year],
  )

  // Drop any previously selected field/bin that no longer matches the crop filter.
  useEffect(() => {
    if (!refsLoaded) return
    setForm((f) => {
      const next = { ...f }
      if (next.from_field_id && !filteredFields.some((x) => x.id === next.from_field_id)) next.from_field_id = ''
      if (next.from_bin_id && !filteredBins.some((x) => x.id === next.from_bin_id)) next.from_bin_id = ''
      if (next.to_bin_id && !filteredBins.some((x) => x.id === next.to_bin_id)) next.to_bin_id = ''
      return next
    })
  }, [refsLoaded, filteredFields, filteredBins])


  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  // Changing a From/To *type* re-defaults the whole from/to combination from
  // the last load that used it (for the selected crop) — the same idea as
  // seeding a new load from the most recent one, but keyed to the combination
  // the user just switched to. E.g. flipping a field→bin load over to
  // bin→buyer pulls in the source bin + buyer (and contract) from the most
  // recent bin→buyer load. Create-mode only: in edit mode the toggle just
  // changes the type so we never clobber an existing record's selections.
  async function applyTypeChange(next: { from_type?: FormState['from_type']; to_type?: FormState['to_type'] }) {
    if (mode !== 'create') {
      setForm((f) => ({ ...f, ...next }))
      return
    }
    const fromType = next.from_type ?? form.from_type
    const toType = next.to_type ?? form.to_type
    // Reflect the toggle immediately; the lookup below fills in the details.
    setForm((f) => ({ ...f, ...next }))

    let q = supabase
      .from('loads')
      .select('from_field_id, from_bin_id, to_bin_id, to_buyer_id, contract_id')
      // Entry order, matching the last-load defaults seam.
      .order('created_at', { ascending: false })
      .limit(1)
    if (form.crop_id) q = q.eq('crop_id', form.crop_id)
    if (fromType) q = q.eq('from_type', fromType)
    if (toType) q = q.eq('to_type', toType)
    const { data } = await q
    const match = data?.[0] as {
      from_field_id: string | null
      from_bin_id: string | null
      to_bin_id: string | null
      to_buyer_id: string | null
      contract_id: string | null
    } | undefined
    if (!match) return

    // Contracts are crop-year specific; only carry the matched load's contract
    // if it belongs to the year selected here (the match may be a prior year).
    const yearNum = form.crop_year === '' ? null : Number(form.crop_year)
    const contractOk =
      !!match.contract_id &&
      contracts.some((c) => c.id === match.contract_id && (yearNum == null || c.crop_year === yearNum))

    setForm((f) => ({
      ...f,
      from_field_id: fromType === 'field' ? (match.from_field_id ?? '') : '',
      from_bin_id: fromType === 'bin' ? (match.from_bin_id ?? '') : '',
      to_bin_id: toType === 'bin' ? (match.to_bin_id ?? '') : '',
      to_buyer_id: toType === 'buyer' ? (match.to_buyer_id ?? '') : '',
      contract_id: toType === 'buyer' && contractOk ? (match.contract_id ?? '') : '',
    }))
  }

  // First time the user activates Split Load with no prior split rows, seed
  // two rows — prefilling row 1 with the currently selected field when there
  // is one (so conversion in edit mode doesn't drop the existing field).
  useEffect(() => {
    if (!splitMode) return
    if (splits.length > 0) return
    setSplits([
      { field_id: form.from_field_id || '', weight: '', practice: form.practice },
      { field_id: '', weight: '', practice: '' },
    ])
    setLastSplitManual(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitMode])

  // If the crop or crop year changes (which narrows filteredFields), clear
  // any split row whose selected field no longer qualifies.
  useEffect(() => {
    if (!splitMode) return
    setSplits((rs) =>
      rs.map((r) =>
        r.field_id && !filteredFields.some((f) => f.id === r.field_id)
          ? { ...r, field_id: '' }
          : r,
      ),
    )
  }, [splitMode, filteredFields])

  const totalNetLb = num(form.net_weight) ?? 0
  const splitParsedWeights = splits.map((s) => num(s.weight) ?? 0)
  function displayedSplitWeight(i: number): string {
    if (i < splits.length - 1) return splits[i].weight
    if (lastSplitManual) return splits[i].weight
    const otherSum = splitParsedWeights.reduce(
      (a, v, j) => (j === splits.length - 1 ? a : a + v),
      0,
    )
    const remaining = totalNetLb - otherSum
    if (!(remaining > 0)) return ''
    return String(Math.round(remaining * 100) / 100)
  }
  function resolvedSplitWeight(i: number): number {
    return num(displayedSplitWeight(i)) ?? 0
  }
  function displayedSplitPct(i: number): string {
    if (totalNetLb <= 0) return ''
    const w = resolvedSplitWeight(i)
    return String(Math.round((w / totalNetLb) * 1000) / 10)
  }
  function setSplitWeight(i: number, weight: string) {
    setSplits((rs) => rs.map((r, j) => (i === j ? { ...r, weight } : r)))
    if (i === splits.length - 1) setLastSplitManual(true)
  }
  function setSplitPct(i: number, pct: string) {
    if (pct === '') {
      setSplitWeight(i, '')
      return
    }
    const p = Number(pct)
    if (!Number.isFinite(p)) return
    const w = totalNetLb * (p / 100)
    setSplitWeight(i, w > 0 ? String(Math.round(w * 100) / 100) : '')
  }
  function setSplitField(i: number, field_id: string) {
    setSplits((rs) => rs.map((r, j) => (i === j ? { ...r, field_id, practice: '' } : r)))
  }
  function setSplitPractice(i: number, practice: PracticeChoice) {
    setSplits((rs) => rs.map((r, j) => (i === j ? { ...r, practice } : r)))
  }
  function addSplit() {
    setSplits((rs) => [...rs, { field_id: '', weight: '', practice: '' }])
    setLastSplitManual(false)
  }
  function removeSplit(i: number) {
    if (splits.length <= 2) return
    setSplits((rs) => rs.filter((_, j) => j !== i))
    setLastSplitManual(false)
  }

  const splitsResolved: SplitDraft[] = splits.map((s, i) => ({
    field_id: s.field_id,
    net_weight: resolvedSplitWeight(i),
    practice: isMixedField(s.field_id) ? s.practice || null : null,
  }))
  const splitTotalLb = splitsResolved.reduce((a, d) => a + d.net_weight, 0)
  const splitTotalPct = totalNetLb > 0 ? (splitTotalLb / totalNetLb) * 100 : 0
  const splitError = splitMode ? validateSplitDrafts(splitsResolved, totalNetLb) : null

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Synchronous guard against double-submit (iPad double-tap, double-click,
    // Enter+tap). React's `busy` state only disables the button on the next
    // render, so without this a second tap a few ms later passes through and
    // we get duplicate inserts.
    if (submittingRef.current) return

    // Block save when split rows don't add up (or any other split-level
    // validation fails). Run this BEFORE flipping the busy state so the UI
    // doesn't briefly grey out for a save that won't proceed.
    const useSplits = splitMode && form.from_type === 'field'
    if (useSplits) {
      const err = validateSplitDrafts(splitsResolved, totalNetLb)
      if (err) {
        setError(err)
        return
      }
    }

    submittingRef.current = true
    setBusy(true)
    setError(null)

    const payload = {
      date: form.date,
      time: form.time || null,
      truck_id: form.truck_id || null,
      // Snapshot of the truck's name at save time (071) — past loads keep
      // displaying it even if the truck is later renamed. Editing a load
      // without changing its truck keeps the label as originally entered.
      truck_label: truckLabelForSave({
        truckId: form.truck_id || null,
        trucks,
        prior: mode === 'edit' && initial
          ? { truck_id: initial.truck_id ?? null, truck_label: initial.truck_label ?? null }
          : null,
      }),
      // Hauler truck only makes sense on a pickup contract; switching the
      // load to a delivered contract clears it (classification rule).
      hauler_truck: isPickup ? form.hauler_truck.trim() || null : null,
      crop_id: form.crop_id || null,
      crop_year: form.crop_year === '' ? null : Number(form.crop_year),
      gross_weight: num(form.gross_weight),
      tare_weight: num(form.tare_weight),
      net_weight: num(form.net_weight),
      moisture: num(form.moisture),
      test_weight: num(form.test_weight),
      bushels: null, // derived at read time from net_weight + moisture + crop base values
      dry_bushels_override: num(form.dry_bushels_override),
      from_type: form.from_type || null,
      // Split loads aggregate across fields — clear the single field pointer.
      from_field_id: useSplits
        ? null
        : form.from_type === 'field'
        ? form.from_field_id || null
        : null,
      from_bin_id: form.from_type === 'bin' ? form.from_bin_id || null : null,
      to_type: form.to_type || null,
      to_bin_id: form.to_type === 'bin' ? form.to_bin_id || null : null,
      to_buyer_id: form.to_type === 'buyer' ? form.to_buyer_id || null : null,
      contract_id: form.to_type === 'buyer' ? form.contract_id || null : null,
      ticket_number: form.ticket_number || null,
      // Only mixed-practice fields carry a designation; pure fields imply it.
      practice:
        !useSplits && form.from_type === 'field' && isMixedField(form.from_field_id)
          ? form.practice || null
          : null,
    }

    // "Save this truck" on a pickup load → external_trucks (NEVER the org's
    // own trucks — see the classification rule in components/truck-picker).
    // Runs BEFORE the load insert so a failure is VISIBLE and retryable
    // without duplicating the load; the free text on the load itself is
    // unaffected either way. org_id stamped from the session (054 WITH CHECK).
    if (isPickup && saveHaulerTruck && form.hauler_truck.trim() && !findExternalTruck(externalTrucks, form.hauler_truck)) {
      const orgId = await getOrgId(supabase)
      const { error: xtErr } = await supabase
        .from('external_trucks')
        .insert(externalTruckInsert(form.hauler_truck, selectedContract?.buyer_id ?? null, orgId))
      if (xtErr) {
        submittingRef.current = false
        setBusy(false)
        setError(`Couldn’t save the hauler truck for future loads: ${xtErr.message}. The load was not saved — try again, or untick “Save this truck”.`)
        return
      }
    }

    let savedLoadId: string | null = null
    let err: { message: string } | null = null
    if (mode === 'create') {
      // Stamp who entered it (073 — powers the per-user last-load defaults).
      // If created_by isn't applied yet the insert retries without it, so a
      // late migration apply degrades to org-level defaults, never a failure.
      const { data: { user } } = await supabase.auth.getUser()
      let res = user?.id
        ? await supabase.from('loads').insert({ ...payload, created_by: user.id }).select('id').single()
        : await supabase.from('loads').insert(payload).select('id').single()
      if (res.error && user?.id && res.error.message.includes('created_by')) {
        res = await supabase.from('loads').insert(payload).select('id').single()
      }
      err = res.error
      savedLoadId = (res.data as { id: string } | null)?.id ?? null
    } else if (initial?.id) {
      const res = await supabase.from('loads').update(payload).eq('id', initial.id)
      err = res.error
      savedLoadId = initial.id
    }

    if (err) {
      submittingRef.current = false
      setBusy(false)
      setError(err.message)
      return
    }

    // Persist splits. Edit mode wipes any existing rows first so removed
    // splits don't linger, then re-inserts the current set. When the user
    // converted a split load back to single-field, useSplits is false and we
    // only do the delete.
    if (savedLoadId) {
      if (mode === 'edit') {
        const { error: delErr } = await supabase
          .from('load_splits')
          .delete()
          .eq('load_id', savedLoadId)
        if (delErr) {
          submittingRef.current = false
          setBusy(false)
          setError(`Saved load but couldn’t update splits: ${delErr.message}`)
          return
        }
      }
      if (useSplits && payload.crop_id) {
        const allocated = allocateSplits(
          {
            crop_id: payload.crop_id,
            net_weight: payload.net_weight ?? 0,
            moisture: payload.moisture,
          },
          splitsResolved,
          selectedCrop ?? null,
        )
        const rows = allocated.map((a) => ({ ...a, load_id: savedLoadId }))
        const { error: insErr } = await supabase.from('load_splits').insert(rows)
        if (insErr) {
          submittingRef.current = false
          setBusy(false)
          setError(`Saved load but couldn’t save splits: ${insErr.message}`)
          return
        }
      }
    }
    // Back-fill load_id on any settlement line that was waiting on this load's
    // ticket (e.g. the settlement was entered before the load, or the ticket
    // was just corrected here). Best-effort: the load already saved, and the
    // settlement views resolve unmatched lines by ticket at read time, so a
    // failure here isn't worth blocking navigation over.
    if (savedLoadId) {
      try {
        await relinkSettlementLinesForLoad(supabase, {
          id: savedLoadId,
          to_type: payload.to_type,
          to_buyer_id: payload.to_buyer_id,
          ticket_number: payload.ticket_number,
        })
      } catch {
        /* ignore — view-time resolution still covers display */
      }
    }

    rememberHarvestEntryPath('load')

    // "Save & New" — stay on the form for the next load of the session.
    if (mode === 'create' && saveAndNewRef.current) {
      saveAndNewRef.current = false
      startNextLoad(payload.ticket_number)
      return
    }

    // Leave submittingRef = true; we're navigating away. Resetting it here
    // would briefly re-enable the button before the route change commits.
    router.push('/loads')
    router.refresh()
  }

  // Present a fresh form immediately after "Save & New". The session fields
  // (date/crop/year/from/to/contract — exactly what the defaults seam seeds)
  // stay as they are: the load just saved is now MY latest load, so keeping
  // them equals re-running the seam without a refetch. The per-load fields —
  // weights, moisture, test weight, ticket, time, AND THE TRUCK — clear
  // (saveAndNewPatch): consecutive harvest loads rotate between trucks, so an
  // inherited truck silently writes wrong-truck records.
  function startNextLoad(ticket: string | null) {
    setForm((f) => ({ ...f, ...saveAndNewPatch(nowHHMM()) }))
    // Splits describe the load just saved, not the next one.
    setSplitMode(false)
    setSplits([])
    setLastSplitManual(false)
    setSaveHaulerTruck(false)
    setJustSaved(ticket ? `Saved — ticket ${ticket}` : 'Load saved')
    setTareRefresh((n) => n + 1) // the saved tare joins the truck's baseline
    setContractRefresh((n) => n + 1) // the tracker recounts WITH the saved load
    submittingRef.current = false
    setBusy(false)
    setError(null)
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base bg-white'
  const labelCls = 'block text-sm text-slate-700'

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <h1 className="text-2xl font-bold">{mode === 'create' ? 'New Load' : 'Edit Load'}</h1>

      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          Date
          <input
            type="date"
            required
            value={form.date}
            onChange={(e) => { dateTouchedRef.current = true; set('date', e.target.value) }}
            className={inputCls}
          />
          {(() => {
            // A next-morning session must never silently land on today: while
            // the field holds a defaulted date that isn't today, say so.
            const note = dateDefaultNote(defaultedDate, todayISO(), form.date)
            return note ? <span className="mt-1 block text-xs text-amber-700">{note}</span> : null
          })()}
        </label>
        <label className={labelCls}>
          Time
          <input type="time" value={form.time} onChange={(e) => set('time', e.target.value)} className={inputCls} />
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={labelCls}>
          Truck
          {isPickup ? (
            <div className="mt-1">
              <HaulerTruckField
                haulerTruck={form.hauler_truck}
                truckId={form.truck_id}
                onChangeHauler={(v) => set('hauler_truck', v)}
                onChangeTruckId={(v) => set('truck_id', v)}
                externalTrucks={externalTrucks}
                trucks={trucks}
                saveTruck={saveHaulerTruck}
                onChangeSaveTruck={setSaveHaulerTruck}
                onExternalUpdated={(t) =>
                  setExternalTrucks((xs) => xs.map((x) => (x.id === t.id ? t : x)).sort((a, b) => a.name.localeCompare(b.name)))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base bg-white"
              />
            </div>
          ) : (
            <TruckPicker
              value={form.truck_id}
              onChange={(id) => set('truck_id', id)}
              trucks={trucks}
              onCreated={(t) =>
                setTrucks((ts) => [...ts, t].sort((a, b) => a.name_or_number.localeCompare(b.name_or_number)))
              }
              onUpdated={(t) =>
                setTrucks((ts) => ts.map((x) => (x.id === t.id ? t : x)).sort((a, b) => a.name_or_number.localeCompare(b.name_or_number)))
              }
              className={inputCls}
            />
          )}
        </label>
        <label className={labelCls}>
          Crop
          <select value={form.crop_id} onChange={(e) => set('crop_id', e.target.value)} className={inputCls}>
            <option value="">— select —</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>

      <label className={labelCls}>
        Crop year <span className="text-xs text-slate-400">from set-up seasons</span>
        <select
          value={form.crop_year}
          onChange={(e) => setForm((f) => ({ ...f, crop_year: e.target.value, contract_id: '' }))}
          className={inputCls}
        >
          <option value="">— select —</option>
          {seasonYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </label>

      <fieldset className="border border-slate-200 rounded-xl p-3 space-y-3">
        <legend className="px-2 text-sm font-semibold">From</legend>
        <div className="flex gap-2">
          {(['field', 'bin'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => applyTypeChange({ from_type: t })}
              className={`flex-1 py-2 rounded-lg border ${
                form.from_type === t ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white'
              }`}
            >
              {t === 'field' ? 'Field' : 'Bin'}
            </button>
          ))}
        </div>
        {form.from_type === 'field' && !splitMode && (
          <>
            <FieldPicker
              value={form.from_field_id}
              onChange={(id) => setForm((f) => ({ ...f, from_field_id: id, practice: '' }))}
              fields={filteredFields}
              farms={farms}
              className={inputCls}
            />
            {form.crop_id && filteredFields.length === 0 && (
              <p className="text-xs text-amber-700">
                No fields have a planting recorded for this crop. Add one under Settings → Field Plantings.
              </p>
            )}
            {isMixedField(form.from_field_id) && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 space-y-1">
                <span className="text-xs text-slate-600">
                  This field has both irrigated and dryland acres. Tag the load if you know — optional.
                </span>
                <div className="flex gap-2">
                  {(['irrigated', 'dryland'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => set('practice', form.practice === p ? '' : p)}
                      className={`flex-1 py-2 rounded-lg border text-sm ${
                        form.practice === p ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white'
                      }`}
                    >
                      {p === 'irrigated' ? 'Irrigated' : 'Dryland'}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => setSplitMode(true)}
              className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2 w-full sm:w-auto"
            >
              Split load across multiple fields
            </button>
          </>
        )}
        {form.from_type === 'field' && splitMode && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-700 flex-1">
                Split across {splits.length} field{splits.length === 1 ? '' : 's'}
              </span>
              <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
                {(['weight', 'percentage'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSplitEntryMode(m)}
                    className={`px-3 py-2 text-sm ${splitEntryMode === m ? 'bg-brand hover:bg-brand-deep text-white' : 'bg-white'}`}
                  >
                    {m === 'weight' ? 'By weight' : 'By percentage'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setSplitMode(false)}
                className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
              >
                Use single field
              </button>
            </div>

            {splitEntryMode === 'percentage' && totalNetLb <= 0 && (
              <p className="text-xs text-amber-700">
                Enter the load’s net weight above before allocating by percentage.
              </p>
            )}

            {splits.map((row, i) => {
              const isLast = i === splits.length - 1
              const weightVal = displayedSplitWeight(i)
              const pctVal = displayedSplitPct(i)
              const isAutoFilled = isLast && !lastSplitManual && !!weightVal
              return (
                <div key={i} className="rounded-lg border border-slate-200 p-2 space-y-2 bg-slate-50">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 w-16">Field {i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <FieldPicker
                        value={row.field_id}
                        onChange={(id) => setSplitField(i, id)}
                        fields={filteredFields}
                        farms={farms}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base bg-white"
                      />
                    </div>
                    {splits.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeSplit(i)}
                        className="text-red-600 text-sm px-2"
                        aria-label="Remove split"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {splitEntryMode === 'weight' ? (
                      <>
                        <label className="text-xs text-slate-500 w-16">Net lb</label>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          value={weightVal}
                          onChange={(e) => setSplitWeight(i, e.target.value)}
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-base bg-white"
                          placeholder={isAutoFilled ? 'auto' : ''}
                        />
                        <span className="text-xs text-slate-500 w-20 text-right">
                          {pctVal ? `${pctVal}%` : ''}
                        </span>
                      </>
                    ) : (
                      <>
                        <label className="text-xs text-slate-500 w-16">%</label>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          value={pctVal}
                          onChange={(e) => setSplitPct(i, e.target.value)}
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-base bg-white"
                          disabled={totalNetLb <= 0}
                        />
                        <span className="text-xs text-slate-500 w-24 text-right font-mono">
                          {weightVal ? `${Number(weightVal).toLocaleString()} lb` : ''}
                        </span>
                      </>
                    )}
                  </div>
                  {isAutoFilled && (
                    <p className="text-[11px] text-slate-500">Auto-filled from remainder — type a value to override.</p>
                  )}
                  {isMixedField(row.field_id) && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500 w-16">Irr / dry</span>
                      <div className="flex gap-2 flex-1">
                        {(['irrigated', 'dryland'] as const).map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setSplitPractice(i, row.practice === p ? '' : p)}
                            className={`flex-1 py-1.5 rounded-lg border text-sm ${
                              row.practice === p ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white'
                            }`}
                          >
                            {p === 'irrigated' ? 'Irrigated' : 'Dryland'}
                          </button>
                        ))}
                      </div>
                      <span className="text-[11px] text-slate-400 w-14 text-right">optional</span>
                    </div>
                  )}
                </div>
              )
            })}

            <button
              type="button"
              onClick={addSplit}
              className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2"
            >
              + Add another field
            </button>

            <div className={`rounded-lg p-2 text-sm ${splitError ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-700'}`}>
              <div className="flex justify-between font-mono">
                <span>Total:</span>
                <span>
                  {splitTotalLb.toLocaleString(undefined, { maximumFractionDigits: 0 })} / {totalNetLb.toLocaleString(undefined, { maximumFractionDigits: 0 })} lb
                  {' · '}
                  {splitTotalPct.toFixed(1)}%
                </span>
              </div>
              {splitError && <div className="mt-1 text-xs">{splitError}</div>}
            </div>
          </div>
        )}
        {form.from_type === 'bin' && (
          <>
            <select value={form.from_bin_id} onChange={(e) => set('from_bin_id', e.target.value)} className={inputCls}>
              <option value="">— select bin —</option>
              {filteredBins.map((b) => <option key={b.id} value={b.id}>{b.name_or_number}</option>)}
            </select>
            {form.crop_id && filteredBins.length === 0 && (
              <p className="text-xs text-amber-700">
                No bins are assigned to this crop. Assign one under Settings → Bins.
              </p>
            )}
          </>
        )}
      </fieldset>

      <fieldset className="border border-slate-200 rounded-xl p-3 space-y-3">
        <legend className="px-2 text-sm font-semibold">To</legend>
        <div className="flex gap-2">
          {(['bin', 'buyer'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => applyTypeChange({ to_type: t })}
              className={`flex-1 py-2 rounded-lg border ${
                form.to_type === t ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white'
              }`}
            >
              {t === 'bin' ? 'Bin' : 'Buyer'}
            </button>
          ))}
        </div>
        {form.to_type === 'bin' && (
          <>
            <select value={form.to_bin_id} onChange={(e) => set('to_bin_id', e.target.value)} className={inputCls}>
              <option value="">— select bin —</option>
              {filteredBins.map((b) => <option key={b.id} value={b.id}>{b.name_or_number}</option>)}
            </select>
            {form.crop_id && filteredBins.length === 0 && (
              <p className="text-xs text-amber-700">
                No bins are assigned to this crop. Assign one under Settings → Bins.
              </p>
            )}
          </>
        )}
        {form.to_type === 'buyer' && (
          <>
            <select value={form.to_buyer_id} onChange={(e) => { set('to_buyer_id', e.target.value); set('contract_id', '') }} className={inputCls}>
              <option value="">— select buyer —</option>
              {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <label className={labelCls}>
              Contract (filtered to buyer + crop + crop year)
              <select
                value={form.contract_id}
                onChange={(e) => set('contract_id', e.target.value)}
                className={inputCls}
                disabled={cropYearNum == null}
              >
                <option value="">
                  {cropYearNum == null ? 'Select crop year first' : '— none —'}
                </option>
                {buyerContracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.contract_number} · {buyerName(c.buyer_id)} · {Number(c.contracted_bushels).toLocaleString()} bu
                  </option>
                ))}
              </select>
            </label>

            {selectedContract && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="flex justify-between items-baseline flex-wrap gap-x-4 text-sm">
                  <span className="font-semibold text-slate-700">
                    #{selectedContract.contract_number} · {buyerName(selectedContract.buyer_id)}
                  </span>
                  <span className="font-mono text-slate-600">{contractTotal.toLocaleString()} bu contracted</span>
                </div>
                <div className="h-3 w-full rounded-full bg-slate-200 overflow-hidden flex">
                  <div className="bg-green-600 h-full" style={{ width: `${pctDelivered}%` }} title="Delivered" />
                  {pctThisLoad > 0 && <div className="bg-green-300 h-full" style={{ width: `${pctThisLoad}%` }} title="This load" />}
                </div>
                <div className="flex justify-between flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span className="text-slate-600">
                    Delivered <span className="font-mono font-semibold text-slate-800">{Math.round(deliveredBu).toLocaleString()}</span> bu
                    {contractDelivered && <span className="text-slate-400"> · {contractDelivered.count} load{contractDelivered.count === 1 ? '' : 's'}</span>}
                    {contractProgressLoading && <span className="text-slate-400"> · updating…</span>}
                  </span>
                  {thisLoadBu > 0 && (
                    <span className="text-green-700">+{Math.round(thisLoadBu).toLocaleString()} bu this load → {Math.round(projectedBu).toLocaleString()} bu</span>
                  )}
                  <span className={remainingBu < 0 ? 'text-amber-700 font-semibold' : 'text-slate-600'}>
                    {remainingBu >= 0
                      ? <>Remaining <span className="font-mono font-semibold">{Math.round(remainingBu).toLocaleString()}</span> bu</>
                      : <>Over by <span className="font-mono font-semibold">{Math.round(-remainingBu).toLocaleString()}</span> bu</>}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          Gross (lb)
          <input type="number" inputMode="decimal" step="0.01" value={form.gross_weight} onChange={(e) => set('gross_weight', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          <span className="flex items-baseline justify-between gap-2">
            <span>Tare (lb)</span>
            {lastTareOffer && (
              <button
                type="button"
                onClick={() => set('tare_weight', String(lastTareOffer.tare))}
                title={lastTareOffer.date ? `From this truck's last load on ${new Date(lastTareOffer.date + 'T00:00:00').toLocaleDateString()}` : "From this truck's last load"}
                className="shrink-0 rounded-lg border border-brand/60 bg-white px-2.5 py-1.5 text-xs font-semibold text-brand-deep hover:bg-brand/10 active:bg-brand/20 whitespace-nowrap"
              >
                Use last tare: {Math.round(lastTareOffer.tare).toLocaleString()}
              </button>
            )}
          </span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={form.tare_weight}
            onChange={(e) => set('tare_weight', e.target.value)}
            aria-describedby={tareWarning ? 'tare-warning' : undefined}
            className={`${inputCls} ${tareWarning ? 'border-amber-400 bg-amber-50' : ''}`}
          />
          {tareWarning && (
            <span id="tare-warning" role="status" className="mt-1 block text-xs font-normal text-amber-800">
              {tareWarning}
            </span>
          )}
        </label>
        <label className={labelCls}>
          Net (lb) <span className="text-xs text-slate-400">auto</span>
          <input type="number" inputMode="decimal" step="0.01" value={form.net_weight} onChange={(e) => set('net_weight', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Moisture %
          <input type="number" inputMode="decimal" step="0.01" value={form.moisture} onChange={(e) => set('moisture', e.target.value)} className={inputCls} />
        </label>
        <label className={labelCls}>
          Test Weight
          <input type="number" inputMode="decimal" step="0.01" value={form.test_weight} onChange={(e) => set('test_weight', e.target.value)} className={inputCls} />
        </label>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
        <div className="text-sm font-semibold text-slate-700">
          Bushels {selectedCrop ? `— base ${selectedCrop.base_moisture_pct ?? '?'}% MC, ${selectedCrop.base_lb_per_bushel ?? '?'} lb/bu` : ''}
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-xs text-slate-500">Wet</div>
            <div className="font-mono text-lg">{fmt(wetBushels)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Dry (auto)</div>
            <div className="font-mono text-lg">{fmt(computedDryBushels)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Shrink</div>
            <div className="font-mono text-lg">{fmt(shrinkBu)}</div>
          </div>
        </div>

        <div className="flex items-end gap-2 flex-wrap">
          <label className="text-sm text-slate-700 flex-1 min-w-[10rem]">
            Dry bushels override <span className="text-xs text-slate-400">optional</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={form.dry_bushels_override}
              onChange={(e) => set('dry_bushels_override', e.target.value)}
              placeholder={computedDryBushels != null ? fmt(computedDryBushels) : ''}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base bg-white"
            />
          </label>
          {form.dry_bushels_override !== '' && (
            <button
              type="button"
              onClick={() => set('dry_bushels_override', '')}
              className="rounded-lg bg-white border border-slate-300 px-3 py-3 text-sm"
            >
              Clear
            </button>
          )}
        </div>

        <div className="text-sm">
          <span className="text-slate-500">Used for reports: </span>
          <span className="font-mono font-semibold">{fmt(dryBushels)} bu</span>
          {overridden && <span className="text-amber-700 text-xs ml-2">(manual override)</span>}
        </div>

        {selectedCrop && selectedCrop.base_lb_per_bushel == null && (
          <p className="text-xs text-amber-700">
            This crop has no base lb/bushel set — auto calc unavailable; enter a dry bushels override.
          </p>
        )}
      </div>

      <label className={labelCls}>
        Ticket #
        <input type="text" value={form.ticket_number} onChange={(e) => set('ticket_number', e.target.value)} className={inputCls} />
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {justSaved && (
        <p aria-live="polite" className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm font-medium text-green-800">
          {justSaved} — ready for the next one.
        </p>
      )}

      <div className="flex gap-3 sticky bottom-3">
        {mode === 'create' ? (
          <>
            {/* The harvest-entry workhorse: save, then a fresh form seeded
                from this load — so it leads, full-primary. Both save buttons
                share the row equally (flex-1). */}
            <button
              type="submit"
              disabled={busy}
              onClick={() => { saveAndNewRef.current = true }}
              className="flex-1 rounded-xl bg-brand hover:bg-brand-deep text-white font-semibold py-4 shadow disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save & New'}
            </button>
            <button
              type="submit"
              disabled={busy}
              onClick={() => { saveAndNewRef.current = false }}
              className="flex-1 rounded-xl bg-white border-2 border-brand text-brand-deep font-semibold py-4 disabled:opacity-60"
            >
              Save
            </button>
          </>
        ) : (
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded-xl bg-brand hover:bg-brand-deep text-white font-semibold py-4 shadow disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Update Load'}
          </button>
        )}
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-xl bg-white border border-slate-300 px-4 py-4"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
