// GET /api/partner/v1/production?year=&crop= — production by field and entity:
// harvested acres + production units (dry bu for grains via the Yields pages'
// shrink math; lint lbs for cotton via gin receipts). Read-only.

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
  buildProductionRecords,
  type CombineEntryRow,
  type CropAssumptionStatusRow,
  type CropRow,
  type EntityRow,
  type FarmRow,
  type FieldRow,
  type GinReceiptRow,
  type LoadRow,
  type PlantingRow,
  type SplitRow,
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
  const crop = req.nextUrl.searchParams.get('crop')

  try {
    const [plantings, loads, splits, ginReceipts, fields, farms, entities, crops] = await Promise.all([
      fetchAll<PlantingRow>((f, t) =>
        supabase
          .from('field_plantings')
          .select('id, field_id, crop_id, season_year, planted_acres, irrigated_acres, dryland_acres, yield_include_override, updated_at')
          .eq('org_id', org)
          .eq('season_year', year)
          .order('id')
          .range(f, t),
      ),
      fetchAll<LoadRow>((f, t) =>
        supabase
          .from('loads')
          .select('id, date, net_weight, moisture, crop_id, crop_year, dry_bushels_override, from_type, from_field_id, updated_at')
          .eq('org_id', org)
          .eq('crop_year', year)
          .order('id')
          .range(f, t),
      ),
      fetchAll<SplitRow>((f, t) =>
        supabase.from('load_splits').select('load_id, field_id, crop_id, dry_bushels').eq('org_id', org).order('id').range(f, t),
      ),
      fetchAll<GinReceiptRow>((f, t) =>
        supabase
          .from('gin_receipts')
          .select('id, field_id, crop_year, total_bale_weight, updated_at')
          .eq('org_id', org)
          .eq('crop_year', year)
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
        supabase.from('entities').select('id, name, entity_role, updated_at').eq('org_id', org).order('id').range(f, t),
      ),
      fetchAll<CropRow>((f, t) =>
        supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').eq('org_id', org).order('id').range(f, t),
      ),
    ])
    // Combine entries (062) net against weighed loads and carry the explicit
    // harvest_complete done-marker. A missing table (062 not applied yet)
    // degrades to none rather than failing the endpoint.
    let combineEntries: CombineEntryRow[] = []
    const combineResult = await supabase
      .from('combine_yield_entries')
      .select('field_id, crop_id, crop_year, adjusted_total_bushels, harvest_complete, entry_date, updated_at')
      .eq('org_id', org)
      .eq('crop_year', year)
    if (!combineResult.error) combineEntries = (combineResult.data ?? []) as CombineEntryRow[]

    // Crop-level harvest-complete flags — force every field of the crop × year
    // to classify complete, exactly like the Yields page.
    let cropAssumptions: CropAssumptionStatusRow[] = []
    const assumptionResult = await supabase
      .from('crop_assumptions')
      .select('crop_id, crop_year, harvest_complete')
      .eq('org_id', org)
      .eq('crop_year', year)
    if (!assumptionResult.error) cropAssumptions = (assumptionResult.data ?? []) as CropAssumptionStatusRow[]

    let records: Array<Record<string, unknown>> = buildProductionRecords({
      plantings, loads, splits, ginReceipts, combineEntries, cropAssumptions, fields, farms, entities, crops, year, crop,
    })
    if (access.share) {
      const allowed = await sharedFieldIds(supabase, org, access.share.landownerId)
      records = records.filter((r) => allowed.has(r.field_id as string))
      // Harvest status is always shared; the yields opt-in only controls the
      // production quantities themselves.
      if (!access.share.includeYields) {
        records = records.map((r) => ({ ...r, production_units: null }))
      }
    }
    return NextResponse.json({ data: records })
  } catch (e) {
    return errorResponse(e)
  }
}
