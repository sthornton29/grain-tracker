'use client'

import { useEffect, useState } from 'react'

// Print-only banner shared by every report (rendered once in the reports layout).
// Stamps the generation date so a printed report is self-describing; each
// report's own <h1> (now printable) supplies the title, and report bodies show
// their active crop-year/filter context in their section headings.
//
// `hidden print:block` keeps it out of the on-screen view and only paints it
// when printing. The date is computed on the client so it reflects the day the
// report is actually printed, not a build/render time.
export default function PrintHeader() {
  const [today, setToday] = useState('')
  useEffect(() => {
    setToday(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))
  }, [])
  return (
    <div className="hidden print:flex items-center justify-between border-b border-slate-300 pb-1 mb-3 text-xs text-slate-500">
      <span className="flex items-center gap-1.5 font-semibold text-slate-700">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo-mark.svg" alt="" className="h-4 w-4" />
        <span className="tracking-[0.18em]">TURNROW</span>
        <span className="font-normal text-slate-400">· Turnrow Farm</span>
      </span>
      {today && <span>Generated {today}</span>}
    </div>
  )
}
