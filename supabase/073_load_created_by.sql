-- 073: loads.created_by — who entered the load.
--
-- Powers the PER-USER last-load defaults on the New Load form: two people
-- entering different load types (e.g. one hauling corn to the bin, one
-- hauling beans to town) no longer stomp each other's pre-fills. The form
-- seeds from the latest load with created_by = me, falling back to the org's
-- latest only when I have none yet (lib/load-defaults.ts).
--
-- Additive + idempotent. Backfill is NULL by design — historical loads have
-- no reliable author, and a null simply never matches a user's tier.
-- APPLY BEFORE (or with) THE DEPLOY THAT SHIPS IT: the load insert paths
-- stamp created_by (they retry without it if the column is missing, so a
-- late apply degrades gracefully rather than failing — but the per-user
-- defaults only work once it exists).

alter table public.loads
  add column if not exists created_by uuid references auth.users(id) on delete set null;

-- The per-user defaults query: newest-entered first for one user.
create index if not exists loads_created_by_created_at_idx
  on public.loads (created_by, created_at desc);

comment on column public.loads.created_by is
  'Auth user who entered the load (per-user last-load defaults). Null on rows predating 073 and service-role imports without a session.';
