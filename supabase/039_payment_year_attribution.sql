-- 039: payment attribution — program year vs revenue crop year.
-- arc_plc_payments.crop_year is the PROGRAM year: it drives all the math
-- (MYA, benchmarks, base acres, elections, payment limits). The cash itself
-- arrives in October of the following year, and revenue views attribute it to
-- that crop year. revenue_crop_year makes the distinction explicit in the
-- model; lib/government-payments.ts revenueCropYearFor/programYearFor are the
-- one place the +1 lives in code.
alter table public.arc_plc_payments
  add column if not exists revenue_crop_year integer generated always as (crop_year + 1) stored;
create index if not exists arc_plc_payments_revenue_year_idx
  on public.arc_plc_payments(revenue_crop_year);

-- other_government_payments.crop_year now means the PAYMENT/attribution year
-- (the crop year the money is received in), not a program year. Existing rows
-- that look like program-year semantics (payment_date the year after
-- crop_year) are surfaced for review in the Payment Tracker.
comment on column public.other_government_payments.crop_year is
  'The crop year the payment is received in / attributed to (payment year, not program year).';
comment on column public.arc_plc_payments.crop_year is
  'PROGRAM year — drives the math. Paid in October of crop_year + 1 (see revenue_crop_year).';
