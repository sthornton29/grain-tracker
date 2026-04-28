-- Grain Tracker — re-add contracts.entity_id
-- Idempotent: safe to re-run.
--
-- Reverses migration 002's removal of contracts.entity_id. Contracts can now
-- be explicitly attributed to an entity at entry time, so the contract entry
-- form can default to the last entity used. The tracker still falls back to
-- delivery-derived attribution (load → field → farm → entity) when
-- entity_id is null on a contract.

alter table public.contracts
  add column if not exists entity_id uuid references public.entities(id) on delete set null;

create index if not exists contracts_entity_idx on public.contracts(entity_id);
