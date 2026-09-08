import { describe, it, expect } from 'vitest'
import { matchesAccept, partitionByAccept, filesFromDataTransfer, dragHasFiles } from '@/lib/dropzone'

// A drop is checked against the SAME accept string the picker uses, with the
// browser's own semantics: ".ext", "type/*", or "type/subtype".

const f = (name: string, type: string) => ({ name, type })

describe('matchesAccept — the picker\'s accept list applied to a dropped file', () => {
  it('accepts everything when there is no accept list', () => {
    expect(matchesAccept(f('a.bin', 'application/octet-stream'), undefined)).toBe(true)
    expect(matchesAccept(f('a.bin', ''), '')).toBe(true)
  })
  it('matches a bare extension case-insensitively', () => {
    expect(matchesAccept(f('Grades.CSV', ''), '.csv,text/csv')).toBe(true)
    expect(matchesAccept(f('grades.txt', 'text/plain'), '.csv,text/csv')).toBe(false)
  })
  it('matches a wildcard type', () => {
    expect(matchesAccept(f('shot.png', 'image/png'), 'image/*')).toBe(true)
    expect(matchesAccept(f('shot.heic', 'image/heic'), 'application/pdf,image/*')).toBe(true)
    expect(matchesAccept(f('doc.pdf', 'application/pdf'), 'image/*')).toBe(false)
  })
  it('matches a full MIME type', () => {
    expect(matchesAccept(f('doc.pdf', 'application/pdf'), 'application/pdf,.pdf')).toBe(true)
    expect(matchesAccept(f('logo.gif', 'image/gif'), 'image/png,image/jpeg')).toBe(false)
  })
  it('a PDF with an empty MIME type still matches on its extension', () => {
    expect(matchesAccept(f('scan.pdf', ''), 'application/pdf,.pdf')).toBe(true)
  })
})

describe('partitionByAccept', () => {
  it('splits accepted from rejected in order', () => {
    const files = [f('a.pdf', 'application/pdf'), f('b.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), f('c.jpg', 'image/jpeg')]
    const { accepted, rejected } = partitionByAccept(files, 'application/pdf,image/*')
    expect(accepted.map((x) => x.name)).toEqual(['a.pdf', 'c.jpg'])
    expect(rejected.map((x) => x.name)).toEqual(['b.docx'])
  })
})

describe('filesFromDataTransfer / dragHasFiles', () => {
  it('reads items first, then the files list', () => {
    const file = f('a.csv', 'text/csv') as File
    const viaItems = filesFromDataTransfer({ items: [{ kind: 'file', getAsFile: () => file }] as unknown as DataTransferItemList, files: [] as unknown as FileList })
    expect(viaItems).toEqual([file])
    const viaFiles = filesFromDataTransfer({ items: [] as unknown as DataTransferItemList, files: [file] as unknown as FileList })
    expect(viaFiles).toEqual([file])
    expect(filesFromDataTransfer(null)).toEqual([])
  })
  it('only a drag carrying Files counts', () => {
    expect(dragHasFiles({ types: ['Files'] })).toBe(true)
    expect(dragHasFiles({ types: ['text/plain', 'text/uri-list'] })).toBe(false)
    expect(dragHasFiles(null)).toBe(false)
  })
})
