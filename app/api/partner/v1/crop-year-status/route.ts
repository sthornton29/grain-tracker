// GET /api/partner/v1/crop-year-status?year= — per crop: production units,
// settled/sold units, unsold balance, computed all-sold check AND the manual
// Settings → Crops "physical sales complete" flag (shrink and small residuals
// can keep the computed check from ever hitting zero). Read-only.

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
  buildCropYearStatus,
  type BaleDispositionRow,
  type BaleRow,
  type CccLoanRow,
  type CombineEntryRow,
  type CropRow,
  type GinReceiptRow,
  type LoadRow,
  type PlantingRow,
  type SalesStatusRow,
  type SettlementLineRow,
  type SplitRow,
} from '@/lib/partner-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PostgREST can't tell FK cardinality on an untyped client, so the embedded
// relation types as object-or-array — normalize below.
type EmbeddedLoad = { id: string; crop_id: string | null; crop_year: number | null }
type LineWithLoad = SettlementLineRow & { loads: EmbeddedLoad | EmbeddedLoad[] | null }

export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const org = await resolvePartnerOrg(req, supabase)
  if (org instanceof NextResponse) return org
  const year = requireYearParam(req)
  if (year instanceof NextResponse) return year

  try {
    const [plantings, loads, splits, crops, lines, ginReceipts, bales, dispositions, loans] =
      await Promise.all([
        fetchAll<PlantingRow>((f, t) =>
          supabase
            .from('field_plantings')
            .select('id, field_id, crop_id, season_year, planted_acres, irrigated_acres, dryland_acres, updated_at')
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
        fetchAll<CropRow>((f, t) =>
          supabase.from('crops').select('id, name, base_moisture_pct, base_lb_per_bushel').eq('org_id', org).order('id').range(f, t),
        ),
        fetchAll<LineWithLoad>((f, t) =>
          supabase
            .from('settlement_lines')
            .select('id, settlement_id, load_id, net_bushels, net_revenue, updated_at, loads(id, crop_id, crop_year)')
            .eq('org_id', org)
            .not('load_id', 'is', null)
            .order('id')
            .range(f, t),
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
        fetchAll<BaleRow>((f, t) =>
          supabase
            .from('cotton_bales')
            .select('id, gin_receipt_id, crop_year, net_weight_lbs, updated_at')
            .eq('org_id', org)
            .eq('crop_year', year)
            .order('id')
            .range(f, t),
        ),
        fetchAll<BaleDispositionRow>((f, t) =>
          supabase
            .from('cotton_bale_dispositions')
            .select('bale_id, disposition, loan_id')
            .eq('org_id', org)
            .order('id')
            .range(f, t),
        ),
        fetchAll<CccLoanRow>((f, t) => supabase.from('ccc_loans').select('id, status').eq('org_id', org).order('id').range(f, t)),
      ])

    // Combine entries (062) net against weighed loads. A missing table (062
    // not applied yet) degrades to none — same pattern as sales status below.
    let combineEntries: CombineEntryRow[] = []
    const combineResult = await supabase
      .from('combine_yield_entries')
      .select('field_id, crop_id, crop_year, adjusted_total_bushels, updated_at')
      .eq('org_id', org)
      .eq('crop_year', year)
    if (!combineResult.error) combineEntries = (combineResult.data ?? []) as CombineEntryRow[]

    // The manual flag lives in crop_year_sales_status (migration 050). A
    // missing table gets an actionable message instead of a bare 42P01.
    let salesStatus: SalesStatusRow[] = []
    let note: string | undefined
    const statusResult = await supabase
      .from('crop_year_sales_status')
      .select('crop_id, crop_year, physical_sales_complete, updated_at')
      .eq('org_id', org)
      .eq('crop_year', year)
    if (statusResult.error) {
      note = 'crop_year_sales_status is missing — run migration 050; manual flags default to false.'
    } else {
      salesStatus = (statusResult.data ?? []) as SalesStatusRow[]
    }

    const settlementLoads = lines.flatMap((l) =>
      l.loads == null ? [] : Array.isArray(l.loads) ? l.loads : [l.loads],
    )
    const data = buildCropYearStatus({
      plantings, loads, splits, crops, lines, settlementLoads,
      ginReceipts, bales, baleDispositions: dispositions, cccLoans: loans,
      salesStatus, combineEntries, year,
    })
    return NextResponse.json(note ? { data, note } : { data })
  } catch (e) {
    return errorResponse(e)
  }
}
