'use client'

// Platform admin: the Ask Turnrow usage log (084) — which tool answered each
// question, and the turns where a data question got NO tool call (the gaps
// that used to surface as screenshots). Metadata only: the question text
// and tool names, never the answer or any farm records.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Row = {
  id: string; created_at: string; answered_at: string | null; org_name: string | null; user_email: string | null; role: string | null
  question: string | null; tools_used: string[] | null; data_question: boolean | null; no_tool_on_data_question: boolean
  redirect_retry: boolean; answer_chars: number | null; error: string | null
}

export default function AssistantUsageLog() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [gapsOnly, setGapsOnly] = useState(false)

  useEffect(() => {
    ;(async () => {
      const { data, error } = await supabase.rpc('admin_assistant_log', { max_rows: 300 })
      if (error) { setErr(error.message.includes('admin_assistant_log') ? 'The usage log needs a database update (084).' : error.message); setRows([]); return }
      setRows((data as Row[]) ?? [])
    })()
  }, [supabase])

  const shown = (rows ?? []).filter((r) => !gapsOnly || r.no_tool_on_data_question || r.redirect_retry || r.error)
  const gaps = (rows ?? []).filter((r) => r.no_tool_on_data_question).length
  const retries = (rows ?? []).filter((r) => r.redirect_retry).length

  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h2 className="font-semibold text-lg">Ask Turnrow usage</h2>
          <p className="text-sm text-slate-500">
            Which tool answered each question. <b>Gap</b> = a data question answered with no tool call; <b>re-asked</b> = the
            never-redirect guard had to send the model back to the data. Questions and tool names only — no answers, no records.
          </p>
        </div>
        <div className="text-sm text-slate-600 whitespace-nowrap">
          last {rows?.length ?? 0} · <span className={gaps ? 'text-red-700 font-semibold' : ''}>{gaps} gap{gaps === 1 ? '' : 's'}</span> · {retries} re-asked
        </div>
        <label className="text-sm flex items-center gap-1.5"><input type="checkbox" checked={gapsOnly} onChange={(e) => setGapsOnly(e.target.checked)} /> gaps &amp; errors only</label>
      </div>
      {err && <p className="text-sm text-amber-700">{err}</p>}
      {rows == null ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing logged yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>{['When', 'Org', 'User', 'Role', 'Question', 'Answered by', 'Flags'].map((h) => <th key={h} className="text-left px-2 py-1.5 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={`border-t border-slate-100 align-top ${r.no_tool_on_data_question ? 'bg-red-50' : r.redirect_retry ? 'bg-amber-50' : ''}`}>
                  <td className="px-2 py-1.5 whitespace-nowrap text-slate-500">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.org_name ?? '—'}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.user_email ?? '—'}</td>
                  <td className="px-2 py-1.5">{r.role ?? '—'}</td>
                  <td className="px-2 py-1.5 max-w-[420px]">{r.question ?? <span className="text-slate-400">(before 084)</span>}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap font-mono text-xs">{(r.tools_used ?? []).length ? (r.tools_used ?? []).join(', ') : <span className="text-slate-400">no tool</span>}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs">
                    {r.no_tool_on_data_question && <span className="rounded-full bg-red-100 text-red-800 px-2 py-0.5 mr-1">gap</span>}
                    {r.redirect_retry && <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 mr-1">re-asked</span>}
                    {r.data_question === false && <span className="rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 mr-1">how-to</span>}
                    {r.error && <span className="rounded-full bg-red-100 text-red-800 px-2 py-0.5" title={r.error}>error</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
