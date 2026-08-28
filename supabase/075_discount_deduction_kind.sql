-- 075: settlement_discount_items.deduction_kind — price vs weight deductions.
-- Idempotent: safe to re-run.
--
-- Buyers discount inconsistently: some cut the PRICE (dollars off the check —
-- drying charges, test-weight docks, fees) and some cut the VOLUME (pay
-- bushels shrunk below our FSA-standard dry bushels). The lost-revenue view
-- (lib/lost-revenue.ts) normalizes both to dollars, and it must never count
-- the same deduction twice:
--
--   * kind 'price'  — the item's dollars came OFF THE CHECK; they add into
--     lost revenue directly, and they are what sums against the settlement's
--     stated discount total (the sum check).
--   * kind 'weight' — the statement itemized a WEIGHT/BUSHEL reduction
--     (shrink lbs, FM weight, dockage weight). Its dollars are informational
--     (the implied value as printed or 0): lost revenue values the volume
--     gap ONCE from the pay-bu vs FSA-dry-bu reconciliation, and weight
--     items only tell that gap WHICH CATEGORY to land in (pro-rata).
--
-- Pre-075 rows are all price-type (the extraction only itemized dollar
-- discounts), so the default backfills correctly.

alter table public.settlement_discount_items
  add column if not exists deduction_kind text not null default 'price'
  check (deduction_kind in ('price', 'weight'));
