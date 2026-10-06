'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { computeBushels } from '@/lib/shrink'
import { cropYearOptionsFromPlantings } from '@/lib/plantings'
import { cropForFieldOnDate, fieldDefaultNote } from '@/lib/load-crop-default'
import { effectiveCropYear } from '@/lib/ticket-date'
import { allocateSplits, validateSplitDrafts, type SplitDraft } from '@/lib/load-splits'
import { practiceOf } from '@/lib/yields'
import { rememberHarvestEntryPath } from '@/lib/harvest-entry-path'
import { relinkSettlementLinesForLoad } from '@/lib/settlement-link'
import { getOrgId } from '@/lib/org'
import { externalTruckInsert, truckLabelForSave } from '@/lib/trucks'
import { reportError } from '@/lib/friendly-error'
import { fmtDate, fmtDateShort } from '@/lib/format-date'
import { checkLoad } from '@/lib/load-checks'
import { compressImage } from '@/lib/image-capture'
import { uploadFileToStorage } from '@/lib/pdf-upload'
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
import { ConfirmDialog, NoticeDialog } from '@/components/app-dialog'
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

/** A ticket photo waiting for the load to save (create mode). */
type PendingPhoto = { id: string; file: File; previewUrl: string }

/** How long a save may hang on a weak signal before the form gives the
 *  buttons back and says so. The typing is kept either way. */
const SAVE_TIMEOUT_MS = 15_000

function todayISO() {
  const d = new Date()
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - tz).toISOString().slice(0, 10)
}
function nowHHMM() {
  const d = new Date()
  return d.toTimeString().slice(0, 5)
}

/** A client-side load id so a retried save is idempotent: if the first
 *  attempt landed but the reply was lost, the retry hits the primary key and
 *  we treat that as success instead of writing the load twice. */
function newLoadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Older iPad Safari: RFC 4122 v4 from getRandomValues / Math.random.
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** True when a duplicate-key error is on the loads PRIMARY KEY — the retry
 *  case above. Any other unique violation is a real rejection. */
function isDuplicateLoadId(err: { code?: string | null; message?: string | null; details?: string | null } | null): boolean {
  if (!err) return false
  const text = `${err.message ?? ''} ${err.details ?? ''}`
  return (err.code === '23505' || /duplicate key/i.test(text)) && /loads_pkey|\(id\)/.test(text)
}

/** Run a Supabase call with a timeout: the builder is thenable, so awaiting
 *  it inside works; the signal aborts the fetch and the client returns an
 *  AbortError result (never throws) that reads as a connection error. */
async function withSaveTimeout<T>(run: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), SAVE_TIMEOUT_MS)
  try {
    return await run(ctrl.signal)
  } finally {
    clearTimeout(t)
  }
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

/** On-screen bushels: whole numbers, commas. */
function fmt(n: number | null): string {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

/** The JPEG the camera tray compressed, as a File for the attachments bucket. */
function jpegFile(base64: string, name: string): File {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: 'image/jpeg' })
}

export default function LoadForm({ initial, initialSplits, mode }: Props) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [form, setForm] = useState<FormState>(toForm(initial))
  // The form as it was seeded (initial values + last-load defaults) — the
  // unsaved-changes guard compares against this, never against "blank".
  const seedRef = useRef<string>(JSON.stringify(toForm(initial)))
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
  const initialSplitsKey = useMemo(
    () => JSON.stringify((initialSplits ?? []).map((s) => [s.field_id, String(s.net_weight), s.practice ?? ''])),
    [initialSplits],
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
    const t = setTimeout(() => setJustSaved(null), 6000)
    return () => clearTimeout(t)
  }, [justSaved])
  // Client-side id for the NEXT insert (see newLoadId). Regenerated after
  // every successful Save & New so the next load never reuses it.
  const [draftId, setDraftId] = useState<string>(() => newLoadId())
  // Plausibility warnings waiting on "Save anyway" / "Go back".
  const [pendingWarnings, setPendingWarnings] = useState<string[] | null>(null)
  // Cancel with unsaved typing.
  const [leaveAsk, setLeaveAsk] = useState(false)
  // Net is computed from gross − tare; a small "edit" affordance unlocks it.
  const [netEditable, setNetEditable] = useState(false)
  // The dry-bushels override lives behind a disclosure — rarely needed.
  const [showOverride, setShowOverride] = useState(() => (initial?.dry_bushels_override ?? null) != null)
  // Ticket photos captured before the load exists (create mode): uploaded
  // right after the insert returns the id, using the load_attachments shape
  // from components/load-attachments.tsx.
  const [photos, setPhotos] = useState<PendingPhoto[]>([])
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoErr, setPhotoErr] = useState<string | null>(null)
  const [isCoarse, setIsCoarse] = useState(false)
  const cameraRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null)
  // Bumped after Save & New so focus lands on the (cleared) Truck select.
  const [focusTruckKey, setFocusTruckKey] = useState(0)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    setIsCoarse(window.matchMedia('(pointer: coarse)').matches)
  }, [])
  useEffect(() => {
    if (focusTruckKey === 0) return
    const el = document.getElementById('load-truck')
    el?.focus({ preventScroll: true })
  }, [focusTruckKey])
  // Last-load date default (create mode): which date the seam applied, and
  // whether the user touched the date before the default could land.
  const [defaultedDate, setDefaultedDate] = useState<string | null>(null)
  const dateTouchedRef = useRef(false)
  // Crop from the field's planting (lib/load-crop-default): applied only while
  // the user has not chosen a crop in this form session — once they pick one,
  // nothing overwrites it. The note names where the default came from.
  const cropTouchedRef = useRef(false)
  const [cropDefaultNote, setCropDefaultNote] = useState<string | null>(null)
  function defaultCropFromField(f: FormState, fieldId: string): FormState {
    if (cropTouchedRef.current || !fieldId) return f
    const d = cropForFieldOnDate({ plantings, crops, fieldId, cropYear: effectiveCropYear(f.crop_year, f.date), date: f.date })
    if (!d.cropId) { setCropDefaultNote(d.reason === 'cotton_only' || d.reason === 'multiple' ? fieldDefaultNote(d, (id) => crops.find((c) => c.id === id)?.name ?? '', effectiveCropYear(f.crop_year, f.date)) : null); return f }
    setCropDefaultNote(d.cropId !== f.crop_id || d.reason === 'spring_fall_by_date' ? fieldDefaultNote(d, (id) => crops.find((c) => c.id === id)?.name ?? '', effectiveCropYear(f.crop_year, f.date)) : null)
    return d.cropId === f.crop_id ? f : { ...f, crop_id: d.cropId, contract_id: '' }
  }
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
      // Archived land (Settings → Archive, or retired over the Turnrow Farm
      // link) stays on old loads but leaves the pickers for new ones. The
      // column is absent on a pre-087 database, which reads as "not archived".
      const live = <T extends { archived_at?: string | null }>(rows: T[] | null | undefined): T[] =>
        (rows || []).filter((r) => r.archived_at == null)
      setFields(live(f.data as Field[]))
      setFarms(live(fa.data as Farm[]))
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
      setForm((f) => {
        const untouched = JSON.stringify(f) === seedRef.current
        const next = applyLastLoadDefaults(f, recent, { dateUntouched }).form
        // Pre-fills are the seed, not the user's typing.
        if (untouched) seedRef.current = JSON.stringify(next)
        return next
      })
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
  const netIsAuto = num(form.gross_weight) != null && num(form.tare_weight) != null
  const netLocked = netIsAuto && !netEditable

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
      // A seeded selection dropped by the filter is still "untouched".
      if (JSON.stringify(f) === seedRef.current) seedRef.current = JSON.stringify(next)
      return next
    })
  }, [refsLoaded, filteredFields, filteredBins])

  // Unsaved-changes guard: the form differs from its seed, or split rows have
  // been typed into. Off while saving and once the save has gone through.
  const splitsKey = JSON.stringify(splits.map((s) => [s.field_id, s.weight, s.practice]))
  const dirty = !busy && (
    JSON.stringify(form) !== seedRef.current ||
    (splitMode ? splitsKey !== initialSplitsKey && splits.some((s) => s.field_id || s.weight) : (initialSplits?.length ?? 0) > 0) ||
    photos.length > 0
  )
  useEffect(() => {
    if (!dirty) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

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

  // ---- ticket photo tray (create mode) ----
  async function addPhotos(files: File[]) {
    if (files.length === 0) return
    setPhotoErr(null)
    setPhotoBusy(true)
    try {
      const next: PendingPhoto[] = []
      for (const file of files) {
        if (file.type === 'application/pdf') {
          next.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file, previewUrl: '' })
          continue
        }
        // Same compression as the scan flow — a phone photo lands well under 1 MB.
        const img = await compressImage(file)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        next.push({ id: img.id, file: jpegFile(img.base64, `ticket-${stamp}.jpg`), previewUrl: img.dataUrl })
      }
      setPhotos((prev) => [...prev, ...next])
    } catch (e) {
      setPhotoErr(reportError(e as Error, { action: 'read that photo' }))
    } finally {
      setPhotoBusy(false)
    }
  }
  function onPhotoPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : []
    e.target.value = ''
    void addPhotos(files)
  }
  /** Upload the tray to the saved load. Returns how many failed. */
  async function uploadPhotos(loadId: string): Promise<number> {
    let failed = 0
    for (const p of photos) {
      try {
        const { publicUrl, path } = await uploadFileToStorage(supabase, p.file, 'load-attachments')
        const { error } = await supabase.from('load_attachments').insert({
          load_id: loadId,
          file_url: publicUrl,
          file_path: path,
          file_name: p.file.name,
          mime_type: p.file.type || null,
          file_size: p.file.size,
        })
        if (error) throw error
      } catch (e) {
        failed++
        reportError(e as Error, { action: 'attach the ticket photo' })
      }
    }
    return failed
  }

  // ---- submit: pre-flight, then the save proper ----
  function onSubmit(e: React.FormEvent) {
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

    // Plausibility (lib/load-checks): a negative net blocks; everything else
    // asks "Save anyway / Go back" in the app's own dialog.
    const checks = checkLoad({
      gross: num(form.gross_weight),
      tare: num(form.tare_weight),
      net: num(form.net_weight),
      moisture: num(form.moisture),
      testWeight: num(form.test_weight),
      truckPicked: !!form.truck_id || (isPickup && form.hauler_truck.trim() !== ''),
      crop: selectedCrop ?? null,
    })
    if (checks.blockers.length > 0) {
      setError(checks.blockers.join(' '))
      return
    }
    if (checks.warnings.length > 0) {
      setPendingWarnings(checks.warnings)
      return
    }
    void doSave()
  }

  function failSave(message: string) {
    submittingRef.current = false
    setBusy(false)
    setError(message)
  }

  async function doSave() {
    if (submittingRef.current) return
    submittingRef.current = true
    setBusy(true)
    setError(null)
    const useSplits = splitMode && form.from_type === 'field'

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
        failSave(`${reportError(xtErr, { action: 'save the hauler truck', noun: 'hauler truck', name: form.hauler_truck.trim() })} The load was not saved — try again, or untick “Save this truck”.`)
        return
      }
    }

    let savedLoadId: string | null = null
    let err: { code?: string | null; message: string; details?: string | null } | null = null
    try {
      if (mode === 'create') {
        // Stamp who entered it (073 — powers the per-user last-load defaults).
        // If created_by isn't applied yet the insert retries without it, so a
        // late migration apply degrades to org-level defaults, never a failure.
        // The id is ours (draftId): a retry after a lost reply can't double up.
        const { data: { user } } = await supabase.auth.getUser()
        const row = { ...payload, id: draftId }
        const insertOnce = (r: typeof row | (typeof row & { created_by: string })) =>
          withSaveTimeout((signal) => supabase.from('loads').insert(r).select('id').abortSignal(signal).single())
        let res = user?.id ? await insertOnce({ ...row, created_by: user.id }) : await insertOnce(row)
        if (res.error && user?.id && res.error.message.includes('created_by')) {
          res = await insertOnce(row)
        }
        if (res.error && isDuplicateLoadId(res.error)) {
          // The first attempt landed; the reply was lost. That IS the save.
          savedLoadId = draftId
        } else {
          err = res.error
          savedLoadId = (res.data as { id: string } | null)?.id ?? null
        }
      } else if (initial?.id) {
        const editId = initial.id
        const res = await withSaveTimeout((signal) => supabase.from('loads').update(payload).eq('id', editId).abortSignal(signal))
        err = res.error
        savedLoadId = editId
      }
    } catch (e) {
      err = { message: (e as Error)?.message ?? 'Failed to fetch' }
    }

    if (err) {
      // Connection trouble keeps the typing and gives both buttons back.
      failSave(reportError(err, { action: 'save this load', noun: 'load' }))
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
          failSave(`The load saved, but its field split didn't. ${reportError(delErr, { action: 'update the field split', noun: 'split' })}`)
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
          failSave(`The load saved, but its field split didn't. ${reportError(insErr, { action: 'save the field split', noun: 'split' })}`)
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

    // Ticket photos: the load exists now, so attach them. A failed upload
    // never un-saves the load — say so and point at the load's page.
    let photoFailures = 0
    if (savedLoadId && photos.length > 0) {
      photoFailures = await uploadPhotos(savedLoadId)
      setPhotos([])
    }

    rememberHarvestEntryPath('load')

    // "Save & New" — stay on the form for the next load of the session.
    if (mode === 'create' && saveAndNewRef.current) {
      saveAndNewRef.current = false
      startNextLoad(payload.ticket_number)
      if (photoFailures > 0) {
        setNotice({
          title: 'Load saved — photo not attached',
          body: `The load saved, but ${photoFailures === 1 ? 'the ticket photo' : `${photoFailures} ticket photos`} didn't upload. Open the load from the Loads page and attach it there.`,
        })
      }
      return
    }

    // Saved and leaving: the guard must not fire on the way out.
    seedRef.current = JSON.stringify(form)
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
    const next = { ...form, ...saveAndNewPatch(nowHHMM()) }
    setForm(next)
    seedRef.current = JSON.stringify(next)
    // Splits describe the load just saved, not the next one.
    setSplitMode(false)
    setSplits([])
    setLastSplitManual(false)
    setSaveHaulerTruck(false)
    setNetEditable(false)
    setShowOverride(false)
    setDraftId(newLoadId())
    setJustSaved(ticket ? `Saved — ticket ${ticket}` : 'Load saved')
    setTareRefresh((n) => n + 1) // the saved tare joins the truck's baseline
    setContractRefresh((n) => n + 1) // the tracker recounts WITH the saved load
    submittingRef.current = false
    setBusy(false)
    setError(null)
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    // The truck was cleared on purpose — it's the next thing to fill.
    setFocusTruckKey((n) => n + 1)
  }

  function onCancel() {
    if (dirty) { setLeaveAsk(true); return }
    router.back()
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 min-h-11 text-base bg-white'
  const weightCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 min-h-12 text-base bg-white tabular-nums'
  const labelCls = 'block text-sm text-slate-700'
  const quietBtn = 'rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm'
  const toggleCls = (active: boolean) =>
    `flex-1 min-h-11 rounded-lg border ${active ? 'bg-brand hover:bg-brand-deep text-white border-green-700' : 'bg-white'}`

  return (
    <form onSubmit={onSubmit} className="space-y-5 pb-4">
      <h1 className="text-2xl font-bold">{mode === 'create' ? 'New Load' : 'Edit Load'}</h1>

      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          Date
          <input
            type="date"
            required
            value={form.date}
            onChange={(e) => { dateTouchedRef.current = true; setForm((f) => defaultCropFromField({ ...f, date: e.target.value }, f.from_type === 'field' ? f.from_field_id : '')) }}
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

      {/* Truck and ticket number first — they're the first things on the paper ticket. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={labelCls}>
          Truck
          {isPickup ? (
            <div className="mt-1">
              <HaulerTruckField
                id="load-truck"
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
                className="w-full rounded-lg border border-slate-300 px-3 py-3 min-h-11 text-base bg-white"
              />
            </div>
          ) : (
            <TruckPicker
              id="load-truck"
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
          Ticket #
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            value={form.ticket_number}
            onChange={(e) => set('ticket_number', e.target.value)}
            className={inputCls}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={labelCls}>
          Crop
          <select value={form.crop_id} onChange={(e) => { cropTouchedRef.current = true; setCropDefaultNote(null); set('crop_id', e.target.value) }} className={inputCls}>
            <option value="">— select —</option>
            {crops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {cropDefaultNote && <span className="block text-xs text-slate-500 mt-1 font-normal">{cropDefaultNote}</span>}
        </label>
        <label className={labelCls}>
          Crop year
          <select
            value={form.crop_year}
            onChange={(e) => setForm((f) => ({ ...f, crop_year: e.target.value, contract_id: '' }))}
            className={inputCls}
          >
            <option value="">— select —</option>
            {seasonYearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
      </div>

      <fieldset className="border border-slate-200 rounded-xl p-3 space-y-3">
        <legend className="px-2 text-sm font-semibold">From</legend>
        <div className="flex gap-2">
          {(['field', 'bin'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => applyTypeChange({ from_type: t })}
              aria-pressed={form.from_type === t}
              className={toggleCls(form.from_type === t)}
            >
              {t === 'field' ? 'Field' : 'Bin'}
            </button>
          ))}
        </div>
        {form.from_type === 'field' && !splitMode && (
          <>
            <FieldPicker
              value={form.from_field_id}
              onChange={(id) => setForm((f) => defaultCropFromField({ ...f, from_field_id: id, practice: '' }, id))}
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
                      aria-pressed={form.practice === p}
                      className={`${toggleCls(form.practice === p)} text-sm`}
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
              className={`${quietBtn} w-full sm:w-auto`}
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
                    aria-pressed={splitEntryMode === m}
                    className={`px-3 min-h-11 text-sm ${splitEntryMode === m ? 'bg-brand hover:bg-brand-deep text-white' : 'bg-white'}`}
                  >
                    {m === 'weight' ? 'By weight' : 'By percentage'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setSplitMode(false)}
                className={quietBtn}
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
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 min-h-11 text-base bg-white"
                      />
                    </div>
                    {splits.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeSplit(i)}
                        className="text-red-600 text-base min-h-11 min-w-11 px-2 rounded-lg"
                        aria-label={`Remove field ${i + 1} from the split`}
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
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 min-h-11 text-base bg-white tabular-nums"
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
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 min-h-11 text-base bg-white tabular-nums"
                          disabled={totalNetLb <= 0}
                        />
                        <span className="text-xs text-slate-500 w-24 text-right tabular-nums">
                          {weightVal ? `${Number(weightVal).toLocaleString(undefined, { maximumFractionDigits: 0 })} lb` : ''}
                        </span>
                      </>
                    )}
                  </div>
                  {isAutoFilled && (
                    <p className="text-xs text-slate-500">Filled in from what’s left — type a value to change it.</p>
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
                            aria-pressed={row.practice === p}
                            className={`${toggleCls(row.practice === p)} text-sm`}
                          >
                            {p === 'irrigated' ? 'Irrigated' : 'Dryland'}
                          </button>
                        ))}
                      </div>
                      <span className="text-xs text-slate-400 w-14 text-right">optional</span>
                    </div>
                  )}
                </div>
              )
            })}

            <button
              type="button"
              onClick={addSplit}
              className={quietBtn}
            >
              + Add another field
            </button>

            <div className={`rounded-lg p-2 text-sm ${splitError ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-700'}`}>
              <div className="flex justify-between tabular-nums">
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
            <select value={form.from_bin_id} onChange={(e) => set('from_bin_id', e.target.value)} className={inputCls} aria-label="From bin">
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
              aria-pressed={form.to_type === t}
              className={toggleCls(form.to_type === t)}
            >
              {t === 'bin' ? 'Bin' : 'Buyer'}
            </button>
          ))}
        </div>
        {form.to_type === 'bin' && (
          <>
            <select value={form.to_bin_id} onChange={(e) => set('to_bin_id', e.target.value)} className={inputCls} aria-label="To bin">
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
            <select value={form.to_buyer_id} onChange={(e) => { set('to_buyer_id', e.target.value); set('contract_id', '') }} className={inputCls} aria-label="Buyer">
              <option value="">— select buyer —</option>
              {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <label className={labelCls}>
              Contract
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
              <span className="mt-1 block text-xs text-slate-500">Showing this buyer’s contracts for this crop and year.</span>
            </label>

            {selectedContract && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                <div className="flex justify-between items-baseline flex-wrap gap-x-4 text-sm">
                  <span className="font-semibold text-slate-700">
                    #{selectedContract.contract_number} · {buyerName(selectedContract.buyer_id)}
                  </span>
                  <span className="tabular-nums text-slate-600">{contractTotal.toLocaleString()} bu contracted</span>
                </div>
                <div className="h-3 w-full rounded-full bg-slate-200 overflow-hidden flex">
                  <div className="bg-green-600 h-full" style={{ width: `${pctDelivered}%` }} title="Delivered" />
                  {pctThisLoad > 0 && <div className="bg-green-300 h-full" style={{ width: `${pctThisLoad}%` }} title="This load" />}
                </div>
                <div className="flex justify-between flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span className="text-slate-600">
                    Delivered <span className="tabular-nums font-semibold text-slate-800">{Math.round(deliveredBu).toLocaleString()}</span> bu
                    {contractDelivered && <span className="text-slate-400"> · {contractDelivered.count} load{contractDelivered.count === 1 ? '' : 's'}</span>}
                    {contractProgressLoading && <span className="text-slate-400"> · updating…</span>}
                  </span>
                  {thisLoadBu > 0 && (
                    <span className="text-green-700">+{Math.round(thisLoadBu).toLocaleString()} bu this load → {Math.round(projectedBu).toLocaleString()} bu</span>
                  )}
                  <span className={remainingBu < 0 ? 'text-amber-700 font-semibold' : 'text-slate-600'}>
                    {remainingBu >= 0
                      ? <>Remaining <span className="tabular-nums font-semibold">{Math.round(remainingBu).toLocaleString()}</span> bu</>
                      : <>Over by <span className="tabular-nums font-semibold">{Math.round(-remainingBu).toLocaleString()}</span> bu</>}
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
          <input type="number" inputMode="decimal" step="0.01" value={form.gross_weight} onChange={(e) => set('gross_weight', e.target.value)} className={weightCls} />
        </label>
        <div>
          <label className={labelCls}>
            Tare (lb)
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={form.tare_weight}
              onChange={(e) => set('tare_weight', e.target.value)}
              aria-describedby={tareWarning ? 'tare-warning' : undefined}
              className={`${weightCls} ${tareWarning ? 'border-amber-400 bg-amber-50' : ''}`}
            />
          </label>
          {tareWarning && (
            <span id="tare-warning" role="status" className="mt-1 block text-xs font-normal text-amber-800">
              {tareWarning}
            </span>
          )}
          {lastTareOffer && (
            <button
              type="button"
              onClick={() => set('tare_weight', String(lastTareOffer.tare))}
              title={lastTareOffer.date ? `From this truck's last load on ${fmtDate(lastTareOffer.date)}` : "From this truck's last load"}
              className="mt-2 w-full rounded-lg border border-brand/60 bg-white px-3 min-h-11 text-sm font-semibold text-brand-deep hover:bg-brand/10 active:bg-brand/20"
            >
              Use last tare: {Math.round(lastTareOffer.tare).toLocaleString()}
              {lastTareOffer.date && <span className="font-normal text-slate-500"> · {fmtDateShort(lastTareOffer.date)}</span>}
            </button>
          )}
        </div>
        <div>
          <label className={labelCls}>
            <span className="flex items-baseline justify-between gap-2">
              <span>Net (lb) {netIsAuto && <span className="text-xs text-slate-400">gross − tare</span>}</span>
              {netLocked && (
                <button
                  type="button"
                  onClick={() => setNetEditable(true)}
                  className="text-xs font-semibold text-brand-deep min-h-8 px-1"
                >
                  edit
                </button>
              )}
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={form.net_weight}
              onChange={(e) => set('net_weight', e.target.value)}
              readOnly={netLocked}
              tabIndex={netLocked ? -1 : undefined}
              aria-readonly={netLocked || undefined}
              className={`${weightCls} ${netLocked ? 'bg-slate-50 text-slate-700' : ''}`}
            />
          </label>
        </div>
        <label className={labelCls}>
          Moisture %
          <input type="number" inputMode="decimal" step="0.01" value={form.moisture} onChange={(e) => set('moisture', e.target.value)} className={weightCls} />
        </label>
        <label className={labelCls}>
          Test weight
          <input type="number" inputMode="decimal" step="0.01" value={form.test_weight} onChange={(e) => set('test_weight', e.target.value)} className={weightCls} />
        </label>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
        <div className="text-sm font-semibold text-slate-700">
          Bushels {selectedCrop ? `— base ${selectedCrop.base_moisture_pct ?? '?'}% moisture, ${selectedCrop.base_lb_per_bushel ?? '?'} lb/bu` : ''}
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-xs text-slate-500">Wet</div>
            <div className="tabular-nums text-lg">{fmt(wetBushels)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Dry</div>
            <div className="tabular-nums text-lg">{fmt(computedDryBushels)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Shrink</div>
            <div className="tabular-nums text-lg">{fmt(shrinkBu)}</div>
          </div>
        </div>

        <div className="text-sm">
          <span className="text-slate-500">Used for reports: </span>
          <span className="tabular-nums font-semibold">{fmt(dryBushels)} bu</span>
          {overridden && <span className="text-amber-700 text-xs ml-2">(entered by hand)</span>}
        </div>

        {!showOverride ? (
          <button
            type="button"
            onClick={() => setShowOverride(true)}
            className="text-sm text-brand-deep font-semibold min-h-11 px-1"
          >
            Override dry bushels…
          </button>
        ) : (
          <div className="flex items-end gap-2 flex-wrap">
            <label className="text-sm text-slate-700 flex-1 min-w-[10rem]">
              Dry bushels (by hand) <span className="text-xs text-slate-400">optional</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                value={form.dry_bushels_override}
                onChange={(e) => set('dry_bushels_override', e.target.value)}
                placeholder={computedDryBushels != null ? fmt(computedDryBushels) : ''}
                className={weightCls}
              />
            </label>
            <button
              type="button"
              onClick={() => { set('dry_bushels_override', ''); setShowOverride(false) }}
              className={quietBtn}
            >
              {form.dry_bushels_override !== '' ? 'Clear' : 'Hide'}
            </button>
          </div>
        )}

        {selectedCrop && selectedCrop.base_lb_per_bushel == null && (
          <p className="text-xs text-amber-700">
            This crop has no pounds per bushel set, so bushels can’t be worked out — enter the dry bushels by hand, or set it under Settings → Crops.
          </p>
        )}
      </div>

      {mode === 'create' && (
        <div className="rounded-xl border border-slate-200 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-700 flex-1">Ticket photo <span className="font-normal text-slate-400">optional</span></span>
            {isCoarse && (
              <button type="button" onClick={() => cameraRef.current?.click()} disabled={photoBusy || busy} className={`${quietBtn} font-semibold disabled:opacity-50`}>
                {photoBusy ? 'Adding…' : '📷 Take ticket photo'}
              </button>
            )}
            <button type="button" onClick={() => libraryRef.current?.click()} disabled={photoBusy || busy} className={`${quietBtn} disabled:opacity-50`}>
              {isCoarse ? 'Choose photo' : photoBusy ? 'Adding…' : 'Add ticket photo'}
            </button>
          </div>
          {photos.length === 0 ? (
            <p className="text-xs text-slate-500">Snap the scale ticket now and it’s attached to the load when you save.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <div key={p.id} className="relative">
                  {p.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.previewUrl} alt={`Ticket photo ${i + 1}`} className="h-20 w-20 object-cover rounded border border-slate-300" />
                  ) : (
                    <div className="h-20 w-20 rounded border border-slate-300 bg-white flex items-center justify-center text-xs font-semibold text-slate-500">PDF</div>
                  )}
                  <button
                    type="button"
                    onClick={() => setPhotos((list) => list.filter((x) => x.id !== p.id))}
                    disabled={busy}
                    aria-label={`Remove ticket photo ${i + 1}`}
                    className="absolute -top-2 -right-2 h-7 w-7 rounded-full bg-red-600 text-white text-xs leading-none"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {photoErr && <p className="text-sm text-red-600">{photoErr}</p>}
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={onPhotoPick} className="hidden" />
          <input ref={libraryRef} type="file" accept="image/*,application/pdf" multiple onChange={onPhotoPick} className="hidden" />
        </div>
      )}

      {/* Sticky save bar — always visible, with the save confirmation and any
          error inside it so they can't scroll out of sight. iOS safe area. */}
      <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-white/95 backdrop-blur border-t border-slate-200 space-y-2 no-print">
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {justSaved && (
          <p aria-live="polite" className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm font-medium text-green-800">
            {justSaved} — ready for the next one.
          </p>
        )}
        <div className="flex gap-3">
          {mode === 'create' ? (
            <>
              {/* The harvest-entry workhorse: save, then a fresh form seeded
                  from this load — so it leads, full-primary. Both save buttons
                  share the row equally (flex-1). */}
              <button
                type="submit"
                disabled={busy}
                onClick={() => { saveAndNewRef.current = true }}
                className="flex-1 rounded-xl bg-brand hover:bg-brand-deep text-white font-semibold min-h-12 py-3 shadow disabled:opacity-60"
              >
                {busy ? 'Saving…' : 'Save & New'}
              </button>
              <button
                type="submit"
                disabled={busy}
                onClick={() => { saveAndNewRef.current = false }}
                className="flex-1 rounded-xl bg-white border-2 border-brand text-brand-deep font-semibold min-h-12 py-3 disabled:opacity-60"
              >
                Save
              </button>
            </>
          ) : (
            <button
              type="submit"
              disabled={busy}
              className="flex-1 rounded-xl bg-brand hover:bg-brand-deep text-white font-semibold min-h-12 py-3 shadow disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Update Load'}
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl bg-white border border-slate-300 px-4 min-h-12"
          >
            Cancel
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={pendingWarnings != null}
        title="Check this load"
        body={
          <ul className="list-disc pl-5 space-y-1">
            {(pendingWarnings ?? []).map((w) => <li key={w}>{w}</li>)}
          </ul>
        }
        confirmLabel="Save anyway"
        cancelLabel="Go back"
        onConfirm={() => { setPendingWarnings(null); void doSave() }}
        onCancel={() => setPendingWarnings(null)}
      />
      <ConfirmDialog
        open={leaveAsk}
        title="Leave without saving this load?"
        body="What you’ve typed on this load will be lost."
        confirmLabel="Leave"
        cancelLabel="Keep editing"
        danger
        onConfirm={() => { setLeaveAsk(false); seedRef.current = JSON.stringify(form); router.back() }}
        onCancel={() => setLeaveAsk(false)}
      />
      <NoticeDialog
        open={notice != null}
        title={notice?.title ?? ''}
        body={notice?.body}
        onClose={() => setNotice(null)}
      />
    </form>
  )
}
