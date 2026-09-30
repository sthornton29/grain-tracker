-- 090: Rolls per seed cotton load — the number of round modules (rolls) on
-- each load that goes to the gin, as the module ticket / gin scale ticket
-- prints it. Captured by hand, by the module-list upload, and from a
-- Statement of Ginning's load table when that creates a missing load. Null =
-- not recorded. An existing tenant table — the column rides cotton_loads'
-- 042/052/054/061 policies. Idempotent.

alter table public.cotton_loads
  add column if not exists rolls integer check (rolls >= 0);
