-- 065: RMA offer base contracts + legacy seed relabel. Idempotent.
--
-- (1) rma_price_cache gains the offer's BASE CONTRACT identity straight from
-- the RMA data (exchange + Barchart-compatible market symbol per window,
-- e.g. Alabama corn = ZCU26 — September, NOT the Midwest DEC assumption).
-- The Barchart estimate tier quotes THIS contract instead of the hard-coded
-- new-crop month.
--
-- (2) The 024-era seeded projected prices (national values: corn 4.62,
-- soybeans 11.09, wheat 6.19, source 'RMA projected') predate real RMA
-- sourcing and are wrong for Southern states — dated 02-28 they outranked the
-- genuinely-fetched RMA value under latest-date resolution. Relabel them
-- source='seed' so the source-aware resolution (RMA released > manual > seed)
-- can never let them mask RMA again. User-typed rows (source 'manual') are
-- untouched.

do $$
begin
  execute 'alter table public.rma_price_cache add column if not exists projected_exchange_code text';
  execute 'alter table public.rma_price_cache add column if not exists projected_market_symbol text';
  execute 'alter table public.rma_price_cache add column if not exists harvest_exchange_code text';
  execute 'alter table public.rma_price_cache add column if not exists harvest_market_symbol text';
end $$;

-- The only rows ever written with source 'RMA projected' are the 024 seeds.
update public.harvest_price_estimates
  set source = 'seed'
  where price_type = 'projected' and source = 'RMA projected';
