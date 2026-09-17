'use client'

// /admin — Turnrow Farm links across organizations (087, super-admin only via
// the admin_list_farm_links RPC, which re-checks is_super_admin). Metadata
// only: org, Farm org name, status, scopes, dates, last-sync times. No land
// records, no tokens, no codes.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Row = {
  link_id: string; org_id: string; org_name: string; farm_org_name: string | null; status: string; scopes: string[]
  created_at: string; redeemed_at: string | null; revoked_at: string | null; last_seen_at: string | null
  last_inbound_at: string | null; last_outbound_at: string | null
}

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')

export default function FarmLinksPanel() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    ;(async () => {
      const { data, error } = await supabase.rpc('admin_list_farm_links')
      if (error) { setErr(error.message.includes('does not exist') ? 'Farm links need a database update.' : error.message); setRows([]); return }
      setRows((data as Row[]) || [])
    })()
  }, [supabase])
  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-3">
      <h2 className="font-semibold text-lg">Turnrow Farm links</h2>
      {err && <p className="text-sm text-amber-700">{err}</p>}
      {rows && rows.length === 0 && !err && <p className="text-sm text-slate-500">No organization has paired with Turnrow Farm yet.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>{['Organization', 'Turnrow Farm org', 'Status', 'Scopes', 'Paired', 'Last seen', 'Last from Farm', 'Last to Farm'].map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.link_id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-semibold">{r.org_name}</td>
                  <td className="px-3 py-2">{r.farm_org_name ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === 'active' ? 'bg-green-50 text-green-800' : r.status === 'revoked' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'}`}>{r.status}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">{(r.scopes ?? []).length} of 7</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmt(r.redeemed_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmt(r.last_seen_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmt(r.last_inbound_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmt(r.last_outbound_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-500">Status and dates only — pairing codes, tokens, and land records are never shown here.</p>
    </section>
  )
}
