// Service-role assembly shared by the partner API's lease-projection routes
// and the farmer-facing /api/shares/[id]/preview — ONE code path builds the
// /marketing-prices payload (whole-operation rows + per-entity rows), the
// /projected-yields payload, and a share's entity structure, which is the
// structural guarantee that the farmer's preview shows exactly what the
// landowner's software receives. Every query scopes by org explicitly (the
// service role bypasses RLS).

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeEntityMarketingRows } from '@/lib/entity-marketing'
import { loadMarketingInputs, loadProductionInputs, type ProductionInputs } from '@/lib/marketing-inputs'
import { farmingEntitiesForFields, fieldEntityMap, type PartnerEntity } from '@/lib/partner-api'
import { fetchAll } from '@/lib/partner-api-server'
import {
  buildEntityMarketingPriceRecords,
  buildMarketingPriceRecords,
  buildProjectedYieldRecords,
  type EntityMarketingPriceRecord,
  type MarketingPriceRecord,
  type ProjectedYieldRecord,
} from '@/lib/partner-marketing'

export type MarketingPricesPayload = {
  /** Whole-operation price per crop (unchanged shape — existing consumers). */
  data: MarketingPriceRecord[]
  /** The same number per FARMING entity with shared fields (additive). */
  by_entity: EntityMarketingPriceRecord[]
}

/** The farming entities behind a set of fields (null = the whole org), with
 *  per-entity shared field counts — the handshake's `entities` list. */
export async function loadShareEntities(
  supabase: SupabaseClient,
  org: string,
  fieldIds: ReadonlySet<string> | null,
): Promise<PartnerEntity[]> {
  const [fields, farms, entities] = await Promise.all([
    fetchAll<{ id: string; farm_id: string | null }>((f, t) =>
      supabase.from('fields').select('id, farm_id').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ id: string; entity_id: string | null }>((f, t) =>
      supabase.from('farms').select('id, entity_id').eq('org_id', org).order('id').range(f, t)),
    fetchAll<{ id: string; name: string; entity_role: string | null }>((f, t) =>
      supabase.from('entities').select('id, name, entity_role').eq('org_id', org).order('id').range(f, t)),
  ])
  return farmingEntitiesForFields({ fieldIds, fields, farms, entities })
}

async function loadSalesStatus(supabase: SupabaseClient, org: string, year: number) {
  // Manual "physical sales complete" flags (050). A missing table simply
  // means no crop is final yet.
  const result = await supabase
    .from('crop_year_sales_status')
    .select('crop_id, physical_sales_complete')
    .eq('org_id', org)
    .eq('crop_year', year)
  return result.error ? [] : ((result.data ?? []) as Array<{ crop_id: string; physical_sales_complete: boolean }>)
}

/** The /marketing-prices payload. `sharedFieldIds` null = full-org token
 *  (every crop, every farming entity with fields). Returns the production
 *  assembly too so a caller can reuse it for projected yields. */
export async function buildMarketingPricesPayload(
  supabase: SupabaseClient,
  org: string,
  year: number,
  sharedFieldIds: ReadonlySet<string> | null,
): Promise<MarketingPricesPayload & { production: ProductionInputs }> {
  const [{ production, rows, entityInputs }, salesStatus] = await Promise.all([
    loadMarketingInputs(supabase, org, year),
    loadSalesStatus(supabase, org, year),
  ])
  const asOf = new Date().toISOString()

  const allowedCropIds =
    sharedFieldIds == null
      ? null
      : new Set(production.plantings.filter((p) => sharedFieldIds.has(p.field_id)).map((p) => p.crop_id))
  const data = buildMarketingPriceRecords({ rows, cropYear: year, salesStatus, allowedCropIds, asOf })

  const allFieldEntity = fieldEntityMap({ fields: production.fields, farms: production.farms })
  const sharedFieldEntity = new Map<string, string | null>()
  for (const [fieldId, entityId] of allFieldEntity) {
    if (sharedFieldIds == null || sharedFieldIds.has(fieldId)) sharedFieldEntity.set(fieldId, entityId)
  }
  const by_entity = buildEntityMarketingPriceRecords({
    entities: production.entities,
    rowsForEntity: (entityId) => computeEntityMarketingRows(entityInputs, entityId),
    sharedFieldEntity,
    plantings: production.plantings,
    cropYear: year,
    salesStatus,
    asOf,
  })
  return { data, by_entity, production }
}

/** The /projected-yields payload over an already-loaded (or freshly loaded)
 *  production assembly. `allowedFieldIds` null = every field. */
export async function buildProjectedYieldsPayload(
  supabase: SupabaseClient,
  org: string,
  year: number,
  allowedFieldIds: ReadonlySet<string> | null,
  production?: ProductionInputs | null,
): Promise<ProjectedYieldRecord[]> {
  const p = production ?? (await loadProductionInputs(supabase, org, year))
  return buildProjectedYieldRecords({
    cropYear: year,
    plantings: p.plantings,
    fields: p.fields,
    crops: p.crops,
    assumptions: p.assumptions,
    doubleCropIds: p.doubleCropIds,
    aggByKey: p.aggByKey,
    cottonLbsByField: p.cottonLbsByField,
    excluded: p.excluded,
    cropCompleteKeys: p.cropCompleteKeys,
    allowedFieldIds,
    fieldEntity: fieldEntityMap({ fields: p.fields, farms: p.farms }),
  })
}
