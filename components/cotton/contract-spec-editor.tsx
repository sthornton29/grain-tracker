'use client'

// The structured editor for a contract's quality requirements (0097,
// 2026-10-20): the USDA color grid as tick boxes, leaf max, staple min, the
// mic range, strength and uniformity minimums, the extraneous-matter rule,
// excluded remarks, eligible farms matched to Turnrow farms by FSA number
// (unmatched numbers listed), the practice toggle (off unless the contract
// tests it), the cap and the estimate. The verbatim clause sits beside it.
// Pure form: the parent saves.

import { useMemo } from 'react'
import { COLOR_GRID_COLUMNS, COLOR_GRID_ROWS, colorGridCode, colorCodesAndBetter } from '@/lib/cotton-quality'
import { EXTRANEOUS_RULE_LABEL, matchEligibleFarms, fsaKey, type ContractQualitySpec, type ExtraneousRule, type NotUnderstood } from '@/lib/cotton-contract-spec'
import { InfoTip } from '@/components/reports/report-kit'

const inputCls = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm bg-white min-h-10'
const numStr = (v: number | null) => (v == null ? '' : String(v))
const parseNum = (s: string): number | null => { const n = Number(s); return s.trim() !== '' && Number.isFinite(n) ? n : null }

export type FarmOption = { id: string; name: string; fsa_number: string | null; archived_at?: string | null }

export default function ContractSpecEditor({ value, onChange, farms, notUnderstood = [], clause }: {
  value: ContractQualitySpec
  onChange: (next: ContractQualitySpec) => void
  farms: ReadonlyArray<FarmOption>
  notUnderstood?: NotUnderstood[]
  /** The verbatim quality clause to show beside the editor (the spec's own when editing by hand). */
  clause?: string | null
}) {
  const set = <K extends keyof ContractQualitySpec>(k: K, v: ContractQualitySpec[K]) => onChange({ ...value, [k]: v })
  const allowed = useMemo(() => new Set(value.allowed_color_codes ?? []), [value.allowed_color_codes])
  const toggleColor = (code: string) => {
    const next = new Set(allowed)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    set('allowed_color_codes', next.size ? Array.from(next).sort() : null)
  }
  const farmsText = (value.eligible_fsa_farms ?? []).join(', ')
  const farmMatch = useMemo(() => matchEligibleFarms(value.eligible_fsa_farms ?? [], farms), [value.eligible_fsa_farms, farms])
  const turnrowFarms = useMemo(() => farms.filter((f) => !f.archived_at && fsaKey(f.fsa_number)).sort((a, z) => a.name.localeCompare(z.name)), [farms])
  const excluded = new Set(value.excluded_remarks ?? [])
  const toggleRemark = (code: string) => {
    const next = new Set(excluded)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    set('excluded_remarks', next.size ? Array.from(next).sort() : null)
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(16rem,22rem)] gap-4">
      <div className="space-y-4">
        {notUnderstood.length > 0 && (
          <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm text-amber-900 space-y-1">
            <div className="font-semibold">Not understood — set these by hand:</div>
            <ul className="list-disc pl-5">
              {notUnderstood.map((n, i) => <li key={i}><span className="font-medium">{n.factor}:</span> &ldquo;{n.text}&rdquo;</li>)}
            </ul>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="text-sm font-semibold flex items-center gap-2">Allowed color grades
            <InfoTip label="?">Tick every color code the contract accepts. &ldquo;41 and better&rdquo; is the white grades 11, 21, 31 and 41 — light spotted grades fail unless ticked. Leave every box clear for no color requirement.</InfoTip>
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs">
            <button type="button" className="rounded-full border border-slate-300 bg-white px-3 min-h-9" onClick={() => set('allowed_color_codes', colorCodesAndBetter('41'))}>41 and better</button>
            <button type="button" className="rounded-full border border-slate-300 bg-white px-3 min-h-9" onClick={() => set('allowed_color_codes', colorCodesAndBetter('31'))}>31 and better</button>
            <button type="button" className="rounded-full border border-slate-300 bg-white px-3 min-h-9" onClick={() => set('allowed_color_codes', [...colorCodesAndBetter('41'), ...colorCodesAndBetter('42')].sort())}>41 / 42 and better</button>
            <button type="button" className="rounded-full border border-slate-300 bg-white px-3 min-h-9 text-slate-500" onClick={() => set('allowed_color_codes', null)}>Clear</button>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse">
              <thead>
                <tr><th className="text-left px-2 py-1 text-slate-500 font-medium">Grade</th>{COLOR_GRID_COLUMNS.map((c) => <th key={c.column} className="px-2 py-1 text-slate-500 font-medium">{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {COLOR_GRID_ROWS.map((r) => (
                  <tr key={r.row}>
                    <td className="px-2 py-0.5 whitespace-nowrap">{r.row} <span className="text-slate-400">{r.symbol}</span></td>
                    {COLOR_GRID_COLUMNS.map((c) => {
                      const code = colorGridCode(r.row, c.column)
                      return (
                        <td key={c.column} className="px-2 py-0.5 text-center">
                          {code ? (
                            <label className={`inline-flex items-center gap-1 min-h-9 px-1.5 rounded cursor-pointer ${allowed.has(code) ? 'bg-green-50 text-green-900 font-semibold' : 'text-slate-600'}`}>
                              <input type="checkbox" checked={allowed.has(code)} onChange={() => toggleColor(code)} className="h-4 w-4 accent-[#36B449]" />
                              {code}
                            </label>
                          ) : <span className="text-slate-200">·</span>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-xs">
          <label className="flex flex-col gap-1">Leaf — maximum
            <input type="number" min={1} max={8} step={1} value={numStr(value.leaf_max)} onChange={(e) => set('leaf_max', parseNum(e.target.value))} className={inputCls} placeholder="e.g. 3" />
          </label>
          <label className="flex flex-col gap-1">Staple — minimum (32nds)
            <input type="number" min={20} max={50} step={1} value={numStr(value.staple_min)} onChange={(e) => set('staple_min', parseNum(e.target.value))} className={inputCls} placeholder="e.g. 37" />
          </label>
          <label className="flex flex-col gap-1">Micronaire — minimum
            <input type="number" step={0.1} value={numStr(value.mic_min)} onChange={(e) => set('mic_min', parseNum(e.target.value))} className={inputCls} placeholder="e.g. 4.0" />
          </label>
          <label className="flex flex-col gap-1">Micronaire — maximum
            <input type="number" step={0.1} value={numStr(value.mic_max)} onChange={(e) => set('mic_max', parseNum(e.target.value))} className={inputCls} placeholder="e.g. 4.7" />
          </label>
          <label className="flex flex-col gap-1">Strength — minimum (g/tex)
            <input type="number" step={0.1} value={numStr(value.strength_min)} onChange={(e) => set('strength_min', parseNum(e.target.value))} className={inputCls} placeholder="e.g. 29.0" />
          </label>
          <label className="flex flex-col gap-1">Uniformity — minimum (%)
            <input type="number" step={0.1} value={numStr(value.uniformity_min)} onChange={(e) => set('uniformity_min', parseNum(e.target.value))} className={inputCls} placeholder="e.g. 80.0" />
          </label>
          <label className="flex flex-col gap-1">Extraneous matter
            <select value={value.extraneous_rule} onChange={(e) => set('extraneous_rule', e.target.value as ExtraneousRule)} className={inputCls}>
              {(Object.keys(EXTRANEOUS_RULE_LABEL) as ExtraneousRule[]).map((r) => <option key={r} value={r}>{EXTRANEOUS_RULE_LABEL[r]}</option>)}
            </select>
          </label>
          <div className="flex flex-col gap-1">Excluded remarks
            <div className="flex flex-wrap gap-2 min-h-10 items-center">
              {[['75', 'Reginned (75)'], ['76', 'Reginned (76)'], ['77', 'Repacked (77)']].map(([code, label]) => (
                <label key={code} className="inline-flex items-center gap-1 min-h-9"><input type="checkbox" checked={excluded.has(code)} onChange={() => toggleRemark(code)} className="h-4 w-4 accent-[#36B449]" />{label}</label>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-sm font-semibold flex items-center gap-2">Eligible farms (FSA numbers)
            <InfoTip label="?">Bales from farms not listed are &ldquo;not eligible&rdquo; — counted apart from the bales that fail the grade specs. Leave empty when the contract accepts cotton from any farm.</InfoTip>
          </div>
          <textarea
            value={farmsText}
            onChange={(e) => {
              const nums = Array.from(new Set(e.target.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)))
              set('eligible_fsa_farms', nums.length ? nums : null)
            }}
            onBlur={() => { const nums = Array.from(new Set((value.eligible_fsa_farms ?? []).map(fsaKey).filter((k): k is string => k != null))); set('eligible_fsa_farms', nums.length ? nums : null) }}
            rows={2}
            className={`${inputCls} w-full font-mono`}
            placeholder="252, 260, 280, …"
          />
          {farmMatch.matched.length > 0 && (
            <div className="text-xs text-slate-600 flex flex-wrap gap-1.5">
              {farmMatch.matched.map((m) => (
                <span key={m.fsa} className="rounded-full bg-green-50 text-green-900 px-2 py-0.5">{m.fsa} → {m.farms.map((f) => f.name).join(' / ')}</span>
              ))}
            </div>
          )}
          {farmMatch.unmatched.length > 0 && (
            <div className="text-xs text-amber-800">Not a Turnrow farm (no farm carries this FSA number): {farmMatch.unmatched.join(', ')} — bales never match these until a farm carries the number under Settings → Farms.</div>
          )}
          {turnrowFarms.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-brand-deep min-h-9 inline-flex items-center">Pick from your farms</summary>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {turnrowFarms.map((f) => {
                  const key = fsaKey(f.fsa_number)!
                  const on = (value.eligible_fsa_farms ?? []).some((x) => fsaKey(x) === key)
                  return (
                    <button key={f.id} type="button" aria-pressed={on} onClick={() => {
                      const cur = value.eligible_fsa_farms ?? []
                      const next = on ? cur.filter((x) => fsaKey(x) !== key) : [...cur, key]
                      set('eligible_fsa_farms', next.length ? next : null)
                    }} className={on ? 'rounded-full bg-brand text-white px-3 min-h-9 font-semibold' : 'rounded-full bg-white border border-slate-300 px-3 min-h-9'}>
                      {f.name} <span className={on ? 'text-white/80' : 'text-slate-400'}>{key}</span>
                    </button>
                  )
                })}
              </div>
            </details>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-xs">
          <label className="flex items-center gap-2 min-h-10 col-span-2">
            <input type="checkbox" checked={value.require_dryland} onChange={(e) => set('require_dryland', e.target.checked)} className="h-4 w-4 accent-[#36B449]" />
            Only dryland (rain-fed) bales are eligible
            <InfoTip label="?">Off by default. Tick only when the contract makes the practice a condition — a deliverables line such as &ldquo;rain-fed cotton&rdquo; is informational.</InfoTip>
          </label>
          <label className="flex flex-col gap-1">Bale cap
            <input type="number" min={0} step={1} value={numStr(value.bale_cap)} onChange={(e) => set('bale_cap', parseNum(e.target.value))} className={inputCls} placeholder="e.g. 4250" />
          </label>
          <label className="flex flex-col gap-1">Estimated bales
            <input type="number" min={0} step={1} value={numStr(value.estimated_bales)} onChange={(e) => set('estimated_bales', parseNum(e.target.value))} className={inputCls} placeholder="e.g. 6825" />
          </label>
          <label className="flex flex-col gap-1">Base grade
            <input value={value.base_grade ?? ''} onChange={(e) => set('base_grade', e.target.value || null)} className={inputCls} placeholder="41-3-37" />
          </label>
          <label className="flex flex-col gap-1">Base price ($/lb)
            <input type="text" inputMode="decimal" value={value.base_price_cents != null ? (value.base_price_cents / 100).toFixed(4) : ''} onChange={(e) => { const n = parseNum(e.target.value); set('base_price_cents', n == null ? null : Math.round(n * 10000) / 100) }} className={inputCls} placeholder="0.8600" />
          </label>
          <label className="flex flex-col gap-1 col-span-2">Off-spec terms
            <input value={value.off_spec_terms ?? ''} onChange={(e) => set('off_spec_terms', e.target.value || null)} className={inputCls} placeholder="Buyer may accept off-spec bales at a lower price" />
          </label>
          <label className="flex flex-col gap-1 col-span-2">Other deliverables (informational)
            <input value={value.other_terms ?? ''} onChange={(e) => set('other_terms', e.target.value || null)} className={inputCls} placeholder="rain-fed, women-owned farms, regenerative practices" />
          </label>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-semibold">Contract wording</div>
        <textarea
          value={value.source_clause ?? clause ?? ''}
          onChange={(e) => set('source_clause', e.target.value || null)}
          rows={14}
          className={`${inputCls} w-full text-xs leading-relaxed`}
          placeholder="Paste or type the quality clause as the contract states it."
        />
        <p className="text-xs text-slate-500">Kept verbatim beside the rules, so anyone can check the reading against the contract.</p>
      </div>
    </div>
  )
}
