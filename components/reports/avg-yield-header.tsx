import type { CropAverage, HarvestProgress } from '@/lib/yields'
import type { CottonCropProgress, CottonYieldBucket } from '@/lib/cotton-field-yields'
import { lintEstimateChip } from '@/lib/cotton-field-yields'
import HarvestProgressBar, { GinningProgressBar } from '@/components/reports/harvest-progress-bar'
import { InfoTip, fmtInt, fmtNum } from '@/components/reports/report-kit'

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
  /** Cotton crops only: the ginned / not-ginned yield split under the
   *  headline and the percent-ginned tracker beside percent picked. */
  cotton?: (cropId: string) => CottonCropProgress | null
}

// A row of per-crop cards shown at the top of the yield views: average yield,
// and (when `progress` is given) a harvest-completion tracker. Yield reflects
// only harvested, non-in-progress fields. Renders nothing when there's nothing
// to summarize.
export default function AvgYieldHeader({ averages, cropName, label = 'Average yield by crop', progress, unitOf, cotton }: Props) {
  const cropIds = progress ? [...progress.keys()] : [...averages.keys()]
  const items = cropIds
    .map((id) => ({
      id,
      name: cropName(id) || '—',
      avg: averages.get(id) ?? null,
      prog: progress?.get(id) ?? null,
      cotton: cotton?.(id) ?? null,
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
              {a.avg ? fmtNum(a.avg.yield, 1) : '—'}
              <span className="text-sm font-medium text-slate-500"> {unitOf?.(a.id) === 'lbs' ? 'lbs lint/ac' : 'bu/ac'}</span>
            </div>
            {a.cotton && a.avg && <CottonYieldSplit progress={a.cotton} />}
            {a.prog ? (
              <HarvestProgressBar progress={a.prog} verb={a.cotton ? 'picked' : 'harvested'} />
            ) : (
              <div className="text-xs text-slate-400">{a.avg ? `${fmtAc(a.avg.acres)} ac` : ''}</div>
            )}
            {a.cotton && a.prog && <GinningProgressBar progress={a.cotton} />}
          </div>
        ))}
      </div>
    </div>
  )
}

/** "ginned 1,150 · not ginned yet 1,020 est." under the headline: the same
 *  counted fields, split by whether their lint is on gin receipts yet. */
function CottonYieldSplit({ progress }: { progress: CottonCropProgress }) {
  const { ginned, unginned } = progress
  if (ginned.acres <= 0 && unginned.acres <= 0) return null
  const part = (label: string, b: CottonYieldBucket) => {
    const chip = lintEstimateChip(b.lintBasis)
    return (
      <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
        <span>{label}</span>
        <span className="font-semibold text-slate-700">{b.lintPerAcre != null ? fmtNum(b.lintPerAcre, 1) : '—'}</span>
        <span className="text-slate-400">on {fmtInt(b.acres)} ac</span>
        {chip && (
          <InfoTip label={chip} tone="warning">
            {chip === 'est.' ? 'Seed cotton still on the yard, counted as lint' : 'Part of this lint is seed cotton still on the yard, counted'}{progress.turnoutLabel ? ` at ${progress.turnoutLabel}` : ' at the turnout'}. Gin receipts replace it.
          </InfoTip>
        )}
      </span>
    )
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500 tabular-nums mt-0.5">
      {ginned.acres > 0 && part('ginned', ginned)}
      {unginned.acres > 0 && part('not ginned yet', unginned)}
    </div>
  )
}
