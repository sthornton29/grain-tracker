// Export branding modes (069). The load-bearing guarantee: `mode: 'org'`
// NEVER emits a Turnrow mark — no wordmark, no "Turnrow ·" attribution, no
// /brand/ asset path, no brand-green fills — because the Rent Settlement
// statement goes out under the FARM'S identity. exportChrome() is the single
// source of every branded string/asset the export layer renders, so pinning
// it here pins the whole surface.

import { describe, expect, it } from 'vitest'
import { exportChrome, type ExportBranding } from './branding'
import { buildSettlement, settlementExportPayload, type LeaseTermsShape } from './rent-settlement'

const ORG: ExportBranding = {
  mode: 'org',
  displayName: 'Thornton Farms',
  logoUrl: 'https://example.supabase.co/storage/v1/object/public/documents/org-1/branding/logo.png',
  addressLines: ['1200 Bluff Road', 'Decatur, AL 35601'],
  contactLine: '(256) 555-0142',
}

describe('exportChrome — turnrow default', () => {
  it('keeps the Turnrow wordmark, mark asset, and brand colors', () => {
    const c = exportChrome(undefined)
    expect(c.wordmark).toBe('TURNROW')
    expect(c.attributionPrefix).toBe('Turnrow')
    expect(c.logoAssetUrl).toBe('/brand/logo-mark.png')
    expect(c.excelHeaderArgb).toBe('FF166534')
    expect(c.pdfHeadFill).toEqual([22, 101, 52])
    expect(exportChrome({ mode: 'turnrow' })).toEqual(c)
  })
})

describe('exportChrome — org mode never emits Turnrow assets', () => {
  it('every chrome string/asset is the org’s, with neutral colors', () => {
    const c = exportChrome(ORG)
    const flat = JSON.stringify(c).toLowerCase()
    expect(flat).not.toContain('turnrow')
    expect(flat).not.toContain('/brand/')
    expect(c.wordmark).toBe('Thornton Farms')
    expect(c.attributionPrefix).toBe('Thornton Farms')
    expect(c.logoAssetUrl).toBe(ORG.mode === 'org' ? ORG.logoUrl : null)
    expect(c.headerLines).toEqual(['1200 Bluff Road', 'Decatur, AL 35601', '(256) 555-0142'])
    // Brand green is chrome-only and must not leak into org documents.
    expect(c.excelHeaderArgb).not.toBe('FF166534')
    expect(c.pdfHeadFill).not.toEqual([22, 101, 52])
    expect(c.wordmarkColor).not.toEqual([11, 74, 36])
  })

  it('an org with no logo renders text-only (no fallback to the Turnrow mark)', () => {
    const c = exportChrome({ ...ORG, logoUrl: null })
    expect(c.logoAssetUrl).toBeNull()
  })
})

describe('the org-branded settlement payload carries no Turnrow text', () => {
  it('statement + org chrome together contain no Turnrow reference', () => {
    const terms: LeaseTermsShape = {
      leaseType: 'cash', shareTerms: null, expenseTerms: [], pricingMethod: null,
      cashTerms: { perAcre: null, totalAnnual: 15_000 }, flexTerms: [], paymentTiming: 'March 1',
    }
    const result = buildSettlement({ terms, production: [], totalAcres: 0, gapValues: {}, cropYear: 2026, landownerName: 'Jones Family', generatedAt: '2026-08-14T12:00:00Z' })
    if (!result.ok) throw new Error('unexpected gaps')
    const payload = { ...settlementExportPayload({ statement: result.statement }), branding: ORG }
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('turnrow')
  })
})
