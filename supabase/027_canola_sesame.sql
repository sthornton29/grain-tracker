-- Grain Tracker — add Canola and Sesame to the covered commodities so base
-- acres can be tracked for them. Both are "other oilseeds": priced per pound
-- with the established $20.15/cwt ($0.2015/lb) statutory reference price and
-- ~$10.09/cwt loan rate. Adjust the effective reference / MYA in Price Data if
-- your OBBBA figures differ. Canola links to the tracked crop; sesame stays
-- unlinked (not a tracked crop).
-- Idempotent.

insert into public.covered_commodities
  (name, crop_id, statutory_reference_price, unit, national_loan_rate, marketing_year_start_month, marketing_year_end_month)
select v.name,
  (select c.id from public.crops c where lower(c.name) = lower(v.crop_match) limit 1),
  v.ref, v.unit, v.loan, v.mstart, v.mend
from (values
  ('Canola', 'Canola', 0.2015::numeric, 'pound', 0.1009::numeric, 7, 6),
  ('Sesame', '',       0.2015::numeric, 'pound', 0.1009::numeric, 9, 8)
) as v(name, crop_match, ref, unit, loan, mstart, mend)
on conflict (name) do update set
  statutory_reference_price  = excluded.statutory_reference_price,
  unit                       = excluded.unit,
  national_loan_rate         = excluded.national_loan_rate,
  marketing_year_start_month = excluded.marketing_year_start_month,
  marketing_year_end_month   = excluded.marketing_year_end_month,
  crop_id                    = coalesce(public.covered_commodities.crop_id, excluded.crop_id);
