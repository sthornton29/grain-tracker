// GET /api/partner/v1/plantings?year= — the year's plantings: field, crop,
// planted acres, entity. Read-only; bearer PARTNER_API_TOKEN.

import { NextRequest, NextResponse } from 'next/server'
import {
  resolvePartnerAccess,
  sharedFieldIds,
  createServiceClient,
  serviceClientMissingResponse,
  fetchAll,
  requireYearParam,
  errorResponse,
} from '@/lib/partner-api-server'
import {
  buildPlantingRecords,
  type CropRow,
  type EntityRow,
  type FarmRow,
  type FieldRow,
  type PlantingRow,
  type PlantingVarietyRow,
} from '@/lib/partner-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const access = await resolvePartnerAccess(req, supabase)
  if (access instanceof NextResponse) return access
  const org = access.org
  const year = requireYearParam(req)
  if (year instanceof NextResponse) return year

  try {
    const [plantings, fields, farms, entities, crops] = await Promise.all([
      fetchAll<PlantingRow>((f, t) =>
        supabase
          .from('field_plantings')
          .select('id, field_id, crop_id, season_year, planted_acres, irrigated_acres, dryland_acres, planting_date, updated_at')
          .eq('org_id', org)
          .eq('season_year', year)
          .order('id')
          .range(f, t),
      ),
      fetchAll<FieldRow>((f, t) =>
        supabase
          .from('fields')
          .select('id, farm_id, name_or_number, total_acres, irrigated_acres, dryland_acres, updated_at')
          .eq('org_id', org)
          .order('id')
          .range(f, t),
      ),
      fetchAll<FarmRow>((f, t) =>
        supabase.from('farms').select('id, name, fsa_number, entity_id, updated_at').eq('org_id', org).order('id').range(f, t),
      ),
      fetchAll<EntityRow>((f, t) =>
        supabase.from('entities').select('id, name, updated_at').eq('org_id', org).order('id').range(f, t),
      ),
      fetchAll<CropRow>((f, t) =>
        supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').eq('org_id', org).order('id').range(f, t),
      ),
    ])
    // Varieties per planting (022). A missing org_id column or table state
    // degrades to an empty list rather than failing the endpoint.
    let varieties: PlantingVarietyRow[] = []
    if (plantings.length > 0) {
      const varietyResult = await supabase
        .from('field_planting_varieties')
        .select('planting_id, variety, acres')
        .eq('org_id', org)
        .in('planting_id', plantings.map((p) => p.id))
      if (!varietyResult.error) varieties = (varietyResult.data ?? []) as PlantingVarietyRow[]
    }

    let records = buildPlantingRecords({ plantings, fields, farms, entities, crops, year, varieties })
    if (access.share) {
      const allowed = await sharedFieldIds(supabase, org, access.share.landownerId)
      records = records.filter((r) => allowed.has(r.field_id))
    }
    return NextResponse.json({ data: records })
  } catch (e) {
    return errorResponse(e)
  }
}
