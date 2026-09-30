'use client'

// Settings → Turnrow Farm link (087). Owner-only in practice (the route guard
// keeps every other role off /settings). Generate the one-time pairing code
// (shown once; sha256 stored; 7-day expiry), see the link's status and the
// Turnrow Farm organization it paired with, flip scopes, read the last sync
// per direction with counts and conflicts, rotate the token (shown once —
// paste it into Turnrow Farm), and revoke. Codes and tokens are hashed in
// the browser exactly like /settings/shares; only the hash is stored.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import {
  FARM_LINK_SCOPES,
  FARM_LINK_SCOPE_LABELS,
  formatFarmLinkSecret,
  landManagedByFarm,
  normalizeScopes,
  type FarmLinkRow,
  type FarmLinkScope,
} from '@/lib/farm-link'
import { fmtSyncTime, TURNROW_FARM_URL } from '@/components/farm-link-banner'
import { reportError } from '@/lib/friendly-error'
import { useDialogs } from '@/components/use-dialogs'

type CallRow = { id: string; endpoint: string; method: string; status: number; counts: Record<string, number>; duration_ms: number | null; called_at: string }

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

function ScopeToggle({ scope, checked, onChange, disabled }: { scope: FarmLinkScope; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const meta = FARM_LINK_SCOPE_LABELS[scope]
  return (
    <label className={`flex items-start gap-3 rounded-lg border p-3 ${checked ? 'border-green-200 bg-green-50/40' : 'border-slate-200'} ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-5 w-5 accent-brand" />
      <span>
        <span className="block font-semibold text-sm">
          {meta.title}
          <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${meta.direction === 'in' ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-600'}`}>
            {meta.direction === 'in' ? 'into Grain' : 'out to Farm'}
          </span>
        </span>
        <span className="block text-sm text-slate-600">{meta.blurb}</span>
      </span>
    </label>
  )
}

export default function FarmLinkPage() {
  const supabase = useMemo(() => createClient(), [])
  const [link, setLink] = useState<FarmLinkRow | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [calls, setCalls] = useState<CallRow[]>([])
  // 089: what the landowners exchange currently holds, for the line below.
  const [landownerStats, setLandownerStats] = useState<{ landowners: number; linked: number; changes: number } | null>(null)
  const [fresh, setFresh] = useState<{ kind: 'code' | 'token'; value: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { confirm, dialogs } = useDialogs()

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.from('farm_links').select('*').neq('status', 'revoked').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (error) { setUnavailable(true); setLoaded(true); return }
    const row = (data as FarmLinkRow | null) ?? null
    setLink(row)
    if (row) {
      const c = await fetchAllRows<CallRow>((f, t) =>
        supabase.from('farm_link_calls').select('id, endpoint, method, status, counts, duration_ms, called_at').eq('link_id', row.id).order('called_at', { ascending: false }).order('id').range(f, t), 50)
      setCalls((c.data ?? []).slice(0, 50))
      // Counts only — head requests, so a big operation costs nothing here.
      const [lo, linked, ch] = await Promise.all([
        supabase.from('landowners').select('id', { count: 'exact', head: true }),
        supabase.from('farm_link_ids').select('id', { count: 'exact', head: true }).eq('grain_table', 'landowners'),
        supabase.from('landowner_field_changes').select('id', { count: 'exact', head: true }),
      ])
      setLandownerStats({ landowners: lo.count ?? 0, linked: linked.count ?? 0, changes: ch.count ?? 0 })
    } else {
      setCalls([])
      setLandownerStats(null)
    }
    setLoaded(true)
  }, [supabase])
  useEffect(() => { refresh() }, [refresh])

  async function generateCode() {
    setErr(null); setBusy(true)
    try {
      const code = formatFarmLinkSecret('code', randomHex(16))
      const codeHash = await sha256Hex(code)
      if (link && link.status === 'pending') {
        // Replace the outstanding code: the old one stops working immediately.
        const { error } = await supabase.from('farm_links').update({ code_hash: codeHash, code_expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }).eq('id', link.id)
        if (error) throw error
      } else {
        const { data: userData } = await supabase.auth.getUser()
        const { error } = await supabase.from('farm_links').insert({ code_hash: codeHash, created_by: userData?.user?.id ?? null })
        if (error) throw error
      }
      setFresh({ kind: 'code', value: code })
      setCopied(false)
      await refresh()
    } catch (e) {
      setErr(reportError(e as Error, { action: 'create a pairing code' }))
    } finally {
      setBusy(false)
    }
  }

  async function rotateToken() {
    if (!link) return
    const ok = await confirm({ title: 'Replace the link token?', body: 'Turnrow Farm stops working with the old token right away — paste the new one there as soon as it appears.', confirmLabel: 'Replace token' })
    if (!ok) return
    setErr(null); setBusy(true)
    try {
      const token = formatFarmLinkSecret('token', randomHex(24))
      const { error } = await supabase.from('farm_links').update({ token_hash: await sha256Hex(token), token_rotated_at: new Date().toISOString() }).eq('id', link.id)
      if (error) throw error
      setFresh({ kind: 'token', value: token })
      setCopied(false)
      await refresh()
    } catch (e) {
      setErr(reportError(e as Error, { action: 'replace the link token' }))
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    if (!link) return
    const ok = await confirm({ title: 'Disconnect Turnrow Farm?', body: 'Turnrow Farm loses access immediately. Land records that already came across stay here and become editable again.', confirmLabel: 'Disconnect', danger: true })
    if (!ok) return
    setErr(null); setBusy(true)
    const { error } = await supabase.from('farm_links').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('id', link.id)
    setBusy(false)
    if (error) { setErr(reportError(error, { action: 'disconnect Turnrow Farm' })); return }
    setFresh(null)
    await refresh()
  }

  async function toggleScope(scope: FarmLinkScope, on: boolean) {
    if (!link) return
    const next = normalizeScopes(on ? [...link.scopes, scope] : link.scopes.filter((s) => s !== scope))
    setLink({ ...link, scopes: next })
    const { error } = await supabase.from('farm_links').update({ scopes: next }).eq('id', link.id)
    if (error) { setErr(reportError(error, { action: 'change what is shared' })); refresh() }
  }

  const status = !link ? null
    : link.status === 'active' ? { label: `Connected to ${link.farm_org_name ?? 'Turnrow Farm'}`, cls: 'bg-green-50 text-green-800' }
    : new Date(link.code_expires_at) < new Date() ? { label: 'Pairing code expired', cls: 'bg-amber-50 text-amber-800' }
    : { label: `Waiting for Turnrow Farm (code expires ${link.code_expires_at.slice(0, 10)})`, cls: 'bg-slate-100 text-slate-600' }
  const inbound = link?.last_sync?.inbound ?? null
  const outbound = link?.last_sync?.outbound ?? null
  // last_sync keeps only the most recent outbound pull of any kind, so the
  // insurance line reads the call log instead (088).
  const lastInsurance = calls.find((c) => c.endpoint === 'insurance' && c.status < 400) ?? null
  const lastLandowners = calls.find((c) => c.endpoint.startsWith('landowners') && c.status < 400) ?? null
  const managed = landManagedByFarm(link)
  const scopes = new Set(link?.scopes ?? [])

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Turnrow Farm Link</h1>
      <p className="text-sm text-slate-600 max-w-2xl">
        Connect this organization to the same organization in Turnrow Farm. Turnrow Farm keeps your entities, farms,
        fields, and plantings and sends them here; Turnrow Grain sends back production, marketing, income, and bins.
        Both sides are your own operation, so everything is shared unless you turn a switch off.
      </p>

      {unavailable && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          The Turnrow Farm link isn’t available for your account yet — contact support.
        </div>
      )}

      {fresh && (
        <div className="bg-white rounded-xl shadow p-4 border-2 border-brand space-y-2">
          <p className="font-semibold">
            {fresh.kind === 'code' ? 'Pairing code' : 'New link token'} — visible only now, copy it before leaving this page:
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <code className="text-lg font-mono font-bold break-all">{fresh.value}</code>
            <button onClick={async () => { await navigator.clipboard.writeText(fresh.value); setCopied(true) }} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-3 py-1.5 text-sm font-semibold">
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={() => setFresh(null)} className="text-sm text-slate-600">Done</button>
          </div>
          <p className="text-sm text-slate-500">
            {fresh.kind === 'code'
              ? 'Paste this into Turnrow Farm under Settings > Integrations > Turnrow Grain. It expires in 7 days if unused.'
              : 'Paste this into Turnrow Farm under Settings > Integrations > Turnrow Grain to replace the old token.'}
          </p>
        </div>
      )}

      {err && <p className="text-sm text-red-600">{err}</p>}

      {loaded && !unavailable && !link && (
        <div className="bg-white rounded-xl shadow p-4 space-y-3">
          <p className="text-sm text-slate-600">No link yet. Generate a pairing code and paste it into Turnrow Farm.</p>
          <button onClick={generateCode} disabled={busy} className="rounded-lg bg-brand hover:bg-brand-deep text-white px-4 py-2 font-semibold disabled:opacity-50">
            Generate pairing code
          </button>
        </div>
      )}

      {link && status && (
        <div className="bg-white rounded-xl shadow">
          <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-[12rem]">
              <p className="font-semibold">{link.farm_org_name ?? 'Turnrow Farm'}</p>
              <p className="text-sm text-slate-500">
                created {link.created_at.slice(0, 10)}
                {link.redeemed_at ? ` · paired ${link.redeemed_at.slice(0, 10)}` : ''}
                {link.last_seen_at ? ` · last seen ${fmtSyncTime(link.last_seen_at)}` : ''}
              </p>
            </div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.cls}`}>{status.label}</span>
            {link.status === 'pending' && (
              <button onClick={generateCode} disabled={busy} className="rounded-lg border border-brand text-brand-deep hover:bg-green-50 px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
                New pairing code
              </button>
            )}
            {link.status === 'active' && (
              <button onClick={rotateToken} disabled={busy} className="rounded-lg border border-brand text-brand-deep hover:bg-green-50 px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
                Replace token
              </button>
            )}
            <button onClick={revoke} disabled={busy} className="text-sm font-semibold text-red-600 hover:underline disabled:opacity-50 min-h-11 px-2">Disconnect</button>
          </div>

          <div className="border-t border-slate-100 px-4 py-4 space-y-4">
            <div>
              <h2 className="font-semibold mb-2">What is shared</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {FARM_LINK_SCOPES.map((s) => (
                  <ScopeToggle key={s} scope={s} checked={scopes.has(s)} onChange={(v) => toggleScope(s, v)} disabled={busy} />
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">Changes apply on Turnrow Farm&apos;s next call.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg border border-slate-200 p-3 text-sm space-y-1">
                <p className="font-semibold">From Turnrow Farm (last update)</p>
                {inbound ? (
                  <>
                    <p>{fmtSyncTime(inbound.at)} · {inbound.endpoint}</p>
                    <p className="text-slate-600">
                      {Object.entries(inbound.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'no counts'}
                    </p>
                    {(inbound.conflicts ?? 0) > 0 && (
                      <p className="text-amber-700">
                        {inbound.conflicts} conflict{inbound.conflicts === 1 ? '' : 's'} returned to Turnrow Farm — a record edited here after the last update. Resolve it in Turnrow Farm.
                      </p>
                    )}
                  </>
                ) : <p className="text-slate-500">Nothing received yet.</p>}
                <p className="text-xs text-slate-500">
                  {managed ? 'Land records are managed in Turnrow Farm; the Entities, Farms, Fields, and Plantings pages are read-only for records that came from there.' : 'Until the first land records arrive from Turnrow Farm, they stay editable here.'}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3 text-sm space-y-1">
                <p className="font-semibold">To Turnrow Farm (last pull)</p>
                {outbound ? (
                  <>
                    <p>{fmtSyncTime(outbound.at)} · {outbound.endpoint}</p>
                    <p className="text-slate-600">{outbound.count} record{outbound.count === 1 ? '' : 's'}</p>
                  </>
                ) : <p className="text-slate-500">Nothing pulled yet.</p>}
                <p className="text-xs text-slate-500">
                  {lastInsurance
                    ? `Crop insurance premiums: ${fmtSyncTime(lastInsurance.called_at)} · ${lastInsurance.counts?.served ?? 0} row${(lastInsurance.counts?.served ?? 0) === 1 ? '' : 's'}`
                    : scopes.has('insurance:read')
                      ? 'Crop insurance premiums: not pulled yet. In Turnrow Farm, open the Turnrow Grain settings and choose Update now.'
                      : 'Crop insurance premiums are turned off. Turn the switch on above, then re-pair in Turnrow Farm if it does not offer them.'}
                </p>
              </div>
            </div>

            {scopes.has('landowners:write') && (
              <div className="rounded-lg border border-slate-200 p-3 text-sm space-y-1">
                <p className="font-semibold">Landowners (both ways)</p>
                {landownerStats ? (
                  <p className="text-slate-600">
                    {landownerStats.landowners} landowner{landownerStats.landowners === 1 ? '' : 's'}
                    {' · '}{landownerStats.linked} shared with Turnrow Farm
                  </p>
                ) : <p className="text-slate-500">Nothing shared yet.</p>}
                <p className="text-slate-600">
                  {lastLandowners
                    ? `Last exchange ${fmtSyncTime(lastLandowners.called_at)} · ${Object.entries(lastLandowners.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'no counts'}`
                    : 'No exchange yet. In Turnrow Farm, open the Turnrow Grain settings and choose Update now.'}
                </p>
                <p className="text-xs text-slate-500">
                  Either side can edit a landowner. Turnrow Grain keeps a 90-day history of what changed so the two sides
                  merge field by field instead of overwriting each other
                  {landownerStats ? ` (${landownerStats.changes} change${landownerStats.changes === 1 ? '' : 's'} on file)` : ''}.
                </p>
              </div>
            )}

            {calls.length > 0 && (
              <div>
                <h2 className="font-semibold mb-2">Recent activity</h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>{['When', 'Call', 'Result', 'Counts'].map((h) => <th key={h} className="text-left px-3 py-1.5 whitespace-nowrap">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {calls.map((c) => (
                        <tr key={c.id} className="border-t border-slate-100">
                          <td className="px-3 py-1.5 whitespace-nowrap">{fmtSyncTime(c.called_at)}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">{c.method} {c.endpoint}</td>
                          <td className={`px-3 py-1.5 ${c.status >= 400 ? 'text-red-700' : 'text-green-700'}`}>{c.status < 400 ? 'ok' : c.status}</td>
                          <td className="px-3 py-1.5 text-slate-600">{Object.entries(c.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <p className="text-sm text-slate-500">
        Turnrow Farm: <a href={TURNROW_FARM_URL} target="_blank" rel="noopener noreferrer" className="text-brand-deep underline">turnrowfm.com</a>
      </p>
      {dialogs}
    </div>
  )
}
