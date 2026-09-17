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

const sql = readFileSync(join(process.cwd(), 'supabase', '087_farm_link.sql'), 'utf8')
const NEW_TABLES = ['farm_links', 'farm_link_ids', 'farm_link_calls', 'landowner_settlements']

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

  it('farm_links: hashed code + token, scopes default to all seven and are constrained to the known set, one live link per org', () => {
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
    expect(vm).toContain('schema is at 087')
  })
})
