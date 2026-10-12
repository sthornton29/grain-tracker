'use client'

// The cotton intake pages' yield reads (2026-10-12): the crop year's cotton
// plantings (acres per field) + the cotton yield model (lib/use-cotton-yields),
// handed back as per-field and farm-wide pounds per acre. One hook, so the
// Seed Cotton Loads page, the Gin Receipts page and the load detail page all
// quote the same figures as the Yields page.

import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { useCottonYields } from '@/lib/use-cotton-yields'
import type { CottonYieldModel } from '@/lib/cotton-yield-sources'
import type { CottonPlantingYield } from '@/lib/cotton'
import { summarizeCottonFieldYields, type CottonFarmYield, type CottonFieldYieldRow } from '@/lib/cotton-field-yields'

type PlantingRow = { id: string; field_id: string; crop_id: string; season_year: number; planted_acres: number | string | null; archived_at?: string | null }
type CropRow = { id: string; name: string }
type AssumptionRow = { crop_id: string; crop_year: number; assumed_turnout_pct: number | string | null }

export type CottonFieldYields = {
  loading: boolean
  /** The Cotton module flag; null while loading. */
  on: boolean | null
  model: CottonYieldModel
  /**
   * The fields with a live cotton planting this crop year — what every
   * farm/field picker on the cotton pages narrows to (lib/planted-scope).
   * Null until the plantings have loaded, so a picker never flashes empty.
   */
  plantedFieldIds: ReadonlySet<string> | null
  /** Planted cotton acres on a field this crop year; null when the field has no cotton planting. */
  acresFor: (fieldId: string | null | undefined) => number | null
  /** The field's seed cotton and lint figures this crop year; null without a cotton planting (or with the module off). */
  yieldFor: (fieldId: string | null | undefined) => CottonPlantingYield | null
  rows: CottonFieldYieldRow[]
  farm: CottonFarmYield
  refresh: () => void
}

export function useCottonFieldYields(supabase: SupabaseClient, cropYear: number): CottonFieldYields {
  const [crops, setCrops] = useState<CropRow[]>([])
  const [assumptions, setAssumptions] = useState<AssumptionRow[]>([])
  const [plantings, setPlantings] = useState<PlantingRow[]>([])
  const [loadingRefs, setLoadingRefs] = useState(true)
  const [plantingsLoaded, setPlantingsLoaded] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [c, a, p] = await Promise.all([
          supabase.from('crops').select('id, name').order('name'),
          supabase.from('crop_assumptions').select('crop_id, crop_year, assumed_turnout_pct'),
          fetchAllRows((f, t) => supabase.from('field_plantings').select('id, field_id, crop_id, season_year, planted_acres, archived_at').eq('season_year', cropYear).order('id').range(f, t)),
        ])
        if (cancelled) return
        setCrops((c.data as CropRow[]) ?? [])
        setAssumptions((a.data as AssumptionRow[]) ?? [])
        setPlantings(((p.data as PlantingRow[]) ?? []).filter((x) => x.archived_at == null))
        setPlantingsLoaded(true)
      } finally {
        if (!cancelled) setLoadingRefs(false)
      }
    })()
    return () => { cancelled = true }
  }, [supabase, cropYear, nonce])

  const cotton = useCottonYields(supabase, { crops, assumptions })

  const { rows, acresByField, yieldByField, plantedFieldIds } = useMemo(() => {
    const acresByField = new Map<string, number>()
    const cropByField = new Map<string, string>()
    for (const p of plantings) {
      if (!cotton.model.cottonCropIds.has(p.crop_id)) continue
      acresByField.set(p.field_id, (acresByField.get(p.field_id) ?? 0) + Number(p.planted_acres ?? 0))
      if (!cropByField.has(p.field_id)) cropByField.set(p.field_id, p.crop_id)
    }
    // A zero-acre planting still counts as planted — acres are a separate question.
    const plantedFieldIds: ReadonlySet<string> | null = plantingsLoaded && crops.length > 0 ? new Set(acresByField.keys()) : null
    const yieldByField = new Map<string, CottonPlantingYield>()
    const rows: CottonFieldYieldRow[] = []
    for (const [fieldId, acres] of acresByField) {
      const y = cotton.model.yieldFor({ field_id: fieldId, crop_id: cropByField.get(fieldId)!, season_year: cropYear, planted_acres: acres })
      if (!y) continue
      yieldByField.set(fieldId, y)
      rows.push({ fieldId, acres, y })
    }
    return { rows, acresByField, yieldByField, plantedFieldIds }
  }, [plantings, plantingsLoaded, crops.length, cotton.model, cropYear])

  const farm = useMemo(() => summarizeCottonFieldYields(rows), [rows])

  return {
    loading: loadingRefs || cotton.loading,
    on: cotton.on,
    model: cotton.model,
    plantedFieldIds,
    acresFor: (fieldId) => (fieldId ? acresByField.get(fieldId) ?? null : null),
    yieldFor: (fieldId) => (fieldId ? yieldByField.get(fieldId) ?? null : null),
    rows,
    farm,
    refresh: () => { setNonce((n) => n + 1); cotton.refresh() },
  }
}
