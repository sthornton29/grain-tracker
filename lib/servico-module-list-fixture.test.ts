import { describe, expect, it } from 'vitest'
import type { CottonLoadExtraction, CottonLoadsExtraction } from '@/lib/pdf-upload'
import { mergeCottonLoads } from '@/lib/parse-merge'
import {
  classificationSummary, classifyAgainstSaved, collapseExtractedLoads, loadNumberKey, pbiReview, receiptClassification, reviewRolls,
  type SavedCottonLoad,
} from '@/lib/cotton-load-review'
import { documentPagePlan } from '@/lib/cotton-loads'

// ---------------------------------------------------------------------------
// The Servico Gin module list for Lamon Farm 5824 / Pivot: a 16-page scan,
// one module ticket per page, 15 distinct loads — load 031627 is scanned
// twice (pages 2 and 7). Every page prints "Number of Rounds: 6"; two pages
// carry a handwritten roll correction ("3 Rolls" and "Busted Roll, 3 Rolls on
// TRK #21"); the circled corner figures (28, 29, 37, #41) are the farm's own
// module sequence, never rolls. The original scan was not on this machine
// when the fixture was written: the weights are synthetic. Modeled as the
// EXTRACTION SHAPE the cotton_weight_ticket prompt emits, page by page, in
// the 4-page batches the upload sends — everything after the model is under
// test: the chunk merge, the duplicate collapse, the rolls review, the
// saved-vs-new classification, and the PBI rules on the receipt side.
// ---------------------------------------------------------------------------

const LOAD_NUMBERS = ['031621', '031622', '031623', '031624', '031625', '031626', '031627', '031628', '031629', '031630', '031631', '031632', '031633', '031634', '031635']

function page(n: number, loadNumber: string, extra: Partial<CottonLoadExtraction> = {}): CottonLoadExtraction {
  const idx = LOAD_NUMBERS.indexOf(loadNumber)
  return {
    page: n,
    load_number: loadNumber,
    producer: 'Lamon Farm',
    farm_number: '5824',
    field: 'Pivot',
    picked_date: `2026-09-${String(20 + Math.floor(idx / 4)).padStart(2, '0')}`,
    delivered_date: `2026-09-${String(21 + Math.floor(idx / 4)).padStart(2, '0')}`,
    truck: `TRK #${20 + (idx % 3)}`,
    gross_weight: 46_000 + idx * 180,
    tare_weight: 16_200,
    net_weight: 29_800 + idx * 180,
    rolls: 6,
    handwritten_rolls: null,
    handwritten_note: null,
    sequence_mark: null,
    crop_year: 2026,
    ...extra,
  }
}

// The 16 pages in document order. Page 7 repeats 031627 (page 2) with the
// same weights; pages 5 and 11 carry handwriting; four pages carry a circled
// sequence number.
const PAGES: CottonLoadExtraction[] = [
  page(1, '031621', { sequence_mark: '28' }),
  page(2, '031627'),
  page(3, '031622', { sequence_mark: '29' }),
  page(4, '031623'),
  page(5, '031624', { handwritten_rolls: 3, handwritten_note: '3 Rolls' }),
  page(6, '031625'),
  page(7, '031627'), // the duplicate scan
  page(8, '031626', { sequence_mark: '37' }),
  page(9, '031628'),
  page(10, '031629'),
  page(11, '031630', { handwritten_rolls: 3, handwritten_note: 'Busted Roll, 3 Rolls on TRK #21' }),
  page(12, '031631', { sequence_mark: '#41' }),
  page(13, '031632'),
  page(14, '031633'),
  page(15, '031634'),
  page(16, '031635'),
]

// The upload parses 4 pages per batch; the page numbers are rebased to the
// whole document by lib/parse-chunked before the merge.
function batches(): CottonLoadsExtraction[] {
  const out: CottonLoadsExtraction[] = []
  for (let i = 0; i < PAGES.length; i += 4) out.push({ loads: PAGES.slice(i, i + 4) })
  return out
}

describe('Servico module list — merge and collapse', () => {
  const merged = mergeCottonLoads(batches())
  const rows = collapseExtractedLoads(merged.loads)

  it('the chunk merge keeps every page (16) — the duplicate is the review\'s call, not the merge\'s', () => {
    expect(merged.loads).toHaveLength(16)
  })

  it('collapses to 15 distinct loads; 031627 appears twice (pages 2 and 7), first page is the ticket', () => {
    expect(rows).toHaveLength(15)
    const dup = rows.find((r) => r.load_number === '031627')!
    expect(dup.pages).toEqual([2, 7])
    expect(dup.pageConflict).toBeNull()
    expect(rows.filter((r) => r.pages.length > 1)).toHaveLength(1)
    expect(rows.map((r) => r.load_number)).toEqual(['031621', '031627', '031622', '031623', '031624', '031625', '031626', '031628', '031629', '031630', '031631', '031632', '031633', '031634', '031635'])
  })

  it('leading zeros never split a load: "31627" and "031627" are one key', () => {
    expect(loadNumberKey('031627')).toBe('31627')
    expect(loadNumberKey('31627')).toBe('31627')
    expect(loadNumberKey('M-0031627')).toBe('31627')
  })

  it('a second page with different weights flags the row red', () => {
    const conflict = collapseExtractedLoads([page(1, '031640', { net_weight: 29_860 }), page(2, '031640', { net_weight: 30_120 })])
    expect(conflict).toHaveLength(1)
    expect(conflict[0].pageConflict).toMatch(/net 29,860 vs 30,120 lbs/)
  })

  it('one page per load with no duplicate keeps a page per row; with the duplicate the plan is per-page only when counts agree', () => {
    expect(documentPagePlan(15, 16)).toBe('whole')
    expect(documentPagePlan(15, 15)).toBe('per-page')
  })
})

describe('Servico module list — rolls: printed, handwritten, and sequence marks', () => {
  const rows = collapseExtractedLoads(PAGES)

  it('every page prints rolls = 6; the printed count is what the row shows', () => {
    expect(rows.every((r) => reviewRolls(r).printed === 6)).toBe(true)
  })

  it('the two handwritten corrections surface as a chip, never picked silently', () => {
    const plain = reviewRolls(rows.find((r) => r.load_number === '031624')!)
    expect(plain).toMatchObject({ printed: 6, handwritten: 3, chip: 'handwritten: 3 rolls (3 rolls)' })
    const busted = reviewRolls(rows.find((r) => r.load_number === '031630')!)
    expect(busted.chip).toBe('handwritten: 3 rolls (busted roll, 3 rolls on trk #21)')
    expect(busted.note).toBe('Busted Roll, 3 Rolls on TRK #21')
    // The row's rolls value is still the printed 6 until the user taps Use 3.
    expect(busted.printed).toBe(6)
    expect(rows.filter((r) => reviewRolls(r).chip).map((r) => r.load_number)).toEqual(['031624', '031630'])
  })

  it('a handwritten count equal to the printed one is not a correction', () => {
    expect(reviewRolls({ rolls: 6, handwritten_rolls: 6, handwritten_note: '6', sequence_mark: null }).chip).toBeNull()
  })

  it('circled / hash-numbered corner figures are sequence marks and never become the roll count', () => {
    const marked = rows.filter((r) => r.sequence_mark)
    expect(marked.map((r) => r.sequence_mark)).toEqual(['28', '29', '37', '#41'])
    expect(marked.every((r) => reviewRolls(r).printed === 6 && reviewRolls(r).handwritten == null)).toBe(true)
  })
})

describe('Servico module list — against the loads already saved', () => {
  const rows = collapseExtractedLoads(PAGES)
  const saved: SavedCottonLoad[] = [
    // 031621 saved exactly as scanned; 031622 saved with the old weight and no rolls; 031623 saved last year (a different crop year is a different load).
    { id: 'a', load_number: '31621', crop_year: 2026, net_weight: 29_800, gross_weight: 46_000, tare_weight: 16_200, picked_date: '2026-09-20', delivered_date: '2026-09-21', rolls: 6 },
    { id: 'b', load_number: '031622', crop_year: 2026, net_weight: 29_500, gross_weight: 45_700, tare_weight: 16_200, picked_date: '2026-09-20', delivered_date: '2026-09-21', rolls: null },
    { id: 'c', load_number: '031623', crop_year: 2025, net_weight: 1, gross_weight: null, tare_weight: null, picked_date: null, delivered_date: null, rolls: null },
  ]
  const classified = rows.map((r) => ({ load: r.load_number, c: classifyAgainstSaved(r, saved, 2026) }))

  it('031621 is already saved, 031622 is an update with a field diff, the rest (incl. last year\'s 031623) are new', () => {
    expect(classified.find((x) => x.load === '031621')!.c.status).toBe('saved')
    const upd = classified.find((x) => x.load === '031622')!.c
    expect(upd.status).toBe('update')
    if (upd.status === 'update') {
      expect(upd.diffs.map((d) => `${d.label}: ${d.saved} → ${d.scanned}`)).toEqual(['Net lbs: 29,500 → 29,980', 'Gross lbs: 45,700 → 46,180', 'Rolls: — → 6'])
    }
    expect(classified.find((x) => x.load === '031623')!.c.status).toBe('new')
    expect(classificationSummary(classified.map((x) => x.c)).text).toBe('1 already saved · 1 update · 13 new')
  })
})

describe('Servico — the receipt side: PBI and receipt-number rules', () => {
  it('flags a PBI repeated in the bale list and one already on another receipt this crop year, by name', () => {
    const bales = [{ pbi_number: '0012345', net: 500 }, { pbi_number: '12346', net: 498 }, { pbi_number: '12345', net: 500 }, { pbi_number: '12347', net: 502 }]
    const existing = [{ pbi_number: '12347', crop_year: 2026, receipt_number: '040611' }, { pbi_number: '12346', crop_year: 2025, receipt_number: '039001' }]
    const rows = pbiReview(bales, existing, 2026)
    expect(rows.map((r) => r.flags)).toEqual([[], [], ['repeated in this bale list'], ['already on receipt #040611']])
  })

  it('a receipt number already saved classifies saved or update; a new number is new', () => {
    const saved = [{ id: 'r1', receipt_number: '040614', crop_year: 2026, receipt_date: '2026-10-02', bales_count: 48, total_seed_cotton_weight: 120_000, total_bale_weight: 24_000 }]
    expect(receiptClassification({ receipt_number: '40614', receipt_date: '2026-10-02', bales_count: 48 }, saved, 2026)).toEqual({ status: 'saved', existingId: 'r1' })
    const u = receiptClassification({ receipt_number: '040614', bales_count: 49, total_bale_weight: 24_480 }, saved, 2026)
    expect(u.status).toBe('update')
    if (u.status === 'update') expect(u.diffs).toEqual(['bales 48 → 49', 'lint 24,000 → 24,480 lbs'])
    expect(receiptClassification({ receipt_number: '040615' }, saved, 2026).status).toBe('new')
    expect(receiptClassification({ receipt_number: '040614' }, saved, 2025).status).toBe('new')
  })
})
