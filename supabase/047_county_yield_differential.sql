-- 047 — County yield assumption becomes a MY-YIELD-VS-COUNTY DIFFERENTIAL.
--
-- The old model (county = RMA expected × (1 + variance_pct)) is replaced by an
-- absolute differential in the crop's own yield unit (bu/ac grains, lbs/ac
-- cotton): yield_differential = "my yields run this much ABOVE the county".
-- Estimated county yield = the farm's own expected/actual yield − differential.
-- variance_pct stays in place (deprecated, unread) for history; the absolute
-- county_yield_override and rma_final_county_yield fields are unchanged and
-- keep their precedence (final pins everything > override > differential).
--
-- Backfill: where the operator had a non-zero variance AND both the farm's
-- expected yield (crop_assumptions) and an RMA expected county yield (from the
-- policy/SCO/ECO rows for that crop × county × year) are on file, derive
--   differential = expected_farm_yield − (RMA expected county × (1 + variance/100))
-- Everything else stays NULL for re-entry (the UI prompts for the differential).
--
-- The RMA expected county yield is resolved in a CTE: an UPDATE target can't
-- be referenced from a LATERAL subquery in its FROM list (42P10), but a
-- correlated scalar subquery inside a plain SELECT is fine. Preference order
-- is explicit: the policy's own figure, then the SCO's, then the ECO's.
--
-- Idempotent: safe to re-run (backfilled rows have a non-null differential
-- and are skipped on the next run).

alter table public.county_yield_assumptions
  add column if not exists yield_differential numeric(12,4);

with resolved as (
  select a.id as assumption_id,
         (
           select ecy.expected_county_yield
           from (
             select 1 as pri, p.expected_county_yield
             from public.crop_insurance_policies p
             where p.crop_id = a.crop_id and p.crop_year = a.crop_year
               and (p.county_id = a.county_id or (p.county_id is null and a.county_id is null))
               and p.expected_county_yield is not null
             union all
             select 2, s.expected_county_yield
             from public.crop_insurance_sco s
             join public.crop_insurance_policies p on p.id = s.policy_id
             where p.crop_id = a.crop_id and p.crop_year = a.crop_year
               and (p.county_id = a.county_id or (p.county_id is null and a.county_id is null))
               and s.expected_county_yield is not null
             union all
             select 3, e.expected_county_yield
             from public.crop_insurance_eco e
             join public.crop_insurance_policies p on p.id = e.policy_id
             where p.crop_id = a.crop_id and p.crop_year = a.crop_year
               and (p.county_id = a.county_id or (p.county_id is null and a.county_id is null))
               and e.expected_county_yield is not null
           ) ecy
           where ecy.expected_county_yield > 0
           order by ecy.pri
           limit 1
         ) as expected_county_yield
  from public.county_yield_assumptions a
  where a.yield_differential is null
    and a.variance_pct <> 0
)
update public.county_yield_assumptions a
set yield_differential = round((ca.expected_yield - r.expected_county_yield * (1 + a.variance_pct / 100.0))::numeric, 4)
from public.crop_assumptions ca,
     resolved r
where r.assumption_id = a.id
  and r.expected_county_yield is not null
  and ca.crop_id = a.crop_id and ca.crop_year = a.crop_year
  and ca.expected_yield is not null;
