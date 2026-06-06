-- Grain Tracker — manual override for the yield harvest classification.
-- The yield views auto-exclude fields that look unharvested (no bushels) or
-- in-progress (the field the latest load came from, yielding >15% below the
-- harvested average). This column lets the user override that per planting:
--   null  → automatic (default)
--   true  → always count this field in the yield numbers, despite the flag
-- Idempotent.

alter table public.field_plantings
  add column if not exists yield_include_override boolean;
