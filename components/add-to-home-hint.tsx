'use client'

// "Add to Home Screen" nudge for iPad/iPhone Safari. Shows only when the
// page is running in Safari (not already installed — navigator.standalone is
// false there, undefined elsewhere) and the person hasn't dismissed it.
// Dismissal is remembered per browser in localStorage.

import { useEffect, useState } from 'react'

const KEY = 'turnrow:a2hs-dismissed'

export default function AddToHomeHint({ className = '' }: { className?: string }) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    try {
      const nav = navigator as Navigator & { standalone?: boolean }
      const ua = navigator.userAgent
      const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
      if (iOS && safari && nav.standalone === false && !window.localStorage.getItem(KEY)) setShow(true)
    } catch { /* no storage or no navigator — just don't show */ }
  }, [])

  if (!show) return null
  return (
    <div className={`rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 flex items-start gap-3 ${className}`}>
      <span aria-hidden className="text-xl leading-none">📲</span>
      <div className="flex-1">
        <div className="font-semibold">Put Turnrow on your Home Screen</div>
        <div className="text-slate-600">
          Tap the Share button in Safari, then <b>Add to Home Screen</b>. Turnrow opens full-screen, like an app — handy in the truck.
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => { try { window.localStorage.setItem(KEY, '1') } catch { /* fine */ } setShow(false) }}
        className="text-slate-400 hover:text-slate-700 min-h-11 min-w-11 -mr-2 -mt-2 flex items-center justify-center text-lg"
      >
        ✕
      </button>
    </div>
  )
}
