'use client'

import { useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

// Makes the contract tracker's URL-driven filters STICK: the current query
// string is remembered, and arriving at a bare /contracts (from the nav, a
// bookmark, tomorrow morning) restores the last filters. Only the FIRST
// mount restores — once the page is open, an empty query is an intentional
// "show everything" (the Clear filters button, or deselecting the last
// filter) and clears the memory instead.
const KEY = 'contracts:filters'

export default function ContractFilterPersistence() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const firstRun = useRef(true)

  useEffect(() => {
    const qs = searchParams.toString()
    if (firstRun.current) {
      firstRun.current = false
      if (!qs) {
        let saved: string | null = null
        try { saved = localStorage.getItem(KEY) } catch { /* storage unavailable */ }
        if (saved) {
          router.replace(`/contracts?${saved}`)
          return
        }
      }
    }
    try {
      if (qs) localStorage.setItem(KEY, qs)
      else localStorage.removeItem(KEY)
    } catch { /* storage unavailable */ }
  }, [searchParams, router])

  return null
}
