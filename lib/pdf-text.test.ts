import { describe, expect, it } from 'vitest'
import { countRowsForType, countSettlementRows, linesFromItems, pdfPageTextRows } from '@/lib/pdf-text'

// The Woodall text shape, as pdf.js lines it: the ticket number alone on a
// line, then the vehicle id, grade, date and the figures. Synthetic.
function woodallPage(tickets: Array<{ ticket: string; date: string }>): string[] {
  const lines = ['Woodall Grain Company', 'Settlement No. 77232', 'Contract Number: 93115 Flat $4.70250', 'No. Tickets: 94']
  for (const t of tickets) {
    lines.push(t.ticket, 'Green/Tinus', '1 US #1', t.date, 'Unload 1 Origin FARM', '1,006.429 1,006.429 1,006.429', '56,360 15.000 4.70250 56.000', '$4,732.73 4.6925 100.00 $4,722.67', 'Checkoff\\SPARC: 10.06')
  }
  return lines
}

describe('countSettlementRows', () => {
  it('counts a 5+ digit line followed within 8 lines by a M/D/YYYY date', () => {
    const page = woodallPage([
      { ticket: '211065', date: '8/27/2026' }, { ticket: '211112', date: '8/27/2026' }, { ticket: '211160', date: '08/28/2026' },
    ])
    expect(countSettlementRows(page)).toBe(3)
  })

  it('a contract number, a settlement number or a page number with no date nearby does not count', () => {
    expect(countSettlementRows(['Settlement No.', '77232', 'Contract Number: 93115', '93115', 'Page 1 of 8', 'Totals'])).toBe(0)
    // 5+ digits, a date too far away
    expect(countSettlementRows(['211065', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '8/27/2026'])).toBe(0)
  })

  it('the Deduction Summary page has no tickets', () => {
    expect(countSettlementRows(['Deduction Summary', 'Checkoff\\SPARC 994.57', 'Totals 99,451.424 467,670.35', 'Remit 466,675.78', '10/5/2026'])).toBe(0)
  })

  it('countRowsForType only knows settlements', () => {
    expect(countRowsForType('settlement', woodallPage([{ ticket: '211065', date: '8/27/2026' }]))).toBe(1)
    expect(countRowsForType('gin_receipt', ['12345', '1/1/2026'])).toBeNull()
  })
})

describe('linesFromItems', () => {
  it('groups pdf.js items by baseline, top of the page first, left to right', () => {
    const items = [
      { str: 'Tinus', transform: [1, 0, 0, 1, 80, 700] },
      { str: 'Green/', transform: [1, 0, 0, 1, 40, 700.4] },
      { str: '211065', transform: [1, 0, 0, 1, 40, 720] },
      { str: '  ', transform: [1, 0, 0, 1, 10, 720] },
      { str: '8/27/2026', transform: [1, 0, 0, 1, 40, 680] },
    ]
    expect(linesFromItems(items)).toEqual(['211065', 'Green/ Tinus', '8/27/2026'])
  })
})

describe('pdfPageTextRows', () => {
  it('never runs on the server: null without a window', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'x.pdf', { type: 'application/pdf' })
    expect(await pdfPageTextRows(file)).toBeNull()
  })
})
