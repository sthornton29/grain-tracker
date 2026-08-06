-- 059: Reference contract month override for the marketing What-If
-- Idempotent: safe to re-run in the Supabase SQL editor.
--
-- crop_assumptions.reference_contract_month — an optional contract-month
-- label ('SEP 26') pointing the crop year's marketing reference contract at a
-- specific listed month. Null = automatic: the new-crop benchmark (DEC corn,
-- NOV soybeans, JUL wheat, DEC cotton), rolled forward past expiry by
-- lib/reference-contract.ts. Persisted alongside the other standing What-If
-- assumptions (assumed_basis / assumed_futures) so the marketing engine, the
-- What-If, and the Income Sensitivity price axis all follow one answer.
--
-- Viewers may override it privately like any other What-If assumption, so the
-- 052 field check-constraint gains the new field (the override machinery is
-- field-generic; only the constraint enumerates fields).

alter table public.crop_assumptions
  add column if not exists reference_contract_month text;

do $$ begin
  alter table public.viewer_assumption_overrides
    drop constraint if exists viewer_assumption_overrides_field_check;
  alter table public.viewer_assumption_overrides
    add constraint viewer_assumption_overrides_field_check check (
      (scope = 'crop' and field in (
        'expected_yield', 'expected_yield_irr', 'expected_yield_dry', 'expected_yield_dc_irr', 'expected_yield_dc_dry',
        'cost_per_acre', 'cost_per_acre_irr', 'cost_per_acre_dry', 'cost_per_acre_dc_irr', 'cost_per_acre_dc_dry',
        'assumed_basis', 'assumed_futures', 'reference_contract_month'
      ))
      or
      (scope = 'county' and field in ('yield_differential', 'county_yield_override', 'rma_final_county_yield'))
    );
end $$;
