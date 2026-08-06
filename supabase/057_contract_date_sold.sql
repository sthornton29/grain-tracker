-- 057: contracts.date_sold — the OPTIONAL date a physical grain contract was
-- sold/signed (distinct from the delivery window and from completed_at).
-- Idempotent. No new RLS: an added column on an existing tenant table rides
-- the 052/054 policies.

alter table public.contracts add column if not exists date_sold date;

comment on column public.contracts.date_sold is
  'Optional: the date the contract was sold/signed. Informational — delivery windows and completion drive the cash-flow math.';
