-- Grain Tracker — Optional manual override for dry bushels on a load.
-- When set, every report uses this value instead of the computed one.
-- Idempotent.

alter table public.loads
  add column if not exists dry_bushels_override numeric(12,2);
