// The account's own names for Ask Turnrow: entities, farms, crops, landowners,
// buyers and seed varieties, rendered as a short system-prompt block so the
// model can tell WHAT KIND of thing a name in the question is before it picks
// a tool. Without it "Two Seasons vs View Celeste" (two entities) was read as
// two varieties. Pure builder + the session-client fetch (RLS scopes every
// list — a viewer sees only the entities their grants allow).

import type { SupabaseClient } from '@supabase/supabase-js'
import { all, allRows } from '@/lib/assistant-tools-shared'

export type AccountVocabulary = {
  entities: ReadonlyArray<{ name: string; entity_role?: string | null }>
  farms: ReadonlyArray<{ name: string }>
  crops: ReadonlyArray<{ name: string; double_crop?: boolean | null }>
  landowners: ReadonlyArray<{ name: string }>
  buyers: ReadonlyArray<{ name: string }>
  varieties: ReadonlyArray<string>
}

/** Names per list before the block says "… and N more". */
export const VOCABULARY_CAP = 60

export const VOCABULARY_HEADING = "==== THIS ACCOUNT'S NAMES (match a name in the question against these BEFORE deciding what kind of thing it is) ===="

export const VOCABULARY_RULES = [
  'Rules: a name under Entities is an entity (use grouping "entity" or the entity filter) — never a variety, a farm or a buyer. A name under Farms is a farm; under Varieties a seed variety inside a planting.',
  'Full-season vs double-crop is a distinction Turnrow already makes for every planting (a double-crop-designated crop planted behind a spring-harvest crop on the same field that year). get_yields knows it: pass cropping "full_season" or "double_crop" (and grouping "entity" for an entity split). Never say the two cannot be told apart.',
].join('\n')

function list(label: string, names: readonly string[]): string {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  if (clean.length === 0) return `${label}: (none yet)`
  const shown = clean.slice(0, VOCABULARY_CAP)
  const more = clean.length - shown.length
  return `${label}: ${shown.join('; ')}${more > 0 ? `; … and ${more} more` : ''}`
}

/** The prompt block. Deterministic for a given vocabulary. */
export function buildAccountVocabulary(v: AccountVocabulary): string {
  const entityNames = v.entities.map((e) => (e.entity_role === 'marketing_agent' ? `${e.name} (marketing agent)` : e.name))
  const cropNames = v.crops.map((c) => (c.double_crop ? `${c.name} (designated Double-crop: its plantings are full-season or double-crop)` : c.name))
  return [
    VOCABULARY_HEADING,
    list('Entities (your operating companies — the "by entity" split)', entityNames),
    list('Farms', v.farms.map((f) => f.name)),
    list('Crops', cropNames),
    list('Landowners', v.landowners.map((l) => l.name)),
    list('Buyers', v.buyers.map((b) => b.name)),
    list('Varieties (seed varieties inside plantings)', v.varieties),
    VOCABULARY_RULES,
  ].join('\n')
}

/** Reads the lists through the caller's session (RLS-scoped). Archived land
 *  rows are left out. field_planting_varieties grows per planting, so it is
 *  paged like every growing table. */
export async function fetchAccountVocabulary(supabase: SupabaseClient): Promise<AccountVocabulary> {
  const [entities, farms, crops, landowners, buyers, varietyRows] = await Promise.all([
    all<{ name: string; entity_role: string | null }>(supabase.from('entities').select('name, entity_role').is('archived_at', null).order('name')),
    all<{ name: string }>(supabase.from('farms').select('name').is('archived_at', null).order('name')),
    all<{ name: string; double_crop: boolean | null }>(supabase.from('crops').select('name, double_crop').order('name')),
    all<{ name: string }>(supabase.from('landowners').select('name').is('archived_at', null).order('name')),
    all<{ name: string }>(supabase.from('buyers').select('name').order('name')),
    allRows<{ variety: string | null }>((f, t) => supabase.from('field_planting_varieties').select('variety').order('id').range(f, t)),
  ])
  return { entities, farms, crops, landowners, buyers, varieties: varietyRows.map((r) => r.variety ?? '').filter(Boolean) }
}
