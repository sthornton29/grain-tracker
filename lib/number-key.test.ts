import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { numberKey, pbiKey, pbiKeys, pbiMatches, pbiGinCode, sameNumber, stripLeadingZeros } from '@/lib/number-key'
import { normalizeTicket } from '@/lib/ticket-matching'

describe('numberKey — the one cotton number key', () => {
  // The hand-verified list. The SAME pairs sit in supabase/verify_migrations.sql
  // as the SQL parity block for cotton_number_key(text) (see below).
  const CASES: Array<[string, string | null]> = [
    ['031633', '31633'],
    ['31633', '31633'],
    ['0031633', '31633'],
    [' 31632, ', '31632'],
    ['31637_', '31637'],
    ['31633 -', '31633'],
    ['000', '0'],
    ['0', '0'],
    ['', null],
    ['   ', null],
    ['988-1', '988-1'],
    ['A0012', 'A0012'],
    ['m-0031627', 'M-0031627'],
    ['31 633', '31633'],
    ['(31633)', '31633'],
    ['-,.', null],
  ]
  it.each(CASES)('numberKey(%j) = %j', (raw, key) => {
    expect(numberKey(raw)).toBe(key)
  })
  it('null and undefined are null', () => {
    expect(numberKey(null)).toBeNull()
    expect(numberKey(undefined)).toBeNull()
  })
  it('sameNumber: 031633 is 31633; blanks never match', () => {
    expect(sameNumber('031633', '31633')).toBe(true)
    expect(sameNumber('031633', '31634')).toBe(false)
    expect(sameNumber('', '')).toBe(false)
    expect(sameNumber(null, '')).toBe(false)
  })

  it('the SQL parity list in verify_migrations.sql names every TS case that has a key', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase', 'verify_migrations.sql'), 'utf8')
    for (const [raw, key] of [['031633', '31633'], ['0031633', '31633'], ['31632,', '31632'], ['000', '0'], ['988-1', '988-1']]) {
      expect(sql, `parity for ${raw}`).toContain(`cotton_number_key(''${raw}'') = ''${key}''`)
      expect(numberKey(raw)).toBe(key)
    }
    // The migration's SQL mirrors the four steps in the same order.
    const mig = readFileSync(join(process.cwd(), 'supabase', '093_cotton_number_key.sql'), 'utf8')
    expect(mig).toContain('create or replace function public.cotton_number_key(raw text)')
    expect(mig).toMatch(/immutable/i)
    expect(mig).toContain("cotton_loads_org_year_key_unique")
  })
})

describe('stripLeadingZeros shares the grain ticket base without changing grain behavior', () => {
  it('the base', () => {
    expect(stripLeadingZeros('0498074')).toBe('498074')
    expect(stripLeadingZeros('000')).toBe('0')
    expect(stripLeadingZeros('A01')).toBe('A01')
  })
  it('normalizeTicket still keeps spaces, strips zeros only on purely numeric tickets', () => {
    expect(normalizeTicket('0498074')).toBe('498074')
    expect(normalizeTicket(' ab-01 ')).toBe('AB-01')
    expect(normalizeTicket('12  34')).toBe('12 34')
    expect(normalizeTicket('0012-A')).toBe('0012-A')
  })
})

describe('pbiKey / pbiKeys / pbiMatches — 12-digit tags only with a gin code', () => {
  it('digits only, leading zeros stripped', () => {
    expect(pbiKey('179122')).toBe('179122')
    expect(pbiKey('0179122')).toBe('179122')
    expect(pbiKey('PBI# 0179122')).toBe('179122')
    expect(pbiKey('no digits')).toBeNull()
    expect(pbiKey(null)).toBeNull()
  })
  it('"179122" = "0179122"', () => {
    expect(pbiMatches('179122', '0179122')).toBe(true)
    expect(pbiMatches('179122', '179123')).toBe(false)
  })
  it('406140179122 matches 179122 when the gin code is 40614', () => {
    expect(pbiKeys('406140179122', '40614')).toEqual(['406140179122', '179122'])
    expect(pbiMatches('406140179122', '179122', '40614')).toBe(true)
    expect(pbiMatches('179122', '406140179122', '40614')).toBe(true)
  })
  it('does NOT match with gin code 40615', () => {
    expect(pbiKeys('406140179122', '40615')).toEqual(['406140179122'])
    expect(pbiMatches('406140179122', '179122', '40615')).toBe(false)
  })
  it('with no gin code it matches only itself', () => {
    expect(pbiKeys('406140179122')).toEqual(['406140179122'])
    expect(pbiMatches('406140179122', '179122')).toBe(false)
    expect(pbiMatches('406140179122', '406140179122')).toBe(true)
    expect(pbiMatches('406140179122', '0406140179122')).toBe(true)
  })
  it('a gin code with a leading zero still prefixes the tag', () => {
    expect(pbiMatches('040610179122', '179122', '4061')).toBe(true)
    expect(pbiMatches('040610179122', '179122', '04061')).toBe(true)
  })
  it('the tag names its gin', () => {
    expect(pbiGinCode('406140179122')).toBe('40614')
    expect(pbiGinCode('179122')).toBeNull()
  })
})
