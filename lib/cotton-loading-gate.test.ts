// CI gate: A SCREEN THAT READS THE COTTON RECORDS WAITS FOR THEM.
//
// useCottonYields answers at once with an inert model (cotton "off") and
// fills in a few seconds later, once a season of gin receipts and bales has
// been read. A screen that renders or exports in between shows cotton acres
// with no production — not an early number, a wrong one. That is how the
// 2026-11-17 Crop Insurance Production export went to an insurance agent's
// desk with 1,432 cotton acres and zero pounds of lint (and no gin tab), and
// it is the same shape as the 2026-11-14 classing import that "did not match"
// because the bales were still loading.
//
// So every file that calls the hook must fold the hook's own `loading` into
// what it shows: `const loading = dataLoading || cottonYields.loading` (or an
// equivalent gate on its export buttons). This test reads the source tree,
// like the other CI gates, and fails with the file name when a new caller
// forgets.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = ['app', 'components', 'lib']

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('every screen that reads the cotton records waits for them', () => {
  const callers: Array<{ file: string; variable: string; text: string }> = []
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf8')
      const m = /const\s+(\w+)\s*=\s*useCottonYields\(/.exec(text)
      if (m) callers.push({ file: file.replace(/\\/g, '/'), variable: m[1], text })
    }
  }

  it('finds the callers (the scan itself works)', () => {
    expect(callers.length).toBeGreaterThanOrEqual(8)
    expect(callers.map((c) => c.file)).toContain('components/reports/crop-insurance-report.tsx')
  })

  it.each(callers.map((c) => [c.file, c] as const))('%s uses the hook\'s loading flag', (_file, c) => {
    // `cottonYields.loading` (or `cotton.loading` in the wrapping hook) must be read somewhere in the file.
    expect(c.text.includes(`${c.variable}.loading`), `${c.file} calls useCottonYields but never reads ${c.variable}.loading — it can show or export numbers before the cotton records arrive`).toBe(true)
  })
})
