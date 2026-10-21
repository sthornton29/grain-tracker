'use client'

import BaleQualityReport from '@/components/reports/bale-quality-report'

export default function BaleQualityPage() {
  return (
    <div className="space-y-4">
      <BaleQualityReport />
      <p className="text-sm text-slate-600 no-print max-w-2xl">
        Every classed bale&rsquo;s HVI results, cut any way a buyer asks: by entity, farm, field, variety, gin, receipt or class week,
        with each grade factor colored by the crop year&rsquo;s loan premium and discount bands. Pick a contract that carries quality
        requirements to see what portion of your bales meets it.
      </p>
    </div>
  )
}
