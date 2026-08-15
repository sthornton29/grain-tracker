// GET /api/partner/v1/fields — every field with its farm/entity and acres.
// Read-only; bearer PARTNER_API_TOKEN; updated_at on every record.

import { NextRequest, NextResponse } from 'next/server'
import {
  resolvePartnerAccess,
  sharedFieldIds,
  createServiceClient,
  serviceClientMissingResponse,
  fetchAll,
  errorResponse,
} from '@/lib/partner-api-server'
import { buildFieldRecords, type EntityRow, type FarmRow, type FieldRow } from '@/lib/partner-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const access = await resolvePartnerAccess(req, supabase)
  if (access instanceof NextResponse) return access
  const org = access.org

  try {
    const [fields, farms, entities] = await Promise.all([
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
    ])
    let records = buildFieldRecords({ fields, farms, entities })
    // Landowner-share tokens see only the fields on that landowner's farms.
    if (access.share) {
      const allowed = await sharedFieldIds(supabase, org, access.share.landownerId)
      records = records.filter((r) => allowed.has(r.id))
    }
    return NextResponse.json({ data: records })
  } catch (e) {
    return errorResponse(e)
  }
}
