import type { HarvestProgress } from '@/lib/yields'

const fmtAc = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })

/** The harvest-completion tracker shown under a yield number: a green
 *  (done) / amber (in progress) bar over the crop's planted acres, the percent
 *  harvested, and the done · in progress · left acre split. Shared by the
 *  per-crop header cards and the Combined | Full-season | Double-crop tiles so
 *  every cohort reads the same way. Renders nothing without planted acres. */
export default function HarvestProgressBar({ progress }: { progress: HarvestProgress }) {
  if (progress.totalAcres <= 0) return null
  return (
    <div className="mt-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div className="bg-green-600" style={{ width: `${(progress.completedAcres / progress.totalAcres) * 100}%` }} />
        <div className="bg-amber-500" style={{ width: `${(progress.inProgressAcres / progress.totalAcres) * 100}%` }} />
      </div>
      <div className="text-xs font-semibold text-slate-700 mt-1">{progress.pctComplete.toFixed(0)}% harvested</div>
      <div className="text-xs text-slate-500 tabular-nums">
        {fmtAc(progress.completedAcres)} done · {fmtAc(progress.inProgressAcres)} in progress · {fmtAc(progress.remainingAcres)} left
      </div>
    </div>
  )
}
