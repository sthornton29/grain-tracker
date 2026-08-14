-- 063: farms.cash_rent_per_acre — the minimal home for cash-rent lease terms
-- surfaced by the unified settings document upload (leases often state one).
-- Deliberately NOT a lease module: like is_share_rent/landlord_share_percentage
-- (015), the term lives on the farm ↔ landowner linkage. Nullable — most farms
-- never record it. Idempotent: safe to re-run.

do $$
begin
  execute 'alter table public.farms add column if not exists cash_rent_per_acre numeric';
  if not exists (select 1 from pg_constraint where conname = 'farms_cash_rent_nonnegative') then
    alter table public.farms
      add constraint farms_cash_rent_nonnegative check (cash_rent_per_acre is null or cash_rent_per_acre >= 0);
  end if;
end $$;
