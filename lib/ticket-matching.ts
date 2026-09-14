// Tolerant settlement-to-load ticket matching (086) — the shared seam the
// settlement upload review, relinkSettlementLines and the assistant tools
// all use. Pure.
//
// Our internal ticket numbers embed the buyer's ticket plus our own
// dash-delimited segments (buyer 498074 stored as "498074-02-A" or
// "12-498074"); buyers print their own forms ("0498074"). So matching runs
// in tiers, each with a confidence and a plain reason:
//
//   Tier 1 EXACT     — equal after normalization (trim, case, strip leading
//                      zeros). High confidence.
//   Tier 2 SEGMENT   — split both sides on dashes / slashes / spaces; the
//                      settlement ticket equals a numeric-substantial (≥ 4
//                      chars) segment of the load's ticket, or vice versa.
//                      The settlement's secondary identifiers (Bunge's Load
//                      Order #) are tried the same way. High confidence.
//   Tier 3 ATTRIBUTE — no text match: same crop, same buyer, delivery date
//                      within ±1 day, net bushels within 1% of our dry
//                      bushels (or exact gross / tare) — corroborated by the
//                      vehicle plate → truck when the statement prints one.
//                      One candidate → medium confidence (pre-checked, "matched
//                      by date + weight"); several → the user picks; none →
//                      unmatched.
//
// Once a Tier 2/3 match is confirmed, the load's ticket is written back so
// the next statement matches on Tier 1.

export type MatchTier = 'exact' | 'segment' | 'attribute'
export type MatchConfidence = 'high' | 'medium'

export type TicketMatchLoad = {
  id: string
  ticket_number: string | null
  crop_id?: string | null
  to_buyer_id?: string | null
  date?: string | null
  /** Our FSA-standard dry bushels (lib/shrink computeBushels). */
  dry_bushels?: number | null
  gross_weight?: number | null
  tare_weight?: number | null
  net_weight?: number | null
  truck_id?: string | null
  /** The truck's license plate, when known (trucks.license_plate). */
  license_plate?: string | null
}

export type TicketMatchLine = {
  ticket_number: string | null
  /** Secondary identifiers printed for the ticket (Load Order #, BOL…). */
  secondary_refs?: ReadonlyArray<string | null | undefined>
  net_bushels?: number | null
  gross_weight?: number | null
  tare_weight?: number | null
  delivery_date?: string | null
  vehicle_plate?: string | null
}

export type TicketMatchContext = {
  crop_id?: string | null
  buyer_id?: string | null
}

export type TicketMatch = {
  tier: MatchTier
  confidence: MatchConfidence
  loadId: string
  /** Plain-language reason shown on the review screen. */
  reason: string
}

export type TicketMatchResult =
  | { status: 'matched'; match: TicketMatch; candidates: TicketMatch[] }
  | { status: 'ambiguous'; candidates: TicketMatch[] }
  | { status: 'unmatched'; candidates: [] }

/** Trim, uppercase, strip leading zeros from purely numeric tokens
 *  ("0498074" → "498074", " ab-01 " → "AB-01"). */
export function normalizeTicket(s: string | null | undefined): string {
  const t = (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
  if (!t) return ''
  return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t
}

const SEGMENT_MIN = 4

/** Dash / slash / space-delimited segments, normalized, keeping only
 *  numeric-substantial ones (≥ 4 chars with at least 4 digits) — "02" and
 *  "A" in "498074-02-A" never match anything. */
export function ticketSegments(s: string | null | undefined): string[] {
  const t = (s ?? '').trim().toUpperCase()
  if (!t) return []
  return t
    .split(/[-/\s]+/)
    .map((seg) => (/^\d+$/.test(seg) ? seg.replace(/^0+(?=\d)/, '') : seg))
    .filter((seg) => seg.length >= SEGMENT_MIN && (seg.match(/\d/g) ?? []).length >= SEGMENT_MIN)
}

function segmentHit(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeTicket(a)
  const nb = normalizeTicket(b)
  if (!na || !nb) return false
  const sa = ticketSegments(a)
  const sb = ticketSegments(b)
  // The whole normalized ticket equals a segment of the other side.
  if (na.length >= SEGMENT_MIN && (na.match(/\d/g) ?? []).length >= SEGMENT_MIN && sb.includes(na)) return true
  if (nb.length >= SEGMENT_MIN && (nb.match(/\d/g) ?? []).length >= SEGMENT_MIN && sa.includes(nb)) return true
  return false
}

function dayDiff(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  const da = Date.parse(String(a).slice(0, 10))
  const db = Date.parse(String(b).slice(0, 10))
  if (!Number.isFinite(da) || !Number.isFinite(db)) return null
  return Math.abs(da - db) / 86_400_000
}

const normPlate = (p: string | null | undefined) => (p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Match one settlement line against the loads (already narrowed to the
 *  settlement's buyer / crop where possible; `alreadyUsed` = load ids
 *  claimed by earlier lines). */
export function matchTicket(
  line: TicketMatchLine,
  loads: ReadonlyArray<TicketMatchLoad>,
  ctx: TicketMatchContext = {},
  alreadyUsed: ReadonlySet<string> = new Set(),
): TicketMatchResult {
  // Every tier stays inside the settlement's buyer and crop when both sides
  // know them — a ticket number is the BUYER's number, so the same digits on
  // a load hauled to someone else are a different load.
  const pool = loads.filter((l) =>
    !alreadyUsed.has(l.id)
    && !(ctx.buyer_id && l.to_buyer_id && l.to_buyer_id !== ctx.buyer_id)
    && !(ctx.crop_id && l.crop_id && l.crop_id !== ctx.crop_id))
  const lineNorm = normalizeTicket(line.ticket_number)

  // Tier 1 — exact after normalization.
  if (lineNorm) {
    const exact = pool.filter((l) => normalizeTicket(l.ticket_number) === lineNorm)
    if (exact.length === 1) {
      const m: TicketMatch = { tier: 'exact', confidence: 'high', loadId: exact[0].id, reason: `ticket ${lineNorm} matches exactly` }
      return { status: 'matched', match: m, candidates: [m] }
    }
    if (exact.length > 1) {
      return { status: 'ambiguous', candidates: exact.map((l) => ({ tier: 'exact', confidence: 'high', loadId: l.id, reason: `ticket ${lineNorm} matches exactly (several loads carry it)` })) }
    }
  }

  // Tier 2 — segment match on the ticket, then on the secondary refs.
  const keys: Array<{ value: string; label: string }> = []
  if (lineNorm) keys.push({ value: line.ticket_number ?? '', label: `ticket ${lineNorm}` })
  for (const ref of line.secondary_refs ?? []) {
    const n = normalizeTicket(ref)
    if (n) keys.push({ value: ref ?? '', label: `load order ${n}` })
  }
  for (const key of keys) {
    const hits = pool.filter((l) => segmentHit(key.value, l.ticket_number))
    if (hits.length === 1) {
      const m: TicketMatch = { tier: 'segment', confidence: 'high', loadId: hits[0].id, reason: `${key.label} is part of our ticket ${normalizeTicket(hits[0].ticket_number)}` }
      return { status: 'matched', match: m, candidates: [m] }
    }
    if (hits.length > 1) {
      return { status: 'ambiguous', candidates: hits.map((l) => ({ tier: 'segment', confidence: 'high', loadId: l.id, reason: `${key.label} is part of our ticket ${normalizeTicket(l.ticket_number)}` })) }
    }
  }

  // Tier 3 — attributes: crop + buyer + date ±1 + bushels within 1% (or
  // exact gross / tare), plate corroborating.
  const attrAll = pool.filter((l) => {
    const dd = dayDiff(line.delivery_date, l.date)
    if (dd == null || dd > 1) return false
    const buOk = line.net_bushels != null && l.dry_bushels != null && l.dry_bushels > 0 && Math.abs(line.net_bushels - l.dry_bushels) <= l.dry_bushels * 0.01
    const wtOk = line.gross_weight != null && line.tare_weight != null && l.gross_weight != null && l.tare_weight != null
      && Number(line.gross_weight) === Number(l.gross_weight) && Number(line.tare_weight) === Number(l.tare_weight)
    return buOk || wtOk
  })
  // A load that already carries a ticket which did NOT text-match is most
  // likely a different load; prefer the ticket-less candidates when any exist.
  const ticketless = attrAll.filter((l) => !normalizeTicket(l.ticket_number))
  const attr = ticketless.length > 0 ? ticketless : attrAll
  const plate = normPlate(line.vehicle_plate)
  const corroborated = plate ? attr.filter((l) => normPlate(l.license_plate) === plate) : []
  const finalists = corroborated.length > 0 ? corroborated : attr
  const describe = (l: TicketMatchLoad): TicketMatch => {
    const bits = ['date']
    if (line.net_bushels != null && l.dry_bushels != null) bits.push('bushels'); else bits.push('weights')
    if (plate && normPlate(l.license_plate) === plate) bits.push('plate')
    return { tier: 'attribute', confidence: 'medium', loadId: l.id, reason: `matched by ${bits.join(' + ')}` }
  }
  if (finalists.length === 1) {
    const m = describe(finalists[0])
    return { status: 'matched', match: m, candidates: [m] }
  }
  if (finalists.length > 1) return { status: 'ambiguous', candidates: finalists.map(describe) }
  return { status: 'unmatched', candidates: [] }
}

/** Match every line in order, each confirmed match claiming its load. */
export function matchAllTickets(
  lines: ReadonlyArray<TicketMatchLine>,
  loads: ReadonlyArray<TicketMatchLoad>,
  ctx: TicketMatchContext = {},
): TicketMatchResult[] {
  const used = new Set<string>()
  return lines.map((line) => {
    const r = matchTicket(line, loads, ctx, used)
    if (r.status === 'matched') used.add(r.match.loadId)
    return r
  })
}
