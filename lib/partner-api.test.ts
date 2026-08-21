import { describe, expect, it } from 'vitest'
import {
  buildCropYearStatus,
  buildFieldRecords,
  buildHedgingRecords,
  buildPlantingRecords,
  buildProductionRecords,
  buildSettlementRecords,
  bearerTokenFrom,
  checkPartnerAuth,
  farmingEntitiesForFields,
  fieldEntityMap,
  type BaleDispositionRow,
  type BaleRow,
  type CccLoanRow,
  type CropRow,
  type EntityRow,
  type FarmRow,
  type FieldRow,
  type FuturesPositionRow,
  type GinReceiptRow,
  type LoadRow,
  type OptionsPositionRow,
  type PlantingRow,
  type SettlementLineRow,
  type SettlementRow,
  type SplitRow,
} from '@/lib/partner-api'

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('bearerTokenFrom', () => {
  // Feeds the 054 per-org token lookup (partner_api_tokens): the raw token
  // must extract exactly, or null so the request fails closed.
  it('extracts the raw token (case-insensitive scheme, trimmed)', () => {
    expect(bearerTokenFrom('Bearer tok_abc')).toBe('tok_abc')
    expect(bearerTokenFrom('bearer tok_abc')).toBe('tok_abc')
    expect(bearerTokenFrom('  Bearer   tok_abc  ')).toBe('tok_abc')
  })
  it('null on missing/malformed headers (fails closed)', () => {
    expect(bearerTokenFrom(null)).toBeNull()
    expect(bearerTokenFrom('')).toBeNull()
    expect(bearerTokenFrom('tok_abc')).toBeNull()
    expect(bearerTokenFrom('Basic tok_abc')).toBeNull()
  })
})

describe('checkPartnerAuth', () => {
  const TOKEN = 'tok_abc123'

  it('accepts the exact bearer token (case-insensitive scheme)', () => {
    expect(checkPartnerAuth(`Bearer ${TOKEN}`, TOKEN)).toBe('ok')
    expect(checkPartnerAuth(`bearer ${TOKEN}`, TOKEN)).toBe('ok')
    expect(checkPartnerAuth(`  Bearer ${TOKEN}  `, TOKEN)).toBe('ok')
  })

  it('rejects a missing/blank/malformed header', () => {
    expect(checkPartnerAuth(null, TOKEN)).toBe('unauthorized')
    expect(checkPartnerAuth(undefined, TOKEN)).toBe('unauthorized')
    expect(checkPartnerAuth('', TOKEN)).toBe('unauthorized')
    expect(checkPartnerAuth(TOKEN, TOKEN)).toBe('unauthorized') // no scheme
    expect(checkPartnerAuth(`Basic ${TOKEN}`, TOKEN)).toBe('unauthorized')
  })

  it('rejects a wrong token, including prefixes and superstrings', () => {
    expect(checkPartnerAuth('Bearer wrong', TOKEN)).toBe('unauthorized')
    expect(checkPartnerAuth(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe('unauthorized')
    expect(checkPartnerAuth(`Bearer ${TOKEN}x`, TOKEN)).toBe('unauthorized')
  })

  it('fails closed when the env token is unset or blank', () => {
    expect(checkPartnerAuth(`Bearer ${TOKEN}`, undefined)).toBe('unconfigured')
    expect(checkPartnerAuth(`Bearer ${TOKEN}`, '')).toBe('unconfigured')
    expect(checkPartnerAuth(`Bearer ${TOKEN}`, '  ')).toBe('unconfigured')
  })
})

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const entities: EntityRow[] = [{ id: 'e1', name: 'Prairie Farms LLC', updated_at: '2026-01-01T00:00:00Z' }]
const farms: FarmRow[] = [
  { id: 'fa1', name: 'Home Place', fsa_number: '1234', entity_id: 'e1', updated_at: '2026-01-02T00:00:00Z' },
]
const fields: FieldRow[] = [
  {
    id: 'f1', farm_id: 'fa1', name_or_number: 'North 80',
    total_acres: 80, irrigated_acres: 60, dryland_acres: 20,
    updated_at: '2026-01-03T00:00:00Z',
  },
  {
    id: 'f2', farm_id: 'fa1', name_or_number: 'Creek Field',
    total_acres: 120, irrigated_acres: 0, dryland_acres: 120,
    updated_at: '2026-01-01T00:00:00Z',
  },
]
const crops: CropRow[] = [
  { id: 'c-corn', name: 'Corn', base_moisture_pct: 15.5, base_lb_per_bushel: 56 },
  { id: 'c-cotton', name: 'Cotton', base_moisture_pct: null, base_lb_per_bushel: null },
]
const plantings: PlantingRow[] = [
  {
    id: 'p1', field_id: 'f1', crop_id: 'c-corn', season_year: 2026,
    planted_acres: 80, irrigated_acres: 60, dryland_acres: 20, updated_at: '2026-04-01T00:00:00Z',
  },
  {
    id: 'p2', field_id: 'f2', crop_id: 'c-cotton', season_year: 2026,
    planted_acres: 120, irrigated_acres: 0, dryland_acres: 120, updated_at: '2026-04-02T00:00:00Z',
  },
  {
    id: 'p3', field_id: 'f1', crop_id: 'c-corn', season_year: 2025,
    planted_acres: 75, irrigated_acres: 60, dryland_acres: 15, updated_at: '2025-04-01T00:00:00Z',
  },
]
// 56,000 lb at base moisture = exactly 1,000 dry bu of corn.
const loads: LoadRow[] = [
  {
    id: 'l1', date: '2026-09-15', net_weight: 56000, moisture: 15.5,
    crop_id: 'c-corn', crop_year: 2026, dry_bushels_override: null,
    from_type: 'field', from_field_id: 'f1', updated_at: '2026-09-15T18:00:00Z',
  },
  {
    id: 'l2', date: '2025-09-20', net_weight: 56000, moisture: 15.5,
    crop_id: 'c-corn', crop_year: 2025, dry_bushels_override: null,
    from_type: 'field', from_field_id: 'f1', updated_at: '2025-09-20T18:00:00Z',
  },
  { // bin-sourced — never production
    id: 'l3', date: '2026-10-01', net_weight: 56000, moisture: 15.5,
    crop_id: 'c-corn', crop_year: 2026, dry_bushels_override: null,
    from_type: 'bin', from_field_id: null, updated_at: '2026-10-01T18:00:00Z',
  },
]
const splits: SplitRow[] = []
const ginReceipts: GinReceiptRow[] = [
  { id: 'g1', field_id: 'f2', crop_year: 2026, total_bale_weight: 48000, updated_at: '2026-11-01T00:00:00Z' },
]

// ---------------------------------------------------------------------------
// /fields
// ---------------------------------------------------------------------------

describe('buildFieldRecords', () => {
  it('shapes id/name/aliases/farm code/entity/acres with updated_at', () => {
    const out = buildFieldRecords({ fields, farms, entities })
    expect(out).toHaveLength(2)
    const north = out.find((f) => f.name === 'North 80')!
    expect(north).toMatchObject({
      id: 'f1',
      name: 'North 80',
      aliases: [],
      farm_id: 'fa1',
      farm_name: 'Home Place',
      farm_code: '1234',
      entity: 'Prairie Farms LLC',
      acres: { total: 80, irrigated: 60, dryland: 20 },
    })
    // updated_at = newest of field/farm/entity.
    expect(north.updated_at).toBe('2026-01-03T00:00:00Z')
    const creek = out.find((f) => f.name === 'Creek Field')!
    expect(creek.updated_at).toBe('2026-01-02T00:00:00Z') // farm newer than field
    for (const r of out) expect(r).toHaveProperty('updated_at')
  })

  it('handles a field with no farm', () => {
    const orphan: FieldRow = {
      id: 'f9', farm_id: null, name_or_number: 'Orphan',
      total_acres: null, irrigated_acres: null, dryland_acres: null, updated_at: '2026-01-01T00:00:00Z',
    }
    const [r] = buildFieldRecords({ fields: [orphan], farms, entities })
    expect(r.farm_name).toBeNull()
    expect(r.farm_code).toBeNull()
    expect(r.entity).toBeNull()
    expect(r.entity_id).toBeNull()
    expect(r.acres.total).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Entity structure of a multi-entity share: every field carries the id of
// the FARMING entity that operates it; the handshake lists exactly those
// entities with their shared field counts; a marketing-agent entity (051)
// never appears even when a farm is mistakenly pointed at it.
// ---------------------------------------------------------------------------

describe('field → operating entity across a multi-entity share', () => {
  const multiEntities: EntityRow[] = [
    { id: 'e-north', name: 'North Farms LLC', entity_role: 'farming' },
    { id: 'e-south', name: 'South Farms LP', entity_role: 'farming' },
    { id: 'e-agent', name: 'Turnrow Marketing', entity_role: 'marketing_agent' },
    { id: 'e-idle', name: 'Idle Holdings', entity_role: 'farming' }, // no fields
  ]
  const multiFarms: FarmRow[] = [
    { id: 'fa-n', name: 'North Place', fsa_number: '1', entity_id: 'e-north' },
    { id: 'fa-s', name: 'South Place', fsa_number: '2', entity_id: 'e-south' },
    { id: 'fa-s2', name: 'South Annex', fsa_number: '3', entity_id: 'e-south' },
    { id: 'fa-ag', name: 'Paper Farm', fsa_number: '4', entity_id: 'e-agent' },
    { id: 'fa-none', name: 'Unassigned', fsa_number: '5', entity_id: null },
  ]
  const fieldOn = (id: string, farm_id: string | null): FieldRow => ({
    id, farm_id, name_or_number: id, total_acres: 10, irrigated_acres: 0, dryland_acres: 10,
  })
  const multiFields: FieldRow[] = [
    fieldOn('n1', 'fa-n'), fieldOn('n2', 'fa-n'),
    fieldOn('s1', 'fa-s'), fieldOn('s2', 'fa-s2'), fieldOn('s3', 'fa-s2'),
    fieldOn('ag1', 'fa-ag'),
    fieldOn('x1', 'fa-none'), fieldOn('x2', null),
  ]

  it('every /fields record carries its farm entity id + name (stable join key)', () => {
    const out = buildFieldRecords({ fields: multiFields, farms: multiFarms, entities: multiEntities })
    const byId = new Map(out.map((r) => [r.id, r]))
    expect(byId.get('n1')).toMatchObject({ entity_id: 'e-north', entity: 'North Farms LLC' })
    expect(byId.get('n2')).toMatchObject({ entity_id: 'e-north', entity: 'North Farms LLC' })
    expect(byId.get('s1')).toMatchObject({ entity_id: 'e-south', entity: 'South Farms LP' })
    expect(byId.get('s3')).toMatchObject({ entity_id: 'e-south', entity: 'South Farms LP' })
    expect(byId.get('x1')).toMatchObject({ entity_id: null, entity: null })
    expect(byId.get('x2')).toMatchObject({ entity_id: null, entity: null })
    // fieldEntityMap is the same field → entity resolution the yields/prices
    // payloads use, so every endpoint agrees with /fields.
    const map = fieldEntityMap({ fields: multiFields, farms: multiFarms })
    for (const r of out) expect(map.get(r.id) ?? null).toBe(r.entity_id)
  })

  it('the handshake lists only FARMING entities with shared fields, each with its shared count', () => {
    // A share covering two North fields, one South field, and the agent's field.
    const shared = new Set(['n1', 'n2', 's2', 'ag1', 'x1'])
    const out = farmingEntitiesForFields({ fieldIds: shared, fields: multiFields, farms: multiFarms, entities: multiEntities })
    expect(out).toEqual([
      { id: 'e-north', name: 'North Farms LLC', field_count: 2 },
      { id: 'e-south', name: 'South Farms LP', field_count: 1 },
    ])
    // South's other fields are outside the share → not counted; Idle has no
    // fields → absent; the agent never appears; no-entity fields count nowhere.
    expect(out.some((e) => e.id === 'e-agent')).toBe(false)
    expect(out.some((e) => e.id === 'e-idle')).toBe(false)
  })

  it('a full-org token (no field restriction) lists every farming entity that operates ground', () => {
    const out = farmingEntitiesForFields({ fieldIds: null, fields: multiFields, farms: multiFarms, entities: multiEntities })
    expect(out.map((e) => [e.id, e.field_count])).toEqual([
      ['e-north', 2],
      ['e-south', 3],
    ])
  })

  it('plantings and production rows carry the same entity_id as /fields', () => {
    const cropsLocal: CropRow[] = [{ id: 'c', name: 'Corn', base_moisture_pct: 15.5, base_lb_per_bushel: 56 }]
    const plantingsLocal: PlantingRow[] = [
      { id: 'p1', field_id: 'n1', crop_id: 'c', season_year: 2026, planted_acres: 10, irrigated_acres: 0, dryland_acres: 10 },
      { id: 'p2', field_id: 's1', crop_id: 'c', season_year: 2026, planted_acres: 10, irrigated_acres: 0, dryland_acres: 10 },
      { id: 'p3', field_id: 'x2', crop_id: 'c', season_year: 2026, planted_acres: 10, irrigated_acres: 0, dryland_acres: 10 },
    ]
    const pl = buildPlantingRecords({ plantings: plantingsLocal, fields: multiFields, farms: multiFarms, entities: multiEntities, crops: cropsLocal, year: 2026 })
    expect(pl.find((r) => r.field_id === 'n1')!.entity_id).toBe('e-north')
    expect(pl.find((r) => r.field_id === 's1')!.entity_id).toBe('e-south')
    expect(pl.find((r) => r.field_id === 'x2')!.entity_id).toBeNull()
    const pr = buildProductionRecords({
      plantings: plantingsLocal, loads: [], splits: [], ginReceipts: [],
      fields: multiFields, farms: multiFarms, entities: multiEntities, crops: cropsLocal, year: 2026,
    })
    expect(pr.find((r) => r.field_id === 'n1')!.entity_id).toBe('e-north')
    expect(pr.find((r) => r.field_id === 's1')!.entity_id).toBe('e-south')
  })
})

// ---------------------------------------------------------------------------
// /plantings
// ---------------------------------------------------------------------------

describe('buildPlantingRecords', () => {
  it('returns only the requested year with field/crop/entity names', () => {
    const out = buildPlantingRecords({ plantings, fields, farms, entities, crops, year: 2026 })
    expect(out).toHaveLength(2)
    expect(out.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    const corn = out.find((p) => p.crop === 'Corn')!
    expect(corn).toMatchObject({
      field_id: 'f1', field_name: 'North 80', crop: 'Corn', crop_year: 2026,
      planted_acres: 80, irrigated_acres: 60, dryland_acres: 20,
      entity: 'Prairie Farms LLC', updated_at: '2026-04-01T00:00:00Z',
    })
  })
})

// ---------------------------------------------------------------------------
// /production
// ---------------------------------------------------------------------------

describe('buildProductionRecords', () => {
  const args = { plantings, loads, splits, ginReceipts, fields, farms, entities, crops }

  it('computes grain dry bushels per field and cotton lint lbs, year-scoped', () => {
    const out = buildProductionRecords({ ...args, year: 2026 })
    expect(out).toHaveLength(2)
    const corn = out.find((r) => r.crop === 'Corn')!
    expect(corn).toMatchObject({
      field_id: 'f1', entity: 'Prairie Farms LLC', crop_year: 2026,
      planted_acres: 80, harvested_acres: 80, production_units: 1000, unit: 'bu',
    })
    // updated_at = newest of planting + contributing loads.
    expect(corn.updated_at).toBe('2026-09-15T18:00:00Z')
    const cotton = out.find((r) => r.crop === 'Cotton')!
    expect(cotton).toMatchObject({ field_id: 'f2', production_units: 48000, unit: 'lbs' })
  })

  it('excludes bin-sourced loads and other years', () => {
    const out2025 = buildProductionRecords({ ...args, year: 2025 })
    expect(out2025).toHaveLength(1)
    expect(out2025[0]).toMatchObject({ crop: 'Corn', crop_year: 2025, production_units: 1000 })
  })

  it('reports unharvested plantings with harvested_acres 0', () => {
    const out = buildProductionRecords({ ...args, loads: [], ginReceipts: [], year: 2026 })
    const corn = out.find((r) => r.crop === 'Corn')!
    expect(corn.production_units).toBe(0)
    expect(corn.harvested_acres).toBe(0)
    expect(corn.planted_acres).toBe(80)
  })

  it('applies the ?crop= filter case-insensitively', () => {
    const out = buildProductionRecords({ ...args, year: 2026, crop: 'corn' })
    expect(out).toHaveLength(1)
    expect(out[0].crop).toBe('Corn')
  })

  it('honors dry_bushels_override and splits', () => {
    const overrideLoad: LoadRow = {
      ...loads[0], id: 'l4', dry_bushels_override: 900, updated_at: '2026-09-16T00:00:00Z',
    }
    const splitParent: LoadRow = {
      id: 'l5', date: '2026-09-17', net_weight: null, moisture: null,
      crop_id: null, crop_year: 2026, dry_bushels_override: null,
      from_type: null, from_field_id: null, updated_at: '2026-09-17T00:00:00Z',
    }
    const split: SplitRow = { load_id: 'l5', field_id: 'f1', crop_id: 'c-corn', dry_bushels: 50 }
    const out = buildProductionRecords({
      ...args, loads: [overrideLoad, splitParent], splits: [split], year: 2026,
    })
    const corn = out.find((r) => r.crop === 'Corn')!
    expect(corn.production_units).toBe(950)
  })
})

// ---------------------------------------------------------------------------
// /settlements
// ---------------------------------------------------------------------------

describe('buildSettlementRecords', () => {
  const buyers = [{ id: 'b1', name: 'River Elevator' }]
  const settlements: SettlementRow[] = [
    { id: 's1', buyer_id: 'b1', settlement_date: '2026-10-05', settlement_number: 'ST-100', updated_at: '2026-10-06T00:00:00Z' },
    { id: 's2', buyer_id: 'b1', settlement_date: '2026-11-01', settlement_number: 'ST-101', updated_at: '2026-11-02T00:00:00Z' },
  ]
  const lines: SettlementLineRow[] = [
    { id: 'sl1', settlement_id: 's1', load_id: 'l1', net_bushels: 980.5, net_revenue: 4310.2, updated_at: '2026-10-06T00:00:00Z' },
    { id: 'sl2', settlement_id: 's1', load_id: null, net_bushels: 100, net_revenue: 450, updated_at: '2026-10-06T00:00:00Z' },
    { id: 'sl3', settlement_id: 's2', load_id: 'l1', net_bushels: 500, net_revenue: 2200, updated_at: '2026-11-02T00:00:00Z' },
  ]
  const lineLoads = [{ id: 'l1', crop_id: 'c-corn' }]

  it('emits one record per settlement × crop with buyer/units/revenue', () => {
    const out = buildSettlementRecords({ settlements, lines, loads: lineLoads, crops, buyers })
    expect(out).toHaveLength(3) // s1 splits into Corn + unmatched, s2 is Corn only
    const s1corn = out.find((r) => r.settlement_id === 's1' && r.crop === 'Corn')!
    expect(s1corn).toMatchObject({
      settlement_date: '2026-10-05', settlement_number: 'ST-100',
      buyer: 'River Elevator', net_units: 980.5, unit: 'bu', net_revenue: 4310.2,
    })
    const s1un = out.find((r) => r.settlement_id === 's1' && r.crop === null)!
    expect(s1un.net_units).toBe(100)
    for (const r of out) expect(r.updated_at).toBeTruthy()
  })

  it('filters on updated_at with ?since= (delta-sync)', () => {
    const out = buildSettlementRecords({
      settlements, lines, loads: lineLoads, crops, buyers, since: '2026-10-15',
    })
    expect(out).toHaveLength(1)
    expect(out[0].settlement_id).toBe('s2')
  })
})

// ---------------------------------------------------------------------------
// /hedging — realized only
// ---------------------------------------------------------------------------

describe('buildHedgingRecords', () => {
  const futures: FuturesPositionRow[] = [
    {
      id: 'fp1', commodity: 'Corn', contract_symbol: 'ZCZ26', crop_year: 2026,
      side: 'short', num_contracts: 2, status: 'closed', close_date: '2026-06-10',
      realized_pnl: 2450.5, updated_at: '2026-06-10T20:00:00Z',
    },
    { // OPEN — must never appear
      id: 'fp2', commodity: 'Corn', contract_symbol: 'ZCZ26', crop_year: 2026,
      side: 'short', num_contracts: 1, status: 'open', close_date: null,
      realized_pnl: null, updated_at: '2026-06-01T00:00:00Z',
    },
    {
      id: 'fp3', commodity: 'Cotton', contract_symbol: 'CTZ26', crop_year: 2026,
      side: 'short', num_contracts: 1, status: 'closed', close_date: '2026-07-01',
      realized_pnl: -500, updated_at: '2026-07-01T00:00:00Z',
    },
  ]
  const options: OptionsPositionRow[] = [
    {
      id: 'op1', commodity: 'Corn', underlying_symbol: 'ZCZ26', option_type: 'put',
      strike_price: 4.8, crop_year: 2026, num_contracts: 1, status: 'closed_offset',
      close_date: '2026-05-01', realized_pnl: 300, updated_at: '2026-05-01T00:00:00Z',
    },
    { // exercised with pnl booked on the futures leg — skipped, not $0
      id: 'op2', commodity: 'Corn', underlying_symbol: 'ZCZ26', option_type: 'put',
      strike_price: 4.6, crop_year: 2026, num_contracts: 1, status: 'exercised',
      close_date: '2026-05-15', realized_pnl: null, updated_at: '2026-05-15T00:00:00Z',
    },
    { // OPEN — must never appear
      id: 'op3', commodity: 'Corn', underlying_symbol: 'ZCH27', option_type: 'call',
      strike_price: 5, crop_year: 2027, num_contracts: 1, status: 'open',
      close_date: null, realized_pnl: null, updated_at: '2026-06-01T00:00:00Z',
    },
  ]

  it('returns only closed transactions with realized P&L and units in the commodity unit', () => {
    const { transactions, totals } = buildHedgingRecords({ futures, options })
    expect(transactions.map((t) => t.id).sort()).toEqual(['fp1', 'fp3', 'op1'])
    const fut = transactions.find((t) => t.id === 'fp1')!
    expect(fut).toMatchObject({
      type: 'futures', contract: 'ZCZ26', crop: 'Corn', crop_year: 2026,
      close_date: '2026-06-10', units: 10000, unit: 'bu', realized_gain_loss: 2450.5,
    })
    const ct = transactions.find((t) => t.id === 'fp3')!
    expect(ct).toMatchObject({ units: 50000, unit: 'lbs', crop: 'Cotton' })
    const opt = transactions.find((t) => t.id === 'op1')!
    expect(opt.contract).toBe('ZCZ26 4.8 put')
    // Net totals per crop × crop year.
    expect(totals).toEqual([
      { crop: 'Corn', crop_year: 2026, net_realized: 2750.5, transaction_count: 2 },
      { crop: 'Cotton', crop_year: 2026, net_realized: -500, transaction_count: 1 },
    ])
    for (const t of transactions) expect(t).toHaveProperty('updated_at')
  })

  it('never leaks open positions regardless of filters', () => {
    const { transactions } = buildHedgingRecords({ futures, options, year: 2027 })
    expect(transactions).toHaveLength(0) // op3 is 2027 but open
  })

  it('filters by year and crop', () => {
    const { transactions } = buildHedgingRecords({ futures, options, year: 2026, crop: 'cotton' })
    expect(transactions.map((t) => t.id)).toEqual(['fp3'])
  })
})

// ---------------------------------------------------------------------------
// /crop-year-status
// ---------------------------------------------------------------------------

describe('buildCropYearStatus', () => {
  const lines: SettlementLineRow[] = [
    { id: 'sl1', settlement_id: 's1', load_id: 'l1', net_bushels: 960, net_revenue: 4200, updated_at: '2026-10-06T00:00:00Z' },
  ]
  const settlementLoads = [{ id: 'l1', crop_id: 'c-corn', crop_year: 2026 }]
  const bales: BaleRow[] = [
    { id: 'ba1', gin_receipt_id: 'g1', crop_year: 2026, net_weight_lbs: 30000, updated_at: '2026-11-05T00:00:00Z' },
    { id: 'ba2', gin_receipt_id: 'g1', crop_year: 2026, net_weight_lbs: 18000, updated_at: '2026-11-05T00:00:00Z' },
  ]
  const dispositions: BaleDispositionRow[] = [
    { bale_id: 'ba1', disposition: 'sold_spot', loan_id: null },
    { bale_id: 'ba2', disposition: 'ccc_loan', loan_id: 'loan1' },
  ]
  const loans: CccLoanRow[] = [{ id: 'loan1', status: 'open' }]

  const base = {
    plantings, loads, splits, crops, lines, settlementLoads,
    ginReceipts, bales, baleDispositions: dispositions, cccLoans: loans,
    salesStatus: [], year: 2026,
  }

  it('computes production vs settled with the unsold balance per crop', () => {
    const out = buildCropYearStatus(base)
    const corn = out.find((r) => r.crop === 'Corn')!
    expect(corn).toMatchObject({
      unit: 'bu', production_units: 1000, settled_units: 960, unsold_units: 40,
      computed_all_sold: false, manually_marked_complete: false, all_physical_sold: false,
    })
    expect(corn.updated_at).toBeTruthy()
    // Cotton: bales in loan are NOT sold; spot-sold bale is.
    const cotton = out.find((r) => r.crop === 'Cotton')!
    expect(cotton).toMatchObject({
      unit: 'lbs', production_units: 48000, settled_units: 30000, unsold_units: 18000,
      computed_all_sold: false,
    })
  })

  it('counts equity-sold loan bales as sold', () => {
    const out = buildCropYearStatus({ ...base, cccLoans: [{ id: 'loan1', status: 'equity_sold' }] })
    const cotton = out.find((r) => r.crop === 'Cotton')!
    expect(cotton.settled_units).toBe(48000)
    expect(cotton.computed_all_sold).toBe(true)
    expect(cotton.all_physical_sold).toBe(true)
  })

  it('computed check flips when settled covers production', () => {
    const fullLines: SettlementLineRow[] = [
      { id: 'sl1', settlement_id: 's1', load_id: 'l1', net_bushels: 1000, net_revenue: 4400, updated_at: '2026-10-06T00:00:00Z' },
    ]
    const out = buildCropYearStatus({ ...base, lines: fullLines })
    const corn = out.find((r) => r.crop === 'Corn')!
    expect(corn.computed_all_sold).toBe(true)
  })

  it('returns both the computed check and the manual flag, ORed into all_physical_sold', () => {
    const out = buildCropYearStatus({
      ...base,
      salesStatus: [
        { crop_id: 'c-corn', crop_year: 2026, physical_sales_complete: true, updated_at: '2026-12-01T00:00:00Z' },
      ],
    })
    const corn = out.find((r) => r.crop === 'Corn')!
    expect(corn.computed_all_sold).toBe(false) // 40 bu shrink residual remains
    expect(corn.manually_marked_complete).toBe(true)
    expect(corn.all_physical_sold).toBe(true)
    expect(corn.updated_at).toBe('2026-12-01T00:00:00Z') // manual flag is newest
    // The flag is year-scoped: a 2025 flag must not leak in.
    const out2 = buildCropYearStatus({
      ...base,
      salesStatus: [
        { crop_id: 'c-corn', crop_year: 2025, physical_sales_complete: true, updated_at: '2025-12-01T00:00:00Z' },
      ],
    })
    expect(out2.find((r) => r.crop === 'Corn')!.manually_marked_complete).toBe(false)
  })
})
