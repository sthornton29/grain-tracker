// GET /api/partner/v1/fields — every field with its farm/entity and acres.
// Read-only; bearer PARTNER_API_TOKEN; updated_at on every record.

import { NextRequest, NextResponse } from 'next/server'
import {
  partnerAuthGate,
  createServiceClient,
  serviceClientMissingResponse,
  fetchAll,
  errorResponse,
} from '@/lib/partner-api-server'
import { buildFieldRecords, type EntityRow, type FarmRow, type FieldRow } from '@/lib/partner-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = partnerAuthGate(req)
  if (denied) return denied
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()

  try {
    const [fields, farms, entities] = await Promise.all([
      fetchAll<FieldRow>((f, t) =>
        supabase
          .from('fields')
          .select('id, farm_id, name_or_number, total_acres, irrigated_acres, dryland_acres, updated_at')
          .order('id')
          .range(f, t),
      ),
      fetchAll<FarmRow>((f, t) =>
        supabase.from('farms').select('id, name, fsa_number, entity_id, updated_at').order('id').range(f, t),
      ),
      fetchAll<EntityRow>((f, t) =>
        supabase.from('entities').select('id, name, updated_at').order('id').range(f, t),
      ),
    ])
    return NextResponse.json({ data: buildFieldRecords({ fields, farms, entities }) })
  } catch (e) {
    return errorResponse(e)
  }
}
