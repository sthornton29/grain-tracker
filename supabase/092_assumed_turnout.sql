-- 092: Assumed lint turnout for cotton — the manual tier of the turnout
-- resolution (lib/cotton.ts resolveTurnout) that estimates lint for seed
-- cotton picked but not yet ginned: manual turnout for the crop × crop year
-- > this year's ginned weighted average > last year's > the 40% default.
-- Null = no manual figure (the automatic tiers apply). Percent (41.5 = 41.5%).
--
-- An existing tenant table — the column rides crop_assumptions' 020/052/054/
-- 061 policies. Viewers may privately re-assume it (052 overrides), so the
-- field allowlist is re-created with it (081 / 059 are the template).
-- Idempotent.

alter table public.crop_assumptions
  add column if not exists assumed_turnout_pct numeric(5,2)
    check (assumed_turnout_pct > 0 and assumed_turnout_pct <= 100);

comment on column public.crop_assumptions.assumed_turnout_pct is
  '092: manual lint turnout % for the crop × crop year (cotton). Null = derive from ginned cotton (this year, then last year), else the 40% default.';

do $$ begin
  alter table public.viewer_assumption_overrides
    drop constraint if exists viewer_assumption_overrides_field_check;
  alter table public.viewer_assumption_overrides
    add constraint viewer_assumption_overrides_field_check check (
      (scope = 'crop' and field in (
        'expected_yield', 'expected_yield_irr', 'expected_yield_dry', 'expected_yield_dc_irr', 'expected_yield_dc_dry',
        'cost_per_acre', 'cost_per_acre_irr', 'cost_per_acre_dry', 'cost_per_acre_dc_irr', 'cost_per_acre_dc_dry',
        'assumed_acres', 'assumed_acres_irr', 'assumed_acres_dry', 'assumed_acres_dc_irr', 'assumed_acres_dc_dry',
        'assumed_basis', 'assumed_futures', 'reference_contract_month',
        'assumed_turnout_pct'
      ))
      or
      (scope = 'county' and field in ('yield_differential', 'county_yield_override', 'rma_final_county_yield'))
    );
end $$;
