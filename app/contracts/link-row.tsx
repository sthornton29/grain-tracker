'use client'

// A table row that opens a page when tapped anywhere on it (iPad: no hunting
// for the one link), while real links/buttons inside the row still work on
// their own. Server tables render this with server-rendered cells as children.

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'

export default function LinkRow({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const router = useRouter()
  return (
    <tr
      className={`cursor-pointer hover:bg-slate-50 ${className ?? ''}`}
      onClick={(e) => {
        const el = e.target as HTMLElement
        if (el.closest('a, button, input, select, label')) return
        router.push(href)
      }}
    >
      {children}
    </tr>
  )
}
