// TEST SUPPORT — "look at the real file".
//
// A test that builds an ExportPayload can hand it to dumpExport(). Normally
// that only proves the workbook (and the PDF) build. With EXPORT_DUMP_DIR set
// it also writes the finished files to that folder, so a person can open them
// in Excel and a PDF viewer:
//
//   EXPORT_DUMP_DIR=<folder> npx vitest run lib/export-dump.test.ts
//   EXPORT_DUMP_DIR=<folder> npx vitest run        (every export a test builds)
//
// Nothing in the app imports this (it writes with node:fs).

import { excelFileBytes, payloadHasFormulas, pdfFileBytes, type ExportPayload } from '@/lib/exports'

export async function dumpExport(name: string, payload: ExportPayload): Promise<{ xlsx: Uint8Array; pdf: Uint8Array | null }> {
  const xlsx = await excelFileBytes(payload)
  // A formula workbook is Excel-only: its report keeps a separate, screen-shaped payload for the PDF.
  const pdf = payloadHasFormulas(payload) || payload.fullCalcOnLoad ? null : await pdfFileBytes(payload)
  const dir = process.env.EXPORT_DUMP_DIR
  if (dir) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.xlsx`), Buffer.from(xlsx))
    if (pdf) writeFileSync(join(dir, `${name}.pdf`), Buffer.from(pdf))
  }
  return { xlsx, pdf }
}
