// GET /api/partner/v1/plantings?year= — the year's plantings: field, crop,
// planted acres, entity. Read-only; bearer PARTNER_API_TOKEN.

import { NextRequest, NextResponse } from 'next/server'
import {
  resolvePartnerOrg,
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
} from '@/lib/partner-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const org = await resolvePartnerOrg(req, supabase)
  if (org instanceof NextResponse) return org
  const year = requireYearParam(req)
  if (year instanceof NextResponse) return year

  try {
    const [plantings, fields, farms, entities, crops] = await Promise.all([
      fetchAll<PlantingRow>((f, t) =>
        supabase
          .from('field_plantings')
          .select('id, field_id, crop_id, season_year, planted_acres, irrigated_acres, dryland_acres, updated_at')
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
    return NextResponse.json({
      data: buildPlantingRecords({ plantings, fields, farms, entities, crops, year }),
    })
  } catch (e) {
    return errorResponse(e)
  }
}
