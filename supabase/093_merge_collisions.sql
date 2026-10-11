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
-- Prints one NOTICE per merged pair. Run 093_cotton_number_key.sql after.

begin;

do $$
declare
  grp record;
  keeper public.cotton_loads%rowtype;
  dup record;
  moved int;
  merged int := 0;
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
    select l.* into keeper
    from public.cotton_loads l
    where l.id = any (grp.ids)
    order by (l.source = 'document_import' and l.source_pdf_url is not null) desc,
             (l.source = 'document_import') desc,
             l.created_at asc
    limit 1;

    for dup in
      select l.* from public.cotton_loads l where l.id = any (grp.ids) and l.id <> keeper.id order by l.created_at
    loop
      -- 1. move receipt links (skip ones the keeper already has)
      update public.gin_receipt_loads grl
         set cotton_load_id = keeper.id
       where grl.cotton_load_id = dup.id
         and not exists (select 1 from public.gin_receipt_loads k2 where k2.receipt_id = grl.receipt_id and k2.cotton_load_id = keeper.id);
      get diagnostics moved = row_count;
      delete from public.gin_receipt_loads where cotton_load_id = dup.id;

      -- 2. fill the keeper's blanks from the duplicate; never overwrite
      update public.cotton_loads k
         set rolls          = coalesce(k.rolls, dup.rolls),
             picked_date    = coalesce(k.picked_date, dup.picked_date),
             delivered_date = coalesce(k.delivered_date, dup.delivered_date),
             truck          = coalesce(k.truck, dup.truck),
             gross_weight   = coalesce(k.gross_weight, dup.gross_weight),
             tare_weight    = coalesce(k.tare_weight, dup.tare_weight),
             net_weight     = coalesce(k.net_weight, dup.net_weight),
             farm_id        = coalesce(k.farm_id, dup.farm_id),
             field_id       = coalesce(k.field_id, dup.field_id),
             entity_id      = coalesce(k.entity_id, dup.entity_id),
             gin_id         = coalesce(k.gin_id, dup.gin_id),
             location       = coalesce(k.location, dup.location),
             source_pdf_url = coalesce(k.source_pdf_url, dup.source_pdf_url),
             notes          = case
                                when dup.notes is null or btrim(dup.notes) = '' then k.notes
                                when k.notes is null or btrim(k.notes) = '' then dup.notes
                                when position(dup.notes in k.notes) > 0 then k.notes
                                else k.notes || E'\n' || dup.notes
                              end
       where k.id = keeper.id;

      -- 3. delete the duplicate
      delete from public.cotton_loads where id = dup.id;
      merged := merged + 1;
      raise notice '093 merge: % (%) kept; % (%, source %) folded in — % receipt link(s) moved',
        keeper.load_number, keeper.id, dup.load_number, dup.id, dup.source, moved;
    end loop;
  end loop;
  raise notice '093 merge: % duplicate load(s) merged.', merged;
end $$;

commit;
