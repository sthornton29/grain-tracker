-- 0098: ARC/PLC parameters the 2026 election test found stale (2026-10-28).
-- Applied with `npx supabase db push --linked` (supabase/migrations/, like 0093 to 0097).
--
-- Sources: 91 FR 1044 (Jan 12 2026 final rule), FSA Notice ARCPLC-123, FSA's
-- Oct 9 2026 program-data tables (2026_ERP.pdf, 2026_PLC.pdf), FSA loan-rate
-- releases (Apr 8 2026; Sept 30 2025), the FSA Alabama 2025-payment release
-- (Oct 21 2026). Every statement is idempotent and keyed by commodity NAME
-- (covered_commodities.name is unique) or crop_year.
--
-- 1. Other oilseeds (canola, sesame, sunflowers): the OBBBA statutory
--    reference price is $23.75/cwt = $0.2375/lb (was $20.15/cwt) and the
--    loan rate $11.10/cwt = $0.1110/lb. Sunflowers were seeded with $0 / $0
--    and a BUSHEL unit although their PLC yields are lb/ac → pound.
-- 2. Seed cotton: OBBBA raised the effective-price floor ("loan rate" in
--    the PLC formula) from $0.25 to $0.30/lb — FSA's 2026 PLC table uses $0.30.
-- 3. Canola prices were stored in $/bu (NASS $/cwt × 50 lb/bu) against a $/lb
--    reference price, so the "MYA" read ~$13 and PLC was permanently $0.
--    lib/nass-quickstats.ts now stores $/lb for pound commodities; convert the
--    rows already saved ($/bu ÷ 50 = $/lb). Guarded: only values that can only
--    be $/bu (> $2 — canola has never traded above $1/lb) are converted, so a
--    re-run or an already-correct row is left alone.
-- 4. FSA-published 2026 effective reference prices for the commodities the
--    2025/2026 seed (037) skipped: grain sorghum $4.67, oats $3.05 (115% cap),
--    barley $5.58, seed cotton $0.42, peanuts $0.3150, other oilseeds $0.2375.
--    Corn $4.42 / soybeans $10.71 / wheat $6.35 already match.
-- 5. program_year_config: the per-person limit is CPI-indexed from 2025
--    ($160,000 for 2025, $164,000 for 2026 per the final rule's calculation);
--    sequestration applied to 2025-crop payments was 5.7% (the 2026-crop rate
--    is not announced — 5.7% is the latest applied rate, carried forward).

-- 1. Other oilseeds ------------------------------------------------------------
update public.covered_commodities
set statutory_reference_price = 0.2375,
    national_loan_rate        = 0.1110,
    unit                      = 'pound'
where name in ('Canola', 'Sesame', 'Sunflowers');

-- 2. Seed cotton effective-price floor ----------------------------------------
update public.covered_commodities
set national_loan_rate = 0.30
where name = 'Seed Cotton' and national_loan_rate < 0.30;

-- 3. Canola $/bu → $/lb -------------------------------------------------------
update public.mya_monthly_prices m
set price = round(m.price / 50, 6),
    note  = coalesce(m.note || ' · ', '') || 'converted $/bu → $/lb (0098)'
from public.covered_commodities c
where c.id = m.commodity_id and c.name = 'Canola' and m.price > 2;

update public.arc_plc_price_data p
set mya_price_estimate = case when p.mya_price_estimate > 2 then round(p.mya_price_estimate / 50, 6) else p.mya_price_estimate end,
    mya_price_final    = case when p.mya_price_final    > 2 then round(p.mya_price_final    / 50, 6) else p.mya_price_final    end,
    wasde_midpoint     = case when p.wasde_midpoint     > 2 then round(p.wasde_midpoint     / 50, 6) else p.wasde_midpoint     end
from public.covered_commodities c
where c.id = p.commodity_id and c.name = 'Canola'
  and (p.mya_price_estimate > 2 or p.mya_price_final > 2 or p.wasde_midpoint > 2);

-- 4. FSA-published 2026 effective reference prices ----------------------------
insert into public.arc_plc_price_data (commodity_id, crop_year, effective_reference_price, source)
select c.id, 2026, v.erp, 'barchart'
from (values
  ('Grain Sorghum', 4.67::numeric),
  ('Oats',          3.05::numeric),
  ('Barley',        5.58::numeric),
  ('Seed Cotton',   0.42::numeric),
  ('Peanuts',       0.3150::numeric),
  ('Canola',        0.2375::numeric),
  ('Sesame',        0.2375::numeric),
  ('Sunflowers',    0.2375::numeric)
) as v(name, erp)
join public.covered_commodities c on c.name = v.name
on conflict (commodity_id, crop_year) do update
  set effective_reference_price = excluded.effective_reference_price;

-- 5. Program-year parameters ----------------------------------------------------
update public.program_year_config
set per_person_payment_limit = 160000,
    sequestration_pct        = 0.0570,
    notes = coalesce(notes || ' ', '') || 'Limit CPI-indexed to $160,000; 5.7% sequestration applied to 2025-crop payments (0098).'
where crop_year = 2025 and (per_person_payment_limit <> 160000 or sequestration_pct <> 0.0570);

update public.program_year_config
set per_person_payment_limit = 164000,
    sequestration_pct        = 0.0570,
    notes = coalesce(notes || ' ', '') || 'Limit CPI-indexed to $164,000 (91 FR 1044); 2026-crop sequestration not yet announced — 5.7% carried from 2025 (0098).'
where crop_year = 2026 and (per_person_payment_limit <> 164000 or sequestration_pct <> 0.0570);
