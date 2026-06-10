-- Marketing dashboard: let the production expectation be broken out by practice
-- (irrigated / dryland) and, for double-cropped acres, by crop type
-- (full-season / double-crop). Each is an optional bu/ac yield; where one is
-- blank the dashboard falls back to the overall expected_yield. Acres come from
-- field_plantings (irrigated_acres / dryland_acres) and the double-crop
-- classification, so only the yields are stored here.
alter table public.crop_assumptions
  add column if not exists expected_yield_irr    numeric(10,2),
  add column if not exists expected_yield_dry    numeric(10,2),
  add column if not exists expected_yield_dc_irr numeric(10,2),
  add column if not exists expected_yield_dc_dry numeric(10,2);
