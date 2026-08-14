// The unified settings document upload — pure layer.
//
// One AI call (parse-document type 'settings_document') extracts EVERY
// settings-relevant thing from any document; this module turns the raw
// response into a reviewable, saveable plan:
//
//   normalizeSettingsExtraction  raw JSON → typed sections, numbers coerced
//   mergeSettingsExtractions     concat multi-batch results
//   buildSettingsReview          rows classified Matched / Update / New /
//                                Possible through the EXISTING resolution
//                                seams (FSA-then-name farm match, county via
//                                normalizeCountyName + state, strict variety
//                                pipeline, single-entity auto-assign,
//                                case-insensitive buyer guard) — never a
//                                parallel matching rule
//   planSettingsSave             dependency-ordered steps (entities →
//                                landowners → crops → farms → fields →
//                                plantings(+varieties); buyers/bins/gins/
//                                trucks independent) with within-batch
//                                parent references
//   executeSettingsSave          sequential writes resolving refs as parents
//                                are created; a failure deletes everything
//                                created this batch, in reverse order
//
// Confirmation is the contract: nothing unchecked is ever planned, and an
// undecided Possible match blocks its row.

import { findBestMatch } from '@/lib/fuzzy'
import { normalizeCountyName, normalizeStateCode } from '@/lib/fsa-benchmark-file'
import { defaultEntityId } from '@/lib/entity-default'
import { matchExistingBuyer } from '@/lib/ai-lookups'
import { buildVarietyPlan, resolvedName, varietyKey, type VarietyPlan, type VarietyDecision } from '@/lib/variety-resolution'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Raw response shape (the prompt's JSON, everything defensive-nullable).
// ---------------------------------------------------------------------------

type RawSource = { source?: string | null }
export type RawSettingsExtraction = {
  document_kinds?: string[] | null
  confidence?: 'high' | 'medium' | 'low' | null
  entities?: Array<{ name?: string | null } & RawSource> | null
  landowners?: Array<{ name?: string | null; phone?: string | null; email?: string | null; address?: string | null } & RawSource> | null
  farms?: Array<{
    name?: string | null; fsa_farm_number?: string | null; county?: string | null; state?: string | null
    entity_name?: string | null; landowner_name?: string | null
    share_rent?: boolean | null; landlord_share_percentage?: number | string | null; cash_rent_per_acre?: number | string | null
  } & RawSource> | null
  fields?: Array<{
    name?: string | null; farm_name?: string | null; fsa_farm_number?: string | null
    total_acres?: number | string | null; irrigated_acres?: number | string | null
    county?: string | null; state?: string | null
  } & RawSource> | null
  plantings?: Array<{
    field_name?: string | null; farm_name?: string | null; crop?: string | null; crop_year?: number | string | null
    planted_acres?: number | string | null; irrigated_acres?: number | string | null; planting_date?: string | null
    varieties?: Array<{ variety?: string | null; acres?: number | string | null }> | null
  } & RawSource> | null
  buyers?: Array<{ name?: string | null; locations?: Array<{ name?: string | null; address?: string | null }> | null } & RawSource> | null
  bin_sites?: Array<{ name?: string | null; address?: string | null; bins?: Array<{ name?: string | null; capacity_bushels?: number | string | null }> | null } & RawSource> | null
  gins?: Array<{ name?: string | null; address?: string | null; phone?: string | null } & RawSource> | null
  trucks?: Array<{ name?: string | null } & RawSource> | null
  crops?: Array<{ name?: string | null } & RawSource> | null
}

// ---------------------------------------------------------------------------
// Normalized sections.
// ---------------------------------------------------------------------------

export const SETTINGS_SECTIONS = [
  'entities', 'landowners', 'farms', 'fields', 'plantings',
  'buyers', 'bin_sites', 'gins', 'trucks', 'crops',
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const SECTION_LABELS: Record<SettingsSection, string> = {
  entities: 'Entities', landowners: 'Landowners', farms: 'Farms', fields: 'Fields',
  plantings: 'Plantings', buyers: 'Buyers', bin_sites: 'Bin sites & bins',
  gins: 'Gins', trucks: 'Trucks', crops: 'Crops',
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export type NormalizedSettingsExtraction = {
  documentKinds: string[]
  entities: Array<{ name: string; source: string | null }>
  landowners: Array<{ name: string; phone: string | null; email: string | null; address: string | null; source: string | null }>
  farms: Array<{
    name: string; fsaNumber: string | null; county: string | null; state: string | null
    entityName: string | null; landownerName: string | null
    shareRent: boolean | null; landlordSharePct: number | null; cashRentPerAcre: number | null
    source: string | null
  }>
  fields: Array<{
    name: string; farmName: string | null; fsaNumber: string | null
    totalAcres: number | null; irrigatedAcres: number | null
    county: string | null; state: string | null; source: string | null
  }>
  plantings: Array<{
    fieldName: string; farmName: string | null; crop: string | null; cropYear: number | null
    plantedAcres: number | null; irrigatedAcres: number | null; plantingDate: string | null
    varieties: Array<{ variety: string; acres: number | null }>
    source: string | null
  }>
  buyers: Array<{ name: string; locations: Array<{ name: string; address: string | null }>; source: string | null }>
  binSites: Array<{ name: string; address: string | null; bins: Array<{ name: string; capacityBushels: number | null }>; source: string | null }>
  gins: Array<{ name: string; address: string | null; phone: string | null; source: string | null }>
  trucks: Array<{ name: string; source: string | null }>
  crops: Array<{ name: string; source: string | null }>
}

export function normalizeSettingsExtraction(raw: RawSettingsExtraction | null | undefined): NormalizedSettingsExtraction {
  const r = raw ?? {}
  return {
    documentKinds: Array.isArray(r.document_kinds) ? r.document_kinds.filter((k): k is string => typeof k === 'string') : [],
    entities: (r.entities ?? []).flatMap((e) => {
      const name = str(e?.name)
      return name ? [{ name, source: str(e?.source) }] : []
    }),
    landowners: (r.landowners ?? []).flatMap((l) => {
      const name = str(l?.name)
      return name ? [{ name, phone: str(l?.phone), email: str(l?.email), address: str(l?.address), source: str(l?.source) }] : []
    }),
    farms: (r.farms ?? []).flatMap((f) => {
      const name = str(f?.name) ?? (str(f?.fsa_farm_number) ? `Farm ${str(f?.fsa_farm_number)}` : null)
      if (!name) return []
      const pct = num(f?.landlord_share_percentage)
      return [{
        name,
        fsaNumber: str(f?.fsa_farm_number),
        county: str(f?.county), state: str(f?.state),
        entityName: str(f?.entity_name), landownerName: str(f?.landowner_name),
        // A stated share % implies share rent even when the flag was omitted.
        shareRent: f?.share_rent ?? (pct != null ? true : null),
        landlordSharePct: pct != null && pct >= 0 && pct <= 100 ? pct : null,
        cashRentPerAcre: (() => { const c = num(f?.cash_rent_per_acre); return c != null && c >= 0 ? c : null })(),
        source: str(f?.source),
      }]
    }),
    fields: (r.fields ?? []).flatMap((f) => {
      const name = str(f?.name)
      return name ? [{
        name, farmName: str(f?.farm_name), fsaNumber: str(f?.fsa_farm_number),
        totalAcres: num(f?.total_acres), irrigatedAcres: num(f?.irrigated_acres),
        county: str(f?.county), state: str(f?.state), source: str(f?.source),
      }] : []
    }),
    plantings: (r.plantings ?? []).flatMap((p) => {
      const fieldName = str(p?.field_name)
      return fieldName ? [{
        fieldName, farmName: str(p?.farm_name), crop: str(p?.crop), cropYear: num(p?.crop_year),
        plantedAcres: num(p?.planted_acres), irrigatedAcres: num(p?.irrigated_acres),
        plantingDate: str(p?.planting_date),
        varieties: (p?.varieties ?? []).flatMap((v) => {
          const variety = str(v?.variety)
          return variety ? [{ variety, acres: num(v?.acres) }] : []
        }),
        source: str(p?.source),
      }] : []
    }),
    buyers: (r.buyers ?? []).flatMap((b) => {
      const name = str(b?.name)
      return name ? [{
        name,
        locations: (b?.locations ?? []).flatMap((l) => {
          const ln = str(l?.name)
          return ln ? [{ name: ln, address: str(l?.address) }] : []
        }),
        source: str(b?.source),
      }] : []
    }),
    binSites: (r.bin_sites ?? []).flatMap((s) => {
      const name = str(s?.name)
      return name ? [{
        name, address: str(s?.address),
        bins: (s?.bins ?? []).flatMap((b) => {
          const bn = str(b?.name)
          return bn ? [{ name: bn, capacityBushels: num(b?.capacity_bushels) }] : []
        }),
        source: str(s?.source),
      }] : []
    }),
    gins: (r.gins ?? []).flatMap((g) => {
      const name = str(g?.name)
      return name ? [{ name, address: str(g?.address), phone: str(g?.phone), source: str(g?.source) }] : []
    }),
    trucks: (r.trucks ?? []).flatMap((t) => {
      const name = str(t?.name)
      return name ? [{ name, source: str(t?.source) }] : []
    }),
    crops: (r.crops ?? []).flatMap((c) => {
      const name = str(c?.name)
      return name ? [{ name, source: str(c?.source) }] : []
    }),
  }
}

/** Concatenate multi-batch extractions (PDF batches / photo sets), deduping
 *  identical names within a section so a record spanning a page boundary
 *  doesn't double up. */
export function mergeSettingsExtractions(parts: readonly NormalizedSettingsExtraction[]): NormalizedSettingsExtraction {
  const out = normalizeSettingsExtraction({})
  const seen = new Map<string, Set<string>>()
  const keep = <T extends { name?: string; fieldName?: string }>(section: string, item: T, key?: string): boolean => {
    const k = (key ?? item.name ?? item.fieldName ?? '').toLowerCase()
    let s = seen.get(section)
    if (!s) { s = new Set(); seen.set(section, s) }
    if (s.has(k)) return false
    s.add(k)
    return true
  }
  for (const p of parts) {
    out.documentKinds.push(...p.documentKinds.filter((k) => !out.documentKinds.includes(k)))
    out.entities.push(...p.entities.filter((x) => keep('entities', x)))
    out.landowners.push(...p.landowners.filter((x) => keep('landowners', x)))
    out.farms.push(...p.farms.filter((x) => keep('farms', x, `${x.fsaNumber ?? ''}|${x.name}`.toLowerCase())))
    out.fields.push(...p.fields.filter((x) => keep('fields', x, `${x.farmName ?? ''}|${x.name}`.toLowerCase())))
    out.plantings.push(...p.plantings.filter((x) => keep('plantings', x, `${x.fieldName}|${x.crop ?? ''}|${x.cropYear ?? ''}`.toLowerCase())))
    out.buyers.push(...p.buyers.filter((x) => keep('buyers', x)))
    out.binSites.push(...p.binSites.filter((x) => keep('bin_sites', x)))
    out.gins.push(...p.gins.filter((x) => keep('gins', x)))
    out.trucks.push(...p.trucks.filter((x) => keep('trucks', x)))
    out.crops.push(...p.crops.filter((x) => keep('crops', x)))
  }
  return out
}

// ---------------------------------------------------------------------------
// Review building — classification through the existing seams.
// ---------------------------------------------------------------------------

export type SettingsReviewContext = {
  entities: ReadonlyArray<{ id: string; name: string }>
  landowners: ReadonlyArray<{ id: string; name: string; phone: string | null; email: string | null; address: string | null }>
  farms: ReadonlyArray<{
    id: string; name: string; fsa_number: string | null; county_id: string | null
    entity_id: string | null; landowner_id: string | null
    is_share_rent: boolean; landlord_share_percentage: number | null; cash_rent_per_acre?: number | null
  }>
  fields: ReadonlyArray<{ id: string; farm_id: string | null; name_or_number: string; total_acres: number | null; irrigated_acres: number | null; county_id: string | null }>
  plantings: ReadonlyArray<{ id: string; field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null; irrigated_acres: number | string | null }>
  buyers: ReadonlyArray<{ id: string; name: string }>
  deliveryLocations: ReadonlyArray<{ id: string; buyer_id: string; name: string }>
  binSites: ReadonlyArray<{ id: string; name: string }>
  bins: ReadonlyArray<{ id: string; bin_site_id: string | null; name_or_number: string; capacity_bushels: number | null }>
  gins: ReadonlyArray<{ id: string; name: string }>
  trucks: ReadonlyArray<{ id: string; name_or_number: string }>
  crops: ReadonlyArray<{ id: string; name: string }>
  counties: ReadonlyArray<{ id: string; name: string; state: string; state_code: string }>
  existingVarietyNames: string[]
  dismissedVarietyPairs?: ReadonlySet<string>
}

export type RowClass = 'exists' | 'update' | 'new' | 'possible'
export type FieldDiff = { label: string; existing: string; incoming: string }

/** A parent reference: an existing row's id, or another review row created in
 *  this same batch (by row key) — the cross-reference the review resolved. */
export type ParentRef = { id: string } | { ref: string } | null

export type SettingsReviewRow = {
  key: string
  section: SettingsSection
  label: string
  detail: string | null
  source: string | null
  cls: RowClass
  diffs: FieldDiff[]
  matchedId: string | null
  /** Fuzzy candidate for 'possible' rows — the user must pick existing-vs-new. */
  candidate: { id: string; label: string } | null
  include: boolean
  /** Section-specific payload + refs, consumed by planSettingsSave. */
  draft: Record<string, unknown> & {
    entityRef?: ParentRef; landownerRef?: ParentRef; farmRef?: ParentRef
    fieldRef?: ParentRef; buyerRef?: ParentRef; siteRef?: ParentRef; cropRef?: ParentRef
  }
  /** Unmatched raw text worth showing as "AI: …" hints (e.g. county). */
  hints: string[]
}

export type SettingsReviewSection = {
  section: SettingsSection
  rows: SettingsReviewRow[]
}

export type SettingsReview = {
  sections: SettingsReviewSection[]
  varietyPlan: VarietyPlan
}

const ci = (s: string) => s.trim().toLowerCase()

function resolveCounty(
  county: string | null, state: string | null,
  counties: SettingsReviewContext['counties'],
): { id: string | null; hint: string | null } {
  if (!county) return { id: null, hint: null }
  const wantName = normalizeCountyName(county)
  const wantState = normalizeStateCode(state)
  // county + state required for a confident resolution (the 038 exact seam);
  // fuzzy fallback mirrors the policy-upload idiom.
  if (wantState) {
    const exact = counties.find((c) => c.state_code === wantState && normalizeCountyName(c.name) === wantName)
    if (exact) return { id: exact.id, hint: null }
  }
  const fuzzy = findBestMatch([county, state].filter(Boolean).join(' '), [...counties], (c) => `${c.name} ${c.state} ${c.state_code}`)
  if (fuzzy && wantState == null) return { id: fuzzy.id, hint: null }
  if (fuzzy && normalizeStateCode(fuzzy.state_code) === wantState) return { id: fuzzy.id, hint: null }
  return { id: null, hint: `county “${[county, state].filter(Boolean).join(', ')}” not recognized` }
}

/** exists/update/new/possible for a simple named record. */
function classifyByName<T extends { id: string }>(
  name: string,
  existing: ReadonlyArray<T>,
  getName: (t: T) => string,
): { cls: RowClass; matched: T | null; candidate: T | null } {
  const hit = existing.find((e) => ci(getName(e)) === ci(name))
  if (hit) return { cls: 'exists', matched: hit, candidate: null }
  const fuzzy = findBestMatch(name, [...existing], getName, { minScore: 200 })
  if (fuzzy) return { cls: 'possible', matched: null, candidate: fuzzy }
  return { cls: 'new', matched: null, candidate: null }
}

const fmt = (v: unknown): string => (v == null || v === '' ? '—' : String(v))

/** Field-level diffs, policy-upload semantics: a blank incoming value is never
 *  a difference and never overwrites. */
function diffFields(pairs: Array<{ label: string; existing: unknown; incoming: unknown }>): FieldDiff[] {
  const out: FieldDiff[] = []
  for (const p of pairs) {
    if (p.incoming == null || p.incoming === '') continue
    const a = typeof p.existing === 'number' ? p.existing : str(String(p.existing ?? '')) ?? null
    const b = typeof p.incoming === 'number' ? p.incoming : str(String(p.incoming)) ?? null
    if (typeof a === 'number' || typeof b === 'number') {
      if (Number(a ?? NaN) !== Number(b ?? NaN)) out.push({ label: p.label, existing: fmt(p.existing), incoming: fmt(p.incoming) })
    } else if (ci(String(a ?? '')) !== ci(String(b ?? ''))) {
      out.push({ label: p.label, existing: fmt(p.existing), incoming: fmt(p.incoming) })
    }
  }
  return out
}

export function buildSettingsReview(
  x: NormalizedSettingsExtraction,
  ctx: SettingsReviewContext,
  primaryTarget?: SettingsSection | null,
): SettingsReview {
  const rows: SettingsReviewRow[] = []
  const push = (row: SettingsReviewRow) => { rows.push(row); return row }
  const mk = (section: SettingsSection, i: number): string => `${section}:${i}`

  // --- Entities ---
  x.entities.forEach((e, i) => {
    const { cls, matched, candidate } = classifyByName(e.name, ctx.entities, (t) => t.name)
    push({
      key: mk('entities', i), section: 'entities', label: e.name, detail: null, source: e.source,
      cls, diffs: [], matchedId: matched?.id ?? null,
      candidate: candidate ? { id: candidate.id, label: candidate.name } : null,
      include: cls === 'new', draft: { name: e.name }, hints: [],
    })
  })
  const entityRowByName = new Map(rows.filter((r) => r.section === 'entities').map((r) => [ci(r.label), r]))

  // Resolve a document entity name → existing id, in-batch row, or the
  // single-entity auto-assign (the 042 upload seam).
  const entityRefFor = (name: string | null): ParentRef => {
    if (name) {
      const existing = ctx.entities.find((e) => ci(e.name) === ci(name))
      if (existing) return { id: existing.id }
      const inBatch = entityRowByName.get(ci(name))
      if (inBatch) return inBatch.cls === 'exists' ? { id: inBatch.matchedId! } : { ref: inBatch.key }
    }
    const auto = defaultEntityId(ctx.entities)
    return auto ? { id: auto } : null
  }

  // --- Landowners ---
  x.landowners.forEach((l, i) => {
    const { cls: base, matched, candidate } = classifyByName(l.name, ctx.landowners, (t) => t.name)
    const diffs = matched
      ? diffFields([
          { label: 'Phone', existing: matched.phone, incoming: l.phone },
          { label: 'Email', existing: matched.email, incoming: l.email },
          { label: 'Address', existing: matched.address, incoming: l.address },
        ])
      : []
    const cls: RowClass = base === 'exists' && diffs.length > 0 ? 'update' : base
    push({
      key: mk('landowners', i), section: 'landowners', label: l.name,
      detail: [l.phone, l.email].filter(Boolean).join(' · ') || null, source: l.source,
      cls, diffs, matchedId: matched?.id ?? null,
      candidate: candidate ? { id: candidate.id, label: candidate.name } : null,
      include: cls === 'new' || cls === 'update',
      draft: { name: l.name, phone: l.phone, email: l.email, address: l.address }, hints: [],
    })
  })
  const landownerRowByName = new Map(rows.filter((r) => r.section === 'landowners').map((r) => [ci(r.label), r]))
  const landownerRefFor = (name: string | null): ParentRef => {
    if (!name) return null
    const existing = ctx.landowners.find((e) => ci(e.name) === ci(name))
    if (existing) return { id: existing.id }
    const inBatch = landownerRowByName.get(ci(name))
    if (inBatch) return inBatch.cls === 'exists' ? { id: inBatch.matchedId! } : { ref: inBatch.key }
    return null
  }

  // --- Crops (before plantings need them) ---
  x.crops.forEach((c, i) => {
    const { cls, matched, candidate } = classifyByName(c.name, ctx.crops, (t) => t.name)
    push({
      key: mk('crops', i), section: 'crops', label: c.name,
      detail: cls === 'new' ? 'set base moisture & lbs/bu after saving' : null, source: c.source,
      cls, diffs: [], matchedId: matched?.id ?? null,
      candidate: candidate ? { id: candidate.id, label: candidate.name } : null,
      include: cls === 'new', draft: { name: c.name }, hints: [],
    })
  })

  // --- Farms (the 156EZ seam: FSA number first, then name) ---
  x.farms.forEach((f, i) => {
    const byFsa = f.fsaNumber
      ? ctx.farms.find((cf) => (cf.fsa_number ?? '').trim() === f.fsaNumber!.trim()) ?? null
      : null
    const byName = byFsa ? null : ctx.farms.find((cf) => ci(cf.name) === ci(f.name)) ?? null
    const matched = byFsa ?? byName
    const candidate = matched ? null : findBestMatch(f.name, [...ctx.farms], (cf) => cf.name, { minScore: 200 })
    const county = resolveCounty(f.county, f.state, ctx.counties)
    const entityRef = entityRefFor(f.entityName)
    const landownerRef = landownerRefFor(f.landownerName)
    const diffs = matched
      ? diffFields([
          { label: 'FSA #', existing: matched.fsa_number, incoming: f.fsaNumber },
          { label: 'Landlord share %', existing: matched.landlord_share_percentage, incoming: f.landlordSharePct },
          { label: 'Cash rent $/ac', existing: matched.cash_rent_per_acre ?? null, incoming: f.cashRentPerAcre },
          { label: 'Share rent', existing: matched.is_share_rent ? 'yes' : null, incoming: f.shareRent === true ? 'yes' : null },
        ])
      : []
    const cls: RowClass = matched ? (diffs.length > 0 ? 'update' : 'exists') : candidate ? 'possible' : 'new'
    push({
      key: mk('farms', i), section: 'farms', label: f.name,
      detail: [f.fsaNumber ? `FSA #${f.fsaNumber}` : null, f.county ? [f.county, f.state].filter(Boolean).join(', ') : null,
               f.landlordSharePct != null ? `${f.landlordSharePct}% share` : null,
               f.cashRentPerAcre != null ? `$${f.cashRentPerAcre}/ac cash rent` : null].filter(Boolean).join(' · ') || null,
      source: f.source, cls, diffs, matchedId: matched?.id ?? null,
      candidate: candidate ? { id: candidate.id, label: candidate.name } : null,
      include: cls === 'new' || cls === 'update',
      draft: {
        name: f.name, fsa_number: f.fsaNumber, county_id: county.id,
        is_share_rent: f.shareRent === true, landlord_share_percentage: f.landlordSharePct,
        cash_rent_per_acre: f.cashRentPerAcre,
        entityRef, landownerRef,
      },
      hints: county.hint ? [county.hint] : [],
    })
  })
  const farmRows = rows.filter((r) => r.section === 'farms')
  const farmRefFor = (farmName: string | null, fsaNumber: string | null): ParentRef => {
    if (fsaNumber) {
      const existing = ctx.farms.find((cf) => (cf.fsa_number ?? '').trim() === fsaNumber.trim())
      if (existing) return { id: existing.id }
      const inBatch = farmRows.find((r) => (r.draft.fsa_number as string | null)?.trim() === fsaNumber.trim())
      if (inBatch) return inBatch.cls === 'exists' ? { id: inBatch.matchedId! } : { ref: inBatch.key }
    }
    if (farmName) {
      const existing = ctx.farms.find((cf) => ci(cf.name) === ci(farmName))
      if (existing) return { id: existing.id }
      const inBatch = farmRows.find((r) => ci(r.label) === ci(farmName))
      if (inBatch) return inBatch.cls === 'exists' ? { id: inBatch.matchedId! } : { ref: inBatch.key }
      const fuzzy = findBestMatch(farmName, [...ctx.farms], (cf) => cf.name)
      if (fuzzy) return { id: fuzzy.id }
    }
    return null
  }

  // --- Fields ---
  x.fields.forEach((f, i) => {
    const farmRef = farmRefFor(f.farmName, f.fsaNumber)
    const farmId = farmRef && 'id' in farmRef ? farmRef.id : null
    const inFarm = farmId ? ctx.fields.filter((cf) => cf.farm_id === farmId) : ctx.fields
    const matched = inFarm.find((cf) => ci(cf.name_or_number) === ci(f.name)) ?? null
    const candidate = matched ? null : findBestMatch(f.name, [...inFarm], (cf) => cf.name_or_number, { minScore: 300 })
    const county = resolveCounty(f.county, f.state, ctx.counties)
    const diffs = matched
      ? diffFields([
          { label: 'Total acres', existing: matched.total_acres, incoming: f.totalAcres },
          { label: 'Irrigated acres', existing: matched.irrigated_acres, incoming: f.irrigatedAcres },
        ])
      : []
    const cls: RowClass = matched ? (diffs.length > 0 ? 'update' : 'exists') : candidate ? 'possible' : 'new'
    push({
      key: mk('fields', i), section: 'fields', label: f.name,
      detail: [f.farmName, f.totalAcres != null ? `${f.totalAcres} ac` : null].filter(Boolean).join(' · ') || null,
      source: f.source, cls, diffs, matchedId: matched?.id ?? null,
      candidate: candidate ? { id: candidate.id, label: candidate.name_or_number } : null,
      include: cls === 'new' || cls === 'update',
      draft: {
        name_or_number: f.name, total_acres: f.totalAcres, irrigated_acres: f.irrigatedAcres ?? 0,
        county_id: county.id, farmRef,
      },
      hints: [
        ...(county.hint ? [county.hint] : []),
        ...(!farmRef && f.farmName ? [`farm “${f.farmName}” not recognized`] : []),
      ],
    })
  })
  const fieldRows = rows.filter((r) => r.section === 'fields')
  const fieldRefFor = (fieldName: string, farmName: string | null): ParentRef => {
    const existing = ctx.fields.find((cf) => ci(cf.name_or_number) === ci(fieldName))
    if (existing) return { id: existing.id }
    const inBatch = fieldRows.find((r) => ci(r.label) === ci(fieldName))
    if (inBatch) return inBatch.cls === 'exists' ? { id: inBatch.matchedId! } : { ref: inBatch.key }
    const fuzzy = findBestMatch(fieldName, [...ctx.fields], (cf) => cf.name_or_number)
    if (fuzzy) return { id: fuzzy.id }
    void farmName
    return null
  }

  // --- Plantings (varieties through the strict pipeline) ---
  const varietyPlan = buildVarietyPlan(
    x.plantings.flatMap((p, pi) => p.varieties.map((v) => ({ rowIndex: pi, name: v.variety }))),
    ctx.existingVarietyNames,
    ctx.dismissedVarietyPairs,
  )
  const cropIdFor = (cropName: string | null): ParentRef => {
    if (!cropName) return null
    const existing = ctx.crops.find((c) => ci(c.name) === ci(cropName))
    if (existing) return { id: existing.id }
    const inBatch = rows.find((r) => r.section === 'crops' && ci(r.label) === ci(cropName))
    if (inBatch) return inBatch.cls === 'exists' ? { id: inBatch.matchedId! } : { ref: inBatch.key }
    const fuzzy = findBestMatch(cropName, [...ctx.crops], (c) => c.name)
    return fuzzy ? { id: fuzzy.id } : null
  }
  x.plantings.forEach((p, i) => {
    const fieldRef = fieldRefFor(p.fieldName, p.farmName)
    const cropRef = cropIdFor(p.crop)
    const fieldId = fieldRef && 'id' in fieldRef ? fieldRef.id : null
    const cropId = cropRef && 'id' in cropRef ? cropRef.id : null
    const matched = fieldId && cropId && p.cropYear != null
      ? ctx.plantings.find((cp) => cp.field_id === fieldId && cp.crop_id === cropId && cp.season_year === p.cropYear) ?? null
      : null
    const diffs = matched
      ? diffFields([
          { label: 'Planted acres', existing: Number(matched.planted_acres ?? 0), incoming: p.plantedAcres },
          { label: 'Irrigated acres', existing: Number(matched.irrigated_acres ?? 0), incoming: p.irrigatedAcres },
        ])
      : []
    const cls: RowClass = matched ? (diffs.length > 0 ? 'update' : 'exists') : 'new'
    push({
      key: mk('plantings', i), section: 'plantings',
      label: `${p.fieldName} — ${p.crop ?? '?'} ${p.cropYear ?? ''}`.trim(),
      detail: [p.plantedAcres != null ? `${p.plantedAcres} ac` : null,
               p.varieties.length > 0 ? p.varieties.map((v) => v.variety).join(', ') : null].filter(Boolean).join(' · ') || null,
      source: p.source, cls, diffs, matchedId: matched?.id ?? null, candidate: null,
      include: cls === 'new' || cls === 'update',
      draft: {
        season_year: p.cropYear, planted_acres: p.plantedAcres,
        irrigated_acres: p.irrigatedAcres ?? 0, planting_date: p.plantingDate,
        varieties: p.varieties, fieldRef, cropRef,
      },
      hints: [
        ...(!fieldRef ? [`field “${p.fieldName}” not recognized`] : []),
        ...(!cropRef && p.crop ? [`crop “${p.crop}” not recognized`] : []),
        ...(p.cropYear == null ? ['crop year missing'] : []),
      ],
    })
  })

  // --- Buyers (case-insensitive duplicate guard) + locations ---
  x.buyers.forEach((b, i) => {
    const matched = matchExistingBuyer(ctx.buyers as Array<{ id: string; name: string }>, b.name)
    const newLocations = matched
      ? b.locations.filter((l) => !ctx.deliveryLocations.some((dl) => dl.buyer_id === matched.id && ci(dl.name) === ci(l.name)))
      : b.locations
    const cls: RowClass = matched ? (newLocations.length > 0 ? 'update' : 'exists') : 'new'
    push({
      key: mk('buyers', i), section: 'buyers', label: b.name,
      detail: newLocations.length > 0 ? `${newLocations.length} delivery location${newLocations.length === 1 ? '' : 's'}` : null,
      source: b.source, cls,
      diffs: newLocations.map((l) => ({ label: 'New location', existing: '—', incoming: l.name })),
      matchedId: matched?.id ?? null, candidate: null,
      include: cls === 'new' || cls === 'update',
      draft: { name: b.name, locations: newLocations }, hints: [],
    })
  })

  // --- Bin sites + bins ---
  x.binSites.forEach((s, i) => {
    const matched = ctx.binSites.find((cs) => ci(cs.name) === ci(s.name)) ?? null
    const newBins = matched
      ? s.bins.filter((b) => !ctx.bins.some((cb) => cb.bin_site_id === matched.id && ci(cb.name_or_number) === ci(b.name)))
      : s.bins
    const cls: RowClass = matched ? (newBins.length > 0 ? 'update' : 'exists') : 'new'
    push({
      key: mk('bin_sites', i), section: 'bin_sites', label: s.name,
      detail: s.bins.length > 0 ? `${s.bins.length} bin${s.bins.length === 1 ? '' : 's'}` : null,
      source: s.source, cls,
      diffs: newBins.map((b) => ({ label: 'New bin', existing: '—', incoming: b.capacityBushels != null ? `${b.name} (${b.capacityBushels} bu)` : b.name })),
      matchedId: matched?.id ?? null, candidate: null,
      include: cls === 'new' || cls === 'update',
      draft: { name: s.name, address: s.address, bins: newBins, entityRef: entityRefFor(null) }, hints: [],
    })
  })

  // --- Gins / Trucks ---
  x.gins.forEach((g, i) => {
    const { cls, matched, candidate } = classifyByName(g.name, ctx.gins, (t) => t.name)
    push({
      key: mk('gins', i), section: 'gins', label: g.name, detail: g.address, source: g.source,
      cls, diffs: [], matchedId: matched?.id ?? null,
      candidate: candidate ? { id: candidate.id, label: candidate.name } : null,
      include: cls === 'new', draft: { name: g.name, address: g.address, phone: g.phone }, hints: [],
    })
  })
  x.trucks.forEach((t, i) => {
    const { cls, matched, candidate } = classifyByName(t.name, ctx.trucks, (tt) => tt.name_or_number)
    push({
      key: mk('trucks', i), section: 'trucks', label: t.name, detail: null, source: t.source,
      cls, diffs: [], matchedId: matched?.id ?? null,
      candidate: candidate ? { id: candidate.id, label: candidate.name_or_number } : null,
      include: cls === 'new', draft: { name_or_number: t.name }, hints: [],
    })
  })

  // Section ordering: the primary target first, then by row count desc, then
  // canonical order; empty sections dropped.
  const bySection = new Map<SettingsSection, SettingsReviewRow[]>()
  for (const r of rows) {
    const list = bySection.get(r.section) ?? []
    list.push(r)
    bySection.set(r.section, list)
  }
  const sections = [...bySection.entries()].map(([section, rws]) => ({ section, rows: rws }))
  sections.sort((a, b) => {
    if (primaryTarget) {
      if (a.section === primaryTarget) return -1
      if (b.section === primaryTarget) return 1
    }
    if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length
    return SETTINGS_SECTIONS.indexOf(a.section) - SETTINGS_SECTIONS.indexOf(b.section)
  })

  return { sections, varietyPlan }
}

// ---------------------------------------------------------------------------
// Save planning — dependency order + within-batch parent wiring.
// ---------------------------------------------------------------------------

export type SaveStep = {
  key: string
  section: SettingsSection
  table: string
  op: 'insert' | 'update'
  /** update target */
  id?: string
  payload: Record<string, unknown>
  /** column → row key of a parent created earlier in this same plan; the
   *  executor fills the id once the parent exists. */
  parentRefs?: Record<string, string>
}

export type SavePlan = {
  steps: SaveStep[]
  skipped: Array<{ key: string; label: string; reason: string }>
}

/** Per-row user decisions from the review. Possible-match rows REQUIRE one. */
export type ReviewDecisions = {
  /** 'possible' resolution: use the candidate (id) or create new. */
  possible?: ReadonlyMap<string, 'existing' | 'new'>
  varieties?: ReadonlyMap<string, VarietyDecision>
}

const SECTION_ORDER: SettingsSection[] = [
  'entities', 'landowners', 'crops', 'farms', 'fields', 'plantings',
  'buyers', 'bin_sites', 'gins', 'trucks',
]

// The FK-ordered plan. Checked rows only; a child whose in-batch parent isn't
// being created is skipped with a human reason (the review surfaced the
// dependency, the user unchecked it anyway).
export function planSettingsSave(
  review: SettingsReview,
  decisions: ReviewDecisions = {},
): SavePlan {
  const steps: SaveStep[] = []
  const skipped: SavePlan['skipped'] = []
  const planned = new Set<string>()
  const allRows = review.sections.flatMap((s) => s.rows)
  const rowByKey = new Map(allRows.map((r) => [r.key, r]))

  const refValue = (ref: ParentRef): { value?: string; parentRef?: string; missing?: boolean; reason?: string } => {
    if (!ref) return { missing: true }
    if ('id' in ref) return { value: ref.id }
    const parent = rowByKey.get(ref.ref)
    if (!parent) return { missing: true }
    if (parent.cls === 'exists' && parent.matchedId) return { value: parent.matchedId }
    if (planned.has(ref.ref)) return { parentRef: ref.ref }
    return { missing: true, reason: `depends on “${parent.label}”, which isn't checked` }
  }

  for (const section of SECTION_ORDER) {
    const sec = review.sections.find((s) => s.section === section)
    if (!sec) continue
    for (const row of sec.rows) {
      if (!row.include) continue
      if (row.cls === 'exists') continue

      // Possible matches demand an explicit decision — confirmation is the contract.
      let effectiveCls = row.cls
      let matchedId = row.matchedId
      if (row.cls === 'possible') {
        const choice = decisions.possible?.get(row.key)
        if (!choice) { skipped.push({ key: row.key, label: row.label, reason: 'possible match not decided' }); continue }
        if (choice === 'existing') {
          // Confirmed as the candidate — nothing to write for simple sections
          // (no diffs were computed against the candidate), but children may
          // reference it, so record the resolution.
          matchedId = row.candidate?.id ?? null
          row.matchedId = matchedId
          row.cls = 'exists'
          continue
        }
        effectiveCls = 'new'
      }

      const d = row.draft
      const step: SaveStep = { key: row.key, section, table: '', op: effectiveCls === 'update' ? 'update' : 'insert', payload: {} }
      if (step.op === 'update') { if (!matchedId) continue; step.id = matchedId }
      const parentRefs: Record<string, string> = {}
      const need = (column: string, ref: ParentRef, required: boolean): boolean => {
        const rv = refValue(ref)
        if (rv.value) { step.payload[column] = rv.value; return true }
        if (rv.parentRef) { parentRefs[column] = rv.parentRef; return true }
        if (required) {
          skipped.push({ key: row.key, label: row.label, reason: rv.reason ?? `missing its ${column.replace(/_id$/, '')}` })
          return false
        }
        return true
      }

      switch (section) {
        case 'entities':
          step.table = 'entities'
          step.payload = { name: d.name }
          break
        case 'landowners':
          step.table = 'landowners'
          step.payload = step.op === 'update'
            ? Object.fromEntries(row.diffs.map((df) => {
                const col = df.label === 'Phone' ? 'phone' : df.label === 'Email' ? 'email' : 'address'
                return [col, d[col]]
              }))
            : { name: d.name, phone: d.phone, email: d.email, address: d.address }
          break
        case 'crops':
          step.table = 'crops'
          step.payload = { name: d.name }
          break
        case 'farms': {
          step.table = 'farms'
          const base: Record<string, unknown> = {
            name: d.name, fsa_number: d.fsa_number, county_id: d.county_id,
            is_share_rent: d.is_share_rent === true,
            landlord_share_percentage: d.landlord_share_percentage,
          }
          // cash_rent_per_acre exists only after migration 063 — include it
          // only when the document actually stated one, so pre-063 saves of
          // rent-less documents keep working.
          if (d.cash_rent_per_acre != null) base.cash_rent_per_acre = d.cash_rent_per_acre
          if (step.op === 'update') {
            step.payload = {}
            for (const df of row.diffs) {
              if (df.label === 'FSA #') step.payload.fsa_number = d.fsa_number
              if (df.label === 'Landlord share %') { step.payload.landlord_share_percentage = d.landlord_share_percentage; step.payload.is_share_rent = true }
              if (df.label === 'Cash rent $/ac') step.payload.cash_rent_per_acre = d.cash_rent_per_acre
              if (df.label === 'Share rent') step.payload.is_share_rent = true
            }
          } else {
            step.payload = base
            if (!need('entity_id', d.entityRef ?? null, false)) continue
          }
          if (!need('landowner_id', d.landownerRef ?? null, false)) continue
          break
        }
        case 'fields':
          step.table = 'fields'
          if (step.op === 'update') {
            step.payload = {}
            for (const df of row.diffs) {
              if (df.label === 'Total acres') step.payload.total_acres = d.total_acres
              if (df.label === 'Irrigated acres') step.payload.irrigated_acres = d.irrigated_acres
            }
          } else {
            step.payload = { name_or_number: d.name_or_number, total_acres: d.total_acres, irrigated_acres: d.irrigated_acres ?? 0, county_id: d.county_id }
            if (!need('farm_id', d.farmRef ?? null, true)) continue
          }
          break
        case 'plantings': {
          step.table = 'field_plantings'
          if (d.season_year == null) { skipped.push({ key: row.key, label: row.label, reason: 'crop year missing' }); continue }
          if (step.op === 'update') {
            step.payload = {}
            for (const df of row.diffs) {
              if (df.label === 'Planted acres') step.payload.planted_acres = d.planted_acres
              if (df.label === 'Irrigated acres') step.payload.irrigated_acres = d.irrigated_acres
            }
          } else {
            step.payload = {
              season_year: d.season_year, planted_acres: d.planted_acres,
              irrigated_acres: d.irrigated_acres ?? 0, planting_date: d.planting_date,
            }
            if (!need('field_id', d.fieldRef ?? null, true)) continue
            if (!need('crop_id', d.cropRef ?? null, true)) continue
            // Varieties ride as child steps; unresolved possible-variety names
            // block the whole row (strict pipeline: resolvedName null = block).
            const vars = (d.varieties as Array<{ variety: string; acres: number | null }>) ?? []
            if (vars.length > 0) {
              const names: Array<{ variety: string; acres: number | null }> = []
              let blocked = false
              for (const v of vars) {
                const item = review.varietyPlan.items.find((it) => it.key === varietyKey(v.variety))
                const name = item ? resolvedName(item, decisions.varieties?.get(item.key)) : v.variety
                if (name == null) { blocked = true; break }
                names.push({ variety: name, acres: v.acres })
              }
              if (blocked) { skipped.push({ key: row.key, label: row.label, reason: 'variety needs review' }); continue }
              step.payload.__varieties = names
            }
          }
          break
        }
        case 'buyers': {
          if (step.op === 'update') {
            // Existing buyer, new locations only — each location is its own step.
            const locs = (d.locations as Array<{ name: string; address: string | null }>) ?? []
            for (const [li, loc] of locs.entries()) {
              steps.push({
                key: `${row.key}#loc${li}`, section, table: 'delivery_locations', op: 'insert',
                payload: { buyer_id: matchedId, name: loc.name, address: loc.address },
              })
            }
            planned.add(row.key)
            continue
          }
          step.table = 'buyers'
          step.payload = { name: d.name }
          break
        }
        case 'bin_sites': {
          if (step.op === 'update') {
            const bins = (d.bins as Array<{ name: string; capacityBushels: number | null }>) ?? []
            for (const [bi, b] of bins.entries()) {
              steps.push({
                key: `${row.key}#bin${bi}`, section, table: 'bins', op: 'insert',
                payload: { bin_site_id: matchedId, name_or_number: b.name, capacity_bushels: b.capacityBushels },
              })
            }
            planned.add(row.key)
            continue
          }
          step.table = 'bin_sites'
          step.payload = { name: d.name, address: d.address }
          if (!need('entity_id', d.entityRef ?? null, false)) continue
          break
        }
        case 'gins':
          step.table = 'gins'
          step.payload = { name: d.name, address: d.address, phone: d.phone }
          break
        case 'trucks':
          step.table = 'trucks'
          step.payload = { name_or_number: d.name_or_number }
          break
      }

      if (Object.keys(parentRefs).length > 0) step.parentRefs = parentRefs
      if (step.op === 'update' && Object.keys(step.payload).length === 0) continue
      steps.push(step)
      planned.add(row.key)

      // New buyer's locations / new site's bins follow their parent by ref.
      if (section === 'buyers' && step.op === 'insert') {
        const locs = (d.locations as Array<{ name: string; address: string | null }>) ?? []
        for (const [li, loc] of locs.entries()) {
          steps.push({
            key: `${row.key}#loc${li}`, section, table: 'delivery_locations', op: 'insert',
            payload: { name: loc.name, address: loc.address }, parentRefs: { buyer_id: row.key },
          })
        }
      }
      if (section === 'bin_sites' && step.op === 'insert') {
        const bins = (d.bins as Array<{ name: string; capacityBushels: number | null }>) ?? []
        for (const [bi, b] of bins.entries()) {
          steps.push({
            key: `${row.key}#bin${bi}`, section, table: 'bins', op: 'insert',
            payload: { name_or_number: b.name, capacity_bushels: b.capacityBushels }, parentRefs: { bin_site_id: row.key },
          })
        }
      }
    }
  }

  // Planting variety child steps (after all planting steps exist).
  for (const step of [...steps]) {
    if (step.table !== 'field_plantings' || step.op !== 'insert') continue
    const vars = step.payload.__varieties as Array<{ variety: string; acres: number | null }> | undefined
    if (!vars) continue
    delete step.payload.__varieties
    for (const [vi, v] of vars.entries()) {
      steps.push({
        key: `${step.key}#var${vi}`, section: 'plantings', table: 'field_planting_varieties', op: 'insert',
        payload: { variety: v.variety, acres: v.acres }, parentRefs: { planting_id: step.key },
      })
    }
  }

  return { steps, skipped }
}

// ---------------------------------------------------------------------------
// Execution — sequential, ref-resolving, compensating rollback.
// ---------------------------------------------------------------------------

export type SaveResult = { inserted: number; updated: number }

/** Runs the plan in order. Any failure deletes every row created in THIS batch
 *  (reverse order, FK-safe) and throws with a clear message — the reviewed
 *  batch lands whole or not at all. */
export async function executeSettingsSave(supabase: SupabaseClient, plan: SavePlan): Promise<SaveResult> {
  const createdIds = new Map<string, string>()
  const createdRows: Array<{ table: string; id: string }> = []
  let inserted = 0
  let updated = 0
  try {
    for (const step of plan.steps) {
      const payload = { ...step.payload }
      for (const [column, refKey] of Object.entries(step.parentRefs ?? {})) {
        const id = createdIds.get(refKey)
        if (!id) throw new Error(`Internal: unresolved reference for ${step.key} (${column}).`)
        payload[column] = id
      }
      if (step.op === 'insert') {
        const { data, error } = await supabase.from(step.table).insert(payload).select('id').single()
        if (error) throw new Error(`Saving ${SECTION_LABELS[step.section].toLowerCase()} failed: ${error.message}`)
        const id = (data as { id: string }).id
        createdIds.set(step.key, id)
        createdRows.push({ table: step.table, id })
        inserted++
      } else {
        const { error } = await supabase.from(step.table).update(payload).eq('id', step.id!)
        if (error) throw new Error(`Updating ${SECTION_LABELS[step.section].toLowerCase()} failed: ${error.message}`)
        updated++
      }
    }
    return { inserted, updated }
  } catch (e) {
    // Best-effort atomicity (the gin-receipt rollback pattern): remove what
    // this batch created, children first. Updates are not reverted — they only
    // ever touch fields the user explicitly confirmed in the diff.
    for (const row of [...createdRows].reverse()) {
      await supabase.from(row.table).delete().eq('id', row.id)
    }
    throw e instanceof Error
      ? new Error(`${e.message} Nothing from this batch was kept.`)
      : new Error('Save failed. Nothing from this batch was kept.')
  }
}
