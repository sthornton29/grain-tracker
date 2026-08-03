// GET /api/partner/v1/hedging?year=&crop= — REALIZED hedge results ONLY:
// closed futures/options transactions with realized gain/loss net of
// commissions, plus a net realized total per crop × crop year. Open positions
// are never exposed by this endpoint. Read-only.

import { NextRequest, NextResponse } from 'next/server'
import {
  partnerAuthGate,
  createServiceClient,
  serviceClientMissingResponse,
  fetchAll,
  errorResponse,
} from '@/lib/partner-api-server'
import {
  buildHedgingRecords,
  type FuturesPositionRow,
  type OptionsPositionRow,
} from '@/lib/partner-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = partnerAuthGate(req)
  if (denied) return denied
  const params = req.nextUrl.searchParams
  const yearRaw = params.get('year')
  const year = yearRaw == null || yearRaw === '' ? null : Number(yearRaw)
  if (year != null && !Number.isInteger(year)) {
    return NextResponse.json({ error: '?year= must be an integer crop year.' }, { status: 400 })
  }
  const crop = params.get('crop')
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()

  try {
    // Only closed rows ever leave the database — the status filters here are
    // the "never open positions" guarantee, and the builder re-checks.
    const [futures, options] = await Promise.all([
      fetchAll<FuturesPositionRow>((f, t) =>
        supabase
          .from('futures_positions')
          .select('id, commodity, contract_symbol, crop_year, side, num_contracts, status, close_date, realized_pnl, updated_at')
          .eq('status', 'closed')
          .order('id')
          .range(f, t),
      ),
      fetchAll<OptionsPositionRow>((f, t) =>
        supabase
          .from('options_positions')
          .select('id, commodity, underlying_symbol, option_type, strike_price, crop_year, num_contracts, status, close_date, realized_pnl, updated_at')
          .in('status', ['closed_offset', 'expired_worthless', 'exercised'])
          .order('id')
          .range(f, t),
      ),
    ])
    const { transactions, totals } = buildHedgingRecords({ futures, options, year, crop })
    return NextResponse.json({ data: transactions, totals })
  } catch (e) {
    return errorResponse(e)
  }
}
