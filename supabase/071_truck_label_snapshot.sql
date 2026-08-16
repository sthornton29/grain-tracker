-- 071: Truck label snapshots on loads. Idempotent: safe to re-run.
--
-- Trucks are now editable from the load form's picker (rename/correct), so a
-- load must keep displaying its truck exactly as it read when the load was
-- entered. loads.truck_label captures trucks.name_or_number at save time (the
-- loads.hauler_truck precedent from 067, where the free text IS the snapshot);
-- every historical display surface prefers the snapshot and falls back to the
-- live FK name only for rows that predate this column (or were written by a
-- path that doesn't stamp it). Renaming a truck therefore changes the picker
-- and FUTURE loads only.
--
-- A bonus of the snapshot: deleting a truck (FK is ON DELETE SET NULL) no
-- longer blanks the truck on its historical loads.
--
-- No new table ⇒ no new RLS/org work: truck_label rides on loads, which
-- already carries the 053/054 org column + isolation policies.

alter table public.loads add column if not exists truck_label text;

-- Backfill from the current truck names — for existing loads "as entered"
-- is best approximated by the name as it stands today.
update public.loads l
set truck_label = t.name_or_number
from public.trucks t
where l.truck_id = t.id
  and l.truck_label is null;
