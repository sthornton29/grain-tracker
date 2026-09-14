-- 085: Assumed bale weight for cotton — the Marketing dashboard quotes cotton
-- production in BALES beside lbs of lint (lbs ÷ bale weight). 500 lb is the
-- default; it is an editable per crop × crop year assumption like basis or
-- expected yield. Null = use the default. An existing tenant table — the
-- column rides crop_assumptions' 020/052/054/061 policies. Idempotent.

alter table public.crop_assumptions
  add column if not exists bale_weight_lbs numeric(8,1) check (bale_weight_lbs > 0);
