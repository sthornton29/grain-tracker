// Convert an uploaded Excel workbook (.xlsx / .xls) into a PDF so it flows
// through the exact same AI document pipeline as PDFs and photos — each sheet
// becomes a page rendered as a table, and the model reads the tabular text. No
// route or per-caller changes are needed: DocumentCapture hands the generated
// PDF off as a normal { kind: 'pdf' } source.
//
// xlsx + jspdf are already app dependencies; they're imported dynamically so a
// user who never uploads a spreadsheet doesn't pay their download cost.

export function isExcelFile(file: File): boolean {
  return (
    /\.(xlsx|xls)$/i.test(file.name) ||
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.type === 'application/vnd.ms-excel'
  )
}

export async function excelToPdf(file: File): Promise<File> {
  const XLSX = await import('xlsx')
  const [{ default: JsPDF }, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autoTable = ((autoTableMod as any).default ?? autoTableMod) as any

  const bytes = new Uint8Array(await file.arrayBuffer())
  const wb = XLSX.read(bytes, { type: 'array' })
  const doc = new JsPDF({ orientation: 'landscape', unit: 'pt' })

  let rendered = false
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]
    if (!ws) continue
    const rows = (XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' }) as unknown[][])
      .map((r) => r.map((c) => (c == null ? '' : String(c))))
    if (rows.length === 0) continue

    if (rendered) doc.addPage()
    rendered = true
    doc.setFontSize(11)
    doc.text(sheetName, 40, 28)

    const hasBody = rows.length > 1
    autoTable(doc, {
      head: hasBody ? [rows[0]] : undefined,
      body: hasBody ? rows.slice(1) : [rows[0]],
      startY: 38,
      styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: [22, 101, 52] },
      margin: { left: 40, right: 40 },
    })
  }
  if (!rendered) doc.text('Empty spreadsheet.', 40, 40)

  const blob = doc.output('blob')
  const name = file.name.replace(/\.(xlsx|xls)$/i, '') + '.pdf'
  return new File([blob], name, { type: 'application/pdf' })
}
