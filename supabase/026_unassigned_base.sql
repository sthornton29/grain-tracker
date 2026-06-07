-- Grain Tracker — Unassigned / generic base acres.
--
-- FSA retains "unassigned" (generic) base acres on a farm record, but they do
-- NOT generate ARC/PLC payments. Under the OBBBA some may become eligible
-- starting with the 2026 crop. We track them on farm_base_acres with a flag and
-- allow commodity_id to be null (generic base has no commodity until converted).
-- Idempotent.

alter table public.farm_base_acres
  add column if not exists is_unassigned boolean not null default false;

-- Generic/unassigned base may carry no commodity. The unique (farm_id,
-- commodity_id) constraint still holds for assigned rows; Postgres treats nulls
-- as distinct, so a farm can hold one or more unassigned rows alongside them.
alter table public.farm_base_acres
  alter column commodity_id drop not null;

create index if not exists farm_base_acres_unassigned_idx
  on public.farm_base_acres(is_unassigned);
