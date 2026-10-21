// ONE quality reference for upland cotton classing (2026-10-20). Pure.
//
// Everything about HVI grades lives here so the Bale Quality report, its
// exports, the contract-spec evaluator and Ask Turnrow agree on what a code
// means and which price band a reading falls in:
//
//   * color grades (code → name, group, grid position), leaf, staple (32nds
//     and inches), UHML length categories, strength and uniformity
//     categories (the USDA descriptive bands), extraneous matter and remarks
//     codes;
//   * PRICE BANDS per crop year from that year's CCC loan premium & discount
//     schedule — the buckets the market prices against, each tagged premium /
//     base / discount, with the finer loan buckets kept for distribution
//     charts. A future crop year gets its own PRICE_BANDS entry and nothing
//     else changes.
//
// Boundaries compare at the precision USDA reports: mic, strength and
// uniformity to tenths (readings are rounded to tenths before bucketing, so
// 4.25 stored from a sloppy import still lands where "4.3" would).
//
// 2026 figures: "2026-CROP UPLAND COTTON SCHEDULE OF PREMIUMS AND DISCOUNTS",
// USDA FSA, May 2026 (FULL FINAL CORRECTED) —
// https://www.fsa.usda.gov/sites/default/files/2026-05/2026%20Cotton%20Loan%20Schedule%20FULL%20FINAL%20CORRECTED.pdf
// Page 1: the grade × leaf × staple grid is 0 points at SLM (41), leaf 4,
// staple 34 — the loan base. Page 3: micronaire, strength, uniformity and
// extraneous matter differences (points per lb; 100 points = 1¢).

// ---------------------------------------------------------------------------
// Color grades
// ---------------------------------------------------------------------------

export type ColorGroup = 'white' | 'light_spotted' | 'spotted' | 'tinged' | 'yellow_stained' | 'below_grade' | 'special'

export type ColorGradeInfo = {
  code: string
  /** Grade name ("Strict Low Middling"). */
  name: string
  /** USDA symbol ("SLM"). */
  symbol: string
  group: ColorGroup
  /** Grid row: the grade digit 1–7, 8 = below grade; null for special codes. */
  row: number | null
  /** Grid column: 1 white · 2 light spotted · 3 spotted · 4 tinged · 5 yellow stained; null for special codes. */
  column: number | null
}

const GRADE_NAMES: Array<[number, string, string]> = [
  [1, 'Good Middling', 'GM'],
  [2, 'Strict Middling', 'SM'],
  [3, 'Middling', 'M'],
  [4, 'Strict Low Middling', 'SLM'],
  [5, 'Low Middling', 'LM'],
  [6, 'Strict Good Ordinary', 'SGO'],
  [7, 'Good Ordinary', 'GO'],
]

export const COLOR_GROUP_LABEL: Record<ColorGroup, string> = {
  white: 'White',
  light_spotted: 'Light Spotted',
  spotted: 'Spotted',
  tinged: 'Tinged',
  yellow_stained: 'Yellow Stained',
  below_grade: 'Below Grade',
  special: 'Special',
}

/** The five grid columns of the USDA color chart, in order. */
export const COLOR_GRID_COLUMNS: Array<{ column: number; group: ColorGroup; label: string }> = [
  { column: 1, group: 'white', label: 'White' },
  { column: 2, group: 'light_spotted', label: 'Light Spotted' },
  { column: 3, group: 'spotted', label: 'Spotted' },
  { column: 4, group: 'tinged', label: 'Tinged' },
  { column: 5, group: 'yellow_stained', label: 'Yellow Stained' },
]
/** Grid rows: grade 1–7, 8 = below grade. */
export const COLOR_GRID_ROWS: Array<{ row: number; label: string; symbol: string }> = [
  ...GRADE_NAMES.map(([row, name, symbol]) => ({ row, label: name, symbol })),
  { row: 8, label: 'Below Grade', symbol: 'BG' },
]

function build(): Map<string, ColorGradeInfo> {
  const m = new Map<string, ColorGradeInfo>()
  const put = (code: string, name: string, symbol: string, group: ColorGroup, row: number | null, column: number | null) =>
    m.set(code, { code, name, symbol, group, row, column })
  const groupOfColumn: Record<number, ColorGroup> = { 1: 'white', 2: 'light_spotted', 3: 'spotted', 4: 'tinged', 5: 'yellow_stained' }
  const suffix: Record<number, string> = { 1: '', 2: ' Light Spotted', 3: ' Spotted', 4: ' Tinged', 5: ' Yellow Stained' }
  // White 11–71, light spotted 12–62, spotted 13–63, tinged 24–54, yellow stained 25, 35.
  const columnsByRow: Record<number, number[]> = { 1: [1, 2, 3], 2: [1, 2, 3, 4, 5], 3: [1, 2, 3, 4, 5], 4: [1, 2, 3, 4], 5: [1, 2, 3, 4], 6: [1, 2, 3], 7: [1] }
  for (const [row, name, symbol] of GRADE_NAMES) {
    for (const column of columnsByRow[row]) {
      put(`${row}${column}`, `${name}${suffix[column]}`, symbol, groupOfColumn[column], row, column)
    }
  }
  for (let column = 1; column <= 5; column++) put(`8${column}`, `Below Grade${suffix[column]}`, 'BG', 'below_grade', 8, column)
  put('96', 'Upland / Pima mix', '—', 'special', null, null)
  put('97', 'Fire damaged', '—', 'special', null, null)
  put('98', 'Water damaged', '—', 'special', null, null)
  return m
}
const COLOR_GRADES = build()

/** Every upland color code, grid order (row-major), then the special codes. */
export const COLOR_GRADE_CODES: string[] = Array.from(COLOR_GRADES.keys())

/** Normalize a stored color grade ("31", "31-2", " 31 ") to its two-digit code. */
export function colorCode(raw: string | number | null | undefined): string | null {
  if (raw == null) return null
  const m = String(raw).trim().match(/^(\d{2})/)
  return m ? m[1] : null
}

export function colorGradeInfo(raw: string | number | null | undefined): ColorGradeInfo | null {
  const code = colorCode(raw)
  return code ? COLOR_GRADES.get(code) ?? null : null
}

/** The code at a grid cell, or null where the chart has no grade (e.g. row 1, tinged). */
export function colorGridCode(row: number, column: number): string | null {
  const code = `${row}${column}`
  return COLOR_GRADES.has(code) ? code : null
}

/** "Color 41 and better" = the WHITE grades at or above that grade:
 *  41 → 11, 21, 31, 41 · 31 → 11, 21, 31. Light spotted and below never
 *  count unless the contract lists them. Non-white input → that group's
 *  grades at or above the grade digit (22 → 12, 22). */
export function colorCodesAndBetter(raw: string | number): string[] {
  const code = colorCode(raw)
  const info = code ? COLOR_GRADES.get(code) : null
  if (!info || info.row == null || info.column == null || info.row === 8) return []
  const out: string[] = []
  for (let row = 1; row <= info.row; row++) {
    const c = colorGridCode(row, info.column)
    if (c) out.push(c)
  }
  return out
}

/** The HVI color quadrant: the digit after the dash in a composite grade
 *  ("31-2" → 2) — where in the color-grade block the Rd / +b point fell. */
export function colorQuadrant(compositeGrade: string | null | undefined): number | null {
  if (!compositeGrade) return null
  const m = String(compositeGrade).trim().match(/^\d{2}\s*-\s*(\d)$/)
  return m ? Number(m[1]) : null
}

// ---------------------------------------------------------------------------
// Leaf, staple, length, strength, uniformity, extraneous matter, remarks
// ---------------------------------------------------------------------------

export function leafGrade(raw: string | number | null | undefined): number | null {
  if (raw == null) return null
  const n = Number(String(raw).trim())
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : null
}
export function leafLabel(leaf: number): string {
  return leaf === 8 ? 'Below grade' : `Leaf ${leaf}`
}

/** Staple in 32nds → inches as the trade writes it: 34 → 1-1/16, 37 → 1-5/32. */
export function stapleInches(staple32nds: number): string {
  const n = Math.round(staple32nds)
  const whole = Math.floor(n / 32)
  let numer = n - whole * 32
  let denom = 32
  while (numer > 0 && numer % 2 === 0) { numer /= 2; denom /= 2 }
  if (numer === 0) return `${whole}`
  return whole > 0 ? `${whole}-${numer}/${denom}` : `${numer}/${denom}`
}

export type LengthCategory = 'short' | 'medium' | 'long' | 'extra_long'
export const LENGTH_CATEGORY_LABEL: Record<LengthCategory, string> = { short: 'Short', medium: 'Medium', long: 'Long', extra_long: 'Extra Long' }
/** UHML categories: Short < 0.99", Medium 0.99–1.10, Long 1.11–1.26, Extra Long > 1.26 (length in 100ths). */
export function lengthCategory(length100ths: number): LengthCategory {
  const n = Math.round(length100ths)
  if (n <= 98) return 'short'
  if (n <= 110) return 'medium'
  if (n <= 126) return 'long'
  return 'extra_long'
}

export type StrengthCategory = 'weak' | 'intermediate' | 'average' | 'strong' | 'very_strong'
export const STRENGTH_CATEGORY_LABEL: Record<StrengthCategory, string> = { weak: 'Weak', intermediate: 'Intermediate', average: 'Average', strong: 'Strong', very_strong: 'Very Strong' }
/** USDA descriptive strength categories (g/tex): Weak ≤ 23.4, Intermediate 23.5–25.4, Average 25.5–28.4, Strong 28.5–30.4, Very Strong ≥ 30.5. */
export function strengthCategory(gTex: number): StrengthCategory {
  const t = tenths(gTex)
  if (t <= 234) return 'weak'
  if (t <= 254) return 'intermediate'
  if (t <= 284) return 'average'
  if (t <= 304) return 'strong'
  return 'very_strong'
}

export type UniformityCategory = 'very_low' | 'low' | 'average' | 'high' | 'very_high'
export const UNIFORMITY_CATEGORY_LABEL: Record<UniformityCategory, string> = { very_low: 'Very Low', low: 'Low', average: 'Average', high: 'High', very_high: 'Very High' }
/** USDA descriptive uniformity categories: Very Low < 76.5, Low 76.5–79.4, Average 79.5–82.4, High 82.5–85.4, Very High > 85.4. */
export function uniformityCategory(pct: number): UniformityCategory {
  const t = tenths(pct)
  if (t < 765) return 'very_low'
  if (t <= 794) return 'low'
  if (t <= 824) return 'average'
  if (t <= 854) return 'high'
  return 'very_high'
}

export type ExtraneousKind = 'prep' | 'bark' | 'grass' | 'seed_coat' | 'oil' | 'spindle_twist' | 'other' | 'plastic'
export const EXTRANEOUS_KIND_LABEL: Record<ExtraneousKind, string> = {
  prep: 'Preparation', bark: 'Bark', grass: 'Grass', seed_coat: 'Seed coat fragments', oil: 'Oil', spindle_twist: 'Spindle twist', other: 'Other', plastic: 'Plastic',
}
const EXTRANEOUS_BY_TENS: Record<string, ExtraneousKind> = { '0': 'prep', '1': 'bark', '2': 'grass', '3': 'seed_coat', '4': 'oil', '5': 'spindle_twist', '6': 'other', '7': 'plastic' }

/** Extraneous matter code → kind + level: 01/02 prep, 11/12 bark, 21/22 grass,
 *  31/32 seed coat fragments, 41/42 oil, 51/52 spindle twist, 61/62 other,
 *  71/72 plastic (level 1 / level 2). Blank = none. */
export function extraneousInfo(raw: string | number | null | undefined): { code: string; kind: ExtraneousKind; level: 1 | 2; label: string } | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '' || s === '0' || s === '00') return null
  const m = s.padStart(2, '0').match(/^(\d)(\d)$/)
  if (!m) return null
  const kind = EXTRANEOUS_BY_TENS[m[1]]
  const level = Number(m[2])
  if (!kind || (level !== 1 && level !== 2)) return null
  return { code: m[1] + m[2], kind, level: level as 1 | 2, label: `${EXTRANEOUS_KIND_LABEL[kind]} (level ${level})` }
}

/** Remarks codes: 75 and 76 reginned, 77 repacked. */
export function remarksInfo(raw: string | number | null | undefined): { code: string; label: string } | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '' || s === '0') return null
  if (s === '75' || s === '76') return { code: s, label: 'Reginned' }
  if (s === '77') return { code: s, label: 'Repacked' }
  return { code: s, label: `Remark ${s}` }
}

// ---------------------------------------------------------------------------
// Price bands per crop year
// ---------------------------------------------------------------------------

export type Band = 'premium' | 'base' | 'discount'
export const BAND_LABEL: Record<Band, string> = { premium: 'Premium', base: 'Base', discount: 'Discount' }

/** One bucket of a reading's scale. Bounds are inclusive, in the reading's
 *  own units; null = open-ended. `points` are the loan schedule's points per
 *  lb for the finer loan buckets (100 points = 1¢). */
export type Bucket = {
  key: string
  label: string
  min: number | null
  max: number | null
  band: Band | null
  points?: number
}

export type CropYearBands = {
  cropYear: number
  source: string
  /** The loan base grade the color / leaf / staple bands are relative to. */
  loanBase: { color: string; leaf: number; staple: number }
  /** Finer loan buckets (distribution charts); the coarse bands derive from these. */
  mic: Bucket[]
  strength: Bucket[]
  uniformity: Bucket[]
  /** Extraneous matter points by kind and level, for reference. */
  extraneousPoints: Record<ExtraneousKind, [number, number]>
}

const b = (key: string, label: string, min: number | null, max: number | null, band: Band, points: number): Bucket => ({ key, label, min, max, band, points })

export const PRICE_BANDS: Record<number, CropYearBands> = {
  // 2026-crop upland schedule (FSA, May 2026, FULL FINAL CORRECTED), page 3.
  2026: {
    cropYear: 2026,
    source: '2026-Crop Upland Cotton Schedule of Premiums and Discounts (USDA FSA, May 2026)',
    loanBase: { color: '41', leaf: 4, staple: 34 },
    mic: [
      b('mic_le24', '2.4 & lower', null, 2.4, 'discount', -1785),
      b('mic_25_26', '2.5–2.6', 2.5, 2.6, 'discount', -1310),
      b('mic_27_29', '2.7–2.9', 2.7, 2.9, 'discount', -885),
      b('mic_30_32', '3.0–3.2', 3.0, 3.2, 'discount', -620),
      b('mic_33_34', '3.3–3.4', 3.3, 3.4, 'discount', -475),
      b('mic_35_36', '3.5–3.6', 3.5, 3.6, 'base', 0),
      b('mic_37_42', '3.7–4.2', 3.7, 4.2, 'premium', 10),
      b('mic_43_49', '4.3–4.9', 4.3, 4.9, 'base', 0),
      b('mic_50_52', '5.0–5.2', 5.0, 5.2, 'discount', -280),
      b('mic_ge53', '5.3 & higher', 5.3, null, 'discount', -415),
    ],
    strength: [
      b('str_le179', '17.9 & lower', null, 17.9, 'discount', -700),
      b('str_18', '18.0–18.9', 18.0, 18.9, 'discount', -670),
      b('str_19', '19.0–19.9', 19.0, 19.9, 'discount', -660),
      b('str_20', '20.0–20.9', 20.0, 20.9, 'discount', -650),
      b('str_21', '21.0–21.9', 21.0, 21.9, 'discount', -640),
      b('str_22', '22.0–22.9', 22.0, 22.9, 'discount', -605),
      b('str_23', '23.0–23.9', 23.0, 23.9, 'discount', -595),
      b('str_24', '24.0–24.9', 24.0, 24.9, 'discount', -570),
      b('str_25', '25.0–25.9', 25.0, 25.9, 'discount', -510),
      b('str_26', '26.0–26.9', 26.0, 26.9, 'base', 0),
      b('str_27', '27.0–27.9', 27.0, 27.9, 'base', 0),
      b('str_28', '28.0–28.9', 28.0, 28.9, 'base', 0),
      b('str_29', '29.0–29.9', 29.0, 29.9, 'premium', 5),
      b('str_30', '30.0–30.9', 30.0, 30.9, 'premium', 20),
      b('str_31_32', '31.0–32.9', 31.0, 32.9, 'premium', 40),
      b('str_ge33', '33.0 & higher', 33.0, null, 'premium', 40),
    ],
    uniformity: [
      b('unif_le779', '77.9 & lower', null, 77.9, 'discount', -100),
      b('unif_78', '78.0–78.9', 78.0, 78.9, 'discount', -85),
      b('unif_79', '79.0–79.9', 79.0, 79.9, 'discount', -70),
      b('unif_80', '80.0–80.9', 80.0, 80.9, 'base', 0),
      b('unif_81', '81.0–81.9', 81.0, 81.9, 'base', 0),
      b('unif_82', '82.0–82.9', 82.0, 82.9, 'premium', 5),
      b('unif_83', '83.0–83.9', 83.0, 83.9, 'premium', 15),
      b('unif_84', '84.0–84.9', 84.0, 84.9, 'premium', 25),
      b('unif_85', '85.0–85.9', 85.0, 85.9, 'premium', 30),
      b('unif_ge86', '86.0 & higher', 86.0, null, 'premium', 35),
    ],
    extraneousPoints: {
      bark: [-430, -685], prep: [-230, -695], grass: [-585, -790], seed_coat: [-430, -720],
      plastic: [-4000, -4000], other: [-425, -720], oil: [-425, -720], spindle_twist: [-425, -720],
    },
  },
}

/** The bands for a crop year: that year's entry, else the newest entry at or
 *  before it, else the newest known (a 2027 crop reads 2026's until 2027 is
 *  entered — the report says which schedule it used). */
export function bandsFor(cropYear: number): CropYearBands {
  const years = Object.keys(PRICE_BANDS).map(Number).sort((a, z) => a - z)
  const exact = PRICE_BANDS[cropYear]
  if (exact) return exact
  const before = years.filter((y) => y <= cropYear)
  const pick = before.length ? before[before.length - 1] : years[years.length - 1]
  return PRICE_BANDS[pick]
}

/** Readings compare at tenths (USDA precision). */
export function tenths(v: number): number {
  return Math.round(v * 10 + 1e-9)
}

function inBucket(bucket: Bucket, v: number): boolean {
  const t = tenths(v)
  if (bucket.min != null && t < tenths(bucket.min)) return false
  if (bucket.max != null && t > tenths(bucket.max)) return false
  return true
}

/** Collapse the fine loan buckets into contiguous same-band bands:
 *  mic → ≤3.4 discount · 3.5–3.6 base · 3.7–4.2 premium · 4.3–4.9 base · ≥5.0 discount. */
export function coarseBuckets(fine: Bucket[], prefix: string): Bucket[] {
  const out: Bucket[] = []
  for (const f of fine) {
    const last = out[out.length - 1]
    if (last && last.band === f.band) {
      last.max = f.max
      last.label = rangeLabel(last.min, last.max)
      last.key = `${prefix}_${out.length - 1}`
    } else {
      out.push({ key: `${prefix}_${out.length}`, label: rangeLabel(f.min, f.max), min: f.min, max: f.max, band: f.band })
    }
  }
  return out
}

function rangeLabel(min: number | null, max: number | null): string {
  if (min == null && max != null) return `≤ ${max.toFixed(1)}`
  if (max == null && min != null) return `≥ ${min.toFixed(1)}`
  if (min != null && max != null) return `${min.toFixed(1)}–${max.toFixed(1)}`
  return 'All'
}

// ---------------------------------------------------------------------------
// Factors: the things a quality report can show
// ---------------------------------------------------------------------------

export type FactorKey =
  | 'color' | 'leaf' | 'staple' | 'mic' | 'strength' | 'uniformity'
  | 'extraneous' | 'remarks' | 'rd' | 'plus_b' | 'quadrant' | 'trash' | 'length' | 'loan'

export type FactorDef = {
  key: FactorKey
  label: string
  short: string
  /** 'number' readings average; 'code' factors only distribute. */
  kind: 'number' | 'code'
  decimals: number
  /** Whether a bucket carries a premium / base / discount band. */
  banded: boolean
  /** The classing column the factor reads. */
  column: 'color_grade' | 'leaf_grade' | 'staple_32nds' | 'micronaire' | 'strength_g_tex' | 'uniformity_pct' | 'extraneous' | 'remarks' | 'rd' | 'plus_b' | 'composite_grade' | 'trash_pct' | 'length_100ths' | 'loan_value_cents_per_lb'
  unit?: string
}

export const FACTORS: Record<FactorKey, FactorDef> = {
  color: { key: 'color', label: 'Color grade', short: 'Color', kind: 'code', decimals: 0, banded: true, column: 'color_grade' },
  leaf: { key: 'leaf', label: 'Leaf grade', short: 'Leaf', kind: 'number', decimals: 1, banded: true, column: 'leaf_grade' },
  staple: { key: 'staple', label: 'Staple (32nds)', short: 'Staple', kind: 'number', decimals: 1, banded: true, column: 'staple_32nds' },
  mic: { key: 'mic', label: 'Micronaire', short: 'Mic', kind: 'number', decimals: 2, banded: true, column: 'micronaire' },
  strength: { key: 'strength', label: 'Strength (g/tex)', short: 'Strength', kind: 'number', decimals: 1, banded: true, column: 'strength_g_tex', unit: 'g/tex' },
  uniformity: { key: 'uniformity', label: 'Uniformity (%)', short: 'Uniformity', kind: 'number', decimals: 1, banded: true, column: 'uniformity_pct', unit: '%' },
  extraneous: { key: 'extraneous', label: 'Extraneous matter', short: 'Extraneous', kind: 'code', decimals: 0, banded: true, column: 'extraneous' },
  remarks: { key: 'remarks', label: 'Remarks', short: 'Remarks', kind: 'code', decimals: 0, banded: false, column: 'remarks' },
  rd: { key: 'rd', label: 'Reflectance (Rd)', short: 'Rd', kind: 'number', decimals: 1, banded: false, column: 'rd' },
  plus_b: { key: 'plus_b', label: 'Yellowness (+b)', short: '+b', kind: 'number', decimals: 1, banded: false, column: 'plus_b' },
  quadrant: { key: 'quadrant', label: 'Color quadrant', short: 'Quadrant', kind: 'code', decimals: 0, banded: false, column: 'composite_grade' },
  trash: { key: 'trash', label: 'Trash (% area)', short: 'Trash', kind: 'number', decimals: 1, banded: false, column: 'trash_pct' },
  length: { key: 'length', label: 'Length (100ths)', short: 'Length', kind: 'number', decimals: 0, banded: false, column: 'length_100ths' },
  loan: { key: 'loan', label: 'Loan value (¢/lb)', short: 'Loan ¢/lb', kind: 'number', decimals: 2, banded: false, column: 'loan_value_cents_per_lb', unit: '¢/lb' },
}

export const FACTOR_ORDER: FactorKey[] = ['color', 'leaf', 'staple', 'mic', 'strength', 'uniformity', 'extraneous', 'remarks', 'rd', 'plus_b', 'quadrant', 'trash', 'length', 'loan']

export const FACTOR_PRESETS: Record<'loan' | 'mill' | 'everything', { label: string; factors: FactorKey[] }> = {
  loan: { label: 'Loan factors', factors: ['color', 'leaf', 'staple', 'mic', 'strength', 'uniformity', 'loan'] },
  mill: { label: 'Mill specs', factors: ['mic', 'strength', 'uniformity', 'length', 'staple', 'color', 'extraneous', 'trash'] },
  everything: { label: 'Everything', factors: [...FACTOR_ORDER] },
}

/** The classing row shape every factor reads from (lib/types CottonBaleGrade's columns). */
export type GradeLike = {
  color_grade: string | null
  leaf_grade: string | null
  staple_32nds: number | string | null
  micronaire: number | string | null
  strength_g_tex: number | string | null
  uniformity_pct: number | string | null
  extraneous: string | null
  remarks: string | null
  rd: number | string | null
  plus_b: number | string | null
  composite_grade: string | null
  trash_pct: number | string | null
  length_100ths: number | string | null
  loan_value_cents_per_lb: number | string | null
}

const numOrNull = (v: number | string | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** A factor's value for one classed bale: a number for numeric factors, a
 *  code string for code factors (color code, extraneous code, remarks code,
 *  quadrant digit), null when the classing row has none. */
export function factorValue(grade: GradeLike, key: FactorKey): number | string | null {
  switch (key) {
    case 'color': return colorCode(grade.color_grade)
    case 'leaf': return leafGrade(grade.leaf_grade)
    case 'staple': return numOrNull(grade.staple_32nds)
    case 'mic': return numOrNull(grade.micronaire)
    case 'strength': return numOrNull(grade.strength_g_tex)
    case 'uniformity': return numOrNull(grade.uniformity_pct)
    case 'extraneous': return extraneousInfo(grade.extraneous)?.code ?? null
    case 'remarks': return remarksInfo(grade.remarks)?.code ?? null
    case 'rd': return numOrNull(grade.rd)
    case 'plus_b': return numOrNull(grade.plus_b)
    case 'quadrant': { const q = colorQuadrant(grade.composite_grade); return q == null ? null : String(q) }
    case 'trash': return numOrNull(grade.trash_pct)
    case 'length': return numOrNull(grade.length_100ths)
    case 'loan': return numOrNull(grade.loan_value_cents_per_lb)
  }
}

/** Display text for a factor value ("31 SLM", "1-5/32", "4.30"). */
export function factorText(key: FactorKey, value: number | string | null): string {
  if (value == null) return '—'
  switch (key) {
    case 'color': { const info = colorGradeInfo(value); return info ? `${info.code} ${info.symbol}` : String(value) }
    case 'extraneous': return extraneousInfo(value)?.label ?? String(value)
    case 'remarks': return remarksInfo(value)?.label ?? String(value)
    case 'quadrant': return `Q${value}`
    case 'staple': return `${Number(value)} (${stapleInches(Number(value))}")`
    case 'length': return `${(Number(value) / 100).toFixed(2)}"`
    default: return Number(value).toFixed(FACTORS[key].decimals)
  }
}

/** The buckets a factor distributes over for a crop year. Banded factors
 *  carry premium / base / discount per bucket; 'fine' asks for the loan
 *  schedule's own buckets where the factor has them. Non-banded factors
 *  get descriptive ranges with band = null. */
export function factorBuckets(key: FactorKey, cropYear: number, mode: 'coarse' | 'fine' = 'coarse'): Bucket[] {
  const bands = bandsFor(cropYear)
  const base = bands.loanBase
  switch (key) {
    case 'color': {
      // Each code present in the chart, better than / at / worse than the loan base.
      return COLOR_GRADE_CODES.map((code) => {
        const info = COLOR_GRADES.get(code)!
        const band: Band = info.group === 'white' && info.row != null && info.row < Number(base.color[0]) ? 'premium'
          : code === base.color ? 'base' : 'discount'
        return { key: `color_${code}`, label: `${code} ${info.symbol}${info.column && info.column > 1 ? ' ' + COLOR_GROUP_LABEL[info.group] : ''}`, min: null, max: null, band }
      })
    }
    case 'leaf':
      return [1, 2, 3, 4, 5, 6, 7, 8].map((l) => ({ key: `leaf_${l}`, label: leafLabel(l), min: l, max: l, band: l < base.leaf ? 'premium' : l === base.leaf ? 'base' : 'discount' }))
    case 'staple': {
      const out: Bucket[] = [{ key: 'staple_le31', label: '≤ 31', min: null, max: 31, band: 'discount' }]
      for (let s = 32; s <= 39; s++) out.push({ key: `staple_${s}`, label: `${s}`, min: s, max: s, band: s < base.staple ? 'discount' : s === base.staple ? 'base' : 'premium' })
      out.push({ key: 'staple_ge40', label: '40+', min: 40, max: null, band: 'premium' })
      return out
    }
    case 'mic': return mode === 'fine' ? bands.mic : coarseBuckets(bands.mic, 'mic')
    case 'strength': return mode === 'fine' ? bands.strength : coarseBuckets(bands.strength, 'strength')
    case 'uniformity': return mode === 'fine' ? bands.uniformity : coarseBuckets(bands.uniformity, 'uniformity')
    case 'extraneous':
      return [
        { key: 'ex_none', label: 'None', min: null, max: null, band: 'base' },
        ...(Object.keys(EXTRANEOUS_KIND_LABEL) as ExtraneousKind[]).map((kind) => ({ key: `ex_${kind}`, label: EXTRANEOUS_KIND_LABEL[kind], min: null, max: null, band: 'discount' as Band })),
      ]
    case 'remarks':
      return [
        { key: 'rm_none', label: 'None', min: null, max: null, band: null },
        { key: 'rm_reginned', label: 'Reginned', min: null, max: null, band: null },
        { key: 'rm_repacked', label: 'Repacked', min: null, max: null, band: null },
        { key: 'rm_other', label: 'Other remark', min: null, max: null, band: null },
      ]
    case 'rd':
      return [
        { key: 'rd_lt70', label: '< 70', min: null, max: 69.9, band: null },
        { key: 'rd_70', label: '70–74.9', min: 70, max: 74.9, band: null },
        { key: 'rd_75', label: '75–79.9', min: 75, max: 79.9, band: null },
        { key: 'rd_80', label: '80+', min: 80, max: null, band: null },
      ]
    case 'plus_b':
      return [
        { key: 'b_lt7', label: '< 7.0', min: null, max: 6.9, band: null },
        { key: 'b_7', label: '7.0–8.9', min: 7, max: 8.9, band: null },
        { key: 'b_9', label: '9.0–10.9', min: 9, max: 10.9, band: null },
        { key: 'b_11', label: '11+', min: 11, max: null, band: null },
      ]
    case 'quadrant':
      return [1, 2, 3, 4].map((q) => ({ key: `q_${q}`, label: `Quadrant ${q}`, min: q, max: q, band: null }))
    case 'trash':
      return [
        { key: 'tr_le2', label: '≤ 2', min: null, max: 2, band: null },
        { key: 'tr_3', label: '3–4', min: 3, max: 4, band: null },
        { key: 'tr_5', label: '5–6', min: 5, max: 6, band: null },
        { key: 'tr_7', label: '7+', min: 7, max: null, band: null },
      ]
    case 'length':
      return [
        { key: 'len_short', label: 'Short (< 0.99")', min: null, max: 98, band: null },
        { key: 'len_medium', label: 'Medium (0.99–1.10")', min: 99, max: 110, band: null },
        { key: 'len_long', label: 'Long (1.11–1.26")', min: 111, max: 126, band: null },
        { key: 'len_xl', label: 'Extra Long (> 1.26")', min: 127, max: null, band: null },
      ]
    case 'loan':
      return [
        { key: 'loan_lt50', label: '< 50¢', min: null, max: 49.99, band: null },
        { key: 'loan_50', label: '50–54.99¢', min: 50, max: 54.99, band: null },
        { key: 'loan_55', label: '55–59.99¢', min: 55, max: 59.99, band: null },
        { key: 'loan_60', label: '60¢+', min: 60, max: null, band: null },
      ]
  }
}

/** Which bucket a value lands in (null for a missing value or an unknown code). */
export function bucketOf(key: FactorKey, value: number | string | null, cropYear: number, mode: 'coarse' | 'fine' = 'coarse'): Bucket | null {
  if (value == null) return null
  const buckets = factorBuckets(key, cropYear, mode)
  switch (key) {
    case 'color': return buckets.find((bk) => bk.key === `color_${colorCode(value)}`) ?? null
    case 'extraneous': { const info = extraneousInfo(value); return buckets.find((bk) => bk.key === (info ? `ex_${info.kind}` : 'ex_none')) ?? null }
    case 'remarks': {
      const info = remarksInfo(value)
      const k = !info ? 'rm_none' : info.label === 'Reginned' ? 'rm_reginned' : info.label === 'Repacked' ? 'rm_repacked' : 'rm_other'
      return buckets.find((bk) => bk.key === k) ?? null
    }
    case 'quadrant': return buckets.find((bk) => bk.key === `q_${value}`) ?? null
    case 'loan': {
      const n = Number(value)
      return buckets.find((bk) => (bk.min == null || n >= bk.min) && (bk.max == null || n <= bk.max)) ?? null
    }
    default: {
      const n = Number(value)
      if (!Number.isFinite(n)) return null
      return buckets.find((bk) => inBucket(bk, n)) ?? null
    }
  }
}

/** The price band of a value (null for non-banded factors / missing values). */
export function bandOf(key: FactorKey, value: number | string | null, cropYear: number): Band | null {
  return bucketOf(key, value, cropYear)?.band ?? null
}

/** The loan schedule's points per lb for a mic / strength / uniformity reading. */
export function loanPoints(key: 'mic' | 'strength' | 'uniformity', value: number, cropYear: number): number | null {
  return bucketOf(key, value, cropYear, 'fine')?.points ?? null
}

/** Base or better on every banded loan factor — the "clean bale" KPI. A
 *  missing reading is not base-or-better. */
export function baseOrBetterOnLoanFactors(grade: GradeLike, cropYear: number): boolean {
  const keys: FactorKey[] = ['color', 'leaf', 'staple', 'mic', 'strength', 'uniformity']
  return keys.every((k) => {
    const band = bandOf(k, factorValue(grade, k), cropYear)
    return band === 'base' || band === 'premium'
  })
}
