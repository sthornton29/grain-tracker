// Universal report exports — Excel, PDF, and Print.
//
// The xlsx (SheetJS) and jspdf libraries together are ~500 KB, which would
// dominate first-load on a farm-truck iPad if loaded eagerly. We import them
// dynamically inside the export functions so a user who never clicks Export
// never pays the download cost.
//
// Print uses the browser's own dialog (also reachable as "Save as PDF" on
// most platforms) and relies on the `.print-area` / `.no-print` CSS classes
// defined in app/globals.css.

export type ExportColumn = {
  /** Column header text. */
  label: string
  /** Optional numeric formatter for Excel/PDF cells. */
  align?: 'left' | 'right'
}

/** Visual role of a row, used by the PDF/Excel renderers to style it.
 *  'data'    — a normal table row.
 *  'subhead' — a group label that spans the whole table (e.g. a farm name).
 *              Only the first cell's text is shown.
 *  'total'   — an emphasized summary row (bold, tinted background). */
export type RowKind = 'data' | 'subhead' | 'total'

export type ExportSection = {
  /** Section label, e.g. "Crop totals". Rendered as a heading bar in the PDF
   *  and a sheet name / banner row in Excel when present. Optional. */
  title?: string
  columns: ExportColumn[]
  /** One value per column, per row. Strings render as-is; numbers format. */
  rows: Array<Array<string | number | null>>
  /** Optional per-row role, parallel to `rows`. Missing entries default to
   *  'data'. Lets a section embed sub-headers and totals so the PDF can match
   *  an on-screen grouped layout. */
  rowMeta?: RowKind[]
}

export type ExportPayload = {
  /** Report title shown at the top of every export. */
  title: string
  /** Human-readable filter summary ("Crop year: 2026 · Crop: Wheat"). */
  filters?: string
  /** One or more table sections to emit. Single-section reports are common. */
  sections: ExportSection[]
  /** Filename without extension (defaults to slug of the title + date). */
  filename?: string
  /** Excel only: stack every section onto one worksheet instead of one sheet
   *  per section. Use for reports whose sections are groups of one report
   *  (e.g. one section per landowner) rather than independent tables. */
  singleSheet?: boolean
}

function defaultFilename(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return `${slug}-${new Date().toISOString().slice(0, 10)}`
}

function cellForExcel(v: string | number | null): string | number {
  if (v == null) return ''
  return v
}

// ---------- Excel (xlsx via SheetJS) ----------

function autoWidths(aoa: Array<Array<string | number>>): Array<{ wch: number }> {
  const widths: number[] = []
  for (const r of aoa) {
    r.forEach((v, idx) => {
      const len = String(v ?? '').length
      if (!widths[idx] || len > widths[idx]) widths[idx] = len
    })
  }
  return widths.map((w) => ({ wch: Math.min(40, Math.max(10, w + 2)) }))
}

export async function exportToExcel(payload: ExportPayload): Promise<void> {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  const today = new Date().toLocaleString()

  // Single-sheet mode: every section flows down one worksheet, each preceded
  // by its title and column header. Mirrors a grouped on-screen report.
  if (payload.singleSheet) {
    const aoa: Array<Array<string | number>> = []
    aoa.push([payload.title])
    if (payload.filters) aoa.push([payload.filters])
    aoa.push([`Generated: ${today}`])
    for (const section of payload.sections) {
      aoa.push([])
      if (section.title) aoa.push([section.title])
      aoa.push(section.columns.map((c) => c.label))
      for (const row of section.rows) aoa.push(row.map(cellForExcel))
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    ws['!cols'] = autoWidths(aoa)
    const sheetName = payload.title.slice(0, 31).replace(/[\\/?*[\]:]/g, '-') || 'Report'
    XLSX.utils.book_append_sheet(wb, ws, sheetName)
    XLSX.writeFile(wb, `${payload.filename || defaultFilename(payload.title)}.xlsx`)
    return
  }

  for (let i = 0; i < payload.sections.length; i++) {
    const section = payload.sections[i]
    const aoa: Array<Array<string | number>> = []
    aoa.push([payload.title])
    if (payload.filters) aoa.push([payload.filters])
    aoa.push([`Generated: ${today}`])
    aoa.push([])
    if (section.title) {
      aoa.push([section.title])
    }
    aoa.push(section.columns.map((c) => c.label))
    for (const row of section.rows) aoa.push(row.map(cellForExcel))

    const ws = XLSX.utils.aoa_to_sheet(aoa)
    ws['!cols'] = autoWidths(aoa)

    const sheetName = (section.title || `Sheet ${i + 1}`).slice(0, 31).replace(/[\\/?*[\]:]/g, '-')
    XLSX.utils.book_append_sheet(wb, ws, sheetName || `Sheet ${i + 1}`)
  }

  XLSX.writeFile(wb, `${payload.filename || defaultFilename(payload.title)}.xlsx`)
}

// ---------- PDF (jsPDF + jspdf-autotable) ----------

export async function exportToPdf(payload: ExportPayload): Promise<void> {
  const [{ default: JsPDF }, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  const autoTable = (autoTableMod as { default: unknown }).default ?? autoTableMod
  // Landscape — most reports have many columns and bushels totals.
  const doc = new JsPDF({ orientation: 'landscape', unit: 'pt' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const today = new Date().toLocaleString()

  doc.setFontSize(16)
  doc.text(payload.title, 40, 40)
  doc.setFontSize(10)
  doc.setTextColor(110)
  doc.text(`Generated ${today}`, pageWidth - 40, 40, { align: 'right' })
  doc.setTextColor(0)

  const pageHeight = doc.internal.pageSize.getHeight()

  let cursorY = 60
  if (payload.filters) {
    doc.setFontSize(10)
    doc.text(payload.filters, 40, cursorY)
    cursorY += 16
  }

  for (let i = 0; i < payload.sections.length; i++) {
    const section = payload.sections[i]
    const meta = section.rowMeta ?? []

    if (section.title) {
      // Keep a section's heading bar with the first rows of its table — start a
      // fresh page if we're too close to the bottom to fit the header + a row.
      if (cursorY > pageHeight - 90) {
        doc.addPage()
        cursorY = 40
      }
      doc.setFillColor(241, 245, 249) // slate-100, matching the on-screen card header
      doc.rect(40, cursorY + 2, pageWidth - 80, 22, 'F')
      doc.setFontSize(12)
      doc.setTextColor(15, 23, 42)
      doc.text(section.title, 48, cursorY + 17)
      doc.setTextColor(0)
      cursorY += 30
    }

    // Build the body, turning 'subhead' rows into a single full-width cell so a
    // farm name (etc.) spans the table just like its row on the page.
    const body = section.rows.map((r, ri) => {
      if (meta[ri] === 'subhead') {
        const label = r.find((v) => v != null && v !== '') ?? ''
        return [
          {
            content: String(label),
            colSpan: section.columns.length,
            styles: {
              fontStyle: 'bold' as const,
              fillColor: [241, 245, 249] as [number, number, number],
              textColor: [51, 65, 85] as [number, number, number],
              halign: 'left' as const,
            },
          },
        ]
      }
      return r.map((v) => (v == null ? '' : String(v)))
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(autoTable as any)(doc, {
      head: [section.columns.map((c) => c.label)],
      body,
      startY: cursorY + 4,
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [22, 101, 52] }, // green-800 to match the nav
      columnStyles: Object.fromEntries(
        section.columns.map((c, idx) => [idx, { halign: c.align ?? 'left' }]),
      ),
      margin: { left: 40, right: 40 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      didParseCell: (data: any) => {
        if (data.section === 'body' && meta[data.row.index] === 'total') {
          data.cell.styles.fontStyle = 'bold'
          data.cell.styles.fillColor = [248, 250, 252] // slate-50
        }
      },
      didDrawPage: (data: { pageNumber: number }) => {
        doc.setFontSize(8)
        doc.setTextColor(140)
        doc.text(`Page ${data.pageNumber}`, pageWidth - 40, pageHeight - 20, { align: 'right' })
        doc.setTextColor(0)
      },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cursorY = ((doc as any).lastAutoTable?.finalY ?? cursorY) + 20
  }

  doc.save(`${payload.filename || defaultFilename(payload.title)}.pdf`)
}

// ---------- Print ----------

// Just opens the browser's print dialog. Print CSS in globals.css hides the
// nav, sidebar, and the export buttons so only the report content renders.
export function printReport(): void {
  if (typeof window === 'undefined') return
  window.print()
}
