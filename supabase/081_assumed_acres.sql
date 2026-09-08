-- 081: Assumed acres — marketing dashboards for crop years with no plantings yet.
-- Idempotent: safe to re-run in the Supabase SQL editor.
--
-- Next year's wheat is sold ahead and the year-after's corn is hedged long
-- before a single field is planted. Until now the Marketing Dashboard (and
-- everything riding its engine — Revenue Projections, Income Sensitivity,
-- Cash Flow) had nothing to show for such a year because every crop's acres
-- came from field_plantings alone. This adds an ASSUMED acreage per crop ×
-- year to crop_assumptions, with the same optional irrigated/dryland ×
-- full-season/double-crop breakout the yield and cost assumptions carry.
--
--   crop_assumptions.assumed_acres         — overall assumed acres for the crop
--   crop_assumptions.assumed_acres_irr     — full-season irrigated (optional)
--   crop_assumptions.assumed_acres_dry     — full-season dryland   (optional)
--   crop_assumptions.assumed_acres_dc_irr  — double-crop irrigated (optional)
--   crop_assumptions.assumed_acres_dc_dry  — double-crop dryland   (optional)
--
-- Resolution rule (lib/marketing.ts resolveAcresByCrop): real plantings for a
-- crop × year ALWAYS win. The moment the first planting is entered the
-- assumed figure is ignored (the panel greys it: "using planted acres").
-- With no plantings, expected production = assumed acres × expected yield,
-- and contracts, hedges, costs and the unpriced valuation all compute as
-- usual. Assumed acres are operation-level (there is no field to attribute
-- them to), so they show under "All entities"; an entity filter keeps the
-- standing pro-rata-by-planted-acres rule.
--
-- Viewers may override the assumed acres privately like every other What-If
-- assumption (052 overlay), so the field check-constraint gains the five
-- columns — the override machinery is field-generic; only the constraint
-- enumerates fields (059 is the template).
--
-- An existing tenant table — the columns ride its 020/052/054/061 policies.

alter table public.crop_assumptions
  add column if not exists assumed_acres        numeric(12,2) check (assumed_acres >= 0),
  add column if not exists assumed_acres_irr    numeric(12,2) check (assumed_acres_irr >= 0),
  add column if not exists assumed_acres_dry    numeric(12,2) check (assumed_acres_dry >= 0),
  add column if not exists assumed_acres_dc_irr numeric(12,2) check (assumed_acres_dc_irr >= 0),
  add column if not exists assumed_acres_dc_dry numeric(12,2) check (assumed_acres_dc_dry >= 0);

do $$ begin
  alter table public.viewer_assumption_overrides
    drop constraint if exists viewer_assumption_overrides_field_check;
  alter table public.viewer_assumption_overrides
    add constraint viewer_assumption_overrides_field_check check (
      (scope = 'crop' and field in (
        'expected_yield', 'expected_yield_irr', 'expected_yield_dry', 'expected_yield_dc_irr', 'expected_yield_dc_dry',
        'cost_per_acre', 'cost_per_acre_irr', 'cost_per_acre_dry', 'cost_per_acre_dc_irr', 'cost_per_acre_dc_dry',
        'assumed_acres', 'assumed_acres_irr', 'assumed_acres_dry', 'assumed_acres_dc_irr', 'assumed_acres_dc_dry',
        'assumed_basis', 'assumed_futures', 'reference_contract_month'
      ))
      or
      (scope = 'county' and field in ('yield_differential', 'county_yield_override', 'rma_final_county_yield'))
    );
end $$;
