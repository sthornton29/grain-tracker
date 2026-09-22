// Shape tests on supabase/087_farm_link.sql — the Turnrow Farm link's schema
// contract, pinned by reading the migration text (the agronomist-rls /
// hedge-events pattern): the four tenant tables with the full policy stack,
// the id map's two uniques, one live link per org, managed_by + archived_at on
// exactly the four land tables, the share scope column, cost provenance, the
// transactional apply RPC (service role only, allowlisted tables, org forced)
// and its presence in every tenant-table array the verify scripts read.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FARM_LINK_SCOPES, GRAIN_LINK_TABLES, LAND_TABLES } from '@/lib/farm-link'
import { LANDOWNER_SHARED_FIELDS } from '@/lib/farm-link-landowners'

const sql = readFileSync(join(process.cwd(), 'supabase', '087_farm_link.sql'), 'utf8')
const sql088 = readFileSync(join(process.cwd(), 'supabase', '088_farm_link_insurance.sql'), 'utf8')
const sql089 = readFileSync(join(process.cwd(), 'supabase', '089_farm_link_landowners.sql'), 'utf8')
const CROP_INSURANCE_TABLES = [
  'crop_insurance_policies', 'crop_insurance_sco', 'crop_insurance_eco',
  'crop_insurance_stax', 'crop_insurance_mco',
]
const NEW_TABLES = ['farm_links', 'farm_link_ids', 'farm_link_calls', 'landowner_settlements']

function section089(start: string, end: string): string {
  const a = sql089.indexOf(start)
  expect(a, `marker "${start}" missing in 089`).toBeGreaterThan(-1)
  const b = sql089.indexOf(end, a + start.length)
  return b === -1 ? sql089.slice(a) : sql089.slice(a, b)
}

function section088(start: string, end: string): string {
  const a = sql088.indexOf(start)
  expect(a, `marker "${start}" missing in 088`).toBeGreaterThan(-1)
  const b = sql088.indexOf(end, a + start.length)
  return b === -1 ? sql088.slice(a) : sql088.slice(a, b)
}

function section(start: string, end: string): string {
  const a = sql.indexOf(start)
  expect(a, `marker "${start}" missing`).toBeGreaterThan(-1)
  const b = sql.indexOf(end, a + start.length)
  return b === -1 ? sql.slice(a) : sql.slice(a, b)
}

describe('087 farm link migration', () => {
  it('creates the four tenant tables with org_id stamped by the 054 default and updated_at', () => {
    for (const t of NEW_TABLES) {
      const block = section(`create table if not exists public.${t} (`, '\n);')
      expect(block).toMatch(/org_id uuid not null references public\.organizations\(id\) on delete cascade\s+default coalesce\(public\.current_org_id\(\), public\.default_org_id\(\)\)/)
      expect(block).toMatch(/updated_at timestamptz not null default now\(\)/)
      expect(sql).toMatch(new RegExp(`create index if not exists ${t}_org\\w* on public\\.${t} \\(org_id`))
    }
  })

  it('farm_links: hashed code + token, scopes default to all eight and are constrained to the known set, one live link per org', () => {
    const block = section('create table if not exists public.farm_links (', '\n);')
    expect(block).toMatch(/code_hash text not null unique/)
    expect(block).toMatch(/token_hash text unique/)
    expect(block).toMatch(/code_expires_at timestamptz not null default now\(\) \+ interval '7 days'/)
    expect(block).toMatch(/status text not null default 'pending' check \(status in \('pending', 'active', 'revoked'\)\)/)
    expect(block).toMatch(/farm_org_id uuid/)
    expect(block).toMatch(/last_sync jsonb not null default '\{\}'::jsonb/)
    const scopesBlock = section('-- FARM_LINK_SCOPES', 'status text')
    for (const s of FARM_LINK_SCOPES) expect(scopesBlock).toContain(`'${s}'`)
    const check = section('constraint farm_links_scopes_known check', ')\n);')
    for (const s of FARM_LINK_SCOPES) expect(check).toContain(`'${s}'`)
    expect(sql).toMatch(/create unique index if not exists farm_links_one_live_per_org\s+on public\.farm_links \(org_id\) where status <> 'revoked'/)
    // Plaintext secrets never touch a column.
    expect(block).not.toMatch(/\bcode text\b|\btoken text\b/)
  })

  it('farm_link_ids: the seven grain tables, text farm_uid (crop slugs), and BOTH uniques', () => {
    const block = section('create table if not exists public.farm_link_ids (', '\n);')
    for (const t of GRAIN_LINK_TABLES) expect(block).toContain(`'${t}'`)
    expect(block).toMatch(/farm_uid text not null/)
    expect(block).toMatch(/linked_by text not null default 'sync' check \(linked_by in \('handshake', 'match', 'sync'\)\)/)
    expect(sql).toMatch(/farm_link_ids_grain_unique unique \(org_id, grain_table, grain_id\)/)
    expect(sql).toMatch(/farm_link_ids_farm_unique unique \(org_id, grain_table, farm_uid\)/)
    // The id map is the only home for Farm keys: no farm_uid column lands on a core table.
    const coreAlters = sql.match(/alter table public\.(entities|farms|fields|field_plantings|crops|landowners)[^;]*;/g) ?? []
    for (const a of coreAlters) expect(a).not.toMatch(/farm_uid/)
  })

  it('landowner_settlements: keyed per org on the Farm lease year, landowner FK set-null, statement jsonb', () => {
    const block = section('create table if not exists public.landowner_settlements (', '\n);')
    expect(block).toMatch(/farm_uid uuid not null/)
    expect(block).toMatch(/landowner_id uuid references public\.landowners\(id\) on delete set null/)
    expect(block).toMatch(/statement jsonb not null default '\{\}'::jsonb/)
    expect(block).toMatch(/crop_year integer not null/)
    expect(sql).toMatch(/landowner_settlements_org_farm_uid_unique unique \(org_id, farm_uid\)/)
  })

  it('policy stack: authed all + org isolation + gin block + viewer block-all + agronomist block-all on every new table', () => {
    const loop = section('-- FARM_LINK_TENANT_TABLES', '-- 9.')
    for (const t of NEW_TABLES) expect(loop).toContain(`'${t}'`)
    expect(loop).toMatch(/enable row level security/)
    expect(loop).toMatch(/create policy "authed all" on public\.%I for all to authenticated using \(true\) with check \(true\)/)
    expect(loop).toMatch(/as restrictive for all to authenticated using \(org_id = public\.current_org_id\(\)\) with check \(org_id = public\.current_org_id\(\)\)/)
    expect(loop).toMatch(/public\.app_role\(\) <> ''gin''/)
    expect(loop).toMatch(/_viewer_block_all/)
    expect(loop).toMatch(/_agronomist_block_all/)
    expect(loop).not.toMatch(/_viewer_block_ins/) // viewers get no reads either — pairing secrets and landowner finances
  })

  it('managed_by + archived_at land on exactly the four land tables, constrained to turnrow_farm', () => {
    const block = section('-- FARM_LINK_MANAGED_TABLES', '-- 5b.')
    const listed = [...block.matchAll(/array\[([^\]]+)\]/g)][0][1].match(/'([a-z_]+)'/g)!.map((s) => s.replace(/'/g, ''))
    expect(listed).toEqual([...LAND_TABLES])
    expect(block).toMatch(/add column if not exists managed_by text/)
    expect(block).toMatch(/add column if not exists archived_at timestamptz/)
    expect(block).toMatch(/managed_by is null or managed_by = ''turnrow_farm''/)
  })

  it('adds updated_at to crops + landowners, the settlements share scope (default OFF), and cost provenance with the override switch', () => {
    expect(section('-- 5b.', '-- 6.')).toMatch(/array\['crops', 'landowners'\]/)
    expect(sql).toMatch(/alter table public\.partner_shares\s+add column if not exists share_settlements boolean not null default false/)
    const ca = section('alter table public.crop_assumptions', 'alter table public.budget_scenarios')
    expect(ca).toMatch(/cost_source text check \(cost_source is null or cost_source = 'turnrow_farm'\)/)
    expect(ca).toMatch(/cost_source_updated_at timestamptz/)
    expect(ca).toMatch(/cost_manual_override boolean not null default false/)
    expect(sql).toMatch(/alter table public\.budget_scenarios\s+add column if not exists follow_farm_costs boolean not null default false/)
    expect(section('alter table public.budget_lines', '-- 8.')).toMatch(/cost_source text/)
  })

  it('farm_link_apply: service-role only, allowlisted land tables, org forced, archive never deletes, id/org_id stripped from payloads', () => {
    const fn = section('create or replace function public.farm_link_apply', 'end $$;')
    expect(fn).toMatch(/security definer/)
    expect(fn).toMatch(/allowed constant text\[\] := array\['entities', 'landowners', 'farms', 'fields', 'crops', 'field_plantings', 'field_planting_varieties'\]/)
    expect(fn).toMatch(/if k in \('org_id', 'id', 'created_at'\) then continue; end if;/)
    expect(fn).toMatch(/jsonb_build_object\('id', new_id, 'org_id', p_org\)/)
    expect(fn).toMatch(/where t\.id = \$2 and t\.org_id = \$3/)
    expect(fn).toMatch(/set archived_at = coalesce\(archived_at, now\(\)\), managed_by = ''turnrow_farm'' where id = \$1 and org_id = \$2/)
    expect(fn).toMatch(/if not \(tbl = any\(array\['entities', 'farms', 'fields', 'field_plantings'\]\)\) then/)
    // Only variety rows are ever deleted (replaced as a set, scoped to the org).
    const deletes = fn.match(/delete from public\.\w+/g) ?? []
    expect(deletes).toEqual(['delete from public.field_planting_varieties'])
    expect(fn).toMatch(/delete from public\.field_planting_varieties where planting_id = target and org_id = p_org/)
    // $ref resolution for values, update ids, planting refs, and link grain_ids.
    expect(fn).toMatch(/refs->\(v->>'\$ref'\)/)
    expect(fn).toMatch(/refs->>\(op->'id'->>'\$ref'\)/)
    expect(fn).toMatch(/on conflict \(org_id, grain_table, grain_id\) do update/)
    expect(sql).toMatch(/revoke execute on function public\.farm_link_apply\(uuid, jsonb\) from public, anon, authenticated;/)
    expect(sql).toMatch(/grant execute on function public\.farm_link_apply\(uuid, jsonb\) to service_role;/)
  })

  it('admin_list_farm_links is super-admin gated and returns metadata only', () => {
    const fn = section('create or replace function public.admin_list_farm_links', '$$;')
    expect(fn).toMatch(/where public\.is_super_admin\(\)/)
    expect(fn).not.toMatch(/code_hash|token_hash/)
  })

  it('every new tenant table is in the 053/054 arrays, verify_053/054, and the verify_migrations checklist reaches 087', () => {
    const read = (f: string) => readFileSync(join(process.cwd(), 'supabase', f), 'utf8')
    const m053 = read('053_multitenant_phase1.sql')
    const m054 = read('054_org_isolation.sql')
    const v053 = read('verify_053.sql')
    const v054 = read('verify_054.sql')
    for (const t of NEW_TABLES) {
      expect(m053, `053 lacks ${t}`).toContain(`'${t}'`)
      expect(m054, `054 lacks ${t}`).toContain(`'${t}'`)
      expect(v053, `verify_053 lacks ${t}`).toContain(`('${t}')`)
      expect(v054, `verify_054 lacks ${t}`).toContain(`('${t}')`)
      expect(v054, `verify_054 loop lacks ${t}`).toContain(`'${t}'`)
    }
    const vm = read('verify_migrations.sql')
    expect(vm).toMatch(/\( 87, '087_farm_link'/)
    expect(vm).toMatch(/\( 88, '088_farm_link_insurance'/)
    expect(vm).toMatch(/\( 89, '089_farm_link_landowners'/)
    expect(vm).toContain('schema is at 089')
  })
})

// ---------------------------------------------------------------------------
// 088 — crop insurance over the link
// ---------------------------------------------------------------------------

describe('088 farm link insurance migration', () => {
  it('widens the farm_links scope default AND the known-scope check to the scopes that existed at 088, insurance:read included', () => {
    const scopesBlock = section088('-- FARM_LINK_SCOPES', 'end $$;')
    // 088's own list, pinned: a LATER migration adding a scope restates the
    // whole list itself (089 does), so this one is not chased forward.
    const AT_088 = ['land:write', 'production:read', 'marketing:read', 'income:read', 'bins:read', 'insurance:read', 'assumptions:write', 'settlements:write']
    for (const scope of AT_088) expect(scopesBlock).toContain(`'${scope}'`)
    expect(scopesBlock).toContain("insurance:read")
    // The constraint is dropped and re-added, so re-running is safe and an
    // already-applied 087 widens in place.
    expect(scopesBlock).toMatch(/drop constraint if exists farm_links_scopes_known/)
    expect(scopesBlock).toMatch(/add constraint farm_links_scopes_known check/)
  })

  it('gives every crop insurance table updated_at with the set_updated_at trigger, backfilled ONLY on the add', () => {
    const block = section088('-- CROP_INSURANCE_TABLES', '-- 3.')
    for (const t of CROP_INSURANCE_TABLES) expect(block).toContain(`'${t}'`)
    expect(block).toMatch(/add column updated_at timestamptz not null default now\(\)/)
    expect(block).toMatch(/set updated_at = created_at/)
    // Guarded on the column NOT already existing: a re-run must never reset a
    // genuinely-edited row's stamp back to its creation.
    expect(block).toMatch(/if not exists \(select 1 from information_schema\.columns c/)
    expect(block).toMatch(/execute function public\.set_updated_at\(\)/)
  })

  it('creates the tombstone log as a tenant table with the 054 stamping default and the org index', () => {
    const block = section088('create table if not exists public.crop_insurance_deletions (', '\n);')
    expect(block).toMatch(/org_id uuid not null references public\.organizations\(id\) on delete cascade\s+default coalesce\(public\.current_org_id\(\), public\.default_org_id\(\)\)/)
    expect(block).toMatch(/crop_year integer not null/)
    expect(block).toMatch(/practice text/)
    expect(block).toMatch(/deleted_at timestamptz not null default now\(\)/)
    // policy_id traces the row that went; it is deliberately NOT a FK.
    expect(block).toMatch(/policy_id uuid,/)
    expect(block).not.toMatch(/policy_id uuid[^,]*references/)
    expect(sql088).toMatch(/create index if not exists crop_insurance_deletions_org_idx on public\.crop_insurance_deletions \(org_id\)/)
  })

  it('writes the log from an AFTER DELETE trigger on the policies AND every rider, keyed off the parent policy', () => {
    expect(sql088).toMatch(/create or replace function public\.log_crop_insurance_deletion\(\)/)
    for (const t of CROP_INSURANCE_TABLES) {
      expect(sql088).toMatch(new RegExp(`after delete on public\\.%I`))
      expect(sql088).toContain(`'${t}'`)
    }
    // A rider whose parent is already gone logs nothing (the policy's own row
    // covers it) — otherwise one cascade would raise two tombstones.
    expect(sql088).toMatch(/if not found then return old; end if;/)
  })

  it('adds the includes_insurance flag to crop_assumptions, defaulting to today behavior', () => {
    expect(sql088).toMatch(/alter table public\.crop_assumptions\s+add column if not exists cost_includes_insurance boolean not null default false/)
  })

  it('gives the tombstone log the full policy stack: org isolation, gin, viewer, agronomist', () => {
    const block = section088('-- FARM_LINK_TENANT_TABLES', 'end $$;')
    expect(block).toContain("'crop_insurance_deletions'")
    expect(block).toMatch(/enable row level security/)
    expect(block).toMatch(/_org_isolation/)
    expect(block).toMatch(/app_role\(\) <> ''gin''/)
    expect(block).toMatch(/_viewer_block_all/)
    expect(block).toMatch(/_agronomist_block_all/)
  })

  it('is in every tenant-table array and verify script', () => {
    for (const file of ['053_multitenant_phase1.sql', '054_org_isolation.sql', 'verify_053.sql', 'verify_054.sql']) {
      const text = readFileSync(join(process.cwd(), 'supabase', file), 'utf8')
      expect(text, file).toContain('crop_insurance_deletions')
    }
    const verify = readFileSync(join(process.cwd(), 'supabase', 'verify_migrations.sql'), 'utf8')
    expect(verify).toContain('088_farm_link_insurance')
  })

  it('053 and 054 skip a tenant table a LATER migration creates, so a fresh install runs in order', () => {
    for (const file of ['053_multitenant_phase1.sql', '054_org_isolation.sql']) {
      const text = readFileSync(join(process.cwd(), 'supabase', file), 'utf8')
      expect(text, file).toMatch(/if to_regclass\('public\.' \|\| t\) is null then continue; end if;/)
    }
  })
})

// ---------------------------------------------------------------------------
// 089 — landowners shared both ways
// ---------------------------------------------------------------------------

describe('089 farm link landowners migration', () => {
  it('widens the scope default AND the known-scope check to every FARM_LINK_SCOPES entry, landowners:write included', () => {
    const scopesBlock = section089('-- FARM_LINK_SCOPES', 'end $$;')
    for (const scope of FARM_LINK_SCOPES) expect(scopesBlock).toContain(`'${scope}'`)
    expect(scopesBlock).toContain('landowners:write')
    expect(scopesBlock).toMatch(/drop constraint if exists farm_links_scopes_known/)
    expect(scopesBlock).toMatch(/add constraint farm_links_scopes_known check/)
  })

  it('adds every shared field to landowners, plus archived_at and merged_into_id, and KEEPS the old address column', () => {
    for (const col of ['kind', 'contact_name', 'payee_name', 'address_street', 'address_city', 'address_state', 'address_zip', 'archived_at', 'merged_into_id']) {
      expect(sql089, col).toMatch(new RegExp(`add column if not exists ${col}\\b`))
    }
    // The free-text address is split where it parses, never dropped.
    expect(sql089).not.toMatch(/drop column .*address\b/)
    expect(sql089).toMatch(/regexp_match/)
    // The split runs only on rows not split yet, so a re-run is a no-op.
    expect(sql089).toMatch(/address_street is null and address_city is null/)
    expect(sql089).toMatch(/landowners_kind_known/)
    expect(sql089).toMatch(/landowners_merge_not_self/)
  })

  it('creates the change log as a tenant table with the 054 default, and a lookup index on (org, landowner, field)', () => {
    const block = section089('create table if not exists public.landowner_field_changes (', '\n);')
    expect(block).toMatch(/org_id uuid not null references public\.organizations\(id\) on delete cascade\s+default coalesce\(public\.current_org_id\(\), public\.default_org_id\(\)\)/)
    expect(block).toMatch(/field text not null/)
    expect(block).toMatch(/old_value text/)
    expect(block).toMatch(/new_value text/)
    expect(block).toMatch(/changed_at timestamptz not null default now\(\)/)
    expect(block).toMatch(/changed_by text not null/)
    expect(sql089).toMatch(/landowner_field_changes_lookup_idx[\s\S]*?\(org_id, landowner_id, field, changed_at desc\)/)
  })

  it('the trigger logs exactly the shared fields, stamped with who changed them', () => {
    const fn = section089('create or replace function public.log_landowner_field_changes()', 'end $$;')
    for (const field of LANDOWNER_SHARED_FIELDS) expect(fn, field).toContain(`'${field}'`)
    // The link's own writes are stamped turnrow_farm via a session flag, so
    // they never come back to Farm as Grain edits.
    expect(fn).toMatch(/current_setting\('app\.change_actor', true\)/)
    expect(fn).toMatch(/is distinct from/)
    expect(sql089).toMatch(/after update on public\.landowners/)
  })

  it('keeps the change log 90 days through a service-role-only function', () => {
    expect(sql089).toMatch(/create or replace function public\.trim_landowner_field_changes\(p_days integer default 90\)/)
    expect(sql089).toMatch(/revoke execute on function public\.trim_landowner_field_changes\(integer\) from public, anon/)
    expect(sql089).toMatch(/grant execute on function public\.trim_landowner_field_changes\(integer\) to service_role/)
  })

  it('adds the lease and settlement columns: managed_by + farm_lease_uid, superseded_by, and the withdrawn status', () => {
    expect(sql089).toMatch(/alter table public\.lease_terms[\s\S]*?add column if not exists managed_by text/)
    expect(sql089).toMatch(/add column if not exists farm_lease_uid text/)
    expect(sql089).toMatch(/lease_terms_managed_by_known/)
    expect(sql089).toMatch(/lease_terms_farm_lease_uid_unique[\s\S]*?\(org_id, farm_lease_uid\)/)
    expect(sql089).toMatch(/add column if not exists superseded_by_settlement_id uuid\s+references public\.landowner_settlements\(id\)/)
    expect(sql089).toMatch(/alter table public\.landowner_settlements\s+add column if not exists status text not null default 'final'/)
    expect(sql089).toMatch(/check \(status in \('final', 'withdrawn'\)\)/)
    expect(sql089).toMatch(/alter table public\.partner_shares\s+add column if not exists last_viewed_at timestamptz/)
  })

  it('farm_link_landowner_apply is service-role only, forces the org, allowlists the shared columns, and stamps the actor', () => {
    const fn = section089('create or replace function public.farm_link_landowner_apply(p_org uuid, p_ops jsonb)', 'revoke execute')
    expect(fn).toMatch(/security definer set search_path = public/)
    // Every write in the call is Turnrow Farm's, for the change log.
    expect(fn).toMatch(/set_config\('app\.change_actor', 'turnrow_farm', true\)/)
    for (const field of LANDOWNER_SHARED_FIELDS) expect(fn, field).toContain(`'${field}'`)
    expect(fn).toMatch(/if not \(k = any\(allowed\)\) then continue; end if;/)
    // The org is forced on inserts and every update/merge/archive is scoped.
    expect(fn).toMatch(/jsonb_build_object\('id', new_id, 'org_id', p_org\)/)
    expect(fn).toMatch(/where t\.id = \$2 and t\.org_id = \$3/)
    expect(fn).toMatch(/both landowners must belong to the organization/)
    // The merge moves every dependent; the share only with move_share.
    for (const table of ['farms', 'lease_terms', 'rent_settlements', 'landowner_settlements']) {
      expect(fn, table).toMatch(new RegExp(`update public\\.${table} set landowner_id = survivor`))
    }
    expect(fn).toMatch(/if coalesce\(\(op->>'move_share'\)::boolean, false\) then[\s\S]*?update public\.partner_shares set landowner_id = survivor/)
    // Archive, never delete.
    expect(fn).toMatch(/set archived_at = coalesce\(archived_at, now\(\)\)/)
    expect(fn).not.toMatch(/delete from public\.landowners/)
    expect(sql089).toMatch(/revoke execute on function public\.farm_link_landowner_apply\(uuid, jsonb\) from public, anon, authenticated/)
    expect(sql089).toMatch(/grant execute on function public\.farm_link_landowner_apply\(uuid, jsonb\) to service_role/)
  })

  it('gives the change log the full policy stack and registers it everywhere a tenant table belongs', () => {
    const block = section089('-- FARM_LINK_TENANT_TABLES', 'end $$;')
    expect(block).toContain("'landowner_field_changes'")
    expect(block).toMatch(/enable row level security/)
    expect(block).toMatch(/_org_isolation/)
    expect(block).toMatch(/app_role\(\) <> ''gin''/)
    expect(block).toMatch(/_viewer_block_all/)
    expect(block).toMatch(/_agronomist_block_all/)
    for (const file of ['053_multitenant_phase1.sql', '054_org_isolation.sql', 'verify_053.sql', 'verify_054.sql']) {
      expect(readFileSync(join(process.cwd(), 'supabase', file), 'utf8'), file).toContain('landowner_field_changes')
    }
  })
})
