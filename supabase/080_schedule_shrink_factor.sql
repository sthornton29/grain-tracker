-- 080: Buyer discount schedules — the moisture shrink factor.
-- Idempotent: safe to re-run.
--
-- An elevator's real treatment of wet grain is TWO steps: it shrinks the
-- bushels to its base moisture at ITS shrink factor (1.3–1.5% per point,
-- against the 1.183% of physical water), then charges drying on what is
-- left. The Dryer Math dry-vs-haul comparison models exactly that — so the
-- schedule's moisture rule must carry the factor.
--
--   buyer_discount_schedule_rules.shrink_factor_pct_per_point — the percent
--   of weight the buyer shrinks per point of moisture over the rule's
--   base_value (the schedule's own base, e.g. 15.0), stored on the moisture
--   rule(s). NULL = not stated on the sheet: the comparison falls back to
--   the industry-standard 1.4% and flags it "assumed — verify against the
--   schedule" (editable on the schedule row under Settings → Buyers).
--
-- The charge basis needs no new column: the moisture rule's basis already
-- distinguishes 'cents_per_bu' (¢/bu per point) from 'pct_of_price' (% of
-- price per point — the ISU-style bundled discount that embodies the shrink
-- when no separate shrink line or factor is on file).
--
-- An existing tenant table — the column rides its 074 policies.

alter table public.buyer_discount_schedule_rules
  add column if not exists shrink_factor_pct_per_point numeric(6,3)
    check (shrink_factor_pct_per_point >= 0);
