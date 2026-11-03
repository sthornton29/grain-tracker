// Agent trigger yield report → insurance_trigger_yields rows (0101). Pure.
//
// The document reader returns one unit per page (lib/pdf-upload
// InsuranceTriggerReportExtraction). This groups the units by the insured
// printed at the top of the page, matches that insured to an ENTITY or, for a
// share-rent landlord insuring their own share, a LANDOWNER (names compared
// through lib/landowner-match landownerNameKey — "Two Seasons Farm LLC" is
// "Two Seasons Farm, LLC"), matches crop and county, and builds the rows to
// save. Saving replaces the insured × crop year × crop rows the report covers.

import { findBestMatch } from '@/lib/fuzzy'
import { landownerNameKey } from '@/lib/landowner-match'
import type { InsuranceTriggerReportExtraction, InsuranceTriggerUnitExtraction } from '@/lib/pdf-upload'

type Named = { id: string; name: string }
type CountyRef = { id: string; name: string; state?: string | null; state_code?: string | null }

export type InsuredChoice = { kind: 'entity' | 'landowner'; id: string } | null

export type ImportUnit = {
  raw: InsuranceTriggerUnitExtraction
  cropId: string
  countyId: string
  practice: 'irrigated' | 'non_irrigated'
  include: boolean
}

export type ImportGroup = {
  insuredName: string
  insured: InsuredChoice
  units: ImportUnit[]
}

export function matchInsured(name: string, entities: readonly Named[], landowners: readonly Named[]): InsuredChoice {
  const key = landownerNameKey(name)
  if (key) {
    const e = entities.find((x) => landownerNameKey(x.name) === key)
    if (e) return { kind: 'entity', id: e.id }
    const l = landowners.find((x) => landownerNameKey(x.name) === key)
    if (l) return { kind: 'landowner', id: l.id }
  }
  const e = findBestMatch(name, [...entities], (x) => x.name)
  return e ? { kind: 'entity', id: e.id } : null
}

export function groupTriggerReport(args: {
  extraction: InsuranceTriggerReportExtraction
  entities: readonly Named[]
  landowners: readonly Named[]
  crops: readonly Named[]
  counties: readonly CountyRef[]
}): ImportGroup[] {
  const groups = new Map<string, ImportGroup>()
  for (const u of args.extraction.units ?? []) {
    if (u.trigger_yield == null || !(Number(u.trigger_yield) > 0)) continue
    const insuredName = (u.insured_name ?? '').trim() || 'Unknown insured'
    const gk = landownerNameKey(insuredName) || insuredName.toLowerCase()
    let g = groups.get(gk)
    if (!g) {
      g = { insuredName, insured: matchInsured(insuredName, args.entities, args.landowners), units: [] }
      groups.set(gk, g)
    }
    const crop = findBestMatch(u.crop, [...args.crops], (c) => c.name)
    const county = findBestMatch(
      [u.county, u.state].filter(Boolean).join(' '),
      [...args.counties],
      (c) => `${c.name} ${c.state ?? ''} ${c.state_code ?? ''}`,
    )
    g.units.push({
      raw: u,
      cropId: crop?.id ?? '',
      countyId: county?.id ?? '',
      practice: u.practice === 'irrigated' ? 'irrigated' : 'non_irrigated',
      include: true,
    })
  }
  return [...groups.values()]
}

export function cropYearOf(extraction: InsuranceTriggerReportExtraction, fallback: number): number {
  if (extraction.crop_year != null && extraction.crop_year > 2000) return extraction.crop_year
  const y = Number((extraction.report_date ?? '').slice(0, 4))
  return y > 2000 ? y : fallback
}

export type TriggerInsert = {
  crop_year: number
  insured_name: string
  entity_id: string | null
  landowner_id: string | null
  crop_id: string
  county_id: string | null
  practice: 'irrigated' | 'non_irrigated'
  unit_label: string | null
  plan_type: 'RP' | 'RP_HPE' | 'YP'
  reported_acres: number | null
  aph_yield: number | null
  approved_yield: number | null
  trigger_yield: number
  expected_county_yield: number | null
  eco_trigger_yield: number | null
  sco_trigger_yield: number | null
  projected_price: number | null
  harvest_price: number | null
  report_date: string | null
  agency: string | null
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

/** The rows one group saves (included units with a crop matched). Duplicate
 *  units (same crop × county × practice read twice) keep the first. */
export function rowsForGroup(g: ImportGroup, cropYear: number, meta: { report_date: string | null; agency: string | null }): TriggerInsert[] {
  if (!g.insured) return []
  const seen = new Set<string>()
  const out: TriggerInsert[] = []
  for (const u of g.units) {
    if (!u.include || !u.cropId) continue
    const k = `${u.cropId}|${u.countyId}|${u.practice}`
    if (seen.has(k)) continue
    seen.add(k)
    const plan = u.raw.plan_type === 'YP' || u.raw.plan_type === 'RP_HPE' ? u.raw.plan_type : 'RP'
    out.push({
      crop_year: cropYear,
      insured_name: g.insuredName,
      entity_id: g.insured.kind === 'entity' ? g.insured.id : null,
      landowner_id: g.insured.kind === 'landowner' ? g.insured.id : null,
      crop_id: u.cropId,
      county_id: u.countyId || null,
      practice: u.practice,
      unit_label: u.raw.unit_label ?? null,
      plan_type: plan,
      reported_acres: num(u.raw.acres),
      aph_yield: num(u.raw.aph_yield),
      approved_yield: num(u.raw.approved_yield),
      trigger_yield: Number(u.raw.trigger_yield),
      expected_county_yield: num(u.raw.expected_county_yield),
      eco_trigger_yield: num(u.raw.eco_trigger_yield),
      sco_trigger_yield: num(u.raw.sco_trigger_yield),
      projected_price: num(u.raw.spring_price),
      harvest_price: num(u.raw.fall_price),
      report_date: /^\d{4}-\d{2}-\d{2}$/.test(meta.report_date ?? '') ? meta.report_date : null,
      agency: meta.agency,
    })
  }
  return out
}
