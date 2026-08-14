// Export branding modes. Default is Turnrow chrome; `mode: 'org'` renders a
// document under the FARM'S OWN identity — org display name, org logo, org
// address — with ZERO Turnrow marks (no wordmark, no /brand/ assets, no
// "Turnrow ·" attribution). Built for landowner/lender-facing documents the
// farm mails out (the Rent Settlement statement first); any export can opt
// in by putting `branding` on its ExportPayload.
//
// exportChrome() is the single source of every branded string/asset/color
// the export layer emits — lib/branding.test.ts pins that the org mode's
// chrome never contains a Turnrow mark.

import type { SupabaseClient } from '@supabase/supabase-js'

export type OrgBrandingInfo = {
  displayName: string
  logoUrl: string | null
  addressLines: string[]
  contactLine: string | null
}

export type ExportBranding =
  | { mode: 'turnrow' }
  | ({ mode: 'org' } & OrgBrandingInfo)

export type ExportChrome = {
  /** "<name> · Generated <ts>" prefix for Excel attribution rows. */
  attributionPrefix: string
  /** Text next to the logo in the PDF header. */
  wordmark: string
  /** Spaced-caps styling only suits the Turnrow wordmark. */
  wordmarkSpaced: boolean
  /** RGB for the PDF wordmark text. */
  wordmarkColor: [number, number, number]
  /** Logo image URL for the PDF header (null = text only). */
  logoAssetUrl: string | null
  /** Extra header lines (org address / contact) under the title. */
  headerLines: string[]
  /** Table-header fill: Excel ARGB + PDF RGB. */
  excelHeaderArgb: string
  pdfHeadFill: [number, number, number]
}

export function exportChrome(branding?: ExportBranding): ExportChrome {
  if (branding?.mode === 'org') {
    return {
      attributionPrefix: branding.displayName,
      wordmark: branding.displayName,
      wordmarkSpaced: false,
      wordmarkColor: [15, 23, 42], // slate-900 — deliberately brand-neutral
      logoAssetUrl: branding.logoUrl,
      headerLines: [...branding.addressLines, ...(branding.contactLine ? [branding.contactLine] : [])],
      excelHeaderArgb: 'FF334155', // slate-700
      pdfHeadFill: [51, 65, 85],
    }
  }
  return {
    attributionPrefix: 'Turnrow',
    wordmark: 'TURNROW',
    wordmarkSpaced: true,
    wordmarkColor: [11, 74, 36], // brand forest
    logoAssetUrl: '/brand/logo-mark.png',
    headerLines: [],
    excelHeaderArgb: 'FF166534',
    pdfHeadFill: [22, 101, 52],
  }
}

/** The org's branding for `mode: 'org'` exports — display name falls back to
 *  the org name. RLS returns the caller's own org row. */
export async function fetchOrgBranding(supabase: SupabaseClient): Promise<OrgBrandingInfo> {
  const { data } = await supabase
    .from('organizations')
    .select('name, branding_display_name, branding_logo_url, branding_address, branding_contact')
    .limit(1)
    .maybeSingle()
  const row = data as {
    name?: string
    branding_display_name?: string | null
    branding_logo_url?: string | null
    branding_address?: string | null
    branding_contact?: string | null
  } | null
  return {
    displayName: row?.branding_display_name?.trim() || row?.name || 'Farm',
    logoUrl: row?.branding_logo_url ?? null,
    addressLines: (row?.branding_address ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
    contactLine: row?.branding_contact?.trim() || null,
  }
}
