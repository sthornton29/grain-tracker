// GET /api/partner/v1/settlements?since= — one record per settlement × crop
// (crop attributed via each line's matched load): settlement date/number,
// buyer, crop, net units, net revenue. ?since= is a delta-sync cursor and
// compares against updated_at (ISO date or timestamp). Read-only.

import { NextRequest, NextResponse } from 'next/server'
import {
  partnerAuthGate,
  createServiceClient,
  serviceClientMissingResponse,
  fetchAll,
  errorResponse,
} from '@/lib/partner-api-server'
import {
  buildSettlementRecords,
  type BuyerRow,
  type CropRow,
  type SettlementLineRow,
  type SettlementRow,
} from '@/lib/partner-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PostgREST can't tell FK cardinality on an untyped client, so the embedded
// relation types as object-or-array — normalize below.
type EmbeddedLoad = { id: string; crop_id: string | null }
type LineWithLoad = SettlementLineRow & { loads: EmbeddedLoad | EmbeddedLoad[] | null }

export async function GET(req: NextRequest) {
  const denied = partnerAuthGate(req)
  if (denied) return denied
  const since = req.nextUrl.searchParams.get('since')
  if (since && !/^\d{4}-\d{2}-\d{2}/.test(since)) {
    return NextResponse.json(
      { error: '?since= must be an ISO date or timestamp (e.g. 2026-01-31 or 2026-01-31T00:00:00Z).' },
      { status: 400 },
    )
  }
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()

  try {
    const [settlements, lines, buyers, crops] = await Promise.all([
      fetchAll<SettlementRow>((f, t) =>
        supabase
          .from('settlements')
          .select('id, buyer_id, settlement_date, settlement_number, updated_at')
          .order('id')
          .range(f, t),
      ),
      fetchAll<LineWithLoad>((f, t) =>
        supabase
          .from('settlement_lines')
          .select('id, settlement_id, load_id, net_bushels, net_revenue, updated_at, loads(id, crop_id)')
          .order('id')
          .range(f, t),
      ),
      fetchAll<BuyerRow>((f, t) => supabase.from('buyers').select('id, name').order('id').range(f, t)),
      fetchAll<CropRow>((f, t) =>
        supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').order('id').range(f, t),
      ),
    ])
    const loads = lines.flatMap((l) =>
      l.loads == null ? [] : Array.isArray(l.loads) ? l.loads : [l.loads],
    )
    return NextResponse.json({
      data: buildSettlementRecords({ settlements, lines, loads, crops, buyers, since }),
    })
  } catch (e) {
    return errorResponse(e)
  }
}
