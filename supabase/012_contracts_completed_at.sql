-- Grain Tracker — manual contract completion
-- Idempotent: safe to re-run.
--
-- Adds completed_at so a contract can be marked complete manually from the
-- detail page even when delivered bushels haven't met the contracted amount
-- (basis trades, contract closed early, partial fill accepted, etc.).
-- The tracker also auto-treats a contract as complete when delivered ≥
-- contracted; this column only captures manual overrides.

alter table public.contracts
  add column if not exists completed_at timestamptz;
