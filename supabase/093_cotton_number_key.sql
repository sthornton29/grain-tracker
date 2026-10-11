-- 093: ONE number key for cotton + statement identity (2026-10-11).
--
-- The module list prints a load as "031633"; the Statement of Ginning prints
-- the same load as "31633". The app compares every cotton number through
-- lib/number-key numberKey; this migration gives the database the same rule
-- so a 31633 / 031633 pair can never be saved again from any path:
--
--   * cotton_number_key(text)  — IMMUTABLE twin of numberKey: trim, upper,
--     drop internal whitespace, strip leading + trailing punctuation (a tick
--     mark read as "31632," or "31637_"), strip leading zeros ("000" → "0"),
--     empty → null. Internal dashes stay ("988-1").
--   * cotton_pbi_key(text)     — IMMUTABLE twin of pbiKey: digits only,
--     leading zeros stripped, no digits → null.
--   * unique index cotton_loads (org_id, crop_year, cotton_number_key(load_number)).
--     PRE-FLIGHT: supabase/093_preflight.sql lists any colliding pairs;
--     supabase/093_merge_collisions.sql merges them (keeper = the module
--     ticket load). Run those FIRST — this index refuses to build while a
--     collision exists, and says so.
--   * unique index cotton_bales (org_id, crop_year, cotton_pbi_key(pbi_number))
--     — built ONLY when no two bales of an org × year share a PBI key (the
--     preflight reports them); otherwise skipped with a notice, never an error.
--   * gins.gin_code — the USDA gin code ("40614": the 5-digit prefix of a
--     12-digit PBI tag), where PBI matching reads it.
--   * gin_receipts: gin_code / statement_number (null unless the gin prints a
--     distinct per-statement number — "Gin 40614" is the gin, not the
--     statement), printed_farm_number / printed_field (as printed; the
--     identity key with the date and totals), farm_ytd_* (the gin's Farm
--     Year-To-Date block). receipt_number stays the unique key per org ×
--     crop year; when the statement prints no number the app synthesizes
--     it deterministically ("40614-20261007-5824-PIVOT-6-183540-160").
--
-- Idempotent. Stored load numbers are never rewritten.

create or replace function public.cotton_number_key(raw text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when raw is null then null
    else nullif(
      case
        when s ~ '^0+$' then '0'
        else regexp_replace(s, '^0+', '')
      end, '')
  end
  from (
    select regexp_replace(
             regexp_replace(
               regexp_replace(upper(btrim(raw)), '\s+', '', 'g'),
               '^[^A-Z0-9]+', ''),
             '[^A-Z0-9]+$', '') as s
  ) x
$$;

comment on function public.cotton_number_key(text) is
  '093: the cotton number key — mirrors lib/number-key numberKey (trim, upper, no internal spaces, leading/trailing punctuation stripped, leading zeros stripped, "000" = "0", empty = null). cotton_loads is unique on (org_id, crop_year, cotton_number_key(load_number)).';

create or replace function public.cotton_pbi_key(raw text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(regexp_replace(regexp_replace(coalesce(raw, ''), '\D', '', 'g'), '^0+(?=\d)', ''), '')
$$;

comment on function public.cotton_pbi_key(text) is
  '093: the PBI key — mirrors lib/number-key pbiKey (digits only, leading zeros stripped, no digits = null).';

-- The guarantee. Fails loudly, by design, while a collision is still there.
do $$
declare
  n int;
begin
  select count(*) into n
  from (
    select org_id, crop_year, public.cotton_number_key(load_number) as k
    from public.cotton_loads
    where public.cotton_number_key(load_number) is not null
    group by org_id, crop_year, public.cotton_number_key(load_number)
    having count(*) > 1
  ) c;
  if n > 0 then
    raise exception '093: % cotton_loads number-key collision group(s) remain (e.g. 031633 and 31633 in one org × crop year). Run supabase/093_preflight.sql to list them and supabase/093_merge_collisions.sql to merge them, then re-run 093.', n;
  end if;
end $$;

create unique index if not exists cotton_loads_org_year_key_unique
  on public.cotton_loads (org_id, crop_year, public.cotton_number_key(load_number));

-- Bales: the same guarantee, only when it already holds.
do $$
declare
  n int;
begin
  select count(*) into n
  from (
    select org_id, crop_year, public.cotton_pbi_key(pbi_number) as k
    from public.cotton_bales
    where public.cotton_pbi_key(pbi_number) is not null
    group by org_id, crop_year, public.cotton_pbi_key(pbi_number)
    having count(*) > 1
  ) c;
  if n = 0 then
    execute 'create unique index if not exists cotton_bales_org_year_pbi_key_unique on public.cotton_bales (org_id, crop_year, public.cotton_pbi_key(pbi_number))';
  else
    raise notice '093: % cotton_bales PBI-key collision group(s) exist — cotton_bales_org_year_pbi_key_unique NOT created. supabase/093_preflight.sql lists them.', n;
  end if;
end $$;

-- Gin code + statement identity columns. Existing tenant tables — the
-- columns ride the 042/052/054/061 policy stack.
alter table public.gins
  add column if not exists gin_code text;

alter table public.gin_receipts
  add column if not exists gin_code text,
  add column if not exists statement_number text,
  add column if not exists printed_farm_number text,
  add column if not exists printed_field text,
  add column if not exists farm_ytd_modules integer,
  add column if not exists farm_ytd_seed_cotton_lbs numeric(14,2),
  add column if not exists farm_ytd_bales integer,
  add column if not exists farm_ytd_bale_weight numeric(14,2);

comment on column public.gins.gin_code is '093: USDA gin code ("40614") — the 5-digit prefix of a 12-digit PBI tag; PBI matching reads it.';
comment on column public.gin_receipts.gin_code is '093: the gin code printed on this statement — identifies the GIN, never the statement.';
comment on column public.gin_receipts.statement_number is '093: a distinct per-statement number ONLY when the gin printed one; null for Servico-style statements. receipt_number is then synthesized (lib/gin-statements).';
comment on column public.gin_receipts.printed_farm_number is '093: the farm # exactly as the statement printed it (identity key part).';
comment on column public.gin_receipts.printed_field is '093: the field exactly as the statement printed it (identity key part).';

create index if not exists gin_receipts_org_gin_farm_idx on public.gin_receipts (org_id, gin_code, printed_farm_number);
