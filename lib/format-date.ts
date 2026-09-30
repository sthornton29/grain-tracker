// ONE on-screen date style for the whole app: month/day/year, no leading
// zeros, never ISO. Dates in the database are 'YYYY-MM-DD' strings (or ISO
// timestamps); parse them as calendar dates, not UTC instants, so a load dated
// 2026-09-24 never shows as 9/23 in a US evening.

function parts(iso: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return null
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() }
}

/** '2026-09-24' → '9/24/2026'. Empty/invalid → ''. */
export function fmtDate(iso: string | null | undefined): string {
  const p = parts(iso)
  return p ? `${p.m}/${p.d}/${p.y}` : ''
}

/** '2026-09-24' → '9/24' — for dense tables where the year is in the filter. */
export function fmtDateShort(iso: string | null | undefined): string {
  const p = parts(iso)
  return p ? `${p.m}/${p.d}` : ''
}

/** '2026-09-24T14:05:00Z' → '9/24/2026 2:05 PM' in the viewer's local time. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const hh = t.getHours()
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  const mm = String(t.getMinutes()).padStart(2, '0')
  return `${t.getMonth() + 1}/${t.getDate()}/${t.getFullYear()} ${h12}:${mm} ${hh < 12 ? 'AM' : 'PM'}`
}

/** 'Sep 24' style for chips and captions. */
export function fmtDateMonth(iso: string | null | undefined): string {
  const p = parts(iso)
  if (!p) return ''
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[p.m - 1]} ${p.d}`
}
