-- 093_preflight.sql — READ-ONLY report to run BEFORE 093_cotton_number_key.sql.
-- Changes nothing. Four result sets (run each statement, or the whole file
-- in the SQL editor and page through the results):
--
--   A. cotton_loads whose numbers are equal once leading zeros / tick marks
--      are ignored, within one org × crop year ("031633" and "31633") —
--      every row of every colliding group, with what 093_merge_collisions.sql
--      would KEEP (the module ticket: source document_import with its
--      source_pdf_url, else the oldest) and what it would fold in.
--   B. gin_receipts that look like they came from a Servico statement
--      (receipt number is the gin code 40614 / 040614, or the 093 gin_code
--      says so once applied) — the ones saved from this PDF before the fix.
--   C. gin_receipt_loads pointing at a load the receipt review created inline
--      (document_import, NO source_pdf_url — a module-ticket load always has
--      one) that duplicates a module-list load under the key.
--   D. cotton_bales PBI collisions under the PBI key (digits, leading zeros
--      ignored) within one org × crop year — must be empty for 093 to build
--      the bale unique index.
--
-- The key expressions are written inline (not via cotton_number_key) so this
-- runs before 093 exists.

-- A. load-number collisions -------------------------------------------------
with keyed as (
  select l.*,
         nullif(
           case when s ~ '^0+$' then '0' else regexp_replace(s, '^0+', '') end, '') as k
  from (
    select l.*,
           regexp_replace(regexp_replace(regexp_replace(upper(btrim(l.load_number)), '\s+', '', 'g'), '^[^A-Z0-9]+', ''), '[^A-Z0-9]+$', '') as s
    from public.cotton_loads l
  ) l
),
groups as (
  select org_id, crop_year, k, count(*) as n
  from keyed where k is not null
  group by org_id, crop_year, k
  having count(*) > 1
),
ranked as (
  select k.*,
         (select count(*) from public.gin_receipt_loads grl where grl.cotton_load_id = k.id) as receipt_links,
         row_number() over (
           partition by k.org_id, k.crop_year, k.k
           order by (k.source = 'document_import' and k.source_pdf_url is not null) desc,
                    (k.source = 'document_import') desc,
                    k.created_at asc
         ) as keep_rank
  from keyed k join groups g on g.org_id = k.org_id and g.crop_year = k.crop_year and g.k = k.k
)
select 'A: load collisions' as report, org_id, crop_year, k as number_key,
       case when keep_rank = 1 then 'KEEP' else 'merge into keeper' end as action,
       id, load_number, source, (source_pdf_url is not null) as has_ticket_pdf,
       net_weight, gross_weight, tare_weight, rolls, picked_date, delivered_date, farm_id, field_id, gin_id,
       receipt_links, created_at
from ranked
order by org_id, crop_year, k, keep_rank;

-- B. receipts saved from a Servico statement (receipt # = the gin code) -----
select 'B: receipts keyed by the gin code' as report,
       r.id, r.org_id, r.crop_year, r.receipt_number, r.receipt_date, r.source, r.created_at,
       r.modules_count, r.total_seed_cotton_weight, r.bales_count, r.total_bale_weight,
       g.name as gin_name,
       (select count(*) from public.gin_receipt_loads grl where grl.receipt_id = r.id) as linked_loads,
       (select count(*) from public.cotton_bales b where b.gin_receipt_id = r.id) as bales
from public.gin_receipts r
left join public.gins g on g.id = r.gin_id
where regexp_replace(r.receipt_number, '^0+', '') ~ '^\d{5}$'
   or regexp_replace(r.receipt_number, '^0+', '') = '40614'
order by r.created_at;

-- C. receipt links to an inline-created load that duplicates a module-list load
with keyed as (
  select l.*,
         nullif(case when s ~ '^0+$' then '0' else regexp_replace(s, '^0+', '') end, '') as k
  from (
    select l.*,
           regexp_replace(regexp_replace(regexp_replace(upper(btrim(l.load_number)), '\s+', '', 'g'), '^[^A-Z0-9]+', ''), '[^A-Z0-9]+$', '') as s
    from public.cotton_loads l
  ) l
)
select 'C: inline-created duplicate on a receipt' as report,
       grl.receipt_id, r.receipt_number, r.receipt_date,
       dup.id as inline_load_id, dup.load_number as inline_load_number, dup.net_weight as inline_net,
       keeper.id as module_list_load_id, keeper.load_number as module_list_number, keeper.net_weight as module_list_net,
       keeper.source_pdf_url is not null as module_list_has_ticket
from public.gin_receipt_loads grl
join keyed dup on dup.id = grl.cotton_load_id
join public.gin_receipts r on r.id = grl.receipt_id
join keyed keeper on keeper.org_id = dup.org_id and keeper.crop_year = dup.crop_year and keeper.k = dup.k and keeper.id <> dup.id
where dup.source = 'document_import' and dup.source_pdf_url is null
  and keeper.source_pdf_url is not null
order by r.receipt_date, dup.load_number;

-- D. bale PBI collisions ----------------------------------------------------
with keyed as (
  select b.*, nullif(regexp_replace(regexp_replace(b.pbi_number, '\D', '', 'g'), '^0+(?=\d)', ''), '') as k
  from public.cotton_bales b
)
select 'D: bale PBI collisions' as report, org_id, crop_year, k as pbi_key,
       count(*) as n, array_agg(pbi_number order by created_at) as pbi_numbers, array_agg(gin_receipt_id::text order by created_at) as receipts
from keyed
where k is not null
group by org_id, crop_year, k
having count(*) > 1
order by org_id, crop_year, k;
