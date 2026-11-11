// GET /api/farm-link/v1/bin-loads (bins:read): the loads delivered INTO a
// bin, one record per load, for Turnrow Farm's saved seed lots (Stuart,
// 2026-11-10: wheat kept back goes to the "Wheat Seed" bin; each load says
// which field, so which variety). The same dry bushels the bin inventory
// counts (computeBushels under the crop's bases), the field the load came
// from with the varieties planted on it that season, or the bin it was moved
// from. Nothing is recomputed beyond what /loads shows.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll } from '@/lib/partner-api-server'
import type { IdMap } from '@/lib/farm-link'
import { computeBushels } from '@/lib/shrink'

export type FarmLinkBinLoadRecord = {
  /** The load id. */
  id: string
  date: string
  ticket_number: string | null
  crop_id: string | null
  crop: string | null
  crop_year: number | null
  to_bin_id: string
  to_bin_name: string
  from_type: 'field' | 'bin' | null
  from_field_id: string | null
  from_field_name: string | null
  /** Turnrow Farm's key for the field (the id map), null until linked. */
  from_field_farm_uid: string | null
  from_bin_id: string | null
  from_bin_name: string | null
  /** The varieties on the source field's planting of the load's crop and season (empty for a bin-to-bin load). */
  varieties: string[]
  net_weight_lb: number | null
  moisture_pct: number | null
  test_weight: number | null
  dry_bushels: number | null
  updated_at: string
}

export type BinLoadInputs = {
  bins: Array<{ id: string; name_or_number: string }>
  crops: Array<{ id: string; name: string; base_moisture_pct: number | null; base_lb_per_bushel: number | null }>
  fields: Array<{ id: string; name_or_number: string }>
  loads: Array<{ id: string; date: string; ticket_number: string | null; crop_id: string | null; crop_year: number | null; net_weight: number | null; moisture: number | null; test_weight: number | null; dry_bushels_override: number | null; from_type: string | null; from_field_id: string | null; from_bin_id: string | null; to_type: string | null; to_bin_id: string | null; updated_at: string }>
  plantings: Array<{ id: string; field_id: string; crop_id: string; season_year: number }>
  varieties: Array<{ planting_id: string; variety: string }>
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const r2 = (n: number) => Math.round(n * 100) / 100

/** Pure: the records for every load into a bin (or into the one bin asked for) in the crop year. */
export function assembleBinLoads(inputs: BinLoadInputs, opts: { cropYear: number; binId?: string | null; idMap?: IdMap | null }): FarmLinkBinLoadRecord[] {
  const binName = new Map(inputs.bins.map((b) => [b.id, b.name_or_number]))
  const crop = new Map(inputs.crops.map((c) => [c.id, c]))
  const fieldName = new Map(inputs.fields.map((f) => [f.id, f.name_or_number]))
  const varietiesByPlanting = new Map<string, string[]>()
  for (const v of inputs.varieties) {
    const name = (v.variety ?? '').trim()
    if (!name) continue
    const list = varietiesByPlanting.get(v.planting_id) ?? []
    if (!list.includes(name)) list.push(name)
    varietiesByPlanting.set(v.planting_id, list)
  }
  const out: FarmLinkBinLoadRecord[] = []
  for (const l of inputs.loads) {
    if (l.to_type !== 'bin' || !l.to_bin_id) continue
    if (opts.binId && l.to_bin_id !== opts.binId) continue
    if (num(l.crop_year) !== opts.cropYear) continue
    const c = l.crop_id ? crop.get(l.crop_id) : undefined
    const dry = computeBushels({ netWeightLb: num(l.net_weight), moisturePct: num(l.moisture), baseMoisturePct: c?.base_moisture_pct ?? null, baseLbPerBushel: c?.base_lb_per_bushel ?? null, dryBushelsOverride: num(l.dry_bushels_override) }).dryBushels
    const fromField = l.from_type === 'field' ? l.from_field_id : null
    const planting = fromField ? inputs.plantings.find((p) => p.field_id === fromField && p.crop_id === l.crop_id && p.season_year === opts.cropYear) : undefined
    out.push({
      id: l.id,
      date: l.date,
      ticket_number: l.ticket_number?.trim() || null,
      crop_id: l.crop_id,
      crop: c?.name ?? null,
      crop_year: num(l.crop_year),
      to_bin_id: l.to_bin_id,
      to_bin_name: binName.get(l.to_bin_id) ?? '',
      from_type: l.from_type === 'field' || l.from_type === 'bin' ? l.from_type : null,
      from_field_id: fromField,
      from_field_name: fromField ? fieldName.get(fromField) ?? null : null,
      from_field_farm_uid: fromField && opts.idMap ? opts.idMap.farmUid('fields', fromField) : null,
      from_bin_id: l.from_type === 'bin' ? l.from_bin_id : null,
      from_bin_name: l.from_type === 'bin' && l.from_bin_id ? binName.get(l.from_bin_id) ?? null : null,
      varieties: planting ? varietiesByPlanting.get(planting.id) ?? [] : [],
      net_weight_lb: num(l.net_weight),
      moisture_pct: num(l.moisture),
      test_weight: num(l.test_weight),
      dry_bushels: dry === null || dry === undefined ? null : r2(dry),
      updated_at: l.updated_at,
    })
  }
  return out.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)))
}

export async function loadBinLoadsPayload(supabase: SupabaseClient, org: string, year: number, binId: string | null, idMap: IdMap): Promise<FarmLinkBinLoadRecord[]> {
  const [bins, crops, fields, loads, plantings, varieties] = await Promise.all([
    fetchAll<BinLoadInputs['bins'][number]>((f, t) => supabase.from('bins').select('id, name_or_number').eq('org_id', org).order('id').range(f, t)),
    fetchAll<BinLoadInputs['crops'][number]>((f, t) => supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').eq('org_id', org).order('id').range(f, t)),
    fetchAll<BinLoadInputs['fields'][number]>((f, t) => supabase.from('fields').select('id, name_or_number').eq('org_id', org).order('id').range(f, t)),
    fetchAll<BinLoadInputs['loads'][number]>((f, t) => {
      let q = supabase.from('loads').select('id, date, ticket_number, crop_id, crop_year, net_weight, moisture, test_weight, dry_bushels_override, from_type, from_field_id, from_bin_id, to_type, to_bin_id, updated_at').eq('org_id', org).eq('crop_year', year).eq('to_type', 'bin')
      if (binId) q = q.eq('to_bin_id', binId)
      return q.order('id').range(f, t)
    }),
    fetchAll<BinLoadInputs['plantings'][number]>((f, t) => supabase.from('field_plantings').select('id, field_id, crop_id, season_year').eq('org_id', org).eq('season_year', year).order('id').range(f, t)),
    fetchAll<BinLoadInputs['varieties'][number]>((f, t) => supabase.from('field_planting_varieties').select('planting_id, variety').eq('org_id', org).order('id').range(f, t)),
  ])
  return assembleBinLoads({ bins, crops, fields, loads, plantings, varieties }, { cropYear: year, binId, idMap })
}
