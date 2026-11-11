-- 0105: grain kept back for seed, and a contract closed short (2026-11-10).
-- Applied with `npx supabase db push --linked`.
--
-- Kept for seed (turnrow-farm docs/GRAIN_KEPT_FOR_SEED.md): Turnrow Farm's
-- saved seed lot takes bushels of this crop year's grain at the year's
-- average price as next year's seed. Grain counts those bushels as sold at
-- that price: the marketing engine reads each row as a fully priced
-- flat-cash sale (lib/kept-for-seed.ts through the spot seam), so the
-- growing year's revenue and the planting year's seed cost are the same
-- figure. Written by the farm link only (service role, POST/DELETE
-- /api/farm-link/v1/kept-for-seed); everyone in the org may read it.
--
-- Closed short: contracts.original_contracted_bushels keeps what was signed
-- when a contract is closed at what was delivered (Woodall 90894: 3,000 bu
-- signed, 1,154 delivered, the rest kept for seed). contracted_bushels then
-- carries the delivered bushels, so every engine values only those.

create table if not exists public.kept_for_seed (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade
    default coalesce(public.current_org_id(), public.default_org_id()),
  crop_id uuid not null references public.crops(id) on delete cascade,
  crop_year int not null,
  entity_id uuid references public.entities(id) on delete set null,
  bushels numeric not null check (bushels > 0),
  price_per_bu numeric not null check (price_per_bu >= 0),
  kept_on date not null,
  reference text not null check (char_length(reference) between 1 and 200),
  label text,
  source text not null default 'turnrow_farm',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists kept_for_seed_org_reference on public.kept_for_seed (org_id, reference);
create index if not exists kept_for_seed_org_year_idx on public.kept_for_seed (org_id, crop_year, crop_id);
comment on table public.kept_for_seed is
  '0105: bushels of a crop year kept back as next year''s seed (Turnrow Farm saved seed lots), counted as sold at price_per_bu by the marketing engine. reference is the Farm lot (turnrow-farm:saved_seed_lot:<id>); one row per reference. Written by the farm link only.';

alter table public.kept_for_seed enable row level security;
revoke all on public.kept_for_seed from anon, authenticated;
grant select on public.kept_for_seed to authenticated;

do $$
declare t text := 'kept_for_seed';
begin
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_select') then
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select', t);
  end if;
  if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_org_isolation') then
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (org_id = public.current_org_id()) with check (org_id = public.current_org_id())', t || '_org_isolation', t);
  end if;
end $$;

alter table public.contracts add column if not exists original_contracted_bushels numeric;
comment on column public.contracts.original_contracted_bushels is
  '0105: the bushels signed for, kept when the contract is closed short; contracted_bushels then holds the bushels delivered. Null when never closed short.';

notify pgrst, 'reload schema';
