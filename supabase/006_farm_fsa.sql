-- Grain Tracker — FSA number per farm.
-- Idempotent.

alter table public.farms
  add column if not exists fsa_number text;
