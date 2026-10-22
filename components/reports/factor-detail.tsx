'use client'

// Bale Quality factor tiles + detail (2026-10-21). One slim tile per grade
// factor — the average, the premium / base / discount split, and with a
// contract how many bales fail that factor. Tap a tile to open its detail
// underneath: a real histogram of the readings at the factor's own precision
// (mic by tenths, strength by halves…) colored by price band, with the
// contract's requirement drawn as a line (and the allowed range as a wash),
// the averages both ways, the spread, and the fail count. Code factors
// (color, extraneous matter, remarks, quadrant) list their codes with a bar
// each, marked allowed / not allowed; the Color detail also carries the USDA
// color grid.
//
// Every number comes from lib/bale-quality-report.ts (factorDetail); nothing
// here knows the filters.

import { useMemo, useState, type ReactNode } from 'react'
import { fmtInt, toneText } from '@/components/reports/report-kit'
import { BAND_LABEL, COLOR_GRID_COLUMNS, COLOR_GRID_ROWS, FACTORS, colorGridCode, factorText, type Band, type FactorKey } from '@/lib/cotton-quality'
import type { ContractQualitySpec } from '@/lib/cotton-contract-spec'
import { BIN_STEP, type ColorGridCell, type FactorBin, type FactorDetail, type Weighting } from '@/lib/bale-quality-report'

// Data-semantic colors (never brand green): premium favorable, discount
// unfavorable, base neutral; unbanded readings in one hue.
export const BAND_FILL: Record<Band, string> = { premium: 'bg-green-600', base: 'bg-slate-400', discount: 'bg-red-500' }
export const UNBANDED_FILL = 'bg-sky-600'
export const bandBg = (band: Band | null) => (band === 'premium' ? 'bg-green-50' : band === 'discount' ? 'bg-red-50' : '')
export const pct1 = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
export const pct0 = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`)
/** An average, in the factor's own notation (staple to a tenth, loan in ¢). */
export const avgText = (key: FactorKey, v: number | null) => (v == null ? '—' : key === 'staple' ? v.toFixed(1) : key === 'loan' ? `${v.toFixed(2)}¢` : key === 'length' ? `${(v / 100).toFixed(2)}"` : factorText(key, v))

const fillOf = (b: FactorBin) => (b.band ? BAND_FILL[b.band] : UNBANDED_FILL)

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

export function FactorTiles({ factors, details, selected, onSelect, hasContract }: {
  factors: FactorKey[]
  details: Partial<Record<FactorKey, FactorDetail>>
  selected: FactorKey | null
  onSelect: (f: FactorKey | null) => void
  hasContract: boolean
}) {
  return (
    <div role="tablist" aria-label="Grade factors" className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-7">
      {factors.map((f) => {
        const d = details[f]
        if (!d) return null
        const def = FACTORS[f]
        const active = selected === f
        const top = d.bins.slice().sort((a, z) => z.pct - a.pct)[0]
        const value = def.kind === 'number' ? avgText(f, d.avgBale) : top ? top.label : '—'
        const sub = def.kind === 'number' ? (f === 'loan' ? 'avg ¢/lb' : 'average') : top ? `${pct0(top.pct)} share` : 'no readings'
        const failTone = d.fails === 0 ? 'favorable' : d.fails / Math.max(1, d.eligibleClassed) > 0.25 ? 'unfavorable' : 'warning'
        return (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(active ? null : f)}
            className={`min-w-0 text-left rounded-xl bg-white p-3 min-h-11 shadow-sm border-2 transition-colors ${active ? 'border-brand shadow' : 'border-transparent hover:border-slate-200'}`}
          >
            <div className="text-xs text-slate-500 truncate">{def.short}</div>
            <div className="text-xl font-bold text-slate-900 leading-tight mt-0.5 truncate">{value}</div>
            <div className="text-[11px] text-slate-500 truncate">
              {sub}
              {hasContract && d.requirement && (
                <> · <span className={`font-semibold tabular-nums ${toneText(failTone)}`}>{d.fails === 0 ? 'all meet' : `${fmtInt(d.fails)} fail`}</span></>
              )}
            </div>
            {d.classed > 0 && (def.banded ? (
              <div className="mt-2 flex h-1.5 w-full gap-px rounded overflow-hidden" aria-hidden="true">
                {(['premium', 'base', 'discount'] as Band[]).map((b) => d.byBand[b].pct > 0 && <span key={b} className={BAND_FILL[b]} style={{ width: `${d.byBand[b].pct * 100}%` }} />)}
              </div>
            ) : (
              <div className="mt-2 flex h-1.5 w-full gap-px rounded overflow-hidden" aria-hidden="true">
                {d.bins.filter((b) => b.pct > 0).map((b, i) => <span key={b.key} className={i % 2 ? 'bg-sky-400' : 'bg-sky-600'} style={{ width: `${b.pct * 100}%` }} />)}
              </div>
            ))}
            {d.classed === 0 && <div className="mt-2 h-1.5 w-full rounded bg-slate-100" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

export function FactorDetailPanel({ detail, weighting, contractLabel, onDrillBin, onDrillFails, onClose, grid, spec, onDrillColor }: {
  detail: FactorDetail
  weighting: Weighting
  contractLabel: string | null
  onDrillBin: (bin: FactorBin) => void
  onDrillFails: () => void
  onClose: () => void
  /** For the Color detail: the USDA color grid. */
  grid?: { cells: Map<string, ColorGridCell>; classed: number }
  spec?: ContractQualitySpec | null
  onDrillColor?: (code: string, label: string) => void
}) {
  const f = detail.factor
  const def = FACTORS[f]
  const req = detail.requirement
  const unit = weighting === 'lbs' ? 'lbs' : 'bales'
  return (
    <div className="bg-white rounded-xl shadow border-t-4 border-brand p-4 space-y-3" role="tabpanel" aria-label={`${def.label} detail`}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-lg leading-tight">{def.label}</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {fmtInt(detail.classed)} readings{detail.missing > 0 ? ` · ${fmtInt(detail.missing)} classed bale${detail.missing === 1 ? '' : 's'} without one` : ''}
            {def.banded && detail.classed > 0 && <> · <span className={toneText('favorable')}>premium {pct1(detail.byBand.premium.pct)}</span> · base {pct1(detail.byBand.base.pct)} · <span className={toneText('unfavorable')}>discount {pct1(detail.byBand.discount.pct)}</span></>}
          </div>
        </div>
        {def.kind === 'number' && detail.classed > 0 && (
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
            <Stat label={f === 'loan' ? 'Avg (lbs-wtd)' : 'Avg per bale'} value={avgText(f, f === 'loan' ? detail.avgLbs : detail.avgBale)} big />
            {f !== 'loan' && <Stat label="Lbs-weighted" value={avgText(f, detail.avgLbs)} />}
            <Stat label="Median" value={avgText(f, detail.median)} />
            <Stat label="Range" value={`${avgText(f, detail.min)} – ${avgText(f, detail.max)}`} />
          </dl>
        )}
        <button type="button" onClick={onClose} aria-label="Close detail" className="min-h-11 min-w-11 rounded-lg text-slate-500 hover:bg-slate-100 text-lg">✕</button>
      </div>

      {req && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm rounded-lg bg-slate-50 px-3 py-2">
          <span><span className="text-slate-500">{contractLabel ?? 'Contract'} needs</span> <span className="font-semibold">{req.text}</span></span>
          {detail.eligibleClassed > 0 && (
            <button type="button" onClick={onDrillFails} className={`underline decoration-dotted min-h-7 tabular-nums ${toneText(detail.fails === 0 ? 'favorable' : 'unfavorable')}`}>
              {detail.fails === 0 ? 'every eligible bale meets it' : `${fmtInt(detail.fails)} of ${fmtInt(detail.eligibleClassed)} eligible bales fail here (${pct1(detail.fails / detail.eligibleClassed)})`}
            </button>
          )}
          {detail.onlyThis > 0 && <span className="text-slate-500">{fmtInt(detail.onlyThis)} fail only this — the near misses</span>}
        </div>
      )}

      {detail.classed === 0 ? (
        <p className="text-sm text-slate-400">No readings for this factor in these bales.</p>
      ) : def.kind === 'number' ? (
        <Histogram detail={detail} unit={unit} onDrillBin={onDrillBin} contractLabel={contractLabel} />
      ) : (
        <CodeBars detail={detail} unit={unit} onDrillBin={onDrillBin} hasContract={req != null} />
      )}

      {f === 'color' && grid && onDrillColor && <ColorGrid grid={grid} spec={spec ?? null} weighting={weighting} onDrill={onDrillColor} />}
    </div>
  )
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] text-slate-500 uppercase tracking-wide">{label}</dt>
      <dd className={`${big ? 'text-xl font-bold' : 'font-semibold'} text-slate-900 leading-tight`}>{value}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Histogram (HTML columns + overlaid reference lines; no chart library)
// ---------------------------------------------------------------------------

function niceMax(v: number): number {
  if (v <= 0) return 0.1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / exp
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return nice * exp
}

function Histogram({ detail, unit, onDrillBin, contractLabel }: { detail: FactorDetail; unit: string; onDrillBin: (b: FactorBin) => void; contractLabel: string | null }) {
  const f = detail.factor
  const bins = detail.bins
  const [hover, setHover] = useState<number | null>(null)
  const axisLo = bins[0]?.min ?? 0
  const axisHi = bins[bins.length - 1]?.max ?? 1
  const span = Math.max(axisHi - axisLo, 1e-9)
  const x = (v: number) => Math.min(100, Math.max(0, ((v - axisLo) / span) * 100))
  const top = niceMax(Math.max(...bins.map((b) => b.pct)))
  const ticks = [top, top / 2]
  const labelEvery = Math.max(1, Math.ceil(bins.length / 12))
  const req = detail.requirement
  const reqMin = req?.min ?? null
  const reqMax = req?.max ?? null
  const avg = f === 'loan' ? detail.avgLbs : detail.avgBale
  // The allowed wash: from the min (or the axis start) to the max (or the axis end).
  const washFrom = reqMin != null ? x(reqMin) : 0
  const washTo = reqMax != null ? x(reqMax + (detail.step ?? 0)) : 100
  const h = hover != null ? bins[hover] : null
  const bandOrder = useMemo(() => (['premium', 'base', 'discount'] as Band[]).filter((b) => bins.some((bin) => bin.band === b)), [bins])
  return (
    <div className="space-y-1">
      <div className="relative h-44 select-none">
        {/* Gridlines + y labels */}
        {ticks.map((t) => (
          <div key={t} className="absolute left-0 right-0 border-t border-slate-100" style={{ bottom: `${(t / top) * 100}%` }}>
            <span className="absolute -top-2 left-0 text-[10px] text-slate-400 tabular-nums">{pct0(t)}</span>
          </div>
        ))}
        <div className="absolute inset-y-0 left-6 right-0">
        {/* Allowed wash */}
        {req && (reqMin != null || reqMax != null) && (
          <div className="absolute inset-y-0 bg-green-500/10 pointer-events-none" style={{ left: `${washFrom}%`, width: `${Math.max(0, washTo - washFrom)}%` }} aria-hidden="true" />
        )}
        {/* Columns */}
        <div className="absolute inset-0 flex items-end gap-px">
          {bins.map((b, i) => (
            <button
              key={b.key}
              type="button"
              onClick={() => { setHover(i); onDrillBin(b) }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h0) => (h0 === i ? null : h0))}
              onFocus={() => setHover(i)}
              className="relative flex-1 h-full min-w-[3px] flex items-end group focus-visible:outline-none"
              aria-label={`${b.label}: ${unit === 'lbs' ? fmtInt(b.lbs) + ' lbs' : fmtInt(b.bales) + ' bales'} (${pct1(b.pct)})${b.band ? `, ${BAND_LABEL[b.band].toLowerCase()}` : ''}${b.allowed === false ? ', outside the contract' : ''}. Show these bales.`}
            >
              <span
                className={`block w-full rounded-t-[3px] ${fillOf(b)} ${hover === i ? 'brightness-90' : ''} ${b.allowed === false ? 'opacity-70' : ''}`}
                style={{ height: `${Math.max(b.pct > 0 ? 2 : 0, (b.pct / top) * 100)}%` }}
              />
            </button>
          ))}
        </div>
        {/* Reference lines */}
        {reqMin != null && <RefLine at={x(reqMin)} label={`${contractLabel ?? 'Contract'} min ${req!.min != null ? avgText(f, reqMin) : ''}`} kind="contract" />}
        {reqMax != null && <RefLine at={x(reqMax + (detail.step ?? 0))} label={`${contractLabel ?? 'Contract'} max ${avgText(f, reqMax)}`} kind="contract" align="right" />}
        {avg != null && <RefLine at={x(avg + (detail.step ?? 0) / 2)} label={`avg ${avgText(f, avg)}`} kind="avg" align={reqMin != null && Math.abs(x(avg) - x(reqMin)) < 12 ? 'right' : 'left'} low />}
        </div>
        {/* Tooltip */}
        {h && (
          <div className="absolute top-0 right-0 rounded-lg bg-slate-900 text-white text-xs px-2 py-1 shadow pointer-events-none tabular-nums">
            <span className="font-semibold">{h.label}{detail.step != null && detail.step > (BIN_STEP[f] ?? 1) && h.max != null ? ` to ${h.max}` : ''}</span> · {unit === 'lbs' ? `${fmtInt(h.lbs)} lbs` : `${fmtInt(h.bales)} bales`} · {pct1(h.pct)}{h.band ? ` · ${BAND_LABEL[h.band].toLowerCase()}` : ''}{h.allowed === false ? ' · outside the contract' : ''}
          </div>
        )}
      </div>
      {/* X labels */}
      <div className="flex gap-px pl-6 text-[10px] text-slate-500 tabular-nums">
        {bins.map((b, i) => (
          <div key={b.key} className="flex-1 min-w-[3px] text-center overflow-visible whitespace-nowrap">{i % labelEvery === 0 ? b.label : ''}</div>
        ))}
      </div>
      <Legend bands={bandOrder} contract={req != null && (reqMin != null || reqMax != null)} avg={avg != null} unbanded={!FACTORS[f].banded} />
    </div>
  )
}

function RefLine({ at, label, kind, align = 'left', low }: { at: number; label: string; kind: 'contract' | 'avg'; align?: 'left' | 'right'; low?: boolean }) {
  const line = kind === 'contract' ? 'border-l-2 border-slate-900' : 'border-l-2 border-dashed border-sky-700'
  const pill = kind === 'contract' ? 'bg-slate-900 text-white' : 'bg-sky-50 text-sky-900 border border-sky-200'
  return (
    <div className={`absolute inset-y-0 ${line} pointer-events-none`} style={{ left: `${at}%` }} aria-hidden="true">
      <span className={`absolute ${low ? 'top-6' : 'top-0'} ${align === 'right' ? 'right-1' : 'left-1'} whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${pill}`}>{label}</span>
    </div>
  )
}

function Legend({ bands, contract, avg, unbanded }: { bands: Band[]; contract: boolean; avg: boolean; unbanded: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 pt-1">
      {bands.map((b) => <span key={b} className="inline-flex items-center gap-1"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${BAND_FILL[b]}`} aria-hidden="true" />{BAND_LABEL[b]}</span>)}
      {unbanded && <span className="inline-flex items-center gap-1"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${UNBANDED_FILL}`} aria-hidden="true" />Readings (the loan schedule does not price this factor)</span>}
      {contract && <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-0.5 bg-slate-900" aria-hidden="true" />Contract requirement <span className="inline-block h-2.5 w-4 bg-green-500/10 border border-green-200 rounded-sm ml-1" aria-hidden="true" /> allowed range</span>}
      {avg && <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-0 border-l-2 border-dashed border-sky-700" aria-hidden="true" />Average</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Code factors: one bar per code
// ---------------------------------------------------------------------------

function CodeBars({ detail, unit, onDrillBin, hasContract }: { detail: FactorDetail; unit: string; onDrillBin: (b: FactorBin) => void; hasContract: boolean }) {
  const max = Math.max(1e-9, ...detail.bins.map((b) => b.pct))
  const bandOrder = (['premium', 'base', 'discount'] as Band[]).filter((b) => detail.bins.some((bin) => bin.band === b))
  return (
    <div className="space-y-1">
      <ul className="space-y-0.5">
        {detail.bins.map((b) => (
          <li key={b.key}>
            <button type="button" onClick={() => onDrillBin(b)} className="w-full text-left min-h-9 rounded px-1 hover:bg-slate-50 flex items-center gap-2 text-sm" aria-label={`${b.label}: ${unit === 'lbs' ? fmtInt(b.lbs) + ' lbs' : fmtInt(b.bales) + ' bales'} (${pct1(b.pct)}). Show these bales.`}>
              <span className={`inline-block h-2.5 w-2.5 rounded-sm shrink-0 ${fillOf(b)}`} aria-hidden="true" />
              <span className="w-40 truncate">{b.label}</span>
              <span className="flex-1 h-4 rounded bg-slate-100 overflow-hidden"><span className={`block h-full rounded-r-[3px] ${fillOf(b)} ${b.allowed === false ? 'opacity-70' : ''}`} style={{ width: `${(b.pct / max) * 100}%` }} /></span>
              <span className="tabular-nums w-14 text-right font-semibold">{pct1(b.pct)}</span>
              <span className="tabular-nums w-16 text-right text-slate-500">{unit === 'lbs' ? fmtInt(b.lbs) : fmtInt(b.bales)}</span>
              {hasContract && <span className={`w-16 text-right text-xs ${b.allowed == null ? 'text-slate-300' : b.allowed ? toneText('favorable') : toneText('unfavorable')}`}>{b.allowed == null ? '' : b.allowed ? '✓ allowed' : '✕ fails'}</span>}
            </button>
          </li>
        ))}
      </ul>
      <Legend bands={bandOrder} contract={false} avg={false} unbanded={!FACTORS[detail.factor].banded} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Color grade grid (the USDA chart as a heatmap)
// ---------------------------------------------------------------------------

export function ColorGrid({ grid, spec, weighting, onDrill }: { grid: { cells: Map<string, ColorGridCell>; classed: number }; spec: ContractQualitySpec | null; weighting: Weighting; onDrill: (code: string, label: string) => void }) {
  const maxPct = Math.max(0, ...Array.from(grid.cells.values()).map((c) => c.pct))
  const allowed = spec?.allowed_color_codes?.length ? new Set(spec.allowed_color_codes) : null
  const hatch = 'repeating-linear-gradient(45deg, transparent 0 4px, rgba(15,23,42,0.10) 4px 6px)'
  return (
    <div className="space-y-1 pt-2 border-t border-slate-100">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-semibold text-sm">USDA color grid <span className="font-normal text-slate-500">· {weighting === 'lbs' ? '% of lbs' : '% of bales'} · darker holds more</span></div>
        {allowed && <div className="text-xs text-slate-500">Hatched cells are outside the contract&rsquo;s allowed colors.</div>}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs border-collapse">
          <thead>
            <tr>
              <th className="text-left px-2 py-1 text-slate-500 font-medium">Grade</th>
              {COLOR_GRID_COLUMNS.map((c) => <th key={c.column} className="px-2 py-1 text-slate-500 font-medium text-center">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {COLOR_GRID_ROWS.map((r) => (
              <tr key={r.row}>
                <td className="px-2 py-1 whitespace-nowrap text-slate-700">{r.row} <span className="text-slate-400">{r.symbol}</span></td>
                {COLOR_GRID_COLUMNS.map((c) => {
                  const code = colorGridCode(r.row, c.column)
                  if (!code) return <td key={c.column} className="px-1 py-1"><div className="h-11 rounded bg-slate-50" /></td>
                  const cellV = grid.cells.get(code)
                  const outside = allowed ? !allowed.has(code) : false
                  const alpha = cellV && maxPct > 0 ? 0.12 + 0.7 * (cellV.pct / maxPct) : 0
                  return (
                    <td key={c.column} className="px-1 py-1">
                      <button
                        type="button"
                        disabled={!cellV}
                        onClick={() => cellV && onDrill(code, `Color ${code}`)}
                        style={{ backgroundImage: outside ? hatch : undefined, backgroundColor: cellV ? `rgba(2, 132, 199, ${alpha})` : undefined }}
                        className={`w-full min-w-[4.5rem] h-11 rounded border text-left px-1.5 ${cellV ? 'border-sky-200 hover:ring-2 hover:ring-sky-500' : 'border-slate-100 text-slate-300'} ${outside && cellV ? 'border-red-300' : ''}`}
                        aria-label={cellV ? `${code}: ${cellV.bales} bales, ${pct1(cellV.pct)}${outside ? ', outside the contract' : ''}. Show these bales.` : `${code}: no bales`}
                      >
                        <span className="block text-[11px] leading-tight text-slate-700">{code}{outside && cellV ? <span className="text-red-700"> ✕</span> : null}</span>
                        {cellV && <span className="block text-[11px] leading-tight tabular-nums font-semibold text-slate-900">{cellV.bales.toLocaleString()} · {pct1(cellV.pct)}</span>}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <h2 className="font-display font-semibold text-slate-900">{children}</h2>
      {right}
    </div>
  )
}
