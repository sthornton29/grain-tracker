import type { CropAverage, HarvestProgress } from '@/lib/yields'

type Props = {
  /** Crop id → weighted average, as returned by analyzeYields. */
  averages: Map<string, CropAverage>
  /** Resolve a crop id to its display name. */
  cropName: (cropId: string) => string
  label?: string
  /** When provided, each crop card also shows a harvest-completion tracker and
   *  every crop with planted acres is listed (even 0%-harvested ones). */
  progress?: Map<string, HarvestProgress>
}

// A row of per-crop cards shown at the top of the yield views: average yield,
// and (when `progress` is given) a harvest-completion tracker. Yield reflects
// only harvested, non-in-progress fields. Renders nothing when there's nothing
// to summarize.
export default function AvgYieldHeader({ averages, cropName, label = 'Average yield by crop', progress }: Props) {
  const cropIds = progress ? [...progress.keys()] : [...averages.keys()]
  const items = cropIds
    .map((id) => ({
      id,
      name: cropName(id) || '—',
      avg: averages.get(id) ?? null,
      prog: progress?.get(id) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (items.length === 0) return null

  const fmtAc = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })

  return (
    <div className="bg-white rounded-xl shadow p-3 avoid-break">
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">{label}</div>
      <div className="flex flex-wrap gap-2">
        {items.map((a) => (
          <div key={a.id} className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 min-w-[12rem]">
            <div className="text-sm font-semibold text-slate-700">{a.name}</div>
            <div className="text-2xl font-bold tabular-nums leading-tight">
              {a.avg ? a.avg.yield.toFixed(1) : '—'}
              <span className="text-sm font-medium text-slate-500"> bu/ac</span>
            </div>
            {a.prog ? (
              <div className="mt-1.5">
                <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                  {a.prog.totalAcres > 0 && (
                    <>
                      <div className="bg-green-600" style={{ width: `${(a.prog.completedAcres / a.prog.totalAcres) * 100}%` }} />
                      <div className="bg-amber-500" style={{ width: `${(a.prog.inProgressAcres / a.prog.totalAcres) * 100}%` }} />
                    </>
                  )}
                </div>
                <div className="text-xs font-semibold text-slate-700 mt-1">{a.prog.pctComplete.toFixed(0)}% harvested</div>
                <div className="text-xs text-slate-500">
                  {fmtAc(a.prog.completedAcres)} done · {fmtAc(a.prog.inProgressAcres)} in progress · {fmtAc(a.prog.remainingAcres)} left
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-400">{a.avg ? `${fmtAc(a.avg.acres)} ac` : ''}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
