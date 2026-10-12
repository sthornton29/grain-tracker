import type { HarvestProgress } from '@/lib/yields'
import type { CottonCropProgress } from '@/lib/cotton-field-yields'

const fmtAc = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })

/** The harvest-completion tracker shown under a yield number: a green
 *  (done) / amber (in progress) bar over the crop's planted acres, the percent
 *  harvested, and the done · in progress · left acre split. Shared by the
 *  per-crop header cards and the Combined | Full-season | Double-crop tiles so
 *  every cohort reads the same way. Renders nothing without planted acres. */
export default function HarvestProgressBar({ progress, verb = 'harvested' }: {
  progress: HarvestProgress
  /** "harvested" for grain; cotton says "picked". */
  verb?: string
}) {
  if (progress.totalAcres <= 0) return null
  return (
    <div className="mt-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div className="bg-green-600" style={{ width: `${(progress.completedAcres / progress.totalAcres) * 100}%` }} />
        <div className="bg-amber-500" style={{ width: `${(progress.inProgressAcres / progress.totalAcres) * 100}%` }} />
      </div>
      <div className="text-xs font-semibold text-slate-700 mt-1">{progress.pctComplete.toFixed(0)}% {verb}</div>
      <div className="text-xs text-slate-500 tabular-nums">
        {fmtAc(progress.completedAcres)} done · {fmtAc(progress.inProgressAcres)} in progress · {fmtAc(progress.remainingAcres)} left
      </div>
    </div>
  )
}

/** The cotton card's second tracker, the same shape as the one above and over
 *  the same acres: green = fields all ginned, amber = partly ginned, the rest
 *  of the planted acres grey (on the yard or not picked). Nothing planted →
 *  nothing shown. */
export function GinningProgressBar({ progress }: { progress: CottonCropProgress }) {
  if (progress.acresPlanted <= 0) return null
  const notGinned = Math.max(0, progress.acresPlanted - progress.acresGinned - progress.acresPartlyGinned)
  return (
    <div className="mt-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div className="bg-green-600" style={{ width: `${(progress.acresGinned / progress.acresPlanted) * 100}%` }} />
        <div className="bg-amber-500" style={{ width: `${(progress.acresPartlyGinned / progress.acresPlanted) * 100}%` }} />
      </div>
      <div className="text-xs font-semibold text-slate-700 mt-1">{progress.pctGinned.toFixed(0)}% ginned</div>
      <div className="text-xs text-slate-500 tabular-nums">
        {fmtAc(progress.acresGinned)} ginned · {fmtAc(progress.acresPartlyGinned)} partly · {fmtAc(notGinned)} not ginned
      </div>
    </div>
  )
}
