-- 093_merge_collisions.sql — merge cotton_loads whose numbers collide under
-- the cotton number key ("031633" and "31633" in one org × crop year), in ONE
-- transaction, after the owner has reviewed 093_preflight.sql report A.
--
-- Merge rule (per colliding group):
--   keeper  = the module-ticket load: source 'document_import' WITH a
--             source_pdf_url; else any document_import row; else the oldest.
--   * gin_receipt_loads links on every duplicate move to the keeper (a link
--     the keeper already has is dropped, never doubled).
--   * blanks on the keeper are filled from the duplicates — rolls, picked /
--     delivered dates, truck, gross / tare / net, farm / field / entity / gin,
--     location, notes — WITHOUT overwriting anything the keeper already has.
--     Differing notes are appended, never lost.
--   * the duplicates are deleted. The keeper keeps the number its ticket
--     printed; nothing is rewritten.
--
-- Prints one NOTICE per merged pair. Safe to re-run (no collisions → merges
-- 0). Run migrations/0093_cotton_number_key.sql after (npx supabase db push). Only scalar PL/pgSQL variables
-- are referenced inside SQL (2026-10-12 fix: a %rowtype variable's fields
-- were parsed as a relation — 'relation "keeper" does not exist').

begin;

do $$
declare
  grp record;
  v_keeper_id uuid;
  v_keeper_number text;
  v_dup record;
  v_moved int;
  v_merged int := 0;
begin
  for grp in
    with keyed as (
      select l.id, l.org_id, l.crop_year,
             nullif(case when s ~ '^0+$' then '0' else regexp_replace(s, '^0+', '') end, '') as k
      from (
        select l.*,
               regexp_replace(regexp_replace(regexp_replace(upper(btrim(l.load_number)), '\s+', '', 'g'), '^[^A-Z0-9]+', ''), '[^A-Z0-9]+$', '') as s
        from public.cotton_loads l
      ) l
    )
    select org_id, crop_year, k, array_agg(id) as ids
    from keyed where k is not null
    group by org_id, crop_year, k
    having count(*) > 1
  loop
    select l.id, l.load_number into v_keeper_id, v_keeper_number
    from public.cotton_loads l
    where l.id = any (grp.ids)
    order by (l.source = 'document_import' and l.source_pdf_url is not null) desc,
             (l.source = 'document_import') desc,
             l.created_at asc
    limit 1;

    for v_dup in
      select l.id, l.load_number, l.source
      from public.cotton_loads l
      where l.id = any (grp.ids) and l.id <> v_keeper_id
      order by l.created_at
    loop
      -- 1. move receipt links (skip ones the keeper already has)
      update public.gin_receipt_loads grl
         set cotton_load_id = v_keeper_id
       where grl.cotton_load_id = v_dup.id
         and not exists (select 1 from public.gin_receipt_loads k2
                          where k2.receipt_id = grl.receipt_id and k2.cotton_load_id = v_keeper_id);
      get diagnostics v_moved = row_count;
      delete from public.gin_receipt_loads where cotton_load_id = v_dup.id;

      -- 2. fill the keeper's blanks from the duplicate; never overwrite
      update public.cotton_loads k
         set rolls          = coalesce(k.rolls, d.rolls),
             picked_date    = coalesce(k.picked_date, d.picked_date),
             delivered_date = coalesce(k.delivered_date, d.delivered_date),
             truck          = coalesce(k.truck, d.truck),
             gross_weight   = coalesce(k.gross_weight, d.gross_weight),
             tare_weight    = coalesce(k.tare_weight, d.tare_weight),
             net_weight     = coalesce(k.net_weight, d.net_weight),
             farm_id        = coalesce(k.farm_id, d.farm_id),
             field_id       = coalesce(k.field_id, d.field_id),
             entity_id      = coalesce(k.entity_id, d.entity_id),
             gin_id         = coalesce(k.gin_id, d.gin_id),
             location       = coalesce(k.location, d.location),
             source_pdf_url = coalesce(k.source_pdf_url, d.source_pdf_url),
             notes          = case
                                when d.notes is null or btrim(d.notes) = '' then k.notes
                                when k.notes is null or btrim(k.notes) = '' then d.notes
                                when position(d.notes in k.notes) > 0 then k.notes
                                else k.notes || E'\n' || d.notes
                              end
        from public.cotton_loads d
       where k.id = v_keeper_id and d.id = v_dup.id;

      -- 3. delete the duplicate
      delete from public.cotton_loads where id = v_dup.id;
      v_merged := v_merged + 1;
      raise notice '093 merge: % (%) kept; % (%, source %) folded in — % receipt link(s) moved',
        v_keeper_number, v_keeper_id, v_dup.load_number, v_dup.id, v_dup.source, v_moved;
    end loop;
  end loop;
  raise notice '093 merge: % duplicate load(s) merged.', v_merged;
end $$;

commit;
