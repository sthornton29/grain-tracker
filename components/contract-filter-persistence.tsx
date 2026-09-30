'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  clearContractFilterCookie, hasAnyContractFilterParam, savedContractFilters,
  serializeContractFilters, parseContractFilters, writeContractFilterCookie,
} from '@/lib/contract-filters'

// Remembers the contract tracker's filters in the cookie the SERVER reads
// (lib/contract-filters): every filtered view is written; a bare /contracts
// reached from the filter bar (Clear filters, deselecting the last filter)
// has already cleared the cookie before navigating, so an empty query here
// means "show everything" and the memory is dropped too. A bare arrival from
// the nav or a bookmark never renders — the server redirects it to the saved
// filters first — except for the one-time migration of the old localStorage
// memory below.
const LEGACY_KEY = 'contracts:filters'

export default function ContractFilterPersistence() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const explicit = hasAnyContractFilterParam(searchParams)
    const qs = explicit ? serializeContractFilters(parseContractFilters(searchParams)) : ''
    if (explicit) { writeContractFilterCookie(qs); return }

    // Bare URL. Before the cookie existed the memory lived in localStorage:
    // carry it over once, then it is the cookie's job.
    let legacy: string | null = null
    try { legacy = localStorage.getItem(LEGACY_KEY); localStorage.removeItem(LEGACY_KEY) } catch { /* storage unavailable */ }
    const restored = savedContractFilters(legacy)
    if (restored && !document.cookie.includes('turnrow_contract_filters=')) {
      writeContractFilterCookie(restored)
      router.replace(`/contracts?${restored}`)
      return
    }
    clearContractFilterCookie()
  }, [searchParams, router])

  return null
}
