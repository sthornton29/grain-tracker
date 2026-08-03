-- 050: Read-only partner API support
--
-- Two pieces:
--   1) updated_at + the shared set_updated_at trigger on every table the
--      partner API (/api/partner/v1/*) serves, so the intercompany engine can
--      delta-sync on updated_at. Backfill semantics: the column lands with
--      default now() (= migration time), so a consumer's first sync sees every
--      row as "new" once and deltas correctly from then on. loads already has
--      updated_at (001).
--   2) crop_year_sales_status — the manual "physical sales complete" flag per
--      crop × crop year. Shrink and small residuals keep the computed
--      production-vs-settled check from ever hitting exactly zero, so the
--      /crop-year-status endpoint returns BOTH the computed check and this
--      manual flag. Toggled under Settings → Crops.
--
-- Idempotent: safe to re-run.

-- 1) updated_at for delta-sync ---------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'farms', 'fields', 'entities', 'field_plantings',
    'settlements', 'settlement_lines',
    'futures_positions', 'options_positions',
    'gin_receipts', 'cotton_bales'
  ] loop
    execute format(
      'alter table public.%I add column if not exists updated_at timestamptz not null default now()', t
    );
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t, t
    );
  end loop;
end $$;

-- 2) Manual "physical sales complete" flag ---------------------------------

create table if not exists public.crop_year_sales_status (
  id uuid primary key default gen_random_uuid(),
  crop_id uuid not null references public.crops(id) on delete cascade,
  crop_year integer not null,
  physical_sales_complete boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (crop_id, crop_year)
);

drop trigger if exists crop_year_sales_status_set_updated_at on public.crop_year_sales_status;
create trigger crop_year_sales_status_set_updated_at
  before update on public.crop_year_sales_status
  for each row execute function public.set_updated_at();

alter table public.crop_year_sales_status enable row level security;

do $$
begin
  -- Permissive: any authenticated user (the single-tenant baseline).
  if not exists (select 1 from pg_policies where tablename = 'crop_year_sales_status' and policyname = 'crop_year_sales_status_all') then
    create policy crop_year_sales_status_all on public.crop_year_sales_status
      for all to authenticated using (true) with check (true);
  end if;
  -- Restrictive: gin-role users are blocked (042 role model — marketing
  -- status, not cotton intake).
  if not exists (select 1 from pg_policies where tablename = 'crop_year_sales_status' and policyname = 'crop_year_sales_status_owner_only') then
    create policy crop_year_sales_status_owner_only on public.crop_year_sales_status
      as restrictive for all to authenticated
      using (public.app_role() <> 'gin') with check (public.app_role() <> 'gin');
  end if;
end $$;
