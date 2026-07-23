'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from './position-form'
import ClosePositionDialog from './close-position-dialog'
import CloseOptionDialog from './close-option-dialog'
import DocumentCapture, { type DocumentSource } from '@/components/document-capture'
import SourcePreview from '@/components/source-preview'
import {
  MAX_PDF_BYTES,
  PdfTooLargeError,
  parseDocument,
  type BrokerageStatementExtraction,
  type BrokerageClosedGroup,
} from '@/lib/pdf-upload'
import {
  buildContractSymbol,
  normalizeCommodity,
  normalizeOptionType,
  optionPremiumTotal,
  expandClosedGroup,
  pnlSizeFor,
  reconcileClosedGroup,
  coercePrice,
  pricesMatch,
  fmtPrice,
  fmtCommodityPrice,
  fmtPnl,
  fmtCents,
  bushelsFor,
  COMMODITY_SPECS,
  type Commodity,
  type Side,
  type OptionType,
  type OptionSide,
} from '@/lib/hedging'
import {
  matchExistingOpenPosition,
  resolveClosedGroupSide,
  normalizeTradeDate,
  type FieldDifference,
} from '@/lib/statement-matching'
import type { Entity, FuturesPosition, OptionPosition } from '@/lib/types'

function cropYearOptions(): number[] {
  const y = new Date().getFullYear()
  return [y - 1, y, y + 1, y + 2]
}
function priceEq(a: number, b: number) {
  return Math.abs(a - b) < 1e-4
}
function up(s: string) {
  return s.trim().toUpperCase()
}

// Freeze the Commodity and Month columns when the review tables scroll
// horizontally, so each row stays identifiable while reaching Side/Price/Crop
// Yr. Commodity is a fixed 130px (fits "Chicago Wheat") so Month's left offset
// lines up exactly. Header cells sit above body cells (z-20 vs z-10) and carry
// solid backgrounds so scrolling cells pass cleanly underneath.
const STICKY_HEAD_1 = 'sticky left-0 z-20 bg-slate-100 w-[130px] min-w-[130px]'
const STICKY_HEAD_2 = 'sticky left-[130px] z-20 bg-slate-100'
const STICKY_CELL_1 = 'sticky left-0 z-10 bg-white w-[130px] min-w-[130px]'
const STICKY_CELL_2 = 'sticky left-[130px] z-10 bg-white'

type OpenRow = {
  commodity: Commodity
  contract_month: string
  side: Side
  num_contracts: number
  trade_date: string
  trade_price: number
  unrealized_pnl: number | null
  crop_year: string
  include: boolean
  existing: boolean // auto-detected as already in the database
  // The user manually paired this row with a stored open position ("Match to
  // existing") — treated like `existing`: nothing is imported for it.
  manualMatchId: string | null
  // When flagged New but a same-commodity/month position is close, the
  // near-miss and exactly which fields differ — shown inline so the verdict
  // is explainable (and so parse drift is visible, not mysterious).
  nearMiss: { position: FuturesPosition; differences: FieldDifference[] } | null
}
// One opening lot inside a closed offset group. Realized P&L is NOT stored here
// — it's computed per lot from the group's side/close price via expandClosedGroup
// (so flipping the group side instantly re-derives every lot). open_price and
// num_contracts come from the matched DB position when fromDb is true (Part C:
// anchor the math to verified entry prices), otherwise from the statement.
type ClosedLotRow = {
  open_trade_date: string
  open_price: number
  num_contracts: number
  matchedOpenId: string | null // the open DB position this lot closes, if any
  fromDb: boolean // open_price/num_contracts taken from the matched DB record
  alreadyImported: boolean
  crop_year: string
  include: boolean
}
type ClosedGroupRow = {
  commodity: Commodity
  contract_month: string
  side: Side
  // True when the extracted side contradicted the side of the matched open DB
  // positions this group closes, and the DB side won (it's authoritative — a
  // group can't close short positions "as long"). Cleared if the user changes
  // the side by hand.
  sideOverriddenFromDb: boolean
  close_trade_date: string
  close_price: number
  // The statement's printed GROSS PROFIT/LOSS for the whole group — used ONLY to
  // reconcile against the sum of per-lot realized P&L, never written to a lot.
  statement_reported_total: number | null
  lots: ClosedLotRow[]
}
type OptionOpenRow = {
  commodity: Commodity
  option_type: OptionType
  side: OptionSide
  underlying_contract_month: string
  strike_price: number
  num_contracts: number
  premium_cents: number
  trade_date: string
  unrealized_pnl: number | null
  crop_year: string
  include: boolean
  existing: boolean
}
type OptionClosedRow = {
  commodity: Commodity
  option_type: OptionType
  side: OptionSide
  underlying_contract_month: string
  strike_price: number
  num_contracts: number
  open_trade_date: string
  close_trade_date: string
  open_premium_cents: number
  close_premium_cents: number
  realized_pnl: number
  crop_year: string
  include: boolean
  alreadyImported: boolean
}

type Props = {
  entities: Entity[]
  existingPositions: FuturesPosition[]
  existingOptions: OptionPosition[]
  onClose: () => void
  onImported: (summary: { inserted: number; closed: number }) => void
  // Called after a position is closed via the "possibly closed" step, so the
  // parent reloads — the refreshed existingPositions then drop out of the
  // possibly-closed list automatically. Distinct from onImported (which also
  // closes this modal); this keeps the import open so the user can keep reviewing.
  onChanged?: () => void
}

export default function StatementImport({ entities, existingPositions, existingOptions, onClose, onImported, onChanged }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [source, setSource] = useState<DocumentSource | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [extraction, setExtraction] = useState<BrokerageStatementExtraction | null>(null)
  const [openRows, setOpenRows] = useState<OpenRow[]>([])
  const [closedGroups, setClosedGroups] = useState<ClosedGroupRow[]>([])
  const [openOptionRows, setOpenOptionRows] = useState<OptionOpenRow[]>([])
  const [closedOptionRows, setClosedOptionRows] = useState<OptionClosedRow[]>([])
  const [tab, setTab] = useState<'open' | 'closed' | 'options' | 'summary'>('open')
  const [importEntityId, setImportEntityId] = useState('')
  const [bulkCropYear, setBulkCropYear] = useState('')
  const [saving, setSaving] = useState(false)
  // Possibly-closed step: positions the user has dismissed ("Keep open"), and the
  // position currently being closed through the real close workflow.
  const [keptOpenIds, setKeptOpenIds] = useState<Set<string>>(new Set())
  const [closingFut, setClosingFut] = useState<FuturesPosition | null>(null)
  const [closingOpt, setClosingOpt] = useState<OptionPosition | null>(null)

  function buildOpenRow(p: NonNullable<BrokerageStatementExtraction['open_positions']>[number]): OpenRow | null {
    const commodity = normalizeCommodity(p.commodity)
    const trade_price = coercePrice(p.trade_price)
    if (!commodity || !p.contract_month || p.side == null || p.num_contracts == null || trade_price == null || !p.trade_date) {
      return null
    }
    // Already imported? Tolerant fingerprint via matchExistingOpenPosition:
    // commodity + month + contracts exact, date exact after normalization,
    // price within half a cent (fractional-parse drift between extraction runs
    // must not re-flag an existing position as New). Side intentionally doesn't
    // block a match — the AI sometimes mis-reads long/short, and a re-upload
    // must not create a duplicate just because the side flipped. Matches
    // against open OR closed positions. When it doesn't match, the closest
    // candidate and its differing fields are kept for the review screen.
    const { match, nearMiss } = matchExistingOpenPosition(
      {
        commodity,
        contract_month: up(p.contract_month),
        side: p.side,
        num_contracts: p.num_contracts,
        trade_date: p.trade_date,
        trade_price,
      },
      existingPositions,
    )
    const existing = match != null
    return {
      commodity,
      contract_month: up(p.contract_month),
      side: p.side,
      num_contracts: p.num_contracts,
      trade_date: p.trade_date,
      trade_price,
      unrealized_pnl: p.unrealized_pnl ?? null,
      crop_year: '',
      include: !existing,
      existing,
      manualMatchId: null,
      nearMiss,
    }
  }

  // Build the reviewable closed offset groups from the extraction. We prefer the
  // new closed_groups shape; if a statement comes back in the legacy per-line
  // closed_trades shape, we wrap each trade as a one-lot group (its reported
  // realized P&L becomes the group's reconciliation total) so the rest of the
  // flow is identical. Realized P&L is NEVER read from the statement — it's
  // computed per lot at render/save time (expandClosedGroup).
  function buildClosedGroups(data: BrokerageStatementExtraction): ClosedGroupRow[] {
    const raw: BrokerageClosedGroup[] = data.closed_groups?.length
      ? data.closed_groups
      : (data.closed_trades ?? []).map((t) => ({
          commodity: t.commodity,
          contract_month: t.contract_month,
          side: t.side,
          close_date: t.close_trade_date,
          close_price: t.close_price,
          lots: [{ open_date: t.open_trade_date, open_price: t.open_price, contracts: t.num_contracts }],
          statement_reported_total: t.realized_pnl ?? null,
        }))

    // Track which open DB positions a lot has already claimed so two lots can't
    // both match (and "close") the same stored position.
    const usedOpenIds = new Set<string>()
    const out: ClosedGroupRow[] = []

    for (const g of raw) {
      const commodity = normalizeCommodity(g.commodity)
      const close_price = coercePrice(g.close_price)
      if (!commodity || !g.contract_month || g.side == null || close_price == null || !g.close_date) continue
      const month = up(g.contract_month)
      const closeDate = normalizeTradeDate(g.close_date)
      const lots: ClosedLotRow[] = []
      // Sides of the open DB positions this group's lots match — they dictate
      // the group's side below (resolveClosedGroupSide).
      const matchedSides: Side[] = []

      for (const lot of g.lots ?? []) {
        const lotOpenPrice = coercePrice(lot.open_price)
        if (lotOpenPrice == null || lot.contracts == null || !lot.open_date) continue
        const lotOpenDate = normalizeTradeDate(lot.open_date)

        // Already imported as a closed position? (Statements keep listing recent
        // closed trades, so a re-upload would otherwise duplicate them.) Matched
        // on the full per-lot closed fingerprint, ignoring side; dates are
        // normalized and prices compared within tolerance, same as open dedupe.
        const alreadyImported = existingPositions.some(
          (ex) =>
            ex.status === 'closed' &&
            ex.commodity === commodity &&
            up(ex.contract_month) === month &&
            normalizeTradeDate(ex.trade_date) === lotOpenDate &&
            pricesMatch(ex.trade_price, lotOpenPrice) &&
            normalizeTradeDate(ex.close_date) === closeDate &&
            pricesMatch(ex.close_price, close_price),
        )

        // Otherwise, does this lot close an OPEN position we already hold? Match
        // on commodity + month + open date (side and price omitted: the AI can
        // mis-read both, and we'd rather anchor to the DB's verified entry). If
        // several open lots share that date, prefer the one whose price matches.
        let matchedOpenId: string | null = null
        let fromDb = false
        let open_price = lotOpenPrice
        let num_contracts = lot.contracts
        let crop_year = ''
        if (!alreadyImported) {
          const candidates = existingPositions.filter(
            (ex) =>
              ex.status === 'open' &&
              ex.commodity === commodity &&
              up(ex.contract_month) === month &&
              normalizeTradeDate(ex.trade_date) === lotOpenDate &&
              !usedOpenIds.has(ex.id),
          )
          const match = candidates.find((c) => pricesMatch(c.trade_price, lotOpenPrice)) ?? candidates[0]
          if (match) {
            matchedOpenId = match.id
            fromDb = true
            matchedSides.push(match.side)
            // Part C: anchor the math to the verified DB entry price & size; take
            // only the close price/date from the statement.
            open_price = match.trade_price
            num_contracts = match.num_contracts
            crop_year = match.crop_year != null ? String(match.crop_year) : ''
            usedOpenIds.add(match.id)
          }
        }

        lots.push({
          open_trade_date: lot.open_date,
          open_price,
          num_contracts,
          matchedOpenId,
          fromDb,
          alreadyImported,
          crop_year,
          include: !alreadyImported,
        })
      }

      if (lots.length === 0) continue
      // The matched DB positions are authoritative for the group's side: a
      // group closing short positions is short, whatever the extraction said.
      const { side, overridden } = resolveClosedGroupSide(g.side, matchedSides)
      out.push({
        commodity,
        contract_month: month,
        side,
        sideOverriddenFromDb: overridden,
        close_trade_date: g.close_date,
        close_price,
        statement_reported_total: g.statement_reported_total ?? null,
        lots,
      })
    }
    return out
  }

  // Options dedup uses a strong fingerprint (commodity + type + month + strike +
  // trade date + premium), excluding side and num_contracts for the same reason
  // as futures: those are the AI-read fields most likely to flip on re-upload.
  function buildOpenOptionRow(o: NonNullable<BrokerageStatementExtraction['open_options']>[number]): OptionOpenRow | null {
    const commodity = normalizeCommodity(o.commodity)
    const option_type = normalizeOptionType(o.option_type)
    if (!commodity || !option_type || o.side == null || !o.underlying_contract_month || o.strike_price == null || o.num_contracts == null || o.premium_cents == null || !o.trade_date) {
      return null
    }
    const existing = existingOptions.some(
      (ex) =>
        ex.commodity === commodity &&
        ex.option_type === option_type &&
        up(ex.underlying_contract_month) === up(o.underlying_contract_month!) &&
        priceEq(ex.strike_price, o.strike_price!) &&
        ex.trade_date === o.trade_date &&
        priceEq(ex.premium_cents, o.premium_cents!),
    )
    return {
      commodity,
      option_type,
      side: o.side,
      underlying_contract_month: up(o.underlying_contract_month),
      strike_price: o.strike_price,
      num_contracts: o.num_contracts,
      premium_cents: o.premium_cents,
      trade_date: o.trade_date,
      unrealized_pnl: o.unrealized_pnl ?? null,
      crop_year: '',
      include: !existing,
      existing,
    }
  }

  function buildClosedOptionRow(o: NonNullable<BrokerageStatementExtraction['closed_options']>[number]): OptionClosedRow | null {
    const commodity = normalizeCommodity(o.commodity)
    const option_type = normalizeOptionType(o.option_type)
    if (!commodity || !option_type || o.side == null || !o.underlying_contract_month || o.strike_price == null || o.num_contracts == null || o.open_premium_cents == null || o.close_premium_cents == null || !o.open_trade_date || !o.close_trade_date) {
      return null
    }
    const alreadyImported = existingOptions.some(
      (ex) =>
        ex.status !== 'open' &&
        ex.commodity === commodity &&
        ex.option_type === option_type &&
        up(ex.underlying_contract_month) === up(o.underlying_contract_month!) &&
        priceEq(ex.strike_price, o.strike_price!) &&
        ex.trade_date === o.open_trade_date &&
        priceEq(ex.premium_cents, o.open_premium_cents!) &&
        ex.close_date === o.close_trade_date,
    )
    return {
      commodity,
      option_type,
      side: o.side,
      underlying_contract_month: up(o.underlying_contract_month),
      strike_price: o.strike_price,
      num_contracts: o.num_contracts,
      open_trade_date: o.open_trade_date,
      close_trade_date: o.close_trade_date,
      open_premium_cents: o.open_premium_cents,
      close_premium_cents: o.close_premium_cents,
      realized_pnl: o.realized_pnl ?? 0,
      crop_year: '',
      include: !alreadyImported,
      alreadyImported,
    }
  }

  async function onSource(src: DocumentSource) {
    setErr(null)
    if (src.kind === 'pdf' && src.file.size > MAX_PDF_BYTES) {
      setErr('That PDF is larger than 20 MB. Please use a smaller file.')
      return
    }
    setSource(src)
    setStage('Reading document…')
    try {
      await new Promise((r) => setTimeout(r, 200))
      setStage('Extracting positions…')
      const data = await parseDocument(src.kind === 'pdf' ? src.file : src.images, 'brokerage_statement')
      setExtraction(data)
      const open = (data.open_positions ?? []).map(buildOpenRow).filter((r): r is OpenRow => r !== null)
      const closed = buildClosedGroups(data)
      const openOpts = (data.open_options ?? []).map(buildOpenOptionRow).filter((r): r is OptionOpenRow => r !== null)
      const closedOpts = (data.closed_options ?? []).map(buildClosedOptionRow).filter((r): r is OptionClosedRow => r !== null)
      setOpenRows(open)
      setClosedGroups(closed)
      setOpenOptionRows(openOpts)
      setClosedOptionRows(closedOpts)
      setTab(open.length > 0 ? 'open' : closed.length > 0 ? 'closed' : openOpts.length + closedOpts.length > 0 ? 'options' : 'summary')
    } catch (e: any) {
      if (e instanceof PdfTooLargeError) setErr(e.message)
      else setErr(e?.message ? `Couldn't read this statement: ${e.message}.` : "Couldn't read this statement.")
      setSource(null)
    } finally {
      setStage(null)
    }
  }

  function setOpen(i: number, patch: Partial<OpenRow>) {
    setOpenRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))
  }
  // Edit a single lot inside a group (include / crop year).
  function setClosedLot(gi: number, li: number, patch: Partial<ClosedLotRow>) {
    setClosedGroups((gs) =>
      gs.map((g, j) => (j === gi ? { ...g, lots: g.lots.map((l, k) => (k === li ? { ...l, ...patch } : l)) } : g)),
    )
  }
  // Side lives at the group level — flipping it re-derives every lot's realized.
  // A manual change also clears the "side set from matched positions" note,
  // since the side no longer comes from the DB.
  function setClosedGroupSide(gi: number, side: Side) {
    setClosedGroups((gs) => gs.map((g, j) => (j === gi ? { ...g, side, sideOverriddenFromDb: false } : g)))
  }
  function setOpenOption(i: number, patch: Partial<OptionOpenRow>) {
    setOpenOptionRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))
  }
  function setClosedOption(i: number, patch: Partial<OptionClosedRow>) {
    setClosedOptionRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)))
  }
  function applyBulkCropYear() {
    if (!bulkCropYear) return
    setOpenRows((rs) => rs.map((r) => (r.existing || r.manualMatchId ? r : { ...r, crop_year: bulkCropYear })))
    setClosedGroups((gs) =>
      gs.map((g) => ({
        ...g,
        // Matched (fromDb) lots already carry the DB position's crop year, and
        // already-imported lots aren't being saved — leave both alone.
        lots: g.lots.map((l) => (l.fromDb || l.alreadyImported ? l : { ...l, crop_year: bulkCropYear })),
      })),
    )
    setOpenOptionRows((rs) => rs.map((r) => (r.existing ? r : { ...r, crop_year: bulkCropYear })))
    setClosedOptionRows((rs) => rs.map((r) => (r.alreadyImported ? r : { ...r, crop_year: bulkCropYear })))
  }
  function applyBulkSide(side: Side) {
    setOpenRows((rs) => rs.map((r) => ({ ...r, side })))
    setClosedGroups((gs) => gs.map((g) => ({ ...g, side, sideOverriddenFromDb: false })))
  }

  // Per-lot realized P&L (computed, never from the statement) + per-group
  // reconciliation against the statement's printed total. Recomputes whenever a
  // group's side/lots change. We flatten to convenient working lists below.
  const closedComputed = useMemo(
    () =>
      closedGroups.map((g) => {
        const expanded = expandClosedGroup({
          contractSizeBu: pnlSizeFor(g.commodity),
          commodity: g.commodity,
          contract_month: g.contract_month,
          side: g.side,
          close_date: g.close_trade_date,
          close_price: g.close_price,
          lots: g.lots.map((l) => ({ open_date: l.open_trade_date, open_price: l.open_price, contracts: l.num_contracts })),
        })
        const lots = g.lots.map((l, i) => ({ ...l, realized_pnl: expanded[i].realized_pnl }))
        const recon = reconcileClosedGroup(expanded, g.statement_reported_total)
        return { group: g, lots, recon }
      }),
    [closedGroups],
  )
  type ComputedLot = (typeof closedComputed)[number]['lots'][number] & {
    commodity: Commodity
    contract_month: string
    side: Side
    close_trade_date: string
    close_price: number
  }
  const allClosedLots: ComputedLot[] = closedComputed.flatMap(({ group, lots }) =>
    lots.map((l) => ({
      ...l,
      commodity: group.commodity,
      contract_month: group.contract_month,
      side: group.side,
      close_trade_date: group.close_trade_date,
      close_price: group.close_price,
    })),
  )
  const closedLotCount = allClosedLots.length

  const newOpen = openRows.filter((r) => r.include && !r.existing && !r.manualMatchId)
  // Open DB positions already claimed by a manual pairing, so two statement
  // rows can't be pointed at the same stored position.
  const manuallyClaimedIds = new Set(openRows.map((r) => r.manualMatchId).filter((id): id is string => id != null))
  // Manual-pairing choices for a New row: open positions in the row's
  // commodity + month (any side — side reads are unreliable), minus ones
  // another row already claimed.
  function pairingOptions(row: OpenRow): FuturesPosition[] {
    return existingPositions.filter(
      (ex) =>
        ex.status === 'open' &&
        ex.commodity === row.commodity &&
        up(ex.contract_month) === row.contract_month &&
        (!manuallyClaimedIds.has(ex.id) || row.manualMatchId === ex.id),
    )
  }
  const closesMatched = allClosedLots.filter((r) => r.include && r.matchedOpenId && !r.alreadyImported)
  const closedToImport = allClosedLots.filter((r) => r.include && !r.matchedOpenId && !r.alreadyImported)
  const totalClosedRealized = [...closesMatched, ...closedToImport].reduce((s, r) => s + r.realized_pnl, 0)
  const anyClosedMismatch = closedComputed.some(({ recon }) => recon.hasReportedTotal && !recon.matches)
  const newOpenOptions = openOptionRows.filter((r) => r.include && !r.existing)
  const newClosedOptions = closedOptionRows.filter((r) => r.include && !r.alreadyImported)

  // --- Possibly-closed detection (a distinct second review step) -------------
  // Positions we still hold OPEN in the app that do NOT appear among the
  // statement's open positions have likely been closed. We compare conservatively
  // on commodity + contract month (ignoring the AI-unreliable side) built from the
  // RAW parsed positions (not the validated rows), and scope to the account entity
  // selected above, so we never flag a position held in another account. Anything
  // the statement explicitly closes (a matched closed trade) is already handled by
  // the import flow above and excluded here. Nothing is auto-closed — the user
  // confirms each through the real close workflow or keeps it open.
  const importEntity = importEntityId || null
  const statementOpenKeys = useMemo(() => {
    const s = new Set<string>()
    for (const p of extraction?.open_positions ?? []) {
      const c = normalizeCommodity(p.commodity)
      if (c && p.contract_month) s.add(`${c}|${up(p.contract_month)}`)
    }
    return s
  }, [extraction])
  const statementOptionKeys = useMemo(() => {
    const s = new Set<string>()
    for (const o of extraction?.open_options ?? []) {
      const c = normalizeCommodity(o.commodity)
      const t = normalizeOptionType(o.option_type)
      if (c && t && o.underlying_contract_month && o.strike_price != null) {
        s.add(`${c}|${t}|${up(o.underlying_contract_month)}|${o.strike_price.toFixed(4)}`)
      }
    }
    return s
  }, [extraction])
  const matchedCloseIds = useMemo(
    () =>
      new Set(
        closedGroups.flatMap((g) => g.lots.map((l) => l.matchedOpenId).filter((id): id is string => id != null)),
      ),
    [closedGroups],
  )
  const possiblyClosedFutures = useMemo(
    () =>
      extraction == null ? [] : existingPositions.filter(
        (p) =>
          p.status === 'open' &&
          (p.entity_id ?? null) === importEntity &&
          !keptOpenIds.has(p.id) &&
          !matchedCloseIds.has(p.id) &&
          !statementOpenKeys.has(`${p.commodity}|${up(p.contract_month)}`),
      ),
    [extraction, existingPositions, importEntity, keptOpenIds, matchedCloseIds, statementOpenKeys],
  )
  const possiblyClosedOptions = useMemo(
    () =>
      extraction == null ? [] : existingOptions.filter(
        (o) =>
          o.status === 'open' &&
          (o.entity_id ?? null) === importEntity &&
          !keptOpenIds.has(o.id) &&
          !statementOptionKeys.has(`${o.commodity}|${o.option_type}|${up(o.underlying_contract_month)}|${o.strike_price.toFixed(4)}`),
      ),
    [extraction, existingOptions, importEntity, keptOpenIds, statementOptionKeys],
  )
  const possiblyClosedCount = possiblyClosedFutures.length + possiblyClosedOptions.length
  function keepOpen(id: string) {
    setKeptOpenIds((s) => { const next = new Set(s); next.add(id); return next })
  }

  async function save() {
    setErr(null)
    if (newOpen.some((r) => !r.crop_year)) return setErr('Set a crop year on every new open position before saving.')
    if (closedToImport.some((r) => !r.crop_year)) return setErr('Set a crop year on every closed trade you are importing.')
    if (newOpenOptions.some((r) => !r.crop_year)) return setErr('Set a crop year on every new option before saving.')
    if (newClosedOptions.some((r) => !r.crop_year)) return setErr('Set a crop year on every closed option you are importing.')
    if (newOpen.length === 0 && closesMatched.length === 0 && closedToImport.length === 0 && newOpenOptions.length === 0 && newClosedOptions.length === 0) {
      return setErr('Nothing selected to import.')
    }
    setSaving(true)

    const inserts = [
      ...newOpen.map((r) => ({
        entity_id: importEntityId || null,
        commodity: r.commodity,
        contract_month: r.contract_month,
        contract_symbol: buildContractSymbol(r.commodity, r.contract_month),
        crop_year: Number(r.crop_year),
        side: r.side,
        num_contracts: r.num_contracts,
        trade_price: r.trade_price,
        trade_date: r.trade_date,
        status: 'open' as const,
        commission: 0,
        notes: null,
        source: 'statement_import' as const,
      })),
      ...closedToImport.map((r) => ({
        entity_id: importEntityId || null,
        commodity: r.commodity,
        contract_month: r.contract_month,
        contract_symbol: buildContractSymbol(r.commodity, r.contract_month),
        crop_year: Number(r.crop_year),
        side: r.side,
        num_contracts: r.num_contracts,
        trade_price: r.open_price,
        trade_date: r.open_trade_date,
        status: 'closed' as const,
        close_price: r.close_price,
        close_date: r.close_trade_date,
        realized_pnl: r.realized_pnl,
        commission: 0,
        notes: null,
        source: 'statement_import' as const,
      })),
    ]

    if (inserts.length > 0) {
      const { error } = await supabase.from('futures_positions').insert(inserts)
      if (error) { setSaving(false); setErr(`Insert failed: ${error.message}`); return }
    }

    const optionInserts = [
      ...newOpenOptions.map((r) => ({
        entity_id: importEntityId || null,
        commodity: r.commodity,
        option_type: r.option_type,
        side: r.side,
        underlying_contract_month: r.underlying_contract_month,
        underlying_symbol: buildContractSymbol(r.commodity, r.underlying_contract_month),
        strike_price: r.strike_price,
        num_contracts: r.num_contracts,
        premium_cents: r.premium_cents,
        trade_date: r.trade_date,
        crop_year: Number(r.crop_year),
        status: 'open' as const,
        commission: 0,
        notes: null,
        source: 'statement_import' as const,
      })),
      ...newClosedOptions.map((r) => ({
        entity_id: importEntityId || null,
        commodity: r.commodity,
        option_type: r.option_type,
        side: r.side,
        underlying_contract_month: r.underlying_contract_month,
        underlying_symbol: buildContractSymbol(r.commodity, r.underlying_contract_month),
        strike_price: r.strike_price,
        num_contracts: r.num_contracts,
        premium_cents: r.open_premium_cents,
        trade_date: r.open_trade_date,
        crop_year: Number(r.crop_year),
        status: 'closed_offset' as const,
        close_price_cents: r.close_premium_cents,
        close_date: r.close_trade_date,
        realized_pnl: r.realized_pnl,
        commission: 0,
        notes: null,
        source: 'statement_import' as const,
      })),
    ]
    if (optionInserts.length > 0) {
      const { error } = await supabase.from('options_positions').insert(optionInserts)
      if (error) { setSaving(false); setErr(`Option insert failed: ${error.message}`); return }
    }

    let closedCount = 0
    for (const r of closesMatched) {
      const { error } = await supabase
        .from('futures_positions')
        .update({
          status: 'closed',
          close_price: r.close_price,
          close_date: r.close_trade_date,
          realized_pnl: r.realized_pnl,
        })
        .eq('id', r.matchedOpenId!)
      if (error) { setSaving(false); setErr(`Closing matched position failed: ${error.message}`); return }
      closedCount++
    }

    setSaving(false)
    onImported({ inserted: inserts.length + optionInserts.length, closed: closedCount })
  }

  const summary = extraction?.account_summary
  const tabCls = (active: boolean) =>
    `px-3 py-2 text-sm font-semibold border-b-2 ${active ? 'border-green-700 text-green-800' : 'border-transparent text-slate-500'}`
  const cellInput = 'rounded border border-slate-300 px-2 py-1 text-sm w-full bg-white'

  return (
    <Modal onClose={onClose} title="Import Brokerage Statement" wide>
      {!extraction && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Upload a daily statement PDF (StoneX/FCStone, R.J. O’Brien, or similar), or photograph the pages with your camera. The AI extracts open positions and closed trades for
            Corn, Soybeans, Wheat, and Cotton (ICE Cotton No. 2 — statements print ¢/lb like 72.65; the app displays $0.7265/lb). You’ll review and assign crop years before anything is saved.
            Positions and closed trades you’ve already imported are detected and skipped, so you can upload each new statement without creating duplicates.
          </p>
          <DocumentCapture
            onSource={onSource}
            busy={stage != null}
            stageLabel={stage}
            pdfLabel="Choose Statement PDF or Photo"
          />
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      )}

      {extraction && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="text-sm">
              <div className="text-slate-500">Statement date</div>
              <div className="font-semibold">{extraction.statement_date ?? '—'}</div>
            </div>
            <label className="text-sm text-slate-700">
              Account entity (applied to imported positions)
              <select value={importEntityId} onChange={(e) => setImportEntityId(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 bg-white">
                <option value="">— none —</option>
                {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
              </select>
            </label>
            <label className="text-sm text-slate-700">
              Quick-fill crop year <span className="text-xs text-slate-400">optional shortcut</span>
              <div className="mt-1 flex gap-2">
                <select value={bulkCropYear} onChange={(e) => setBulkCropYear(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 bg-white">
                  <option value="">—</option>
                  {cropYearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
                <button type="button" onClick={applyBulkCropYear} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">Apply to all</button>
              </div>
            </label>
            <label className="text-sm text-slate-700">
              Set all sides <span className="text-xs text-slate-400">if the import read them wrong</span>
              <div className="mt-1 flex gap-2">
                <button type="button" onClick={() => applyBulkSide('short')} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">All Short</button>
                <button type="button" onClick={() => applyBulkSide('long')} className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm">All Long</button>
              </div>
            </label>
            <div className="flex-1" />
            <button type="button" onClick={() => { setExtraction(null); setSource(null); setOpenRows([]); setClosedGroups([]); setOpenOptionRows([]); setClosedOptionRows([]) }} className="text-sm rounded-lg bg-white border border-slate-300 px-3 py-2">
              Start over
            </button>
          </div>

          <div className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm text-sky-900">
            Set a <b>crop year for each contract</b> in the <b>Crop Yr</b> column below — different contracts on the same
            statement can be for different crop years. The Quick-fill above is just a shortcut; you can still change any row
            afterward. Every imported contract needs a crop year before you can save.
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="min-w-0">
              <div className="flex gap-1 border-b border-slate-200 mb-3">
                <button className={tabCls(tab === 'open')} onClick={() => setTab('open')}>Open Positions ({openRows.length})</button>
                <button className={tabCls(tab === 'closed')} onClick={() => setTab('closed')}>Closed Trades ({closedLotCount})</button>
                <button className={tabCls(tab === 'options')} onClick={() => setTab('options')}>Options ({openOptionRows.length + closedOptionRows.length})</button>
                <button className={tabCls(tab === 'summary')} onClick={() => setTab('summary')}>Account Summary</button>
              </div>

              {tab === 'open' && (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100 text-slate-700">
                      {/* Crop Yr sits beside Commodity (both sticky) so the two
                          per-row decisions are in first view without scrolling. */}
                      <tr>{['', 'Status', 'Commodity', 'Crop Yr *', 'Month', 'Symbol', 'Side', '#', 'Trade date', 'Price'].map((h, idx) => <th key={h} className={`text-left px-2 py-2 whitespace-nowrap ${idx === 2 ? STICKY_HEAD_1 : idx === 3 ? STICKY_HEAD_2 : ''}`}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {openRows.length === 0 && <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400">No open positions found.</td></tr>}
                      {openRows.map((r, i) => (
                        <tr key={i} className={`border-t border-slate-100 align-top ${r.existing || r.manualMatchId ? 'opacity-60' : ''}`}>
                          <td className="px-2 py-1">
                            <input type="checkbox" checked={r.include} disabled={r.existing || r.manualMatchId != null} onChange={(e) => setOpen(i, { include: e.target.checked })} />
                          </td>
                          <td className="px-2 py-1">
                            {r.existing
                              ? <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5 whitespace-nowrap">Already exists</span>
                              : r.manualMatchId
                              ? <span className="text-xs rounded-full bg-sky-100 text-sky-800 px-2 py-0.5 whitespace-nowrap">Matched to existing</span>
                              : <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5 whitespace-nowrap">New</span>}
                            {!r.existing && !r.manualMatchId && r.nearMiss && (
                              <div className="mt-1 text-[11px] leading-tight text-amber-700 max-w-[230px]">
                                Similar existing position: {r.nearMiss.position.num_contracts} @ {fmtCommodityPrice(r.commodity, r.nearMiss.position.trade_price)} on{' '}
                                {r.nearMiss.position.trade_date} ({r.nearMiss.differences.map((d) => d.message).join(', ')})
                              </div>
                            )}
                            {!r.existing && pairingOptions(r).length > 0 && (
                              <div className="mt-1">
                                <select
                                  value={r.manualMatchId ?? ''}
                                  onChange={(e) => setOpen(i, { manualMatchId: e.target.value || null, include: !e.target.value })}
                                  className="rounded border border-slate-300 px-1.5 py-0.5 text-xs bg-white max-w-[230px]"
                                  title="Mark this row as one of your existing open positions instead of importing it as new"
                                >
                                  <option value="">Match to existing…</option>
                                  {pairingOptions(r).map((ex) => (
                                    <option key={ex.id} value={ex.id}>
                                      {ex.side} {ex.num_contracts} @ {fmtCommodityPrice(r.commodity, ex.trade_price)} · {ex.trade_date}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </td>
                          <td className={`px-2 py-1 whitespace-nowrap ${STICKY_CELL_1}`}>{r.commodity}</td>
                          <td
                            className={`px-2 py-1 sticky left-[130px] z-10 ${!r.existing && !r.manualMatchId && r.include && !r.crop_year ? 'bg-amber-50' : 'bg-white'}`}
                            style={{ minWidth: 90 }}
                          >
                            {r.existing || r.manualMatchId ? <span className="text-slate-400 text-xs">—</span> : (
                              <select value={r.crop_year} onChange={(e) => setOpen(i, { crop_year: e.target.value })} className={cellInput}>
                                <option value="">— pick —</option>
                                {cropYearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
                              </select>
                            )}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">{r.contract_month}</td>
                          <td className="px-2 py-1 font-mono whitespace-nowrap">{buildContractSymbol(r.commodity, r.contract_month)}</td>
                          <td className="px-2 py-1" style={{ minWidth: 92 }}>
                            <select value={r.side} onChange={(e) => setOpen(i, { side: e.target.value as Side })} className={cellInput}>
                              <option value="short">Short</option>
                              <option value="long">Long</option>
                            </select>
                          </td>
                          <td className="px-2 py-1 text-right">{r.num_contracts}</td>
                          <td className="px-2 py-1 whitespace-nowrap">{r.trade_date}</td>
                          <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtCommodityPrice(r.commodity, r.trade_price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'closed' && (
                <div className="space-y-4">
                  <p className="text-xs text-slate-500">
                    Each offset group lists one row per opening lot with its <b>own</b> open price and an
                    individually-computed realized P&amp;L — the statement’s single GROSS PROFIT/LOSS line is the group total
                    and is used only to reconcile the subtotal below, never copied onto a lot.
                  </p>
                  {closedComputed.length === 0 && (
                    <div className="px-3 py-6 text-center text-slate-400 border border-slate-100 rounded-lg">No closed trades found.</div>
                  )}
                  {closedComputed.map(({ group: g, lots, recon }, gi) => (
                    <div key={gi} className="rounded-lg border border-slate-200 overflow-hidden">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-slate-50 px-3 py-2 border-b border-slate-200">
                        <span className="font-semibold text-slate-800">{g.commodity}</span>
                        <span className="font-mono text-slate-700">{g.contract_month}</span>
                        <span className="font-mono text-xs text-slate-500">{buildContractSymbol(g.commodity, g.contract_month)}</span>
                        <span className="text-slate-300">·</span>
                        <label className="text-xs text-slate-600 flex items-center gap-1">
                          Side
                          <select value={g.side} onChange={(e) => setClosedGroupSide(gi, e.target.value as Side)} className="rounded border border-slate-300 px-1.5 py-0.5 text-sm bg-white">
                            <option value="short">Short</option>
                            <option value="long">Long</option>
                          </select>
                        </label>
                        {g.sideOverriddenFromDb && (
                          <span
                            className="text-[11px] rounded-full bg-sky-100 text-sky-800 px-2 py-0.5"
                            title="The statement was read with the opposite side, but this group closes positions you hold on this side — your recorded positions win."
                          >
                            side corrected from your records
                          </span>
                        )}
                        <span className="text-slate-300">·</span>
                        <span className="text-xs text-slate-600">Closed {g.close_trade_date} @ <span className="font-mono">{fmtCommodityPrice(g.commodity, g.close_price)}</span></span>
                        <span className="text-xs text-slate-500">· {lots.length} lot{lots.length === 1 ? '' : 's'}</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                          <thead className="bg-slate-100 text-slate-700">
                            {/* Crop Yr beside Match — the one input per lot, in
                                first view without scrolling. */}
                            <tr>{['', 'Match', 'Crop Yr *', '#', 'Open date', 'Open $', 'Close $', 'Realized'].map((h) => <th key={h} className="text-left px-2 py-1.5 whitespace-nowrap">{h}</th>)}</tr>
                          </thead>
                          <tbody>
                            {lots.map((l, li) => (
                              <tr key={li} className={`border-t border-slate-100 align-top ${l.alreadyImported ? 'opacity-60' : ''}`}>
                                <td className="px-2 py-1"><input type="checkbox" checked={l.include} disabled={l.alreadyImported} onChange={(e) => setClosedLot(gi, li, { include: e.target.checked })} /></td>
                                <td className="px-2 py-1 whitespace-nowrap">
                                  {l.alreadyImported
                                    ? <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">Already imported</span>
                                    : l.matchedOpenId
                                    ? <span className="text-xs rounded-full bg-sky-100 text-sky-800 px-2 py-0.5">Closes open position</span>
                                    : <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Import as closed</span>}
                                </td>
                                <td className={`px-2 py-1 ${!l.matchedOpenId && !l.alreadyImported && l.include && !l.crop_year ? 'bg-amber-50' : ''}`} style={{ minWidth: 90 }}>
                                  {l.fromDb ? <span className="text-slate-400 text-xs">existing</span> : l.alreadyImported ? <span className="text-slate-400 text-xs">—</span> : (
                                    <select value={l.crop_year} onChange={(e) => setClosedLot(gi, li, { crop_year: e.target.value })} className={cellInput}>
                                      <option value="">— pick —</option>
                                      {cropYearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
                                    </select>
                                  )}
                                </td>
                                <td className="px-2 py-1 text-right">{l.num_contracts}</td>
                                <td className="px-2 py-1 whitespace-nowrap">{l.open_trade_date}</td>
                                <td className="px-2 py-1 font-mono whitespace-nowrap">
                                  {fmtCommodityPrice(g.commodity, l.open_price)}
                                  {l.fromDb && <span className="ml-1 text-[10px] font-sans text-sky-600" title="Anchored to your recorded entry price">DB</span>}
                                </td>
                                <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtCommodityPrice(g.commodity, g.close_price)}</td>
                                <td className={`px-2 py-1 font-mono whitespace-nowrap ${l.realized_pnl >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(l.realized_pnl)}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-slate-200 bg-slate-50">
                              <td colSpan={7} className="px-2 py-1.5 text-right font-semibold text-slate-700">Group subtotal</td>
                              <td className={`px-2 py-1.5 font-mono font-semibold whitespace-nowrap ${recon.computedTotal >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(recon.computedTotal)}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                      {recon.hasReportedTotal && (
                        recon.matches ? (
                          <div className="px-3 py-1.5 text-xs text-green-700 bg-green-50 border-t border-green-100">
                            ✓ Ties to the statement total ({fmtPnl(recon.reportedTotal!)}).
                          </div>
                        ) : recon.signFlipSuspected ? (
                          <div className="px-3 py-2 text-sm text-amber-900 bg-amber-50 border-t border-amber-200">
                            ⚠ <b>Computed P&amp;L ({fmtPnl(recon.computedTotal)}) is the exact opposite of the statement total ({fmtPnl(recon.reportedTotal!)})</b> — the side is likely inverted.
                            <button
                              type="button"
                              onClick={() => setClosedGroupSide(gi, g.side === 'long' ? 'short' : 'long')}
                              className="ml-2 rounded-lg bg-amber-600 text-white px-2.5 py-1 text-xs font-semibold"
                            >
                              Flip to {g.side === 'long' ? 'Short' : 'Long'}
                            </button>
                          </div>
                        ) : (
                          <div className="px-3 py-2 text-sm text-red-800 bg-red-50 border-t border-red-200">
                            ⚠ <b>Computed realized P&amp;L ({fmtPnl(recon.computedTotal)}) doesn’t match the statement total ({fmtPnl(recon.reportedTotal!)})</b> — review the per-lot breakdown above before saving.
                          </div>
                        )
                      )}
                    </div>
                  ))}
                </div>
              )}

              {tab === 'options' && (
                <div className="space-y-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-700 mb-1">Open options</div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-100 text-slate-700">
                          <tr>{['', 'Status', 'Commodity', 'Month', 'Type', 'Side', 'Strike', '#', 'Premium ¢', 'Total $', 'Crop Yr *'].map((h) => <th key={h} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
                        </thead>
                        <tbody>
                          {openOptionRows.length === 0 && <tr><td colSpan={11} className="px-3 py-6 text-center text-slate-400">No open options found.</td></tr>}
                          {openOptionRows.map((r, i) => (
                            <tr key={i} className={`border-t border-slate-100 align-top ${r.existing ? 'opacity-60' : ''}`}>
                              <td className="px-2 py-1"><input type="checkbox" checked={r.include} disabled={r.existing} onChange={(e) => setOpenOption(i, { include: e.target.checked })} /></td>
                              <td className="px-2 py-1 whitespace-nowrap">{r.existing ? <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">Already exists</span> : <span className="text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">New</span>}</td>
                              <td className="px-2 py-1 whitespace-nowrap">{r.commodity}</td>
                              <td className="px-2 py-1 whitespace-nowrap">{r.underlying_contract_month}</td>
                              <td className="px-2 py-1 capitalize">{r.option_type}</td>
                              <td className="px-2 py-1 capitalize">{r.side}</td>
                              <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtCommodityPrice(r.commodity, r.strike_price)}</td>
                              <td className="px-2 py-1 text-right">{r.num_contracts}</td>
                              <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtCents(r.premium_cents)}</td>
                              {/* Contract size from the commodity spec — cotton options are 50,000 lbs, never the 5,000-bu grain default. */}
                              <td className="px-2 py-1 font-mono whitespace-nowrap">${optionPremiumTotal(r.premium_cents, r.num_contracts, COMMODITY_SPECS[r.commodity]?.contractSizeBu).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                              <td className={`px-2 py-1 ${!r.existing && r.include && !r.crop_year ? 'bg-amber-50' : ''}`} style={{ minWidth: 90 }}>
                                {r.existing ? <span className="text-slate-400 text-xs">—</span> : (
                                  <select value={r.crop_year} onChange={(e) => setOpenOption(i, { crop_year: e.target.value })} className={cellInput}>
                                    <option value="">— pick —</option>
                                    {cropYearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
                                  </select>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {closedOptionRows.length > 0 && (
                    <div>
                      <div className="text-sm font-semibold text-slate-700 mb-1">Closed options</div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                          <thead className="bg-slate-100 text-slate-700">
                            <tr>{['', 'Match', 'Commodity', 'Month', 'Type', 'Side', 'Strike', '#', 'Open ¢', 'Close ¢', 'Realized', 'Crop Yr *'].map((h) => <th key={h} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
                          </thead>
                          <tbody>
                            {closedOptionRows.map((r, i) => (
                              <tr key={i} className={`border-t border-slate-100 align-top ${r.alreadyImported ? 'opacity-60' : ''}`}>
                                <td className="px-2 py-1"><input type="checkbox" checked={r.include} disabled={r.alreadyImported} onChange={(e) => setClosedOption(i, { include: e.target.checked })} /></td>
                                <td className="px-2 py-1 whitespace-nowrap">{r.alreadyImported ? <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">Already imported</span> : <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Import as closed</span>}</td>
                                <td className="px-2 py-1 whitespace-nowrap">{r.commodity}</td>
                                <td className="px-2 py-1 whitespace-nowrap">{r.underlying_contract_month}</td>
                                <td className="px-2 py-1 capitalize">{r.option_type}</td>
                                <td className="px-2 py-1 capitalize">{r.side}</td>
                                <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtCommodityPrice(r.commodity, r.strike_price)}</td>
                                <td className="px-2 py-1 text-right">{r.num_contracts}</td>
                                <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtCents(r.open_premium_cents)}</td>
                                <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtCents(r.close_premium_cents)}</td>
                                <td className={`px-2 py-1 font-mono whitespace-nowrap ${r.realized_pnl >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmtPnl(r.realized_pnl)}</td>
                                <td className={`px-2 py-1 ${!r.alreadyImported && r.include && !r.crop_year ? 'bg-amber-50' : ''}`} style={{ minWidth: 90 }}>
                                  {r.alreadyImported ? <span className="text-slate-400 text-xs">—</span> : (
                                    <select value={r.crop_year} onChange={(e) => setClosedOption(i, { crop_year: e.target.value })} className={cellInput}>
                                      <option value="">— pick —</option>
                                      {cropYearOptions().map((y) => <option key={y} value={y}>{y}</option>)}
                                    </select>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {tab === 'summary' && (
                <div className="text-sm">
                  {summary ? (
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 max-w-md">
                      {[
                        ['Beginning balance', summary.beginning_balance],
                        ['Ending balance', summary.ending_balance],
                        ['Open trade equity', summary.open_trade_equity],
                        ['Total equity', summary.total_equity],
                        ['Margin requirement', summary.margin_requirement],
                        ['Excess equity', summary.excess_equity],
                      ].map(([label, val]) => (
                        <div key={label as string} className="contents">
                          <dt className="text-slate-500">{label as string}</dt>
                          <dd className="text-right font-mono">{val == null ? '—' : fmtPnl(Number(val))}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : <p className="text-slate-400">No account summary found.</p>}
                  <p className="text-xs text-slate-400 mt-2">For reference only — account balances change daily and are not stored.</p>
                </div>
              )}
            </div>

            {source && (
              <div className="lg:sticky lg:top-3 self-start h-[60vh] min-h-[360px]">
                <div className="text-xs text-slate-500 mb-1">Source statement — cross-reference while reviewing</div>
                <SourcePreview source={source} className="h-full" title="Brokerage statement" />
              </div>
            )}
          </div>

          {/* Step 2 — positions we hold open that the statement no longer lists.
              Deliberately separated from the import above so the two review steps
              read as distinct: (a) new positions to add, (b) existing positions
              that may need closing. Nothing here changes unless the user acts. */}
          {possiblyClosedCount > 0 && (
            <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3 space-y-3">
              <div>
                <div className="font-semibold text-amber-900">
                  Possibly closed — {possiblyClosedCount} open position{possiblyClosedCount === 1 ? '' : 's'} in your records didn’t appear on this statement
                </div>
                <p className="text-xs text-amber-800 mt-0.5">
                  A position you hold open that isn’t on the latest statement has likely been closed. This is a separate step
                  from the new positions above. Choose <b>Close this position</b> to record it through the normal close
                  workflow (you enter the actual close price &amp; date — nothing is auto-closed), or <b>Keep open</b> if it’s
                  on a different account or this statement was partial. Comparison is scoped to the account entity selected
                  above{importEntity ? '' : ' (none — comparing positions with no entity)'}.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-amber-100 text-amber-900">
                    <tr>{['Type', 'Commodity', 'Contract', 'Side', '#', 'Entry', 'Crop Yr', ''].map((h) => <th key={h} className="text-left px-2 py-1.5 whitespace-nowrap">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {possiblyClosedFutures.map((p) => (
                      <tr key={p.id} className="border-t border-amber-200">
                        <td className="px-2 py-1.5">Futures</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{p.commodity}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{p.contract_month}</td>
                        <td className="px-2 py-1.5 capitalize">{p.side}</td>
                        <td className="px-2 py-1.5 text-right">{p.num_contracts}</td>
                        <td className="px-2 py-1.5 font-mono whitespace-nowrap">{fmtCommodityPrice(p.commodity, p.trade_price)}</td>
                        <td className="px-2 py-1.5">{p.crop_year}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-right">
                          <button type="button" onClick={() => setClosingFut(p)} className="rounded-lg bg-sky-700 text-white px-2.5 py-1 text-xs font-semibold mr-2">Close this position</button>
                          <button type="button" onClick={() => keepOpen(p.id)} className="rounded-lg bg-white border border-slate-300 px-2.5 py-1 text-xs">Keep open</button>
                        </td>
                      </tr>
                    ))}
                    {possiblyClosedOptions.map((o) => (
                      <tr key={o.id} className="border-t border-amber-200">
                        <td className="px-2 py-1.5">Option</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{o.commodity}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{o.underlying_contract_month} {fmtCommodityPrice(o.commodity, o.strike_price)} {o.option_type}</td>
                        <td className="px-2 py-1.5 capitalize">{o.side}</td>
                        <td className="px-2 py-1.5 text-right">{o.num_contracts}</td>
                        <td className="px-2 py-1.5 font-mono whitespace-nowrap">{fmtCents(o.premium_cents)}</td>
                        <td className="px-2 py-1.5">{o.crop_year}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-right">
                          <button type="button" onClick={() => setClosingOpt(o)} className="rounded-lg bg-sky-700 text-white px-2.5 py-1 text-xs font-semibold mr-2">Close this position</button>
                          <button type="button" onClick={() => keepOpen(o.id)} className="rounded-lg bg-white border border-slate-300 px-2.5 py-1 text-xs">Keep open</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {err && <p className="text-sm text-red-600">{err}</p>}

          <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
            <div className="text-sm text-slate-600 flex-1">
              <div>
                Will import <b>{newOpen.length}</b> new open · close <b>{closesMatched.length}</b> matched · import <b>{closedToImport.length}</b> closed · <b>{newOpenOptions.length + newClosedOptions.length}</b> options
              </div>
              {(closesMatched.length > 0 || closedToImport.length > 0) && (
                <div className="text-xs text-slate-500 mt-0.5">
                  Total realized P&amp;L on closes:{' '}
                  <b className={totalClosedRealized >= 0 ? 'text-green-700' : 'text-red-700'}>{fmtPnl(totalClosedRealized)}</b>
                  {' '}(computed per lot)
                </div>
              )}
              {anyClosedMismatch && (
                <div className="text-xs text-red-700 mt-0.5">⚠ A closed group’s computed total doesn’t match the statement — see the Closed Trades tab.</div>
              )}
            </div>
            <button type="button" onClick={save} disabled={saving} className="rounded-xl bg-brand hover:bg-brand-deep text-white font-semibold py-2.5 px-5 disabled:opacity-60">
              {saving ? 'Saving…' : 'Save Import'}
            </button>
            <button type="button" onClick={onClose} className="rounded-xl bg-white border border-slate-300 px-4 py-2.5 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* The real close workflow, pre-filled with the flagged position. On save we
          ask the parent to reload; the refreshed positions then drop out of the
          possibly-closed list above (the closed one is no longer 'open'). */}
      {closingFut && (
        <ClosePositionDialog
          position={closingFut}
          onClose={() => setClosingFut(null)}
          onSaved={() => { setClosingFut(null); onChanged?.() }}
        />
      )}
      {closingOpt && (
        <CloseOptionDialog
          position={closingOpt}
          onClose={() => setClosingOpt(null)}
          onSaved={() => { setClosingOpt(null); onChanged?.() }}
        />
      )}
    </Modal>
  )
}
