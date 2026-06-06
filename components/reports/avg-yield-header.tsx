import type { CropAverage } from '@/lib/yields'

type Props = {
  /** Crop id → weighted average, as returned by analyzeYields. */
  averages: Map<string, CropAverage>
  /** Resolve a crop id to its display name. */
  cropName: (cropId: string) => string
  label?: string
}

// A row of per-crop average-yield cards shown at the top of the yield views.
// Reflects only the harvested, completed fields (analyzeYields drops unharvested
// and in-progress fields before the averages are computed). Renders nothing when
// there's no harvested production to summarize.
export default function AvgYieldHeader({ averages, cropName, label = 'Average yield by crop' }: Props) {
  const items = [...averages.values()]
    .map((a) => ({ name: cropName(a.cropId) || '—', yield: a.yield, acres: a.acres }))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (items.length === 0) return null

  return (
    <div className="bg-white rounded-xl shadow p-3 avoid-break">
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">{label}</div>
      <div className="flex flex-wrap gap-2">
        {items.map((a) => (
          <div key={a.name} className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 min-w-[8rem]">
            <div className="text-sm font-semibold text-slate-700">{a.name}</div>
            <div className="text-2xl font-bold tabular-nums leading-tight">
              {a.yield.toFixed(1)}
              <span className="text-sm font-medium text-slate-500"> bu/ac</span>
            </div>
            <div className="text-xs text-slate-400">{a.acres.toLocaleString(undefined, { maximumFractionDigits: 0 })} ac</div>
          </div>
        ))}
      </div>
    </div>
  )
}
