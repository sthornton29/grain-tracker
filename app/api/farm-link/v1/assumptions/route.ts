// POST /api/farm-link/v1/assumptions {crop_year, rows: [{crop, cost_per_acre,
// cost_per_acre_irrigated, cost_per_acre_dryland, cost_per_acre_dc_irrigated,
// cost_per_acre_dc_dryland, source, computed_at}]} — writes crop_assumptions'
// cost per acre + breakouts for the crop year (source 'turnrow_farm' + the
// timestamp, so the Marketing page shows "from Turnrow Farm, updated <date>")
// and budget_lines.cost_per_acre in scenarios marked to follow Turnrow Farm.
// A crop whose manual override switch is on is skipped and says so.
// includes_insurance (088): the pushed cost per acre already carries the crop
// insurance premium, so Grain stops subtracting its own premium again in the
// margins built on these rows.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, serviceClientMissingResponse, errorResponse, resolveFarmLink, requireScope, farmLinkRateLimited, rateLimitedResponse, finish, readJson, fetchAll } from '@/lib/farm-link-server'
import { planAssumptionsWrite, type AssumptionRow } from '@/lib/farm-link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = createServiceClient()
  if (!supabase) return serviceClientMissingResponse()
  const ctx = await resolveFarmLink(req, supabase)
  if (ctx instanceof NextResponse) return ctx
  if (farmLinkRateLimited(ctx.link.id)) return rateLimitedResponse()
  const denied = requireScope(ctx, 'assumptions:write')
  if (denied) return denied
  const body = await readJson(req)
  if (body instanceof NextResponse) return body
  const cropYear = Number(body.crop_year)
  if (!Number.isInteger(cropYear) || cropYear < 1900 || cropYear > 2200) return NextResponse.json({ error: 'crop_year is required.' }, { status: 400 })
  const rows = Array.isArray(body.rows) ? (body.rows as AssumptionRow[]) : null
  if (!rows) return NextResponse.json({ error: 'rows must be an array.' }, { status: 400 })
  const includesInsurance = body.includes_insurance === true
  if (rows.length > 200) return NextResponse.json({ error: 'At most 200 rows per request.' }, { status: 400 })

  try {
    const org = ctx.org
    const [crops, existing, scenarios, budgetLines] = await Promise.all([
      fetchAll<{ id: string; name: string }>((f, t) => supabase.from('crops').select('id, name').eq('org_id', org).order('id').range(f, t)),
      fetchAll<{ id: string; crop_id: string; crop_year: number; cost_manual_override: boolean | null }>((f, t) =>
        supabase.from('crop_assumptions').select('id, crop_id, crop_year, cost_manual_override').eq('org_id', org).eq('crop_year', cropYear).order('id').range(f, t)),
      fetchAll<{ id: string; budget_crop_year: number; follow_farm_costs: boolean | null }>((f, t) =>
        supabase.from('budget_scenarios').select('id, budget_crop_year, follow_farm_costs').eq('org_id', org).eq('budget_crop_year', cropYear).order('id').range(f, t)).catch(() => []),
      fetchAll<{ id: string; scenario_id: string; crop_id: string; practice: string | null; cropping: string | null }>((f, t) =>
        supabase.from('budget_lines').select('id, scenario_id, crop_id, practice, cropping').eq('org_id', org).order('id').range(f, t)).catch(() => []),
    ])
    const plan = planAssumptionsWrite({ cropYear, rows, crops, existing, scenarios, budgetLines, includesInsurance, now: new Date().toISOString() })
    for (const up of plan.upserts) {
      const row = { ...up, org_id: org, updated_at: new Date().toISOString() }
      let { error } = await supabase.from('crop_assumptions').upsert(row, { onConflict: 'crop_id,crop_year' })
      if (error && /cost_includes_insurance/.test(error.message)) {
        // 088 not applied yet: write the costs without the flag rather than
        // refuse the whole push.
        const { cost_includes_insurance: _drop, ...withoutFlag } = row
        ;({ error } = await supabase.from('crop_assumptions').upsert(withoutFlag, { onConflict: 'crop_id,crop_year' }))
      }
      if (error) throw new Error(`crop_assumptions: ${error.message}`)
    }
    for (const bl of plan.budgetLineUpdates) {
      const { id, ...patch } = bl
      const { error } = await supabase.from('budget_lines').update(patch).eq('id', id).eq('org_id', org)
      if (error) throw new Error(`budget_lines: ${error.message}`)
    }
    const counts = { rows: rows.length, updated: plan.upserts.length, skipped: plan.results.filter((r) => r.action === 'skipped').length, budget_lines: plan.budgetLineUpdates.length }
    const res = NextResponse.json({ data: plan.results, counts, crop_year: cropYear, includes_insurance: includesInsurance })
    return finish(supabase, ctx, res, { endpoint: 'assumptions', method: 'POST', counts, direction: 'inbound' })
  } catch (e) {
    return errorResponse(e)
  }
}
