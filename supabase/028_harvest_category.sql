-- Grain Tracker — per-crop harvest category (fall vs spring).
--
-- Double-crop is now determined by harvest timing: for a field + season that
-- has any SPRING-harvest crop (e.g. wheat, canola), each FALL-harvest crop
-- (e.g. corn, soybeans) on that field is a double-crop. The category is a
-- per-crop setting, editable on the Crops page. Corn/Soybeans default to fall;
-- Wheat/Canola are seeded to spring.
-- Idempotent.

alter table public.crops
  add column if not exists harvest_category text not null default 'fall'
  check (harvest_category in ('fall', 'spring'));

update public.crops set harvest_category = 'spring'
  where name in ('Wheat', 'Canola') and harvest_category <> 'spring';
