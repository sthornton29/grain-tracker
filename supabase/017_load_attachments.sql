-- Grain Tracker — multiple file attachments per load (PDFs or photos).
-- Idempotent: safe to re-run.
--
-- Adds:
--   * load_attachments table — many-to-one with loads
--
-- The existing public "documents" bucket (created in 013_pdf_parsing.sql) is
-- reused; files live under a "load-attachments/" prefix.

create table if not exists public.load_attachments (
  id uuid primary key default gen_random_uuid(),
  load_id uuid not null references public.loads(id) on delete cascade,
  file_url text not null,
  file_path text not null,
  file_name text not null,
  mime_type text,
  file_size bigint,
  created_at timestamptz not null default now()
);

create index if not exists load_attachments_load_idx
  on public.load_attachments(load_id);

alter table public.load_attachments enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'load_attachments'
      and policyname = 'authed all'
  ) then
    create policy "authed all" on public.load_attachments
      for all to authenticated
      using (true) with check (true);
  end if;
end $$;
