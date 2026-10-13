import { describe, expect, it } from 'vitest'
import { classifyParseError, parseDocumentChunked, type ParseAttempt } from '@/lib/parse-chunked'
import { ParseTimeoutError, ParseTooLongError, type ParseImage, type ParseOptions } from '@/lib/pdf-upload'
import { jsonLooksTruncated, stripFences } from '@/lib/parse-response'

// The splitter's mechanics with a SCRIPTED model and a fake PDF: the page
// count and the slicer are injected, so no pdf-lib runs. A sliced "file" is
// named p{from}-{to}.pdf and the scripted parser reads the range off it.

type Part = { items: number[] }
const WHOLE = 'doc.pdf'
const fakePdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], WHOLE, { type: 'application/pdf' })
const slicer = async (_f: File, from: number, to: number) => new File([new Uint8Array([1])], `p${from}-${to}.pdf`, { type: 'application/pdf' })

function rangeOf(input: File | ParseImage[], total: number): { from: number; to: number } {
  if (Array.isArray(input)) throw new Error('photos go through photoRange')
  if (input.name === WHOLE) return { from: 1, to: total }
  const m = /^p(\d+)-(\d+)\.pdf$/.exec(input.name)!
  return { from: Number(m[1]), to: Number(m[2]) }
}

type Script = (r: { from: number; to: number }, opts: ParseOptions, nth: number) => Part | Error
function scripted(total: number, script: Script) {
  const calls: Array<{ from: number; to: number; maxTokens?: number }> = []
  const seen = new Map<string, number>()
  const parse = async (input: File | ParseImage[], _t: unknown, opts: ParseOptions) => {
    const r = rangeOf(input, total)
    calls.push({ ...r, maxTokens: opts.maxTokens })
    const key = `${r.from}-${r.to}`
    const nth = (seen.get(key) ?? 0) + 1
    seen.set(key, nth)
    const out = script(r, opts, nth)
    if (out instanceof Error) throw out
    opts.onUsage?.({ input_tokens: 1000, output_tokens: out.items.length * 10, stop_reason: 'end_turn' })
    return out
  }
  return { parse, calls }
}
const pagesOf = (r: { from: number; to: number }): Part => ({ items: Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i) })
const merge = (parts: Part[]): Part => ({ items: parts.flatMap((p) => p.items) })
const log = (a: ParseAttempt[]) => a.map((x) => `${x.from}-${x.to}:${x.outcome}`)

async function run(total: number, script: Script, extra: Record<string, unknown> = {}) {
  const { parse, calls } = scripted(total, script)
  const res = await parseDocumentChunked<Part>(fakePdf(), 'settlement', {
    merge, parse, slice: slicer, pageCount: async () => total, textRows: async () => null, ...extra,
  })
  return { ...res, calls }
}

describe('classifyParseError', () => {
  it('TOO_LONG and TIMEOUT split; anything else is a plain error', () => {
    expect(classifyParseError(new ParseTooLongError())).toBe('too_long')
    expect(classifyParseError(new ParseTimeoutError())).toBe('timeout')
    expect(classifyParseError({ code: 'TOO_LONG' })).toBe('too_long')
    expect(classifyParseError(new Error('Server returned 500.'))).toBe('error')
    expect(classifyParseError(null)).toBe('error')
  })
})

describe('adaptive split', () => {
  it('halves a too-long chunk depth-first, in order, until each half reads', async () => {
    const res = await run(8, (r) => (r.to - r.from + 1 > 2 ? new ParseTooLongError() : pagesOf(r)), { pagesPerBatch: 8 })
    expect(log(res.attempts)).toEqual([
      '1-8:too_long', '1-4:too_long', '1-2:ok', '3-4:ok', '5-8:too_long', '5-6:ok', '7-8:ok',
    ])
    expect(res.data.items).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(res.failedRanges).toEqual([])
    expect(res.failedPages).toBeNull()
    expect(res.warning).toBeNull()
    expect(res.pagesRead).toBe(8)
    expect(res.attempts.find((a) => a.outcome === 'ok')?.outputTokens).toBe(20)
  })

  it('a single page that still truncates gets ONE boosted retry (16384), then reads', async () => {
    const res = await run(4, (r, opts) => {
      if (r.to - r.from + 1 > 1) return new ParseTooLongError()
      if (r.from === 3 && (opts.maxTokens ?? 0) < 16384) return new ParseTooLongError('cut', { outputTokens: 8192 })
      return pagesOf(r)
    }, { pagesPerBatch: 4 })
    expect(log(res.attempts)).toEqual(['1-4:too_long', '1-2:too_long', '1-1:ok', '2-2:ok', '3-4:too_long', '3-3:too_long', '3-3:ok', '4-4:ok'])
    const boosted = res.calls.filter((c) => c.from === 3 && c.to === 3).map((c) => c.maxTokens)
    expect(boosted).toEqual([8192, 16384])
    expect(res.attempts.filter((a) => a.from === 3 && a.to === 3)[0].outputTokens).toBe(8192)
    expect(res.data.items).toEqual([1, 2, 3, 4])
  })

  it('a page that truncates even boosted is recorded failed as too_long — once, no further retries', async () => {
    const res = await run(4, (r) => (r.from <= 3 && r.to >= 3 ? new ParseTooLongError() : pagesOf(r)), { pagesPerBatch: 4 })
    expect(log(res.attempts)).toEqual(['1-4:too_long', '1-2:ok', '3-4:too_long', '3-3:too_long', '3-3:too_long', '4-4:ok'])
    expect(res.failedRanges).toEqual([{ from: 3, to: 3, reason: 'too_long', message: expect.any(String) }])
    expect(res.failedPages).toBe('3')
    expect(res.warning).toBe('Page 3 returned no tickets after several tries.')
    expect(res.pagesRead).toBe(3)
    expect(res.data.items).toEqual([1, 2, 4])
  })

  it('a TIMEOUT splits the chunk like a truncation; a single page that times out is tried once more', async () => {
    const res = await run(4, (r, _o, nth) => {
      if (r.to - r.from + 1 > 2) return new ParseTimeoutError()
      if (r.from === 2 && r.to === 2 && nth === 1) return new ParseTimeoutError()
      if (r.from === 1 && r.to === 2) return new ParseTimeoutError()
      return pagesOf(r)
    }, { pagesPerBatch: 4 })
    expect(log(res.attempts)).toEqual(['1-4:timeout', '1-2:timeout', '1-1:ok', '2-2:timeout', '2-2:ok', '3-4:ok'])
    expect(res.failedRanges).toEqual([])
    expect(res.data.items).toEqual([1, 2, 3, 4])
  })

  it('a plain error is retried once and never splits; a second failure is recorded', async () => {
    const res = await run(4, (r, _o, nth) => {
      if (r.from === 1 && nth === 1) return new Error('network')
      if (r.from === 3) return new Error('Server returned 500.')
      return pagesOf(r)
    }, { pagesPerBatch: 2 })
    expect(log(res.attempts)).toEqual(['1-2:error', '1-2:ok', '3-4:error', '3-4:error'])
    expect(res.failedRanges).toEqual([{ from: 3, to: 4, reason: 'error', message: 'Server returned 500.' }])
    expect(res.warning).toBe('Pages 3–4 returned no tickets after several tries.')
    expect(res.data.items).toEqual([1, 2])
  })

  it('a plain error whose retry truncates then splits', async () => {
    const res = await run(2, (r, _o, nth) => {
      if (r.to - r.from + 1 === 2) return nth === 1 ? new Error('hiccup') : new ParseTooLongError()
      return pagesOf(r)
    }, { pagesPerBatch: 2 })
    expect(log(res.attempts)).toEqual(['1-2:error', '1-2:too_long', '1-1:ok', '2-2:ok'])
  })

  it('nothing read: a single plain failure rethrows the real error; otherwise a clean summary', async () => {
    await expect(run(1, () => new Error('That PDF is larger than 20 MB.'))).rejects.toThrow('larger than 20 MB')
    await expect(run(2, () => new ParseTooLongError(), { pagesPerBatch: 2 })).rejects.toThrow(/None of the document's pages could be read/)
  })

  it('reads ONLY the ranges asked for (the re-read path) and does not re-straighten the file', async () => {
    const normalized: File[] = []
    const res = await run(8, (r) => pagesOf(r), { pages: [{ from: 3, to: 3 }, { from: 7, to: 8 }], onNormalized: (f: File) => normalized.push(f) })
    expect(log(res.attempts)).toEqual(['3-3:ok', '7-8:ok'])
    expect(res.data.items).toEqual([3, 7, 8])
    expect(normalized).toEqual([])
    // Out-of-range pages are clamped; an empty list reads nothing and throws.
    const clamped = await run(4, (r) => pagesOf(r), { pages: [{ from: 3, to: 9 }] })
    expect(log(clamped.attempts)).toEqual(['3-4:ok'])
  })

  it('hands the (straightened) file back on a first read and labels progress with the split', async () => {
    const normalized: File[] = []
    const labels: string[] = []
    await run(4, (r) => (r.to - r.from + 1 > 2 ? new ParseTooLongError() : pagesOf(r)), {
      pagesPerBatch: 4, onNormalized: (f: File) => normalized.push(f), onProgress: (l: string) => labels.push(l),
    })
    expect(normalized).toHaveLength(1)
    expect(labels).toEqual([
      'Reading the document…',
      'Reading pages 1–2 of 4… (splitting a long section)',
      'Reading pages 3–4 of 4… (splitting a long section)',
    ])
  })

  it('uses the density plan by default: counted rows size the chunks (no too_long at all)', async () => {
    const rows = [11, 14, 14, 14, 14, 14, 13, 0]
    const res = await run(8, (r) => (r.to - r.from + 1 > 2 ? new ParseTooLongError() : pagesOf(r)), {
      textRows: async () => rows.map((n) => Array.from({ length: n }, (_, i) => `${211065 + i}`).flatMap((t) => [t, '8/27/2026'])),
    })
    expect(log(res.attempts)).toEqual(['1-2:ok', '3-4:ok', '5-6:ok', '7-8:ok'])
    // Without a text layer the conservative plan (2 pages a chunk) applies.
    const blind = await run(8, (r) => (r.to - r.from + 1 > 2 ? new ParseTooLongError() : pagesOf(r)))
    expect(log(blind.attempts)).toEqual(['1-2:ok', '3-4:ok', '5-6:ok', '7-8:ok'])
  })
})

describe('photos', () => {
  const photos: ParseImage[] = Array.from({ length: 5 }, (_, i) => ({ base64: `img${i + 1}`, mediaType: 'image/jpeg' }))
  const photoRange = (input: File | ParseImage[]) => {
    const arr = input as ParseImage[]
    const from = Number(arr[0].base64.slice(3))
    return { from, to: from + arr.length - 1 }
  }

  it('slices the array per chunk and halves a too-long chunk', async () => {
    const attempts: string[] = []
    const res = await parseDocumentChunked<Part>(photos, 'tickets', {
      pagesPerBatch: 2,
      merge,
      parse: async (input) => {
        const r = photoRange(input)
        attempts.push(`${r.from}-${r.to}`)
        if (r.from === 1 && r.to === 2) throw new ParseTooLongError()
        return pagesOf(r)
      },
    })
    expect(attempts).toEqual(['1-2', '1-1', '2-2', '3-4', '5-5'])
    expect(res.data.items).toEqual([1, 2, 3, 4, 5])
    expect(res.pagesRead).toBe(5)
  })

  it('names failed photos as photos', async () => {
    const res = await parseDocumentChunked<Part>(photos, 'tickets', {
      pagesPerBatch: 5,
      merge,
      parse: async (input) => {
        const r = photoRange(input)
        if (r.from === 5 && r.to === 5) throw new Error('blurry')
        if (r.to - r.from + 1 > 1) throw new ParseTooLongError()
        return pagesOf(r)
      },
    })
    expect(res.failedRanges).toEqual([{ from: 5, to: 5, reason: 'error', message: 'blurry' }])
    expect(res.warning).toBe('Photo 5 returned no tickets after several tries.')
  })
})

describe('the route helpers: a cut-off answer vs a malformed one', () => {
  it('jsonLooksTruncated', () => {
    expect(jsonLooksTruncated('{"a": [1, 2')).toBe(true)
    expect(jsonLooksTruncated('{"a": [{"ticket_number": "2110')).toBe(true)
    expect(jsonLooksTruncated('{"a": [{"x": 1}, {"y": 2}')).toBe(true) // ends with } but depth 2
    expect(jsonLooksTruncated('{"a": 1}')).toBe(false)
    expect(jsonLooksTruncated('{"a": "}"}')).toBe(false)
    expect(jsonLooksTruncated('{"a": 1} trailing junk')).toBe(true)
    expect(jsonLooksTruncated('')).toBe(false)
  })

  it('stripFences', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripFences('{"a":1}')).toBe('{"a":1}')
  })
})
