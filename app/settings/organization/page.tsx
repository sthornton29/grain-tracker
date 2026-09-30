'use client'

// Settings → Organization — the farm's own branding for org-branded
// documents (069): display name, logo, address, contact line. The Rent
// Settlement statement renders EXCLUSIVELY under this identity (no Turnrow
// marks); other landowner/lender-facing exports can opt in later via the
// export layer's `branding: 'org'` mode. Also holds the operation-wide
// Cotton switch (app_settings.cotton_module_enabled — moved here from the
// old Users & Modules page). Owner-only in practice: every other role is
// redirected off /settings by the route guard, and the organizations write
// policies are owner + own-org scoped.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { uploadFileToStorage, deleteStorageObject } from '@/lib/pdf-upload'
import { reportError } from '@/lib/friendly-error'
import Dropzone from '@/components/dropzone'

type OrgRow = {
  id: string
  name: string
  branding_display_name: string | null
  branding_logo_url: string | null
  branding_logo_path: string | null
  branding_address: string | null
  branding_contact: string | null
}

const INPUT = 'w-full rounded-lg border border-slate-300 px-3 py-2 min-h-11'

export default function OrganizationSettingsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [org, setOrg] = useState<OrgRow | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [address, setAddress] = useState('')
  const [contact, setContact] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // The Cotton switch (app_settings row for this org via RLS, 054).
  const [cottonEnabled, setCottonEnabled] = useState<boolean | null>(null)
  const [settingsId, setSettingsId] = useState<number | null>(null)
  const [cottonMsg, setCottonMsg] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const [orgRes, settingsRes] = await Promise.all([
        supabase
          .from('organizations')
          .select('id, name, branding_display_name, branding_logo_url, branding_logo_path, branding_address, branding_contact')
          .limit(1)
          .maybeSingle(),
        supabase.from('app_settings').select('id, cotton_module_enabled').limit(1).maybeSingle(),
      ])
      const settingsRow = settingsRes.data as { id?: number; cotton_module_enabled?: boolean } | null
      if (!settingsRes.error) {
        setCottonEnabled(Boolean(settingsRow?.cotton_module_enabled))
        setSettingsId(settingsRow?.id ?? null)
      }
      if (orgRes.error) {
        // Pre-069: branding columns missing. Fall back to the plain row so the
        // page still explains itself instead of white-screening.
        const { data: basic } = await supabase.from('organizations').select('id, name').limit(1).maybeSingle()
        if (basic) setOrg({ ...(basic as { id: string; name: string }), branding_display_name: null, branding_logo_url: null, branding_logo_path: null, branding_address: null, branding_contact: null })
        setErr(reportError(orgRes.error, { action: 'load your organization details' }))
        return
      }
      const row = orgRes.data as OrgRow | null
      if (row) {
        setOrg(row)
        setDisplayName(row.branding_display_name ?? '')
        setAddress(row.branding_address ?? '')
        setContact(row.branding_contact ?? '')
      }
    })()
  }, [supabase])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!org) return
    setBusy(true); setErr(null); setMsg(null)
    const { error } = await supabase
      .from('organizations')
      .update({
        branding_display_name: displayName.trim() || null,
        branding_address: address.trim() || null,
        branding_contact: contact.trim() || null,
      })
      .eq('id', org.id)
    setBusy(false)
    if (error) { setErr(reportError(error, { action: 'save your organization details' })); return }
    setMsg('Saved.')
    setOrg({ ...org, branding_display_name: displayName.trim() || null, branding_address: address.trim() || null, branding_contact: contact.trim() || null })
  }

  async function toggleCotton(next: boolean) {
    if (settingsId == null) return
    setBusy(true); setErr(null); setCottonMsg(null)
    const { error } = await supabase.from('app_settings')
      .update({ cotton_module_enabled: next, updated_at: new Date().toISOString() })
      .eq('id', settingsId)
    setBusy(false)
    if (error) { setErr(reportError(error, { action: next ? 'turn on Cotton' : 'turn off Cotton' })); return }
    setCottonEnabled(next)
    setCottonMsg(next ? 'Cotton is on. The Cotton tab appears after the next page load.' : 'Cotton is off. The Cotton tab disappears after the next page load — nothing was deleted.')
  }

  async function onLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    await saveLogo(file)
  }

  // Shared by the picker and a drop; the type/size checks live here so a
  // dropped .gif or .pdf gets the same message a picked one would.
  async function saveLogo(file: File) {
    if (!org) return
    if (!file.type.startsWith('image/')) { setErr('The logo must be an image (PNG or JPG).'); return }
    if (file.size > 2 * 1024 * 1024) { setErr('Keep the logo under 2 MB.'); return }
    setBusy(true); setErr(null); setMsg(null)
    try {
      const { publicUrl, path } = await uploadFileToStorage(supabase, file, 'branding')
      const { error } = await supabase.from('organizations').update({ branding_logo_url: publicUrl, branding_logo_path: path }).eq('id', org.id)
      if (error) throw error
      // Best-effort cleanup of the replaced logo.
      if (org.branding_logo_path) { try { await deleteStorageObject(supabase, org.branding_logo_path) } catch { /* keep going */ } }
      setOrg({ ...org, branding_logo_url: publicUrl, branding_logo_path: path })
      setMsg('Logo updated.')
    } catch (error) {
      setErr(reportError(error as Error, { action: 'upload the logo' }))
    } finally {
      setBusy(false)
    }
  }

  async function removeLogo() {
    if (!org?.branding_logo_url) return
    setBusy(true); setErr(null)
    const { error } = await supabase.from('organizations').update({ branding_logo_url: null, branding_logo_path: null }).eq('id', org.id)
    if (!error && org.branding_logo_path) { try { await deleteStorageObject(supabase, org.branding_logo_path) } catch { /* fine */ } }
    setBusy(false)
    if (error) { setErr(reportError(error, { action: 'remove the logo' })); return }
    setOrg({ ...org, branding_logo_url: null, branding_logo_path: null })
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-2xl font-bold">Organization</h1>
      <p className="text-sm text-slate-500">
        How your operation appears on documents you send out — the Rent Settlement statement uses exactly this
        (your name and logo, nothing else). Leave the display name blank to use <b>{org?.name ?? 'your operation name'}</b>.
      </p>

      <form onSubmit={save} className="bg-white rounded-xl shadow p-4 space-y-3">
        <label className="block text-sm text-slate-700">
          Display name on documents
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={org?.name ?? ''} className={`${INPUT} mt-1`} />
        </label>
        <label className="block text-sm text-slate-700">
          Address (one line per row)
          <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={3} placeholder={'123 County Road 12\nAnytown, ST 00000'} className={`${INPUT} mt-1`} />
        </label>
        <label className="block text-sm text-slate-700">
          Contact line
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="(555) 555-0100 · office@yourfarm.com" className={`${INPUT} mt-1`} />
        </label>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy || !org} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 min-h-11 font-semibold disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
          {msg && <span className="text-sm text-green-700">{msg}</span>}
        </div>
      </form>

      <div className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">Logo</h2>
        {org?.branding_logo_url ? (
          <div className="flex items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={org.branding_logo_url} alt="Organization logo" className="h-16 w-auto rounded border border-slate-200 bg-white p-1" />
            <button type="button" onClick={removeLogo} disabled={busy} className="text-sm text-red-600 underline decoration-dotted disabled:opacity-50 min-h-11">Remove</button>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No logo yet — documents show your display name in text.</p>
        )}
        <Dropzone
          onFiles={(files) => void saveLogo(files[0])}
          onReject={() => setErr('The logo must be an image (PNG or JPG).')}
          accept="image/png,image/jpeg"
          disabled={busy || !org}
          hint="Drop the logo here"
          variant="compact"
          accepts="PNG or JPG under 2 MB"
          className="inline-block"
        >
          <label className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm cursor-pointer">
            {busy ? 'Working…' : org?.branding_logo_url ? 'Replace logo…' : 'Upload logo…'}
            <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={onLogo} disabled={busy || !org} />
          </label>
        </Dropzone>
        <p className="text-xs text-slate-500">PNG with a transparent background looks best. Square or wide, under 2 MB.</p>
      </div>

      <section className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">Cotton</h2>
        <label className="flex items-start gap-3 text-sm min-h-11">
          <input
            type="checkbox"
            checked={cottonEnabled ?? false}
            disabled={busy || cottonEnabled == null}
            onChange={(e) => toggleCotton(e.target.checked)}
            className="mt-0.5 h-5 w-5 accent-brand"
          />
          <span>
            <b>Turn on Cotton for this operation</b> — seed cotton loads, gin receipts, bales and classing, cotton yields
            and marketing. Turning it off hides those pages and report sections; nothing is deleted.
            <span className="block text-xs text-slate-500 mt-0.5">The Cotton tab appears after the next page load.</span>
          </span>
        </label>
        {cottonMsg && <p className="text-sm text-green-700">{cottonMsg}</p>}
      </section>

      {err && <p className="text-sm text-red-600">{err}</p>}
    </div>
  )
}
