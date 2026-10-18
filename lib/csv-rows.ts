// The ONE CSV tokenizer (RFC 4180-ish): quoted fields, doubled quotes,
// CRLF / LF, a leading BOM. Returns every row as read — blank rows kept,
// cells untrimmed — so a layout-style export (a gin's statement dump, where
// blank rows and label cells carry the structure) can be walked as-is.
// lib/csv parseCsv builds the headered table on top of this.

export function splitCsvRows(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length
  while (i < len) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') {
      row.push(field); field = ''
      rows.push(row)
      row = []
      i++; continue
    }
    field += c; i++
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}
