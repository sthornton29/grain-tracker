// npm run schema:build — generates the data assistant's schema digest.
//
//  supabase/NNN_*.sql (every migration, in order) ──► lib/assistant-schema.generated.ts
//
//  * The TENANT table list is the canonical one the multi-tenant verify
//    scripts use: the org_id array in supabase/054_org_isolation.sql. Every
//    name in it MUST come out with columns and a description, or this script
//    fails — the same discipline as the help-coverage gate (and
//    lib/assistant-schema.test.ts re-checks it in CI).
//  * Columns come from parsing `create table … (…)` blocks and every
//    `alter table … add column` / `drop column` that follows, so a new
//    migration column shows up in the digest on the next build without
//    anyone hand-editing a list.
//  * The one-line "what this holds" text and the help topic each table maps
//    to live in TABLE_DOCS below (the help topic supplies the page name the
//    assistant can cite). Reference tables (shared, not org-scoped) are the
//    REFERENCE list.
//
// Run it after any migration that adds a table or column (it is also part of
// `npm run help:build`, the session-end ritual).

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sqlDir = join(root, 'supabase')

// ---------- 1. tenant list (054) ----------
export function tenantTablesFrom054(sql) {
  const start = sql.indexOf('foreach t in array array[')
  const end = sql.indexOf('] loop', start)
  if (start < 0 || end < 0) throw new Error('054: tenant array not found')
  return [...sql.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

// Shared reference tables (global rows, not org-scoped) worth joining to.
export const REFERENCE_TABLES = [
  'counties', 'covered_commodities', 'commodity_specs', 'market_prices', 'dryer_models',
  'program_year_config', 'rma_price_cache', 'arc_plc_price_data', 'arc_benchmark_data',
  'mya_monthly_prices', 'awp_weekly', 'fsa_benchmark_cache',
]

// ---------- 2. parse migrations ----------
function stripComments(sql) {
  return sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n')
}

const RESERVED_STARTS = /^(primary\s+key|constraint|unique|check|foreign\s+key|exclude|like)\b/i
const TYPE_STOP = /\b(not\s+null|null|default|references|check|generated|unique|primary|constraint|collate|on\s+delete)\b/i

function splitTopLevel(body) {
  const out = []
  let depth = 0, cur = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

function columnFromDef(def) {
  const d = def.trim().replace(/\s+/g, ' ')
  if (!d || RESERVED_STARTS.test(d)) return null
  const m = d.match(/^"?([a-z_][a-z0-9_]*)"?\s*(.*)$/i)
  if (!m) return null
  const name = m[1].toLowerCase()
  let rest = m[2]
  const stop = rest.search(TYPE_STOP)
  const type = (stop >= 0 ? rest.slice(0, stop) : rest).trim().replace(/\s*\(.*$/, (s) => s).toLowerCase()
  const enumVals = [...rest.matchAll(/check\s*\(\s*[a-z_]+\s+in\s*\(([^)]*)\)/gi)].map((x) => x[1])
  const refs = rest.match(/references\s+(?:public\.)?([a-z_]+)/i)
  const generated = /generated\s+always/i.test(rest)
  return { name, type: type || 'text', enum: enumVals[0]?.replace(/'/g, '').replace(/\s+/g, '') ?? null, ref: refs?.[1] ?? null, generated }
}

export function parseMigrations(files) {
  /** @type {Map<string, Map<string, ReturnType<typeof columnFromDef>>>} */
  const tables = new Map()
  const ensure = (t) => { if (!tables.has(t)) tables.set(t, new Map()); return tables.get(t) }
  for (const { name: file, text } of files) {
    const sql = stripComments(text)
    // create table blocks
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_]+)\s*\(/gi
    let m
    while ((m = re.exec(sql))) {
      const table = m[1].toLowerCase()
      let depth = 1, i = re.lastIndex, body = ''
      while (i < sql.length && depth > 0) {
        const ch = sql[i]
        if (ch === '(') depth++
        if (ch === ')') depth--
        if (depth > 0) body += ch
        i++
      }
      const cols = ensure(table)
      for (const def of splitTopLevel(body)) {
        const c = columnFromDef(def)
        if (c) cols.set(c.name, c)
      }
    }
    // alter table … add column / drop column (single statements, possibly multi-column)
    const alterRe = /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_]+)\s+([^;]*?);/gi
    while ((m = alterRe.exec(sql))) {
      const table = m[1].toLowerCase()
      const stmt = m[2]
      if (!/add\s+column|drop\s+column/i.test(stmt)) continue
      const cols = ensure(table)
      for (const add of stmt.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_]+)\s+([^,]*(?:\([^)]*\)[^,]*)*)/gi)) {
        const c = columnFromDef(`${add[1]} ${add[2]}`)
        if (c) cols.set(c.name, c)
      }
      for (const drop of stmt.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?([a-z_]+)/gi)) cols.delete(drop[1].toLowerCase())
    }
    void file
  }
  return tables
}

// ---------- 3. what each table holds (+ the help topic the assistant can cite) ----------
// Every tenant table needs an entry; the build fails otherwise.
export const TABLE_DOCS = {
  // organization & land
  entities: ['Your farming entities (LLCs, partnerships, individuals) and the marketing-agent entity if you use one; managed_by = turnrow_farm means the row comes from Turnrow Farm (read-only here), archived_at set = archived by that link — exclude archived rows', '/settings'],
  farms: ['Farms (FSA farm numbers) with their entity, county, landowner and rent terms; managed_by = turnrow_farm means the row comes from Turnrow Farm, archived_at set = archived — exclude archived rows', '/settings'],
  fields: ['Fields inside each farm with total / irrigated / dryland acres; managed_by = turnrow_farm means the row comes from Turnrow Farm, archived_at set = archived — exclude archived rows', '/settings'],
  landowners: ['Landowners you rent from', '/settings'],
  entity_counties: ['Which counties each entity operates in (for county benchmarks)', '/settings'],
  crops: ['The crops you grow with their moisture / test-weight bases and harvest category', '/settings'],
  field_plantings: ['What was planted where each season: field × crop × year with acres and practice; managed_by = turnrow_farm means the row comes from Turnrow Farm, archived_at set = archived — exclude archived rows', '/settings'],
  field_planting_varieties: ['Seed varieties (and their acres) inside a planting', '/settings'],
  variety_match_dismissals: ['Variety-name near-match suggestions the user dismissed (housekeeping)', '/settings'],
  trucks: ['Your own trucks', '/settings'],
  external_trucks: ['Hauler trucks that pick up grain (belong to a buyer)', '/settings'],
  buyers: ['Grain buyers / elevators / gins you sell to', '/settings/buyers'],
  delivery_locations: ['Each buyer’s delivery points (address, wait time)', '/settings/buyers'],
  buyer_discount_schedules: ['A buyer’s posted discount sheet per crop (in force from a date)', '/settings/buyers'],
  buyer_discount_schedule_rules: ['The per-factor rules on a discount sheet (moisture, test weight, damage…)', '/settings/buyers'],
  app_settings: ['Operation-level switches (cotton module on/off, default crop year…)', '/settings'],
  user_profiles: ['Each user’s role in this operation', '/settings/users'],
  user_entity_access: ['Which entities a read-only viewer is allowed to see', '/settings/users'],
  viewer_assumption_overrides: ['A viewer’s private what-if overrides of the crop assumptions', '/settings/users'],
  assistant_usage: ['Ask Turnrow usage log (one row per question)', '/assistant'],
  // grain flow
  loads: ['Every grain load: date, truck, crop, from field/bin, to bin/buyer, weights in POUNDS, moisture, ticket, contract', '/loads'],
  load_splits: ['A load split across fields/crops (each split’s share of the load)', '/loads'],
  load_attachments: ['Scale tickets / photos attached to a load', '/loads'],
  combine_yield_entries: ['Combine-monitor totals entered per field × crop (the alternative harvest source)', '/yields'],
  contracts: ['Grain sales contracts: buyer, crop, bushels, pricing (cash / futures + basis), delivery window; contract_kind tells grain vs seed production', '/contracts'],
  contract_attachments: ['Contract documents attached to a contract', '/contracts'],
  settlements: ['Buyer settlement checks (statements) — crop year comes through the loads they pay', '/settlements'],
  settlement_lines: ['One line per load/ticket paid on a settlement: bushels, gross, discounts, net', '/settlements'],
  settlement_discount_items: ['The itemized discounts on a settlement (moisture, test weight, drying, FM…) with amounts', '/settlements'],
  crop_year_sales_status: ['The "physical sales complete" flag per crop × crop year', '/settings'],
  // storage
  bin_sites: ['Bin sites (locations) and their entity', '/inventory'],
  bins: ['Bins with capacity and the crop in them', '/inventory'],
  bin_inventory_adjustments: ['Manual inventory adjustments / beginning inventory per bin', '/inventory'],
  bin_transfers: ['Grain moved bin-to-bin (dry bushels)', '/inventory'],
  // marketing & hedging
  crop_assumptions: ['Per crop × crop year assumptions: expected yield, cost/acre, assumed basis/futures, harvest-complete flag, assumed acres', '/reports/marketing'],
  county_yield_assumptions: ['County-level yield assumptions for the area plans', '/reports/marketing'],
  harvest_price_estimates: ['Insurance projected/harvest price estimates per crop × year (RMA and manual)', '/reports/crop-insurance'],
  futures_positions: ['Futures hedge positions (open/closed) with rolls linked through roll_group_id / rolled_from_position_id', '/hedging'],
  options_positions: ['Options positions (puts/calls) with premiums and results', '/hedging'],
  hedge_position_events: ['Append-only history of every hedge position change (open, close, roll, edit, import)', '/hedging'],
  manual_market_quotes: ['Hand-entered futures quotes for contracts with no live price (cotton)', '/hedging'],
  farm_links: ['The pairing with Turnrow Farm (one per organization): status, Farm organization name, granted scopes, last sync per direction; codes and tokens stored hashed', '/settings/farm-link'],
  farm_link_ids: ['The id map between Grain rows and Turnrow Farm rows (grain_table x grain_id <-> farm_uid); a land row with a map entry is managed in Turnrow Farm', '/settings/farm-link'],
  farm_link_calls: ['Rolling log of Turnrow Farm link API calls (endpoint, status, record counts), trimmed to 30 days', '/settings/farm-link'],
  crop_insurance_deletions: ['Tombstones for deleted crop insurance policies and endorsements (entity, crop, practice, crop year, when), so the Turnrow Farm link can tell its side a premium row is gone; written by a trigger, never by hand', '/settings/crop-insurance'],
  landowner_field_changes: ['Per-field history of landowner changes (which field, old and new value, when, and whether you or Turnrow Farm changed it), so the two sides merge a landowner field by field instead of overwriting each other; written by a trigger, kept 90 days', '/settings/landowners'],
  landowner_settlements: ['Landowner rent statements finalized in Turnrow Farm, one per lease year (farm_uid): landowner, crop year, lease type, the statement rows as jsonb; shared to landowners only under the settlements share scope', '/settings/farm-link'],
  // insurance & government
  crop_insurance_policies: ['Crop insurance policies per entity × crop × county × year (plan, coverage, APH, prices, premiums)', '/settings/crop-insurance'],
  crop_insurance_sco: ['SCO endorsement on a policy', '/settings/crop-insurance'],
  crop_insurance_eco: ['ECO endorsement on a policy', '/settings/crop-insurance'],
  crop_insurance_stax: ['STAX endorsement (cotton) on a policy', '/settings/crop-insurance'],
  crop_insurance_mco: ['MCO margin endorsement on a policy', '/settings/crop-insurance'],
  farm_base_acres: ['FSA base acres and PLC yield per farm × covered commodity', '/settings/government-payments'],
  arc_plc_elections: ['ARC / PLC election per farm × commodity', '/settings/government-payments'],
  arc_plc_payments: ['ARC/PLC payments received per farm × commodity × program year', '/settings/government-payments'],
  other_government_payments: ['Other USDA payments (disaster, CFAP, etc.) by entity/farm/crop', '/settings/government-payments'],
  payment_limit_config: ['Payment-limit settings per program year', '/settings/government-payments'],
  // budget, leases, freight, drying
  budget_scenarios: ['Crop budget planner scenarios (a named plan for a year)', '/reports/crop-budget'],
  budget_lines: ['The crop lines inside a budget scenario: acres, yield, price, cost per acre', '/reports/crop-budget'],
  lease_terms: ['Lease terms per farm × year: cash rent, share %, flex terms, who pays drying', '/reports/rent-settlement'],
  rent_settlements: ['Computed / recorded rent settlements per lease × year', '/reports/rent-settlement'],
  freight_settings: ['Trucking cost settings (rates, fuel)', '/reports/freight-math'],
  freight_distances: ['Saved miles between origins and delivery points', '/reports/freight-math'],
  dryer_settings: ['Your dryer’s fuel and throughput settings', '/reports/dryer-math'],
  org_dryers: ['Dryers you own (model + settings)', '/reports/dryer-math'],
  // seed production (077)
  seed_contract_details: ['Seed production contract terms attached to a contract: premiums, usage fee, price basis', '/contracts/seed'],
  seed_contract_premiums: ['Expected premiums on a seed contract (per unit/bushel)', '/contracts/seed'],
  seed_pricing_elections: ['Pricing elections (increments locked at a price) on a seed contract', '/contracts/seed'],
  seed_contract_payments: ['Payments received on a seed contract', '/contracts/seed'],
  seed_contract_plantings: ['Which plantings (fields) feed a seed contract', '/contracts/seed'],
  // cotton (module)
  gins: ['Cotton gins you deliver to', '/cotton'],
  cotton_loads: ['Seed-cotton module loads from the field to the gin (weights in pounds)', '/cotton'],
  gin_receipts: ['Gin receipts: bales ginned per receipt with lint weight, entity/farm/field', '/cotton'],
  gin_receipt_loads: ['Which cotton loads went into a gin receipt', '/cotton'],
  cotton_bales: ['Individual bales (PBI number, net lbs) under a gin receipt', '/cotton'],
  cotton_bale_grades: ['HVI grades per bale (color, leaf, staple, mic, strength…) and the loan value', '/reports/bale-quality'],
  cotton_sales_contracts: ['Cotton lint sales contracts: buyer, crop year, bales contracted, price in ¢/lb, pricing type (fixed / on-call / pool), delivery window', '/cotton/marketing'],
  cotton_pool_payments: ['Payments received from a marketing pool contract (the pool ledger)', '/cotton/marketing'],
  ccc_loans: ['CCC marketing-assistance loans on bales: loan rate, principal, status, repayment', '/cotton/marketing'],
  ccc_loan_bales: ['Which bales are in a CCC loan (and their equity sale, if any)', '/cotton/marketing'],
  cotton_ldp_records: ['Loan deficiency payments claimed (rate, lbs, amount)', '/cotton/marketing'],
  cotton_ldp_bales: ['Which bales an LDP was claimed on', '/cotton/marketing'],
  cotton_bale_dispositions: ['Where each bale went: sold on a contract / in a loan / in a pool / held (the disposition board)', '/cotton/marketing'],
  cotton_fees: ['Cotton fees accrued or paid (warehouse storage, checkoff, classing…)', '/cotton/marketing'],
  cotton_fee_schedule: ['Your fee rates (storage per bale-month, checkoff…)', '/cotton/marketing'],
}

export const REFERENCE_DOCS = {
  counties: 'US counties (id, name, state_code) — join for county names',
  covered_commodities: 'FSA covered commodities with reference prices (ARC/PLC)',
  commodity_specs: 'Futures contract specs per commodity (symbol root, contract size, tick)',
  market_prices: 'Cached end-of-day futures quotes per contract symbol × date (grains $/bu, cotton ¢/lb)',
  dryer_models: 'Manufacturer dryer models (capacity, fuel)',
  program_year_config: 'ARC/PLC program-year parameters (reference prices, payment limits)',
  rma_price_cache: 'RMA projected/harvest price discovery per crop × state × year',
  arc_plc_price_data: 'MYA / effective prices per commodity × program year',
  arc_benchmark_data: 'ARC-CO benchmark yields and revenues per county × commodity × year',
  mya_monthly_prices: 'USDA monthly prices received (for MYA estimates)',
  awp_weekly: 'Weekly cotton adjusted world price',
  fsa_benchmark_cache: 'Cached FSA ARC-CO benchmark workbook rows',
}

const UNITS = `UNIT CONVENTIONS (never mix):
- Grain: bushels (bu) and $/bu. loads.*_weight are POUNDS; dry bushels are DERIVED (shrink math) — use get_loads/get_yields for bushels.
- Cotton: pounds of lint (lbs) and prices STORED IN CENTS PER LB (72.65 = 72.65¢/lb = $0.7265/lb). Bales are counted (≈ 480–520 lbs each; use net_weight_lbs when present).
- Acres: decimal acres. Money: USD. Crop years are harvest years; season_year on plantings = crop year. Text matches are case-sensitive — use ilike for names.`

export function buildDigest({ tenantTables, tables }) {
  const missing = tenantTables.filter((t) => !tables.has(t) || tables.get(t).size === 0)
  if (missing.length > 0) throw new Error(`No columns parsed for tenant table(s): ${missing.join(', ')}`)
  const undocumented = tenantTables.filter((t) => !TABLE_DOCS[t])
  if (undocumented.length > 0) throw new Error(`TABLE_DOCS is missing: ${undocumented.join(', ')} — add a one-line description + help route`)
  const refMissing = REFERENCE_TABLES.filter((t) => !tables.has(t))
  if (refMissing.length > 0) throw new Error(`No columns parsed for reference table(s): ${refMissing.join(', ')}`)

  const colText = (t) => {
    const cols = [...tables.get(t).values()].filter((c) => !['id', 'org_id', 'created_at', 'updated_at'].includes(c.name))
    return cols.map((c) => {
      let s = c.name
      if (c.enum) s += ` ${c.enum.split(',').map((v) => `'${v}'`).join('|')}`
      else if (c.ref) s += `→${c.ref}`
      else if (/^(numeric|integer|int|bigint|smallint|real|double)/.test(c.type)) s += ''
      else if (/^(date|timestamptz|timestamp)/.test(c.type)) s += ''
      else if (/^bool/.test(c.type)) s += ' bool'
      else if (/^jsonb?/.test(c.type)) s += ' json'
      else if (/\[\]$/.test(c.type)) s += ' []'
      if (c.generated) s += ' GENERATED'
      return s
    }).join(', ')
  }
  const groups = new Map()
  for (const t of tenantTables) {
    const [desc, route] = TABLE_DOCS[t]
    const g = route
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push({ t, desc })
  }
  const lines = [
    `Your account's PostgreSQL tables (query with query_data; you only ever see this account's rows). Every table is listed — every module's data is reachable. Columns: id, org_id, created_at (and updated_at where present) exist on every tenant table and are omitted below.`,
    '',
  ]
  for (const [route, rows] of groups) {
    lines.push(`## Page: ${route}`)
    for (const { t, desc } of rows) lines.push(`- ${t}(${colText(t)})  -- ${desc}`)
    lines.push('')
  }
  lines.push('## Shared reference tables (not org-scoped; join for names/prices)')
  for (const t of REFERENCE_TABLES) lines.push(`- ${t}(${colText(t)})  -- ${REFERENCE_DOCS[t] ?? ''}`)
  lines.push('', UNITS)
  return { text: lines.join('\n'), tableMeta: tenantTables.map((t) => ({ name: t, kind: 'tenant', columns: [...tables.get(t).keys()], description: TABLE_DOCS[t][0], help_route: TABLE_DOCS[t][1] })).concat(REFERENCE_TABLES.map((t) => ({ name: t, kind: 'reference', columns: [...tables.get(t).keys()], description: REFERENCE_DOCS[t] ?? '', help_route: null }))) }
}

export function loadMigrationFiles(dir = sqlDir) {
  // schema.sql is the original base (001) — the numbered migrations build on it.
  const names = ['schema.sql', ...readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort()]
  return names.map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }))
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const files = loadMigrationFiles()
  const tenantTables = tenantTablesFrom054(files.find((f) => f.name.startsWith('054_')).text)
  const tables = parseMigrations(files)
  const { text, tableMeta } = buildDigest({ tenantTables, tables })
  const generated = new Date().toISOString().slice(0, 10)
  const out = `// GENERATED by scripts/build-assistant-schema.mjs — do not edit. Run: npm run schema:build
/* eslint-disable */
export type AssistantSchemaTable = { name: string; kind: 'tenant' | 'reference'; columns: string[]; description: string; help_route: string | null }
export const ASSISTANT_SCHEMA_GENERATED = ${JSON.stringify(generated)}
export const ASSISTANT_SCHEMA_TABLES: AssistantSchemaTable[] = ${JSON.stringify(tableMeta, null, 2)}
export const ASSISTANT_SCHEMA_SUMMARY: string = ${JSON.stringify(text)}
`
  writeFileSync(join(root, 'lib', 'assistant-schema.generated.ts'), out)
  console.log(`schema:build OK — ${tenantTables.length} tenant tables + ${REFERENCE_TABLES.length} reference tables, digest ${Math.round(text.length / 1024)} KB (${generated})`)
}
