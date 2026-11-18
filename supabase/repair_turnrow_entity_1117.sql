-- Repair 2026-11-17: one Turnrow marketing entity again (Turnrow Farm org).
--
-- What happened: the first Turnrow Farm land sync (2026-11-14 15:46 UTC) did
-- not recognise Grain's "Turnrow" as Farm's "Turnrow Farm Services LLC" (no
-- name match) and CREATED a second marketing-agent entity. 18 minutes later
-- the id map was pointed back at the original "Turnrow" and the new row was
-- archived — but it stayed in every report's entity dropdown, and every
-- nightly sync since then has been rolled back: Farm renames the linked
-- entity to "Turnrow Farm Services LLC", which the archived duplicate still
-- holds (entities_org_name_unique), so the whole batch fails with a 409.
--
-- Stuart's decisions (2026-11-17): keep ONE entity, named as Turnrow Farm
-- names it; the 13 hedges and 1 cotton sales contract that carry no entity
-- belong to Turnrow (report totals do not move: attribution treats agent-held
-- and null-entity rows the same).
--
-- Every statement is guarded so a re-run is a no-op.

begin;

-- 1. The duplicate must be empty — refuse otherwise.
do $$
declare
  dup constant uuid := 'b8a1e9cc-67d3-427b-bf63-aec696b64217';
  n bigint;
begin
  select
      (select count(*) from contracts where entity_id = dup)
    + (select count(*) from futures_positions where entity_id = dup)
    + (select count(*) from options_positions where entity_id = dup)
    + (select count(*) from cotton_sales_contracts where entity_id = dup)
    + (select count(*) from cotton_loads where entity_id = dup)
    + (select count(*) from gin_receipts where entity_id = dup)
    + (select count(*) from cotton_fees where entity_id = dup)
    + (select count(*) from cotton_ldp_records where entity_id = dup)
    + (select count(*) from ccc_loans where entity_id = dup)
    + (select count(*) from crop_insurance_policies where entity_id = dup)
    + (select count(*) from farms where entity_id = dup)
    + (select count(*) from bin_sites where entity_id = dup)
    + (select count(*) from entity_counties where entity_id = dup)
    + (select count(*) from user_entity_access where entity_id = dup)
    + (select count(*) from payment_limit_config where entity_id = dup)
    + (select count(*) from farm_program_payees where entity_id = dup)
    + (select count(*) from kept_for_seed where entity_id = dup)
    + (select count(*) from budget_scenarios where entity_id = dup)
    + (select count(*) from other_government_payments where entity_id = dup)
    + (select count(*) from fsa_payment_statements where payee_entity_id = dup)
    + (select count(*) from insurance_trigger_yields where entity_id = dup)
    + (select count(*) from farm_link_ids where grain_table = 'entities' and grain_id = dup)
  into n;
  if n > 0 then
    raise exception 'The duplicate Turnrow entity is not empty (% rows point at it) — stopping.', n;
  end if;
end $$;

delete from entities
where id = 'b8a1e9cc-67d3-427b-bf63-aec696b64217'
  and archived_at is not null
  and managed_by = 'turnrow_farm';

-- 2. The original takes Farm's name and is marked as managed by the link
--    (what the nightly sync has been trying to do since 11/15).
update entities
set name = 'Turnrow Farm Services LLC', managed_by = 'turnrow_farm'
where id = '1fa11cc2-bd57-45a0-8e79-60c007aa618f'
  and (name is distinct from 'Turnrow Farm Services LLC' or managed_by is distinct from 'turnrow_farm');

-- 3. The untagged marketing goes on Turnrow. (futures_positions writes one
--    'edited' row per position to the hedge ledger — the record of this tag.)
update futures_positions
set entity_id = '1fa11cc2-bd57-45a0-8e79-60c007aa618f'
where org_id = '9a8b40a6-ae54-488c-bcd8-5f13b91be804' and entity_id is null;

update cotton_sales_contracts
set entity_id = '1fa11cc2-bd57-45a0-8e79-60c007aa618f'
where org_id = '9a8b40a6-ae54-488c-bcd8-5f13b91be804' and entity_id is null;

-- 4. Verdict.
select json_build_object(
  'entities', (select json_agg(json_build_object('name', name, 'role', entity_role, 'managed_by', managed_by, 'archived', archived_at is not null) order by name)
               from entities where org_id = '9a8b40a6-ae54-488c-bcd8-5f13b91be804'),
  'futures_untagged', (select count(*) from futures_positions where org_id = '9a8b40a6-ae54-488c-bcd8-5f13b91be804' and entity_id is null),
  'futures_turnrow', (select count(*) from futures_positions where entity_id = '1fa11cc2-bd57-45a0-8e79-60c007aa618f'),
  'cotton_sales_untagged', (select count(*) from cotton_sales_contracts where org_id = '9a8b40a6-ae54-488c-bcd8-5f13b91be804' and entity_id is null),
  'link', (select json_agg(grain_id) from farm_link_ids where grain_table = 'entities' and farm_uid = 'd3f50830-4c5e-4063-adbb-3043a9ba9900')
) as verdict;

commit;
