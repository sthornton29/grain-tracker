-- Crop Insurance: add the irrigated/dryland PRACTICE distinction to policies.
--
-- A policy is now uniquely identified by entity × crop × county × crop_year ×
-- practice (+ plan_type): the same crop in a county/year can carry two policies —
-- one irrigated, one non-irrigated — each with its own aph_yield, coverage_level,
-- insured_acres, and premium. Projected and harvest prices stay SHARED per
-- crop/year (still sourced from harvest_price_estimates, not per practice).
-- SCO/ECO endorsements inherit the parent policy's practice (they FK to the
-- policy — no schema change there). Idempotent.

alter table public.crop_insurance_policies
  add column if not exists practice text not null default 'non_irrigated';

-- Existing policies default to non_irrigated (dryland), matching how fields and
-- plantings defaulted; the column default already applied this to rows present
-- at migration time. This line is a belt-and-suspenders no-op on re-run.
update public.crop_insurance_policies set practice = 'non_irrigated' where practice is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crop_insurance_policies_practice_check') then
    alter table public.crop_insurance_policies
      add constraint crop_insurance_policies_practice_check
      check (practice in ('irrigated', 'non_irrigated'));
  end if;
end $$;

create index if not exists crop_insurance_policies_practice_idx
  on public.crop_insurance_policies(crop_id, county_id, crop_year, practice);
