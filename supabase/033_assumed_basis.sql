-- 033_assumed_basis.sql
-- Per-crop-year assumed basis for the Marketing dashboard. Used to value bushels
-- whose basis isn't locked yet: when no physical contract has established basis
-- for a crop, the average basis falls back to this (labeled "assumed"), and it
-- values open-HTA, open-hedge, and completely-unpriced bushels so Total Average
-- Price and profitability always compute. Editable in the Assumptions panel.

alter table public.crop_assumptions
  add column if not exists assumed_basis numeric(12,6) not null default 0;
