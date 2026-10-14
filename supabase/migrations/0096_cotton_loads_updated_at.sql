-- 0096: updated_at on cotton_loads (2026-10-14).
-- Applied with `npx supabase db push --linked` (supabase/migrations/, like 0093 to 0095).
--
-- The Farm link's production and partner endpoints ask lib/cotton-yield-sources
-- fetchCottonYieldSources for the cotton tables WITH updated_at (the delta
-- pull's high-water mark). 050 gave gin_receipts and cotton_bales the column;
-- cotton_loads never got one, so that select failed, the callers' catch read
-- the failure as "Cotton module off", and every cotton planting went out as
-- unharvested with no yield even when its loads were ginned (Highway 20, 2026:
-- 106,959 lb lint on the Yields page, "unharvested" on the link). The 088
-- pattern: add the column once, backfill from created_at on the add only, the
-- set_updated_at trigger, an (org_id, updated_at) index.

do $$
begin
  if not exists (select 1 from information_schema.columns c
                 where c.table_schema = 'public' and c.table_name = 'cotton_loads' and c.column_name = 'updated_at') then
    alter table public.cotton_loads add column updated_at timestamptz not null default now();
    update public.cotton_loads set updated_at = created_at;
  end if;
end $$;

drop trigger if exists cotton_loads_set_updated_at on public.cotton_loads;
create trigger cotton_loads_set_updated_at before update on public.cotton_loads
  for each row execute function public.set_updated_at();
create index if not exists cotton_loads_org_updated_idx on public.cotton_loads (org_id, updated_at);
