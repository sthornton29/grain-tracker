-- 049 — Crop Budget Planner: optional irrigated/dryland and full-season/
-- double-crop breakout per budget line.
--
-- practice: null = blended (all acres), else 'irrigated' | 'non_irrigated'.
-- cropping: null = full season, else 'full_season' | 'double_crop' (offered
-- only for crops designated double-crop). The breakout drives practice-aware
-- assumption SEEDS (per-practice APH weighting; DC lines seed from the
-- dc yield/cost breakouts and never from APH) — the math itself is unchanged.
--
-- Idempotent: safe to re-run.

alter table public.budget_lines
  add column if not exists practice text check (practice in ('irrigated', 'non_irrigated'));

alter table public.budget_lines
  add column if not exists cropping text check (cropping in ('full_season', 'double_crop'));
