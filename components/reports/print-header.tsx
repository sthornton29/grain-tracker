'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// Print-only banner shared by every report (rendered once in the reports layout).
// Stamps the generation date and the CURRENT org's farm name — fetched from
// the signed-in user's own organization, never hardcoded (every customer's
// printouts carry their own name). Each report's own <h1> supplies the title.
//
// `hidden print:block` keeps it out of the on-screen view and only paints it
// when printing. The date is computed on the client so it reflects the day the
// report is actually printed, not a build/render time.
export default function PrintHeader() {
  const supabase = useMemo(() => createClient(), [])
  const [today, setToday] = useState('')
  const [orgName, setOrgName] = useState<string | null>(null)
  useEffect(() => {
    setToday(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))
    ;(async () => {
      const { data } = await supabase.from('organizations').select('name').limit(1).maybeSingle()
      setOrgName((data as { name?: string } | null)?.name ?? null)
    })()
  }, [supabase])
  return (
    <div className="hidden print:flex items-center justify-between border-b border-slate-300 pb-1 mb-3 text-xs text-slate-500">
      <span className="flex items-center gap-1.5 font-semibold text-slate-700">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo-lockup.png" alt="Turnrow" className="h-4 w-auto" />
        {orgName && <span className="font-normal text-slate-400">· {orgName}</span>}
      </span>
      {today && <span>Generated {today}</span>}
    </div>
  )
}
