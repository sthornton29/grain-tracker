// CI gate: a SERVER component must never call a function (or read a value)
// imported from a 'use client' module. On the server those exports are client
// references, not the real thing, so the call throws at request time — the
// build and the typecheck both pass, and production answers "Application
// error: a server-side exception has occurred" (the /contracts outage of
// 2026-09-30: fmtInt from components/reports/report-kit.tsx).
//
// Rule: from a client module, a server file may import only COMPONENTS
// (PascalCase names, default or named) and types. Helpers and constants
// live in a plain module (components/reports/report-format.ts, lib/*).

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

function isClientModule(p: string): boolean {
  const head = readFileSync(p, 'utf8').slice(0, 400)
  return /^\s*['"]use client['"]/.test(head)
}

function resolveAlias(spec: string): string | null {
  if (!spec.startsWith('@/')) return null
  const base = join(ROOT, spec.slice(2))
  for (const cand of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(cand)) return cand
  }
  return null
}

describe('server files never call helpers from client modules', () => {
  it('every lowercase import from a "use client" module in a server file is flagged', () => {
    const offenders: string[] = []
    for (const file of walk(join(ROOT, 'app'))) {
      const src = readFileSync(file, 'utf8')
      if (/^\s*['"]use client['"]/.test(src.slice(0, 400))) continue
      // The clause may not contain a quote, so one match never spans two statements.
      const importRe = /import\s+([^;'"]*?)\s+from\s+['"](@\/[^'"]+)['"]/g
      let m: RegExpExecArray | null
      while ((m = importRe.exec(src))) {
        const [, clause, spec] = m
        const target = resolveAlias(spec)
        if (!target || !isClientModule(target)) continue
        if (/^type\s/.test(clause.trim())) continue
        const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? ''
        const bad = named.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((s) => !/^type\s/.test(s))
          .map((s) => s.split(/\s+as\s+/)[0].trim())
          .filter((name) => name && !/^[A-Z]/.test(name))
        for (const name of bad) offenders.push(`${file.replace(ROOT, '').replace(/\\/g, '/')} imports '${name}' from client module ${spec}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
