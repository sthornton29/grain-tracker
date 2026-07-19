-- 043: Variety match dismissals
--
-- Records a "different varieties — keep both" decision on a suspected-duplicate
-- pair of variety spellings within one crop, so the pair never re-flags — on
-- the Settings → Varieties cleanup page or as an import-time possible-match
-- prompt (AI and CSV planting imports).
--
-- key_a / key_b are the NORMALIZED matching keys (lib/variety-resolution.ts
-- varietyKey: uppercase, spaces/hyphens/periods stripped), stored sorted
-- (key_a <= key_b) so a pair has exactly one representation.
--
-- Idempotent: safe to re-run.

create table if not exists public.variety_match_dismissals (
  id uuid primary key default gen_random_uuid(),
  crop_id uuid not null references public.crops(id) on delete cascade,
  key_a text not null,
  key_b text not null,
  created_at timestamptz not null default now(),
  constraint variety_match_dismissals_sorted check (key_a <= key_b)
);

create unique index if not exists variety_match_dismissals_pair
  on public.variety_match_dismissals (crop_id, key_a, key_b);

alter table public.variety_match_dismissals enable row level security;

do $$
begin
  -- Permissive: any authenticated user (the single-tenant baseline).
  if not exists (select 1 from pg_policies where tablename = 'variety_match_dismissals' and policyname = 'variety_match_dismissals_all') then
    create policy variety_match_dismissals_all on public.variety_match_dismissals
      for all to authenticated using (true) with check (true);
  end if;
  -- Restrictive: gin-role users are blocked (042 role model — this table is
  -- grain/agronomy config, not cotton intake).
  if not exists (select 1 from pg_policies where tablename = 'variety_match_dismissals' and policyname = 'variety_match_dismissals_owner_only') then
    create policy variety_match_dismissals_owner_only on public.variety_match_dismissals
      as restrictive for all to authenticated
      using (public.app_role() <> 'gin') with check (public.app_role() <> 'gin');
  end if;
end $$;
