-- 056: Seeded crops carry the right harvest category. REQUIRES 055. Idempotent.
--
-- crops.harvest_category (028: 'fall' default | 'spring') drives crop-year
-- mapping and the double-crop rules. The 053/055 org-seeding functions
-- inserted crops WITHOUT it, so a new org's Wheat landed on 'fall'. Wheat is
-- a spring-harvest crop (028 set Turnrow's the same way): re-defines both
-- seeders with explicit categories and repairs any already-seeded org.

create or replace function public.seed_org_defaults(target_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.app_role() <> 'owner' then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.organizations where id = target_org) then raise exception 'no such organization'; end if;
  insert into public.crops (name, base_moisture_pct, base_lb_per_bushel, harvest_category, org_id) values
    ('Corn',          15.5, 56.0, 'fall',   target_org),
    ('Soybean',       13.0, 60.0, 'fall',   target_org),
    ('Wheat',         13.5, 60.0, 'spring', target_org),
    ('Grain Sorghum', 14.0, 56.0, 'fall',   target_org)
  on conflict do nothing;
  insert into public.app_settings (id, org_id)
  select coalesce(max(id), 0) + 1, target_org from public.app_settings
  on conflict do nothing;
end $$;

create or replace function public.admin_create_org(org_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_org uuid; base_slug text; final_slug text; n int := 0;
begin
  if not public.is_super_admin() then raise exception 'not allowed'; end if;
  if coalesce(trim(org_name), '') = '' then raise exception 'organization name required'; end if;
  base_slug := trim(both '-' from regexp_replace(lower(trim(org_name)), '[^a-z0-9]+', '-', 'g'));
  if base_slug = '' then raise exception 'organization name needs letters or digits'; end if;
  final_slug := base_slug;
  while exists (select 1 from public.organizations where slug = final_slug) loop
    n := n + 1;
    final_slug := base_slug || '-' || n;
  end loop;
  insert into public.organizations (name, slug) values (trim(org_name), final_slug)
  returning id into new_org;
  insert into public.crops (name, base_moisture_pct, base_lb_per_bushel, harvest_category, org_id) values
    ('Corn',          15.5, 56.0, 'fall',   new_org),
    ('Soybean',       13.0, 60.0, 'fall',   new_org),
    ('Wheat',         13.5, 60.0, 'spring', new_org),
    ('Grain Sorghum', 14.0, 56.0, 'fall',   new_org)
  on conflict do nothing;
  insert into public.app_settings (id, org_id, cotton_module_enabled)
  select coalesce(max(id), 0) + 1, new_org, false from public.app_settings
  on conflict do nothing;
  return new_org;
end $$;

-- Repair already-seeded orgs (matches 028's intent — Wheat/Canola are
-- spring-harvest in every org; Turnrow's rows already comply).
update public.crops set harvest_category = 'spring'
where name in ('Wheat', 'Canola') and harvest_category <> 'spring';
