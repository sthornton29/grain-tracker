-- Crop Insurance: "covers all planted acres" attestation on policies.
--
-- Insured acres are fixed when the policy is purchased (acres reported at the
-- sales-closing date). Actual planted acres drift from that as planting plans
-- change, so the Coverage Check's insured-vs-planted comparison can flag an
-- "under-insured" / "over-reported" gap that isn't a real coverage problem —
-- the agent may have confirmed every planted acre is in fact covered.
--
-- covers_all_planted_acres lets the operator assert that for an
-- entity × crop × county × crop_year × practice combination: when any policy in
-- that combination has it set, the Coverage Check treats the combination as
-- fully covered and stops flagging the acre variance (the "no policy" flag is
-- never suppressed — that stays a real exposure). coverage_note records the
-- justification (e.g. "confirmed with agent 6/2026"). Idempotent.

alter table public.crop_insurance_policies
  add column if not exists covers_all_planted_acres boolean not null default false;

alter table public.crop_insurance_policies
  add column if not exists coverage_note text;
