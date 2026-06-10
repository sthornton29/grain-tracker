-- Marketing dashboard: let cost/acre break out by the same segments as the yield
-- (irrigated/dryland, and full-season/double-crop for double-cropped acres). Each
-- is optional; the overall cost_per_acre holds the acre-weighted average.
alter table public.crop_assumptions
  add column if not exists cost_per_acre_irr    numeric(12,2),
  add column if not exists cost_per_acre_dry    numeric(12,2),
  add column if not exists cost_per_acre_dc_irr numeric(12,2),
  add column if not exists cost_per_acre_dc_dry numeric(12,2);
