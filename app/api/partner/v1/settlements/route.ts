// GET /api/partner/v1/settlements — two token classes, two payloads:
//
//   * Full-org tokens (?since=): one record per GRAIN settlement × crop (crop
//     attributed via each line's matched load): settlement date/number, buyer,
//     crop, net units, net revenue. ?since= is a delta-sync cursor on
//     updated_at (ISO date or timestamp). Unchanged since 050.
//   * Landowner-share tokens (?crop_year=, scope `settlements`, 087): the
//     landowner's own rent statements as Turnrow Farm finalized them
//     (landowner_settlements) — only the statements bound to THAT landowner
//     (Grain landowner id), never another landowner's, never an unresolved
//     one, and never anything beyond the statement rows themselves. Scope
//     off → 403 not_in_share_scope naming `settlements`.
//
// Read-only.

import { NextRequest, NextResponse } from 'next/server'
import {
  resolvePartnerAccess,
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
import { shareScopeError } from '@/lib/partner-marketing'
import { landownerSettlementsForShare, type LandownerSettlementRecord } from '@/lib/farm-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PostgREST can't tell FK cardinality on an untyped client, so the embedded
// relation types as object-or-array — normalize below.
type EmbeddedLoad = { id: string; crop_id: string | null }
type LineWithLoad = SettlementLineRow & { loads: EmbeddedLoad | EmbeddedLoad[] | null }

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const access = await resolvePartnerAccess(req, supabase)
  if (access instanceof NextResponse) return access
  const org = access.org

  // ---- Landowner share: rent statements from Turnrow Farm ------------------
  if (access.share) {
    const denied = shareScopeError(access.share, 'settlements')
    if (denied) return NextResponse.json(denied, { status: 403 })
    const yearRaw = req.nextUrl.searchParams.get('crop_year') ?? req.nextUrl.searchParams.get('year')
    const cropYear = yearRaw ? Number(yearRaw) : null
    if (yearRaw && (!Number.isInteger(cropYear) || (cropYear as number) < 1900 || (cropYear as number) > 2200)) {
      return NextResponse.json({ error: '?crop_year= must be a four-digit year.' }, { status: 400 })
    }
    try {
      // Filtered by the share's landowner in the QUERY as well as in the pure
      // filter — two fences around another landowner's statement.
      const rows = await fetchAll<LandownerSettlementRecord>((f, t) =>
        supabase
          .from('landowner_settlements')
          .select('id, farm_uid, landowner_id, landowner_name, crop_year, lease_type, statement, finalized_at, updated_at')
          .eq('org_id', org)
          .eq('landowner_id', access.share!.landownerId)
          .order('id')
          .range(f, t),
      )
      return NextResponse.json({ data: landownerSettlementsForShare(rows, access.share.landownerId, cropYear), crop_year: cropYear })
    } catch (e) {
      const message = e instanceof Error ? e.message : ''
      if (/landowner_settlements/.test(message) && /does not exist|relation/.test(message)) {
        return NextResponse.json({ data: [], crop_year: cropYear, note: 'Rent statements are not available yet.' })
      }
      return errorResponse(e)
    }
  }

  // ---- Full-org token: Grain settlements -----------------------------------
  const since = req.nextUrl.searchParams.get('since')
  if (since && !/^\d{4}-\d{2}-\d{2}/.test(since)) {
    return NextResponse.json(
      { error: '?since= must be an ISO date or timestamp (e.g. 2026-01-31 or 2026-01-31T00:00:00Z).' },
      { status: 400 },
    )
  }

  try {
    const [settlements, lines, buyers, crops] = await Promise.all([
      fetchAll<SettlementRow>((f, t) =>
        supabase
          .from('settlements')
          .select('id, buyer_id, settlement_date, settlement_number, updated_at')
          .eq('org_id', org)
          .order('id')
          .range(f, t),
      ),
      fetchAll<LineWithLoad>((f, t) =>
        supabase
          .from('settlement_lines')
          .select('id, settlement_id, load_id, net_bushels, net_revenue, updated_at, loads(id, crop_id)')
          .eq('org_id', org)
          .order('id')
          .range(f, t),
      ),
      fetchAll<BuyerRow>((f, t) => supabase.from('buyers').select('id, name').eq('org_id', org).order('id').range(f, t)),
      fetchAll<CropRow>((f, t) =>
        supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').eq('org_id', org).order('id').range(f, t),
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
