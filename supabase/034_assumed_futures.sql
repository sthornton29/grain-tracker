-- 034_assumed_futures.sql
-- Per-crop-year assumed futures price for the Marketing dashboard's What-If. Like
-- assumed_basis (033), it's a standing assumption the user enters to value the
-- crop's completely-unpriced bushels — the futures half of the price on that
-- production, overriding the auto-fetched harvest-price estimate when set. It
-- persists per crop × year so it survives leaving the page, and is wiped by the
-- dashboard's per-crop "Clear assumptions" (which clears futures + basis). NULL =
-- none set (fall back to the harvest-price estimate).

alter table public.crop_assumptions
  add column if not exists assumed_futures numeric(12,6);
