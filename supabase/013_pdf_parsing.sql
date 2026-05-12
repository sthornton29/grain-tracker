-- Grain Tracker — AI PDF parsing support.
-- Idempotent: safe to re-run.
--
-- Adds:
--   * settlements.source_pdf_url   — link to scanned settlement PDF in storage
--   * loads.source_pdf_url         — link to scanned ticket PDF in storage
--   * storage bucket "documents"   — public bucket for uploaded PDFs
--   * Permissive storage policies  — authenticated read/write on the bucket

alter table public.settlements
  add column if not exists source_pdf_url text;

alter table public.loads
  add column if not exists source_pdf_url text;

-- Storage bucket: public so the PDF viewer can <object>-load it without
-- minting signed URLs. Settlement scans may include prices; the bucket is
-- still gated by the unguessable file path generated at upload time.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', true)
on conflict (id) do update set public = excluded.public;

-- Storage policies: authenticated users can read/write objects in this bucket.
-- (The bucket is public-read at the HTTP layer for the <object> tag; these
-- policies cover the SDK paths used for uploads and deletes.)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'documents authed read'
  ) then
    create policy "documents authed read" on storage.objects
      for select to authenticated
      using (bucket_id = 'documents');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'documents authed write'
  ) then
    create policy "documents authed write" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'documents');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'documents authed update'
  ) then
    create policy "documents authed update" on storage.objects
      for update to authenticated
      using (bucket_id = 'documents')
      with check (bucket_id = 'documents');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'documents authed delete'
  ) then
    create policy "documents authed delete" on storage.objects
      for delete to authenticated
      using (bucket_id = 'documents');
  end if;
end $$;
