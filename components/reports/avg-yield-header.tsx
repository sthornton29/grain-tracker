import type { CropAverage, HarvestProgress } from '@/lib/yields'
import HarvestProgressBar from '@/components/reports/harvest-progress-bar'

type Props = {
  /** Crop id → weighted average, as returned by analyzeYields. */
  averages: Map<string, CropAverage>
  /** Resolve a crop id to its display name. */
  cropName: (cropId: string) => string
  label?: string
  /** When provided, each crop card also shows a harvest-completion tracker and
   *  every crop with planted acres is listed (even 0%-harvested ones). */
  progress?: Map<string, HarvestProgress>
  /** Unit per crop (cotton = lbs of lint per acre); bu/ac when absent. */
  unitOf?: (cropId: string) => 'bu' | 'lbs'
}

// A row of per-crop cards shown at the top of the yield views: average yield,
// and (when `progress` is given) a harvest-completion tracker. Yield reflects
// only harvested, non-in-progress fields. Renders nothing when there's nothing
// to summarize.
export default function AvgYieldHeader({ averages, cropName, label = 'Average yield by crop', progress, unitOf }: Props) {
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
              <span className="text-sm font-medium text-slate-500"> {unitOf?.(a.id) === 'lbs' ? 'lbs lint/ac' : 'bu/ac'}</span>
            </div>
            {a.prog ? (
              <HarvestProgressBar progress={a.prog} />
            ) : (
              <div className="text-xs text-slate-400">{a.avg ? `${fmtAc(a.avg.acres)} ac` : ''}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
