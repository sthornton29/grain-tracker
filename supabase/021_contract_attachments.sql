-- Grain Tracker — multiple file attachments per contract (PDFs or photos).
-- Mirrors load_attachments. Idempotent.
--
-- Reuses the public "documents" bucket; files live under a
-- "contract-attachments/" prefix.

create table if not exists public.contract_attachments (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  file_url text not null,
  file_path text not null,
  file_name text not null,
  mime_type text,
  file_size bigint,
  created_at timestamptz not null default now()
);

create index if not exists contract_attachments_contract_idx
  on public.contract_attachments(contract_id);

alter table public.contract_attachments enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'contract_attachments'
      and policyname = 'authed all'
  ) then
    create policy "authed all" on public.contract_attachments
      for all to authenticated
      using (true) with check (true);
  end if;
end $$;
