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
  info.getColumn(1).width = 26
  info.getColumn(2).width = 78
  info.getColumn(3).width = 12

  let r = 1
  const mergedRow = (text: string, height: number, style: (c: any) => void) => {
    info.mergeCells(r, 1, r, 3)
    const cell = info.getCell(r, 1)
    cell.value = text
    cell.alignment = { wrapText: true, vertical: 'top' }
    style(cell)
    info.getRow(r).height = height
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
    info.getRow(r).height = 32
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
  // Aligned to column order by key; columns left blank are for the user to fill.
  for (const row of tpl.dataRows ?? []) {
    data.addRow(config.columns.map((c) => row[c.key] ?? ''))
  }
  data.views = [{ state: 'frozen', ySplit: 1 }]

  const buf = await wb.xlsx.writeBuffer()
  triggerDownload(
    new Blob([buf as ArrayBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    `${config.tableName}-template.xlsx`,
  )
}
