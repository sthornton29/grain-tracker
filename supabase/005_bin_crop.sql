-- Grain Tracker — Designate each bin to a single crop.
-- Idempotent.

alter table public.bins
  add column if not exists crop_id uuid references public.crops(id) on delete set null;

create index if not exists bins_crop_idx on public.bins(crop_id);
