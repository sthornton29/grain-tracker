-- 066: crops.rma_type_override — the explicit RMA insurance-type pick for
-- states carrying BOTH Winter and Spring offers of a commodity (Idaho-style
-- wheat). Null = Auto: the crop's harvest_category decides (spring-harvested
-- fall-planted crops → the Winter/fall type; fall-harvested summer crops →
-- their standard type). Idempotent: safe to re-run.

do $$
begin
  execute 'alter table public.crops add column if not exists rma_type_override text';
  if not exists (select 1 from pg_constraint where conname = 'crops_rma_type_override_check') then
    alter table public.crops
      add constraint crops_rma_type_override_check
      check (rma_type_override is null or rma_type_override in ('winter', 'spring', 'durum'));
  end if;
end $$;
