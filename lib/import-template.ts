import type { ImportConfig } from './csv'

// Builds and downloads a styled two-sheet Excel template:
//   • "Instructions" — title, overview, a per-column guide, tips and worked
//     examples, all with real formatting (bold, colors, wrapped text).
//   • "Data" — just the header row, frozen, for the user to fill in.
// We use ExcelJS (not the bundled SheetJS, whose community build can't write
// cell styles) and store text as proper Unicode, so nothing turns to gibberish
// the way special characters can when Excel opens a UTF-8 CSV.

const BRAND = 'FF15803D' // green-700, matches the app
const HEAD_BG = 'FFE2E8F0' // slate-200
const MUTED = 'FF64748B' // slate-500
const GRID = 'FFCBD5E1' // slate-300

// Excel never grows a merged or fixed-height row to fit wrapped text, so every
// instruction row is given the height its own text needs — otherwise the last
// line of a long paragraph or column note is cut off.
const LINE_PT = 15
const INFO_WIDTHS = [26, 78, 12] // Instructions columns, in characters
const INFO_WIDTH = INFO_WIDTHS.reduce((a, w) => a + w, 0)

/** Lines a text takes when wrapped at whole words into `width` characters. */
function wrappedLines(text: string, width: number): number {
  const cap = Math.max(8, Math.floor(width))
  let lines = 0
  for (const para of text.split(/\r?\n/)) {
    let used = 0
    lines += 1
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (used === 0) { used = word.length; continue }
      if (used + 1 + word.length <= cap) { used += 1 + word.length; continue }
      lines += 1
      used = word.length
    }
  }
  return lines
}

/** Row height for wrapped text, never shorter than `min` points. */
function rowHeight(text: string, width: number, min: number): number {
  return Math.max(min, wrappedLines(text, width - 2) * LINE_PT + 4)
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export async function downloadExcelTemplate(config: ImportConfig) {
  const tpl = config.template
  if (!tpl) return
  // ExcelJS is a sizeable dep; load it only when a template is actually requested.
  const mod: any = await import('exceljs')
  const ExcelJS = mod.default ?? mod
  const wb = new ExcelJS.Workbook()

  const headerLabels = config.columns.map((c) => {
    const base = c.label ?? c.key
    return c.required ? `${base}*` : base
  })

  const thin = { style: 'thin' as const, color: { argb: GRID } }
  const box = { top: thin, left: thin, bottom: thin, right: thin }

  // ---------- Instructions sheet ----------
  const info = wb.addWorksheet('Instructions')
  INFO_WIDTHS.forEach((w, i) => { info.getColumn(i + 1).width = w })

  let r = 1
  // `height` is the least the row gets; longer text makes it taller.
  const mergedRow = (text: string, height: number, style: (c: any) => void) => {
    info.mergeCells(r, 1, r, 3)
    const cell = info.getCell(r, 1)
    cell.value = text
    cell.alignment = { wrapText: true, vertical: 'top' }
    style(cell)
    info.getRow(r).height = rowHeight(text, INFO_WIDTH, height)
    r += 1
  }
  const sectionHeader = (text: string) => {
    info.mergeCells(r, 1, r, 3)
    const cell = info.getCell(r, 1)
    cell.value = text
    cell.font = { bold: true, size: 12, color: { argb: BRAND } }
    cell.alignment = { vertical: 'middle' }
    info.getRow(r).height = 22
    r += 1
  }

  // Title bar
  mergedRow(tpl.title, 30, (c) => {
    c.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } }
    c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
  })
  r += 1

  for (const para of tpl.overview ?? []) {
    mergedRow(para, 30, (c) => { c.font = { size: 11 } })
  }
  if (tpl.overview?.length) r += 1

  // Columns table
  sectionHeader('Columns')
  ;['Column', 'What to enter', 'Required'].forEach((h, i) => {
    const c = info.getCell(r, i + 1)
    c.value = h
    c.font = { bold: true }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } }
    c.border = box
    c.alignment = { vertical: 'top' }
  })
  info.getRow(r).height = 18
  r += 1
  config.columns.forEach((col) => {
    const name = info.getCell(r, 1)
    name.value = col.label ?? col.key
    name.font = { bold: true }
    name.border = box
    name.alignment = { vertical: 'top', wrapText: true }
    const help = info.getCell(r, 2)
    help.value = tpl.help?.[col.key] ?? ''
    help.border = box
    help.alignment = { vertical: 'top', wrapText: true }
    const req = info.getCell(r, 3)
    req.value = col.required ? 'Yes' : ''
    req.border = box
    req.alignment = { vertical: 'top', horizontal: 'center' }
    if (col.required) req.font = { bold: true, color: { argb: BRAND } }
    info.getRow(r).height = Math.max(
      rowHeight(String(help.value), INFO_WIDTHS[1], 32),
      rowHeight(String(name.value), INFO_WIDTHS[0], 32),
    )
    r += 1
  })
  r += 1

  // Tips
  if (tpl.tips?.length) {
    sectionHeader('Good to know')
    for (const tip of tpl.tips) {
      mergedRow(`•  ${tip}`, 28, (c) => { c.font = { size: 11 } })
    }
    r += 1
  }

  // Examples — rendered as readable lines (label: value) to avoid clashing with
  // the column widths used by the table above.
  if (tpl.examples?.length) {
    sectionHeader('Examples')
    tpl.examples.forEach((row, idx) => {
      const parts = headerLabels.map((h, i) => {
        const label = h.replace(/\*$/, '')
        const v = row[i] ?? ''
        return `${label}: ${v === '' ? '(blank)' : v}`
      })
      mergedRow(`Example ${idx + 1}  —  ${parts.join('   ·   ')}`, 46, (c) => {
        c.font = { size: 11 }
      })
    })
    r += 1
  }

  mergedRow('Enter your rows on the "Data" tab, then save and upload this file.', 24, (c) => {
    c.font = { italic: true, color: { argb: MUTED } }
  })

  // ---------- Data sheet ----------
  const data = wb.addWorksheet('Data')
  data.addRow(headerLabels)
  const head = data.getRow(1)
  head.height = 22
  headerLabels.forEach((label, i) => {
    const c = head.getCell(i + 1)
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } }
    c.alignment = { vertical: 'middle' }
    data.getColumn(i + 1).width = Math.max(14, Math.min(30, label.length + 6))
  })
  // Pre-filled seed rows (e.g. one per existing field with the current year).
  // Aligned to column order by key; columns left blank are for the user to fill
  // — truly empty cells — and a pre-filled number (the season year, a field's
  // acres) is written as a number, so Excel does not flag it "number stored as
  // text" beside the ones the user types.
  for (const row of tpl.dataRows ?? []) {
    data.addRow(config.columns.map((c) => {
      const v = row[c.key] ?? ''
      if (v.trim() === '') return null
      return c.type === 'number' && Number.isFinite(Number(v)) ? Number(v) : v
    }))
  }
  data.views = [{ state: 'frozen', ySplit: 1 }]

  const buf = await wb.xlsx.writeBuffer()
  // Named after the template's own title ("field-plantings-import-template"),
  // not the table it loads into.
  const slug = tpl.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  triggerDownload(
    new Blob([buf as ArrayBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    `${slug || 'import-template'}.xlsx`,
  )
}
