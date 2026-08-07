-- 060: Load-level irrigated / dryland designation
-- Idempotent: safe to re-run in the Supabase SQL editor.
--
-- Adds:
--   * loads.practice        ('irrigated' | 'dryland', nullable)
--   * load_splits.practice  ('irrigated' | 'dryland', nullable)
--
-- Null = undesignated. For single-practice fields the practice is implied by
-- the field's planting and is auto-filled at save time (never asked in the
-- UI); the stored value keeps the yields math one code path. For
-- mixed-practice fields the designation is optional per load (and per split
-- portion, since a split load's portions can come from different fields).
--
-- When every counted load/portion on a mixed field carries a designation, the
-- irrigated/dryland bushel breakout derives from the loads and the
-- post-harvest allocation prompt is suppressed. A manually saved allocation
-- (field_plantings.yield_breakout_entered, migration 016) always wins over
-- later load-level edits.

do $$ begin
  alter table public.loads
    add column if not exists practice text;
  alter table public.load_splits
    add column if not exists practice text;

  if not exists (
    select 1 from pg_constraint where conname = 'loads_practice_check'
  ) then
    alter table public.loads
      add constraint loads_practice_check
        check (practice is null or practice in ('irrigated', 'dryland'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'load_splits_practice_check'
  ) then
    alter table public.load_splits
      add constraint load_splits_practice_check
        check (practice is null or practice in ('irrigated', 'dryland'));
  end if;
end $$;
