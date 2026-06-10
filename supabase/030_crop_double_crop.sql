-- Make "double-crop" an explicit per-crop setting instead of inferring it from
-- harvest category alone. A field+season is double-cropped when it has a
-- spring-harvest crop (the first crop); the *second* crop counts as double-crop
-- only when its crop is flagged here. Soybeans are the only double-crop we grow,
-- so seed that flag on; everything else stays full-season.
alter table public.crops
  add column if not exists double_crop boolean not null default false;

update public.crops set double_crop = true
  where name ilike 'soybean%' and double_crop = false;
