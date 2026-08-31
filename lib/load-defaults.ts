// Last-load defaults — the ONE seam that seeds a new load from the most
// recently ENTERED load (by created_at, not the load's own date: a hauling
// session resumed the next morning must key off last night's entries).
//
// PER-USER (073): defaults follow the CURRENT USER's own last-entered load
// (loads.created_by), so two people entering different load types don't
// stomp each other's pre-fills. Only when the user has no loads yet does the
// seam fall back to the org's last load. The form fetches the two tiers
// separately (the user's newest rows, then the org's) and picks via
// pickPerUserLastLoadDefaults.
//
// Covers every source/destination shape the form can produce — field→bin,
// field→buyer, and bin→buyer alike (the old inline version applied to bin
// sources too, but the crop filter wiped the defaulted bin right back out —
// see filteredBins in components/load-form.tsx). Bin→bin rows are grain
// transfers, not hauling sessions, and are skipped as a default source.
//
// Every default is a pre-fill only — each lands in an empty slot and stays
// fully overridable. The date gets special care: the form initializes it to
// today, so the seam REPLACES it with the last load's date unless the user
// already touched the field, and reports which date it applied so the form
// can show the "not today" note (dateDefaultNote) — a session entered the
// next morning must never silently land on the wrong day.

export const LAST_LOAD_DEFAULTS_SELECT =
  'date, crop_id, crop_year, from_type, from_field_id, from_bin_id, to_type, to_bin_id, to_buyer_id, contract_id'

export type LastLoadDefaultsSource = {
  date: string
  crop_id: string | null
  crop_year: number | null
  from_type: 'field' | 'bin' | null
  from_field_id: string | null
  from_bin_id: string | null
  to_type: 'bin' | 'buyer' | null
  to_bin_id: string | null
  to_buyer_id: string | null
  contract_id: string | null
}

/** The slice of the load form the seam reads and fills. */
export type DefaultableForm = {
  date: string
  crop_id: string
  crop_year: string
  from_type: '' | 'field' | 'bin'
  from_field_id: string
  from_bin_id: string
  to_type: '' | 'bin' | 'buyer'
  to_bin_id: string
  to_buyer_id: string
  contract_id: string
}

/** Bin→bin is a transfer, never a hauling-session default source. */
export function isTransferShape(l: { from_type: string | null; to_type: string | null }): boolean {
  return l.from_type === 'bin' && l.to_type === 'bin'
}

/** The default source: the most recently entered non-transfer load.
 *  `rows` must be ordered newest-entered first. */
export function pickLastLoadDefaults<T extends { from_type: string | null; to_type: string | null }>(
  rows: T[],
): T | null {
  return rows.find((l) => !isTransferShape(l)) ?? null
}

/** Per-user tiering (073): the user's own newest non-transfer load wins;
 *  the org's newest is the fallback only when the user has none yet.
 *  Both lists must be ordered newest-entered first. */
export function pickPerUserLastLoadDefaults<T extends { from_type: string | null; to_type: string | null }>(
  args: { mine: T[]; org: T[] },
): T | null {
  return pickLastLoadDefaults(args.mine) ?? pickLastLoadDefaults(args.org)
}

export function applyLastLoadDefaults<F extends DefaultableForm>(
  form: F,
  recent: LastLoadDefaultsSource,
  opts: { dateUntouched: boolean },
): { form: F; defaultedDate: string | null } {
  const defaultedDate = opts.dateUntouched && recent.date ? recent.date : null
  return {
    form: {
      ...form,
      date: defaultedDate ?? form.date,
      crop_id: form.crop_id || (recent.crop_id ?? ''),
      crop_year: form.crop_year || (recent.crop_year != null ? String(recent.crop_year) : ''),
      from_type: form.from_type || (recent.from_type ?? ''),
      from_field_id: form.from_field_id || (recent.from_field_id ?? ''),
      from_bin_id: form.from_bin_id || (recent.from_bin_id ?? ''),
      to_type: form.to_type || (recent.to_type ?? ''),
      to_bin_id: form.to_bin_id || (recent.to_bin_id ?? ''),
      to_buyer_id: form.to_buyer_id || (recent.to_buyer_id ?? ''),
      contract_id: form.contract_id || (recent.contract_id ?? ''),
    },
    defaultedDate,
  }
}

/**
 * The Save & New reset — the patch applied over the just-saved form to start
 * the next load. Everything NOT in this patch carries forward untouched:
 * date, crop, crop year, From/To selections, and contract (the just-saved
 * load is now the user's latest, so keeping them equals re-running the
 * defaults seam without a refetch).
 *
 * THE TRUCK IS DELIBERATELY CLEARED (truck_id + hauler_truck). During
 * harvest, consecutive loads rotate between trucks; a silently inherited
 * truck produces wrong-truck records that are tedious to hunt down later.
 * The truck's last-used affordances (use-last-tare etc.) still work — they
 * just wait for a truck to be picked. Note the fresh-visit defaults seam
 * above never seeds a truck either (LAST_LOAD_DEFAULTS_SELECT has no
 * truck_id), so the truck ALWAYS starts empty on a new-load form.
 */
export function saveAndNewPatch(time: string): {
  time: string
  truck_id: ''
  hauler_truck: ''
  gross_weight: ''
  tare_weight: ''
  net_weight: ''
  moisture: ''
  test_weight: ''
  dry_bushels_override: ''
  ticket_number: ''
  practice: ''
} {
  return {
    time,
    truck_id: '',
    hauler_truck: '',
    gross_weight: '',
    tare_weight: '',
    net_weight: '',
    moisture: '',
    test_weight: '',
    dry_bushels_override: '',
    ticket_number: '',
    practice: '',
  }
}

/** "8/14" from "2026-08-14" — no leading zeros, no year (it's this season). */
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}

/**
 * The persistent note beside the date field. Shows only while the field still
 * holds a defaulted date that ISN'T today — the one case where a next-morning
 * session would silently land on the wrong day. Overriding the date (or the
 * default being today anyway) clears it.
 */
export function dateDefaultNote(
  defaultedDate: string | null,
  today: string,
  currentDate: string,
): string | null {
  if (!defaultedDate || defaultedDate === today || currentDate !== defaultedDate) return null
  return `Defaulted to ${shortDate(defaultedDate)} (your last load's date) — not today`
}
