// The CSV/Excel importer configs for every settings importer, extracted from
// the page components so the real configs are unit-testable (lib/csv.test.ts
// and lib/import-configs.test.ts exercise these exact objects, not copies).
//
// The shared blank-cell contract (lib/csv.ts): a blank cell in a NON-required
// column never fails a row — the key is omitted from the write so the
// database default applies (share_rent blank → false, percentages blank →
// null, optional FKs blank → unlinked). Only the natural keys each importer
// marks `required` may fail a row.
//
// Builders take the page-side runtime inputs (the entity fallback, the fields
// list for the plantings template, the variety maps) as arguments; anything
// static lives in the object literal.

import { defaultEntityId } from '@/lib/entity-default'
import { normalizeCountyName } from '@/lib/fsa-benchmark-file'
import type { ImportConfig } from '@/lib/csv'

const SOY_ALIASES = { soybeans: 'Soybean', beans: 'Soybean', soy: 'Soybean' }

export function farmsImportConfig(entities: ReadonlyArray<{ id: string }>): ImportConfig {
  return {
    tableName: 'farms',
    uniqueKey: 'name',
    note: 'Entity and landowner match by name against what already exists — import entities and landowners first. If your operation has one entity, you can leave the entity column out — it’s filled in for you. Counties match by name + state together (two-letter state code, e.g. AL), so a "Lawrence" resolves to the right state’s Lawrence County. Share rent: yes/no (blank means no), with the landlord share as a percent (e.g. 33.33) when yes.',
    columns: [
      { key: 'name', required: true },
      // fallbackId auto-assigns the lone entity for single-entity
      // operations (column may be omitted); multi-entity operations
      // still get the required-column row error.
      { key: 'entity_id', label: 'entity', required: true, fk: { table: 'entities', matchColumn: 'name', fallbackId: defaultEntityId(entities) } },
      // Lookup-only: pairs with the county column below; never written
      // to the farm row (farms carry county_id, not a state).
      { key: 'state_code', label: 'state', virtual: true },
      {
        key: 'county_id',
        label: 'county',
        fk: {
          table: 'counties',
          matchColumn: 'name',
          scopeKey: 'state_code',
          scopeRequired: true,
          scopeMissingError: 'county requires a state — add a state_code column',
          // Same normalization as the rest of the app's county matching
          // ("Lawrence County" ≡ "LAWRENCE" ≡ "Lawrence").
          normalizeMatch: normalizeCountyName,
        },
      },
      { key: 'fsa_number', label: 'fsa_number' },
      { key: 'landowner_id', label: 'landowner', fk: { table: 'landowners', matchColumn: 'name' } },
      { key: 'is_share_rent', label: 'share_rent', enum: ['yes', 'no', 'true', 'false', 'y', 'n'] },
      { key: 'landlord_share_percentage', label: 'landlord_share_pct', type: 'number' },
    ],
    // The share-rent flag arrives as text; convert to the real boolean and
    // keep the percentage only when share rent is on (the DB requires a
    // percentage with the flag and forbids one without). A blank share_rent
    // cell (or a missing column) is ABSENT from the row — the farm lands
    // with the database default (not share rent), never a row error.
    derive: (row) => {
      const raw = row.is_share_rent
      if (raw == null || raw === '') return {}
      const sr = ['yes', 'true', 'y'].includes(String(raw).toLowerCase())
      if (sr && row.landlord_share_percentage == null) {
        throw new Error('share_rent is yes but landlord_share_pct is blank — add the landlord’s share percent')
      }
      return { is_share_rent: sr, landlord_share_percentage: sr ? row.landlord_share_percentage ?? null : null }
    },
  }
}

export function fieldsImportConfig(): ImportConfig {
  return {
    tableName: 'fields',
    uniqueKey: 'name_or_number',
    columns: [
      { key: 'name_or_number', label: 'name', required: true },
      { key: 'farm_id', label: 'farm', fk: { table: 'farms', matchColumn: 'name' } },
      { key: 'total_acres', type: 'number' },
      { key: 'irrigated_acres', type: 'number' },
    ],
  }
}

export type PlantingsImportDeps = {
  /** Existing fields, for the pre-filled template rows and the acres default. */
  fields: ReadonlyArray<{ name_or_number: string; total_acres: number | null; irrigated_acres: number }>
  currentYear: number
  varietyOptionsByCrop: Map<string, string[]>
  dismissedPairsByCrop: Map<string, Set<string>>
}

export function plantingsImportConfig(deps: PlantingsImportDeps): ImportConfig {
  const { fields, currentYear, varietyOptionsByCrop, dismissedPairsByCrop } = deps
  const fieldAcresByName = new Map(
    fields.map((f) => [f.name_or_number.trim().toLowerCase(), Number(f.total_acres) || 0]),
  )
  return {
    tableName: 'field_plantings',
    title: 'Import from Excel',
    uniqueKey: ['field_id', 'crop_id', 'season_year'],
    columns: [
      // extraColumns: derive() defaults a blank planted_acres to the field's
      // total acres (a planting usually covers the whole field).
      { key: 'field_id', label: 'field', required: true, fk: { table: 'fields', matchColumn: 'name_or_number', extraColumns: ['total_acres'] } },
      { key: 'crop_id', label: 'crop', required: true, fk: { table: 'crops', matchColumn: 'name', aliases: SOY_ALIASES } },
      { key: 'season_year', type: 'number', required: true },
      { key: 'planted_acres', label: 'Total_Planted_Acres', type: 'number' },
      { key: 'irrigated_acres', label: 'Irrigated_Acres_Planted', type: 'number', default: 0 },
      { key: 'planting_date', type: 'date' },
      { key: 'variety', child: { table: 'field_planting_varieties', valueColumn: 'variety', parentKey: 'planting_id', splitOn: ',;', amountColumn: 'acres' } },
      { key: 'notes' },
    ],
    note: 'Download the Excel template — it opens pre-filled with your fields and has an Instructions tab that walks through filling it in. One row per crop: a field with wheat then double-crop soybeans is two rows for the same field (both may use the field’s full acres). Leave Total_Planted_Acres blank to use the field’s full acres.',
    template: {
      title: 'Field Plantings - Import Template',
      overview: [
        'The Data tab is already filled in with one row for every field you have set up, with the season year defaulted to the current year and the irrigated acres defaulted to each field\'s irrigated acres.',
        'For every field you planted, enter the crop. Total_Planted_Acres may be left blank when the planting covers the whole field — it fills in from the field\'s acres. Leave the fields you did not plant untouched — rows you do not complete are ignored on import.',
        'One row per crop. If a field grew two crops in the same season (full-season wheat, then double-crop soybeans), add a second row for the same field with the other crop — both rows may use the field\'s full acres; that overlap is normal for double-cropping.',
        'The season year is the harvest year (for example, wheat harvested in spring 2026 is season year 2026). When you are done, save the file and upload it on the Field Plantings page.',
      ],
      help: {
        field_id: 'Pre-filled with each of your fields (matching Settings > Fields). Leave these as they are. To record a second crop on a field (double-crop), copy the field\'s row and change the crop.',
        crop_id: 'The crop you planted in this field, e.g. Corn, Soybean, or Wheat. "Soybeans", "Beans", and "Soy" all map to Soybean. Fill this in for every field you planted.',
        season_year: 'The harvest year as a 4-digit number. Pre-filled with the current year; change it only for a different season. A full-season crop and its double-crop follow-on share the same season year.',
        planted_acres: 'Total acres of this crop planted in the field. Leave it blank to use the field\'s full acres (most plantings cover the whole field).',
        irrigated_acres: 'Pre-filled with the field\'s irrigated acres. Change it if this planting\'s irrigated acres differ, or set it to 0 (or blank) if this planting is all dryland.',
        planting_date: 'Date planted, formatted YYYY-MM-DD. Optional.',
        variety: 'Optional. To record several varieties in the same field, put them all in this one cell separated by ";" or ",", with each variety\'s acres after a colon. Example: P2089:70; DKC65-95:50',
        notes: 'Anything else worth recording. Optional.',
      },
      tips: [
        'The Data tab is pre-filled with your fields, the current year, and each field\'s irrigated acres — just complete the rows you planted and leave the rest. Rows you do not add a crop to are ignored.',
        'Blank Total_Planted_Acres = the field\'s full acres.',
        'Two crops in one field the same year (wheat, then double-crop beans)? Two rows, same field, same season year, different crop — both may claim the full acres.',
        'Set Irrigated_Acres_Planted to 0 or blank for an all-dryland planting.',
        'Multiple varieties in one field go in a single variety cell: P2089:70; DKC65-95:50',
        'Rows are matched by field + crop + season year, so re-importing updates the matching row instead of creating a duplicate.',
      ],
      examples: [
        ['North 40', 'Corn', String(currentYear), '120', '80', `${currentYear}-04-15`, 'P2089:120', 'first planting'],
        ['South Bottom', 'Wheat', String(currentYear), '', '', `${currentYear - 1}-10-20`, '', 'full-season wheat — blank acres = whole field'],
        ['South Bottom', 'Soybean', String(currentYear), '90', '', `${currentYear}-06-10`, 'AG38X8:50; P31A22:40', 'double-crop beans after the wheat — same field, second row'],
      ],
      // Seed the Data tab with one row per existing field, defaulting the
      // season year to the current year and irrigated acres to the field's
      // irrigated acres. Rows the user never completes are ignored on
      // import (see ignoreRowIfOnly below).
      dataRows: fields.map((f) => ({
        field_id: f.name_or_number,
        season_year: String(currentYear),
        irrigated_acres: Number(f.irrigated_acres) > 0 ? String(f.irrigated_acres) : '',
      })),
    },
    ignoreRowIfOnly: ['field_id', 'season_year', 'irrigated_acres'],
    // Blank planted acres defaults to the FIELD's total acres (a planting
    // usually covers the whole field); dryland = planted − irrigated, so a
    // blank irrigated cell counts as all dryland.
    derive: (r, ctx) => {
      const out: Record<string, unknown> = {}
      let planted = Number(r.planted_acres)
      if (r.planted_acres == null) {
        const fieldAcres = Number(ctx?.fkRow('field_id')?.total_acres)
        planted = Number.isFinite(fieldAcres) && fieldAcres > 0 ? fieldAcres : 0
        out.planted_acres = planted
      }
      const irr = Number(r.irrigated_acres) || 0
      out.dryland_acres = Math.max(0, (Number(planted) || 0) - irr)
      return out
    },
    // Preview: show the derived value on blank acres cells before importing.
    previewAnnotate: (colKey, rowCells) => {
      if (colKey !== 'planted_acres') return null
      if ((rowCells.planted_acres ?? '').trim() !== '') return null
      // Same "row would be ignored" rule as the import: field+year only.
      if ((rowCells.crop_id ?? '').trim() === '') return null
      const acres = fieldAcresByName.get((rowCells.field_id ?? '').trim().toLowerCase())
      if (!acres) return null
      return { text: `${acres} — from field acres`, ok: true }
    },
    // Route the variety column through the shared resolution pipeline:
    // format variants link to the existing spelling, near names need a
    // decision, new names are created once per file (per crop).
    resolution: {
      columnKey: 'variety',
      scopeKey: 'crop_id',
      noun: 'variety',
      loadExisting: async () => varietyOptionsByCrop,
      loadDismissed: async () => dismissedPairsByCrop,
    },
  }
}

export function contractsImportConfig(entities: ReadonlyArray<{ id: string }>): ImportConfig {
  return {
    tableName: 'contracts',
    uniqueKey: 'contract_number',
    note: 'Buyer, crop, and entity match by name against what already exists. If your operation has one entity, you can leave the entity column out — it’s filled in for you. delivery_type is pickup (their trucks load at your farm) or delivered (you haul it to them); blank means pickup.',
    columns: [
      { key: 'contract_number', required: true },
      { key: 'buyer_id', label: 'buyer', fk: { table: 'buyers', matchColumn: 'name' } },
      { key: 'crop_id', label: 'crop', fk: { table: 'crops', matchColumn: 'name', aliases: SOY_ALIASES } },
      // fallbackId auto-assigns the lone entity for single-entity
      // operations (column may be omitted). NOT required: contracts can
      // legitimately be operation-level (null entity), and today's
      // multi-entity import allows a blank entity — keep that behavior.
      { key: 'entity_id', label: 'entity', fk: { table: 'entities', matchColumn: 'name', fallbackId: defaultEntityId(entities) } },
      { key: 'crop_year', type: 'number' },
      { key: 'contracted_bushels', type: 'number' },
      { key: 'price_per_bushel', type: 'number' },
      { key: 'cash_price', type: 'number' },
      { key: 'contract_month' },
      { key: 'delivery_type', enum: ['pickup', 'delivered'], default: 'pickup' },
      { key: 'delivery_location_id', label: 'delivery_location', fk: { table: 'delivery_locations', matchColumn: 'name', scopeKey: 'buyer_id' } },
      { key: 'delivery_start_date', type: 'date' },
      { key: 'delivery_end_date', type: 'date' },
      { key: 'notes' },
    ],
  }
}

export function binsImportConfig(): ImportConfig {
  return {
    tableName: 'bins',
    uniqueKey: 'name_or_number',
    title: 'Import bins from a spreadsheet',
    note: 'One row per bin. Site matches by name against the sites above — add the sites first. If two entities have a site with the same name, rename one before importing (the match must be unambiguous).',
    columns: [
      { key: 'name_or_number', label: 'bin', required: true },
      { key: 'bin_site_id', label: 'site', fk: { table: 'bin_sites', matchColumn: 'name' } },
      { key: 'crop_id', label: 'crop', fk: { table: 'crops', matchColumn: 'name' } },
      { key: 'capacity_bushels', label: 'capacity_bu', type: 'number' },
    ],
  }
}

export function buyersImportConfig(): ImportConfig {
  return {
    tableName: 'buyers',
    uniqueKey: 'name',
    title: 'Import buyers & delivery locations from a spreadsheet',
    note: 'One row per buyer. Put all of a buyer’s delivery locations in one cell, separated by semicolons; add an address after an @ sign — e.g. "North Elevator @ 105 Grain Rd, Decatur AL; River Terminal". Re-importing an existing buyer adds any NEW locations without touching the rest.',
    columns: [
      { key: 'name', label: 'buyer', required: true },
      {
        key: 'delivery_locations',
        label: 'delivery_locations',
        child: {
          table: 'delivery_locations',
          valueColumn: 'name',
          parentKey: 'buyer_id',
          splitOn: ';|',
          detailColumn: 'address',
        },
      },
    ],
  }
}

export function landownersImportConfig(): ImportConfig {
  return {
    tableName: 'landowners',
    uniqueKey: 'name',
    title: 'Import landowners from a spreadsheet',
    note: 'One row per landowner. Only Name is required — import these before farms so the farms import can match landowner names.',
    columns: [
      { key: 'name', required: true },
      { key: 'phone' },
      { key: 'email' },
      { key: 'address' },
      { key: 'notes' },
    ],
  }
}

export function entitiesImportConfig(): ImportConfig {
  return {
    tableName: 'entities',
    uniqueKey: 'name',
    columns: [
      { key: 'name', required: true },
      { key: 'notes' },
    ],
  }
}

export function cropsImportConfig(): ImportConfig {
  return {
    tableName: 'crops',
    uniqueKey: 'name',
    columns: [
      { key: 'name', required: true },
      { key: 'base_moisture_pct', type: 'number' },
      { key: 'base_lb_per_bushel', type: 'number' },
      { key: 'harvest_category', enum: ['fall', 'spring'], default: 'fall' },
    ],
  }
}

export function trucksImportConfig(): ImportConfig {
  return {
    tableName: 'trucks',
    uniqueKey: 'name_or_number',
    columns: [{ key: 'name_or_number', label: 'name', required: true }],
  }
}

/** Every static config builder, for the blank-optional-column fixture tests
 *  (lib/import-configs.test.ts imports these to run each real config). */
export const STATIC_IMPORT_CONFIGS = {
  fields: fieldsImportConfig,
  bins: binsImportConfig,
  buyers: buyersImportConfig,
  landowners: landownersImportConfig,
  entities: entitiesImportConfig,
  crops: cropsImportConfig,
  trucks: trucksImportConfig,
} as const
