-- 046 — Cotton insurance price units: normalize ¢/lb → $/lb.
--
-- Insurance math runs in the policy's NATIVE $ per unit ($/bu grains, $/lb
-- cotton — RMA publishes cotton projected/harvest prices as dollars, e.g.
-- 0.68). The app's cotton FUTURES convention is ¢/lb, and before this fix a
-- cotton policy price could have been entered/extracted in ¢ (e.g. 68.00),
-- inflating guarantees ~100×. Any stored cotton insurance price > 5 is
-- unambiguously ¢/lb (real $/lb range ≈ 0.40–1.50) — divide by 100.
--
-- Applies to upland cotton crops (name contains 'cotton' but not 'seed').

-- Policy projected price
update crop_insurance_policies p
set projected_price = p.projected_price / 100
from crops c
where c.id = p.crop_id
  and c.name ilike '%cotton%' and c.name not ilike '%seed%'
  and p.projected_price > 5;

-- Policy harvest (final) price
update crop_insurance_policies p
set harvest_price = p.harvest_price / 100
from crops c
where c.id = p.crop_id
  and c.name ilike '%cotton%' and c.name not ilike '%seed%'
  and p.harvest_price is not null
  and p.harvest_price > 5;

-- RMA-native rows in harvest_price_estimates ('projected' and 'harvest_final'
-- are $/lb for cotton). 'harvest_estimate' rows are Barchart CT mirrors and
-- stay in ¢/lb by design — the app converts them at the insurance boundary
-- (centsToInsuranceDollars), so they are intentionally NOT touched here.
update harvest_price_estimates e
set price = e.price / 100
from crops c
where c.id = e.crop_id
  and c.name ilike '%cotton%' and c.name not ilike '%seed%'
  and e.price_type in ('projected', 'harvest_final')
  and e.price > 5;
