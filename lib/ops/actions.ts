// The ops actions (2026-11-09): fixes a person approves in Turnrow Farm's
// Assignments, applied here (turnrow-farm docs/OPS_ACTIONS.md). Each action
// previews (reads only: a before-and-after table and a fingerprint over the
// normalized params and the before-state) and applies (previews again,
// refuses as stale when the fingerprint moved, else writes the same columns
// Grain's own pages write, with the same rules, then logs to ops_action_log).
//
// Grain's pages write contracts and plantings straight from the browser
// (app/contracts/[id]/contract-actions.tsx, components/contract-form.tsx,
// app/settings/plantings/page.tsx); these actions write the same columns
// through the service role, scoped .eq('org_id', orgId), and keep those
// pages' rules: the contract form's (bushels above zero, a seed contract is
// never edited by the grain editor), the plantings form's (irrigated within
// planted, varieties within planted) and the Farm link's lock (a planting
// Turnrow Farm manages is read only here, lib/farm-link landRowEditable).
// Nothing is sent anywhere and nothing with money on it is deleted.

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { loadDryBushels } from '@/lib/contract-progress'
import { deliveredBushelsByContract, fetchLoadSales } from '@/lib/load-sales'
import { landManagedByFarm, landRowEditable, LAND_MANAGED_MESSAGE, type FarmLinkRow } from '@/lib/farm-link'
import { APP, url } from './context'
import { fmtBu, loadCrops } from './grain'

export type ParamSpec = { name: string; type: 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'array' | 'object'; required: boolean; description: string; enum?: string[] }
export type ActionSpec = { name: string; description: string; params: ParamSpec[] }
export type Preview = {
  app: string; action: string; params: Record<string, unknown>
  headline: string; columns: string[]; rows: Array<Array<string | number | null>>; notes: string[]
  changes: number; fingerprint: string; url: string
}

/** 400: unknown action or bad params. 422: Grain's rules refuse it. */
export class ActionError extends Error {
  constructor(message: string, public status: 400 | 422 = 400) { super(message) }
}

type Planned = { preview: Preview; apply: () => Promise<Record<string, unknown>> }
type Def = ActionSpec & { plan: (sb: SupabaseClient, orgId: string, params: Record<string, unknown>, now: Date) => Promise<Planned> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const r2 = (n: number) => Math.round(n * 100) / 100
const n0 = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v))
export const fingerprintOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32)

function str(p: Record<string, unknown>, k: string, required = true): string | null {
  const v = p[k]
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw new ActionError(`${k} is needed.`)
    return null
  }
  return String(v).trim()
}
function numberParam(p: Record<string, unknown>, k: string, required = true): number | null {
  const v = p[k]
  if (v === undefined || v === null || v === '') {
    if (required) throw new ActionError(`${k} is needed.`)
    return null
  }
  const n = Number(v)
  if (!Number.isFinite(n)) throw new ActionError(`${k} must be a number.`)
  return n
}
function dateParam(p: Record<string, unknown>, k: string, required = true): string | null {
  const v = str(p, k, required)
  if (v === null) return null
  if (!DATE.test(v) || Number.isNaN(Date.parse(v))) throw new ActionError(`${k} must be a date (YYYY-MM-DD).`)
  return v
}

// ---- contracts -------------------------------------------------------------

type ContractRow = {
  id: string; contract_number: string | null; buyer_id: string | null; crop_id: string | null; crop_year: number | null
  contracted_bushels: number | null; delivery_start_date: string | null; delivery_end_date: string | null
  completed_at: string | null; contract_kind: string | null
}
const CONTRACT_COLS = 'id, contract_number, buyer_id, crop_id, crop_year, contracted_bushels, delivery_start_date, delivery_end_date, completed_at, contract_kind'

/** One contract by its id, or by its number (and crop year when the number repeats). */
async function findContract(sb: SupabaseClient, orgId: string, p: Record<string, unknown>): Promise<ContractRow> {
  const ref = str(p, 'contract')!
  const year = numberParam(p, 'crop_year', false)
  let rows: ContractRow[]
  if (UUID.test(ref)) {
    const { data, error } = await sb.from('contracts').select(CONTRACT_COLS).eq('org_id', orgId).eq('id', ref).limit(1)
    if (error) throw new Error(`contracts: ${error.message}`)
    rows = (data ?? []) as ContractRow[]
  } else {
    let q = sb.from('contracts').select(CONTRACT_COLS).eq('org_id', orgId).eq('contract_number', ref)
    if (year !== null) q = q.eq('crop_year', year)
    const { data, error } = await q.limit(20)
    if (error) throw new Error(`contracts: ${error.message}`)
    rows = (data ?? []) as ContractRow[]
  }
  if (!rows.length) throw new ActionError(`No contract ${ref}${year !== null ? ` for ${year}` : ''}.`)
  if (rows.length > 1) throw new ActionError(`More than one contract is numbered ${ref} (crop years ${rows.map((r) => r.crop_year).join(', ')}); name the crop_year or send its id.`)
  return { ...rows[0], contracted_bushels: rows[0].contracted_bushels === null ? null : Number(rows[0].contracted_bushels) }
}

/** Delivered dry bushels on one contract: the same rule the contract page uses
 *  (lib/load-sales deliveredBushelsByContract over the 094 sale rows, with the
 *  pre-094 loads.contract_id fallback). */
async function deliveredOn(sb: SupabaseClient, orgId: string, contractId: string): Promise<number> {
  const viaSales = await fetchAllRows<{ load_id: string }>((f, t) => sb.from('load_sales').select('id, load_id').eq('org_id', orgId).eq('contract_id', contractId).order('id').range(f, t))
  if (viaSales.error) throw new Error(`load_sales: ${viaSales.error.message}`)
  const direct = await fetchAllRows<{ id: string }>((f, t) => sb.from('loads').select('id').eq('org_id', orgId).eq('contract_id', contractId).order('id').range(f, t))
  if (direct.error) throw new Error(`loads: ${direct.error.message}`)
  const ids = [...new Set([...viaSales.data.map((r) => r.load_id), ...direct.data.map((r) => r.id)])].filter(Boolean)
  if (!ids.length) return 0
  const crops = await loadCrops(sb, orgId)
  type L = { id: string; crop_id: string | null; net_weight: number | null; moisture: number | null; dry_bushels_override: number | null; contract_id: string | null; to_type: 'bin' | 'buyer' | null }
  const loads: L[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from('loads').select('id, crop_id, net_weight, moisture, dry_bushels_override, contract_id, to_type').eq('org_id', orgId).in('id', ids.slice(i, i + 200))
    if (error) throw new Error(`loads: ${error.message}`)
    loads.push(...((data ?? []) as L[]))
  }
  const withBu = loads.map((l) => ({ ...l, dryBu: loadDryBushels({ ...l, net_weight: l.net_weight === null ? null : Number(l.net_weight), moisture: l.moisture === null ? null : Number(l.moisture), dry_bushels_override: l.dry_bushels_override === null ? null : Number(l.dry_bushels_override) }, crops) ?? 0 }))
  const sales = await fetchLoadSales(sb, { orgId, loadIds: ids })
  return deliveredBushelsByContract(withBu, sales).get(contractId)?.dryBu ?? 0
}

async function contractLabel(sb: SupabaseClient, orgId: string, c: ContractRow): Promise<string> {
  const [buyer, crop] = await Promise.all([
    c.buyer_id ? sb.from('buyers').select('name').eq('org_id', orgId).eq('id', c.buyer_id).maybeSingle() : Promise.resolve({ data: null }),
    c.crop_id ? sb.from('crops').select('name').eq('org_id', orgId).eq('id', c.crop_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const b = (buyer.data as { name?: string } | null)?.name ?? 'a buyer'
  const cr = (crop.data as { name?: string } | null)?.name ?? 'crop'
  return `Contract ${c.contract_number ?? ''} with ${b} (${c.crop_year ?? ''} ${cr})`.replace(/\s+/g, ' ')
}

function refuseSeed(c: ContractRow) {
  if (c.contract_kind === 'seed') throw new ActionError('That is a seed contract; its terms are edited on its own seed page, not the grain contract editor.', 422)
}

const contractBefore = (c: ContractRow) => ({ id: c.id, contracted_bushels: c.contracted_bushels, delivery_start_date: c.delivery_start_date, delivery_end_date: c.delivery_end_date, completed: !!c.completed_at })

const completeContract: Def = {
  name: 'complete_contract',
  description: 'Mark a grain contract complete (closed out, so its delivery and pricing reminders stop and it no longer projects revenue), or reopen it, as the contract page\'s Complete contract / Reopen button does.',
  params: [
    { name: 'contract', type: 'string', required: true, description: 'The contract\'s id or its contract number' },
    { name: 'crop_year', type: 'integer', required: false, description: 'The crop year, when the contract number repeats across years' },
    { name: 'completed', type: 'boolean', required: false, description: 'true (default) marks it complete; false reopens it' },
  ],
  async plan(sb, orgId, p, now) {
    const c = await findContract(sb, orgId, p)
    const completed = p.completed === undefined || p.completed === null ? true : p.completed === true || p.completed === 'true'
    const [label, delivered] = await Promise.all([contractLabel(sb, orgId, c), deliveredOn(sb, orgId, c.id)])
    const left = r2((c.contracted_bushels ?? 0) - delivered)
    const was = !!c.completed_at
    const changes = was === completed ? 0 : 1
    const params = { contract: c.id, crop_year: c.crop_year, completed }
    const notes = [`Delivered ${fmtBu(delivered)} of ${fmtBu(c.contracted_bushels ?? 0)}.`]
    if (completed && left > 1) notes.push(`${fmtBu(left)} are not delivered; marking it complete stops the reminders and stops it projecting revenue for them.`)
    return {
      preview: {
        app: APP.app, action: 'complete_contract', params,
        headline: changes ? `${label}: ${completed ? 'would be marked complete' : 'would be reopened'}${completed && left > 1 ? ` with ${fmtBu(left)} undelivered` : ''}.` : `${label} is already ${completed ? 'complete' : 'open'}.`,
        columns: ['What', 'Before', 'After'],
        rows: [[label, was ? 'complete' : 'open', completed ? 'complete' : 'open'], ['Contracted bushels', c.contracted_bushels, c.contracted_bushels], ['Delivered bushels', r2(delivered), r2(delivered)]],
        notes, changes, fingerprint: fingerprintOf({ action: 'complete_contract', params, before: contractBefore(c) }), url: url(`/contracts/${c.id}`),
      },
      async apply() {
        if (!changes) return { contract_id: c.id, completed, unchanged: true }
        const completed_at = completed ? now.toISOString() : null
        const { error } = await sb.from('contracts').update({ completed_at }).eq('org_id', orgId).eq('id', c.id)
        if (error) throw new Error(error.message)
        return { contract_id: c.id, completed_at }
      },
    }
  },
}

const setContractWindow: Def = {
  name: 'set_contract_window',
  description: 'Change a grain contract\'s delivery window (the start and end dates the contract form holds), for example to extend a window the buyer agreed to extend.',
  params: [
    { name: 'contract', type: 'string', required: true, description: 'The contract\'s id or its contract number' },
    { name: 'crop_year', type: 'integer', required: false, description: 'The crop year, when the contract number repeats across years' },
    { name: 'delivery_end_date', type: 'date', required: true, description: 'The new last day of delivery (YYYY-MM-DD)' },
    { name: 'delivery_start_date', type: 'date', required: false, description: 'The new first day of delivery; left as it is when not given' },
  ],
  async plan(sb, orgId, p) {
    const c = await findContract(sb, orgId, p)
    refuseSeed(c)
    const end = dateParam(p, 'delivery_end_date')!
    const start = p.delivery_start_date === undefined ? c.delivery_start_date : dateParam(p, 'delivery_start_date', false)
    if (start && end < start) throw new ActionError(`The window would end (${end}) before it starts (${start}).`, 422)
    const label = await contractLabel(sb, orgId, c)
    const changes = (start !== c.delivery_start_date ? 1 : 0) + (end !== c.delivery_end_date ? 1 : 0)
    const params = { contract: c.id, crop_year: c.crop_year, delivery_start_date: start, delivery_end_date: end }
    return {
      preview: {
        app: APP.app, action: 'set_contract_window', params,
        headline: changes ? `${label}: the delivery window would run ${start ?? '(no start)'} to ${end} (was ${c.delivery_start_date ?? '(no start)'} to ${c.delivery_end_date ?? '(no end)'}).` : `${label} already runs ${start ?? '(no start)'} to ${end}.`,
        columns: ['What', 'Before', 'After'],
        rows: [['Delivery starts', c.delivery_start_date, start], ['Delivery ends', c.delivery_end_date, end]],
        notes: c.completed_at ? ['The contract is marked complete; the dates change but it stays complete.'] : [],
        changes, fingerprint: fingerprintOf({ action: 'set_contract_window', params, before: contractBefore(c) }), url: url(`/contracts/${c.id}`),
      },
      async apply() {
        if (!changes) return { contract_id: c.id, unchanged: true }
        const { error } = await sb.from('contracts').update({ delivery_start_date: start, delivery_end_date: end }).eq('org_id', orgId).eq('id', c.id)
        if (error) throw new Error(error.message)
        return { contract_id: c.id, delivery_start_date: start, delivery_end_date: end }
      },
    }
  },
}

const setContractedBushels: Def = {
  name: 'set_contracted_bushels',
  description: 'Change a grain contract\'s contracted bushels, for example to short-fill a contract at what was delivered when the buyer agreed. Never below what is already delivered.',
  params: [
    { name: 'contract', type: 'string', required: true, description: 'The contract\'s id or its contract number' },
    { name: 'crop_year', type: 'integer', required: false, description: 'The crop year, when the contract number repeats across years' },
    { name: 'contracted_bushels', type: 'number', required: true, description: 'The new contracted bushels (above zero)' },
  ],
  async plan(sb, orgId, p) {
    const c = await findContract(sb, orgId, p)
    refuseSeed(c)
    const bu = numberParam(p, 'contracted_bushels')!
    if (bu <= 0) throw new ActionError('Contracted bushels must be above zero (the contract form\'s rule).', 422)
    const [label, delivered] = await Promise.all([contractLabel(sb, orgId, c), deliveredOn(sb, orgId, c.id)])
    if (bu < Math.floor(delivered)) throw new ActionError(`${fmtBu(delivered)} are already delivered on it; contracted bushels cannot go below that.`, 422)
    const changes = bu === c.contracted_bushels ? 0 : 1
    const params = { contract: c.id, crop_year: c.crop_year, contracted_bushels: bu }
    const notes = [`Delivered ${fmtBu(delivered)}.`]
    if (Math.abs(bu - delivered) <= 1) notes.push('That equals what was delivered, so the contract reads as fully delivered (complete).')
    return {
      preview: {
        app: APP.app, action: 'set_contracted_bushels', params,
        headline: changes ? `${label}: contracted bushels would go from ${fmtBu(c.contracted_bushels ?? 0)} to ${fmtBu(bu)}; ${fmtBu(Math.max(0, bu - delivered))} left to deliver.` : `${label} is already for ${fmtBu(bu)}.`,
        columns: ['What', 'Before', 'After'],
        rows: [['Contracted bushels', c.contracted_bushels, bu], ['Delivered bushels', r2(delivered), r2(delivered)], ['Left to deliver', r2(Math.max(0, (c.contracted_bushels ?? 0) - delivered)), r2(Math.max(0, bu - delivered))]],
        notes, changes, fingerprint: fingerprintOf({ action: 'set_contracted_bushels', params, before: { ...contractBefore(c), delivered: Math.round(delivered) } }), url: url(`/contracts/${c.id}`),
      },
      async apply() {
        if (!changes) return { contract_id: c.id, unchanged: true }
        const { error } = await sb.from('contracts').update({ contracted_bushels: bu }).eq('org_id', orgId).eq('id', c.id)
        if (error) throw new Error(error.message)
        return { contract_id: c.id, contracted_bushels: bu }
      },
    }
  },
}

// ---- plantings -------------------------------------------------------------

type PlantingRow = { id: string; field_id: string; crop_id: string; season_year: number; planted_acres: number | null; irrigated_acres: number | null; dryland_acres: number | null; managed_by: string | null }

async function findByName(sb: SupabaseClient, orgId: string, table: 'fields' | 'crops' | 'farms', ref: string, extra?: { column: string; value: string }): Promise<Array<{ id: string; name: string }>> {
  if (UUID.test(ref)) {
    const { data, error } = await sb.from(table).select('id, name').eq('org_id', orgId).eq('id', ref).limit(1)
    if (error) throw new Error(`${table}: ${error.message}`)
    return (data ?? []) as Array<{ id: string; name: string }>
  }
  let q = sb.from(table).select('id, name').eq('org_id', orgId).ilike('name', ref.replace(/[%_]/g, ''))
  if (extra) q = q.eq(extra.column, extra.value)
  const { data, error } = await q.limit(20)
  if (error) throw new Error(`${table}: ${error.message}`)
  return (data ?? []) as Array<{ id: string; name: string }>
}

const setPlantingAcres: Def = {
  name: 'set_planting_acres',
  description: 'Correct a field\'s planted and irrigated acres for one crop and season, as the Plantings page does (dryland is planted less irrigated). Refused for a planting Turnrow Farm manages: those change in Farm and sync here.',
  params: [
    { name: 'field', type: 'string', required: true, description: 'The field\'s id or exact name' },
    { name: 'farm', type: 'string', required: false, description: 'The farm\'s name, when the field name repeats across farms' },
    { name: 'crop', type: 'string', required: true, description: 'The crop\'s id or name (e.g. Corn)' },
    { name: 'season_year', type: 'integer', required: true, description: 'The season (crop year)' },
    { name: 'planted_acres', type: 'number', required: false, description: 'Planted acres; left as it is when not given' },
    { name: 'irrigated_acres', type: 'number', required: false, description: 'Irrigated acres (within planted); left as it is when not given' },
  ],
  async plan(sb, orgId, p) {
    const year = numberParam(p, 'season_year')!
    if (!Number.isInteger(year)) throw new ActionError('season_year must be a whole year.')
    const fieldRef = str(p, 'field')!
    const farmRef = str(p, 'farm', false)
    let farmId: string | undefined
    if (farmRef) {
      const farms = await findByName(sb, orgId, 'farms', farmRef)
      if (farms.length !== 1) throw new ActionError(farms.length ? `More than one farm is named ${farmRef}.` : `No farm ${farmRef}.`)
      farmId = farms[0].id
    }
    const fields = await findByName(sb, orgId, 'fields', fieldRef, farmId ? { column: 'farm_id', value: farmId } : undefined)
    if (!fields.length) throw new ActionError(`No field ${fieldRef}${farmRef ? ` on ${farmRef}` : ''}.`)
    if (fields.length > 1) throw new ActionError(`More than one field is named ${fieldRef}; name the farm or send the field's id.`)
    const crops = await findByName(sb, orgId, 'crops', str(p, 'crop')!)
    if (crops.length !== 1) throw new ActionError(crops.length ? `More than one crop matches ${String(p.crop)}.` : `No crop ${String(p.crop)}.`)
    const field = fields[0], crop = crops[0]
    const { data, error } = await sb.from('field_plantings').select('id, field_id, crop_id, season_year, planted_acres, irrigated_acres, dryland_acres, managed_by').eq('org_id', orgId).eq('field_id', field.id).eq('crop_id', crop.id).eq('season_year', year).limit(5)
    if (error) throw new Error(`field_plantings: ${error.message}`)
    const found = (data ?? []) as PlantingRow[]
    if (!found.length) throw new ActionError(`No ${year} ${crop.name} planting on ${field.name}.`)
    if (found.length > 1) throw new ActionError(`${field.name} has more than one ${year} ${crop.name} planting; correct it on the Plantings page.`, 422)
    const pl = { ...found[0], planted_acres: n0(found[0].planted_acres), irrigated_acres: n0(found[0].irrigated_acres) }

    // The Farm link's lock: a planting Turnrow Farm manages is read only here.
    const { data: link } = await sb.from('farm_links').select('status, scopes, last_sync').eq('org_id', orgId).neq('status', 'revoked').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!landRowEditable({ managed_by: pl.managed_by === 'turnrow_farm' ? 'turnrow_farm' : undefined }, landManagedByFarm(link as Pick<FarmLinkRow, 'status' | 'scopes' | 'last_sync'> | null))) {
      throw new ActionError(`${LAND_MANAGED_MESSAGE} Change ${field.name}'s ${year} ${crop.name} acres in Turnrow Farm and it syncs here.`, 422)
    }

    const planted = p.planted_acres === undefined ? pl.planted_acres : numberParam(p, 'planted_acres')!
    const irrigated = p.irrigated_acres === undefined ? pl.irrigated_acres : numberParam(p, 'irrigated_acres')!
    if (planted < 0) throw new ActionError('Planted acres cannot be negative.', 422)
    if (irrigated < 0) throw new ActionError('Irrigated acres cannot be negative.', 422)
    if (irrigated > planted) throw new ActionError(`Irrigated acres (${irrigated}) cannot exceed planted acres (${planted}).`, 422)
    const { data: vs, error: ve } = await sb.from('field_planting_varieties').select('acres').eq('planting_id', pl.id).limit(200)
    if (ve) throw new Error(`field_planting_varieties: ${ve.message}`)
    const varietyAcres = ((vs ?? []) as Array<{ acres: number | null }>).reduce((s, v) => s + n0(v.acres), 0)
    if (planted > 0 && varietyAcres > planted + 0.01) throw new ActionError(`Its varieties add up to ${r2(varietyAcres)} acres, more than ${planted} planted; fix the varieties on the Plantings page first.`, 422)
    const dryland = Math.max(0, r2(planted - irrigated))
    const changes = (planted !== pl.planted_acres ? 1 : 0) + (irrigated !== pl.irrigated_acres ? 1 : 0)
    const params = { field: field.id, crop: crop.id, season_year: year, planted_acres: planted, irrigated_acres: irrigated }
    const label = `${field.name} ${year} ${crop.name}`
    return {
      preview: {
        app: APP.app, action: 'set_planting_acres', params,
        headline: changes ? `${label}: ${planted} planted (${irrigated} irrigated, ${dryland} dryland), was ${pl.planted_acres} (${pl.irrigated_acres} irrigated).` : `${label} already has ${planted} planted, ${irrigated} irrigated.`,
        columns: ['What', 'Before', 'After'],
        rows: [['Planted acres', pl.planted_acres, planted], ['Irrigated acres', pl.irrigated_acres, irrigated], ['Dryland acres', n0(pl.dryland_acres), dryland]],
        notes: ['Turnrow Farm reads these acres from Grain; recompute the year in Farm after it syncs.'],
        changes, fingerprint: fingerprintOf({ action: 'set_planting_acres', params, before: { id: pl.id, planted: pl.planted_acres, irrigated: pl.irrigated_acres, managed_by: pl.managed_by } }), url: url('/settings/plantings'),
      },
      async apply() {
        if (!changes) return { planting_id: pl.id, unchanged: true }
        const { error: ue } = await sb.from('field_plantings').update({ planted_acres: planted, irrigated_acres: irrigated, dryland_acres: dryland }).eq('org_id', orgId).eq('id', pl.id)
        if (ue) throw new Error(ue.message)
        return { planting_id: pl.id, planted_acres: planted, irrigated_acres: irrigated, dryland_acres: dryland }
      },
    }
  },
}

export const ACTIONS: Def[] = [completeContract, setContractWindow, setContractedBushels, setPlantingAcres]

export function actionIndex() {
  return { app: APP.app, label: APP.label, actions: ACTIONS.map(({ name, description, params }) => ({ name, description, params })) }
}

function defFor(name: unknown): Def {
  const d = ACTIONS.find((a) => a.name === name)
  if (!d) throw new ActionError(`Unknown action ${String(name ?? '')}.`)
  return d
}
function paramsOf(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new ActionError('params must be an object.')
  return v as Record<string, unknown>
}

export async function previewAction(sb: SupabaseClient, orgId: string, body: { action?: unknown; params?: unknown }, now: Date = new Date()): Promise<Preview> {
  return (await defFor(body.action).plan(sb, orgId, paramsOf(body.params), now)).preview
}

export type ApplyBody = { action?: unknown; params?: unknown; fingerprint?: unknown; key?: unknown; approved_by?: unknown }
export type ApplyAnswer = { status: number; body: Record<string, unknown> }

type LogRow = { key: string; action: string; params: unknown; fingerprint: string | null; approved_by: string | null; outcome: 'applied' | 'stale' | 'refused' | 'failed'; result?: unknown; error?: string | null }
async function log(sb: SupabaseClient, orgId: string, row: LogRow): Promise<{ conflict: boolean }> {
  const { error } = await sb.from('ops_action_log').insert({ org_id: orgId, ...row, result: row.result ?? null, error: row.error ?? null })
  if (!error) return { conflict: false }
  if (/duplicate key|unique/i.test(error.message)) return { conflict: true }
  throw new Error(`ops_action_log: ${error.message}`)
}
async function appliedRow(sb: SupabaseClient, orgId: string, key: string): Promise<{ action: string; result: unknown } | null> {
  const { data, error } = await sb.from('ops_action_log').select('action, result').eq('org_id', orgId).eq('key', key).eq('outcome', 'applied').limit(1).maybeSingle()
  if (error) throw new Error(`ops_action_log: ${error.message}`)
  return (data as { action: string; result: unknown } | null) ?? null
}

/** POST /api/ops/actions/apply: replay by key, re-preview, stale on a moved
 *  fingerprint, else apply and log. */
export async function applyAction(sb: SupabaseClient, orgId: string, body: ApplyBody, now: Date = new Date()): Promise<ApplyAnswer> {
  const key = typeof body.key === 'string' ? body.key.trim().slice(0, 200) : ''
  if (!key) return { status: 400, body: { error: 'key is needed (the idempotency key).' } }
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim() : ''
  if (!fingerprint) return { status: 400, body: { error: 'fingerprint is needed (from the preview).' } }
  const approvedBy = typeof body.approved_by === 'string' ? body.approved_by.trim().slice(0, 200) || null : null
  const action = String(body.action ?? '')

  const done = await appliedRow(sb, orgId, key)
  if (done) {
    const logged = (done.result ?? {}) as Record<string, unknown>
    return { status: 200, body: { app: APP.app, action: done.action, applied: true, replay: true, result: done.result, url: typeof logged.url === 'string' ? logged.url : url('/'), key } }
  }

  let planned: Planned
  try {
    planned = await defFor(action).plan(sb, orgId, paramsOf(body.params), now)
  } catch (e) {
    if (e instanceof ActionError) {
      await log(sb, orgId, { key, action, params: body.params ?? {}, fingerprint, approved_by: approvedBy, outcome: 'refused', error: e.message })
      return { status: e.status, body: { error: e.message, ...(e.status === 400 ? { actions: ACTIONS.map((a) => a.name) } : {}) } }
    }
    throw e
  }
  const { preview } = planned
  if (preview.fingerprint !== fingerprint) {
    await log(sb, orgId, { key, action, params: preview.params, fingerprint, approved_by: approvedBy, outcome: 'stale', error: `Now: ${preview.headline}` })
    return { status: 409, body: { stale: true, error: 'The records changed since the preview.', preview } }
  }
  let result: Record<string, unknown>
  try {
    result = { ...(await planned.apply()), url: preview.url }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'The change failed.'
    await log(sb, orgId, { key, action, params: preview.params, fingerprint, approved_by: approvedBy, outcome: 'failed', error: message })
    return { status: 500, body: { error: message } }
  }
  const { conflict } = await log(sb, orgId, { key, action, params: preview.params, fingerprint, approved_by: approvedBy, outcome: 'applied', result })
  if (conflict) {
    // Another call with this key applied first; answer with what it logged.
    const first = await appliedRow(sb, orgId, key)
    return { status: 200, body: { app: APP.app, action, applied: true, replay: true, result: first?.result ?? result, url: preview.url, key } }
  }
  return { status: 200, body: { app: APP.app, action, applied: true, result, url: preview.url, key } }
}
