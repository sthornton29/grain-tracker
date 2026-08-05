-- DIAGNOSTIC — NOT A MIGRATION. Safe to run repeatedly; changes nothing
-- (the session simulation is wrapped in a rolled-back transaction).
--
-- Verifies the 052 viewer-role enforcement actually holds in THIS database:
--   1) the viewer RLS policies exist (row-scope + write-block counts);
--   2) a simulated viewer session sees ONLY its granted entities' rows.
-- Run the whole file at once in the Supabase SQL editor and read the outputs.

-- 1) Policy census. Expect viewer_row_scope ≈ 30 and viewer_write_block in
--    the hundreds (3 per public table). ZEROS here mean 052's policy
--    sections never applied — re-run the full 052 file.
select
  count(*) filter (where policyname like '%viewer_scope%')  as viewer_row_scope,
  count(*) filter (where policyname like '%viewer_block%')  as viewer_write_block
from pg_policies
where schemaname = 'public';

-- 2) Simulate the viewer's session (swap the email to test another user).
--    Everything inside BEGIN…ROLLBACK is discarded.
begin;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', u.id, 'role', 'authenticated')::text,
  true
) from auth.users u where lower(u.email) = 'jlthornton@gmail.com';
set local role authenticated;

-- Expect: role_seen = 'viewer', grants = 1 (the granted entity id).
select public.app_role() as role_seen,
       (select count(*) from public.viewer_entity_ids()) as grants;

-- Expect: ONLY the granted entity's counts — compare with the totals in (3).
select
  (select count(*) from public.farms)                    as farms_visible,
  (select count(*) from public.fields)                   as fields_visible,
  (select count(*) from public.loads)                    as loads_visible,
  (select count(*) from public.crop_insurance_policies)  as policies_visible,
  (select count(*) from public.contracts)                as contracts_visible; -- null-entity/agent rows DO show here (flow-down needs them; the app scales them)

rollback;

-- 3) The whole-operation totals, for comparison (as admin — no RLS).
select
  (select count(*) from public.farms)                    as farms_total,
  (select count(*) from public.fields)                   as fields_total,
  (select count(*) from public.loads)                    as loads_total,
  (select count(*) from public.crop_insurance_policies)  as policies_total,
  (select count(*) from public.contracts)                as contracts_total;
