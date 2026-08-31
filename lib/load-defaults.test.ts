// Last-load defaults — the ONE seam seeding a new load from the org's most
// recently entered load, across EVERY source/destination shape.
//
// Behavior pinned:
//   * field→bin, field→buyer, AND bin→buyer loads all serve as the default
//     source (the old inline seam let bin-source defaults get wiped);
//   * bin→bin rows are transfers and never seed a hauling session;
//   * every default fills an EMPTY slot only — user picks are never clobbered;
//   * the date defaults from the last load and reports what it applied, so a
//     next-morning session lands on the session's day, not silently on today;
//   * the "not today" note shows exactly while the field holds a defaulted
//     date that isn't today, and clears when overridden (or when the default
//     was today anyway).

import { describe, expect, it } from 'vitest'
import {
  LAST_LOAD_DEFAULTS_SELECT,
  applyLastLoadDefaults,
  dateDefaultNote,
  isTransferShape,
  pickLastLoadDefaults,
  pickPerUserLastLoadDefaults,
  saveAndNewPatch,
  type DefaultableForm,
  type LastLoadDefaultsSource,
} from './load-defaults'

const TODAY = '2026-08-15'

const emptyForm = (over: Partial<DefaultableForm> = {}): DefaultableForm => ({
  date: TODAY,
  crop_id: '',
  crop_year: '',
  from_type: '',
  from_field_id: '',
  from_bin_id: '',
  to_type: '',
  to_bin_id: '',
  to_buyer_id: '',
  contract_id: '',
  ...over,
})

const recent = (over: Partial<LastLoadDefaultsSource> = {}): LastLoadDefaultsSource => ({
  date: '2026-08-14',
  crop_id: 'corn',
  crop_year: 2026,
  from_type: 'field',
  from_field_id: 'f-1',
  from_bin_id: null,
  to_type: 'bin',
  to_bin_id: 'b-1',
  to_buyer_id: null,
  contract_id: null,
  ...over,
})

const fieldToBin = recent()
const fieldToBuyer = recent({ from_type: 'field', from_field_id: 'f-2', to_type: 'buyer', to_bin_id: null, to_buyer_id: 'by-1', contract_id: 'c-1' })
const binToBuyer = recent({ from_type: 'bin', from_field_id: null, from_bin_id: 'b-9', to_type: 'buyer', to_bin_id: null, to_buyer_id: 'by-2', contract_id: 'c-2' })
const transfer = recent({ from_type: 'bin', from_field_id: null, from_bin_id: 'b-1', to_type: 'bin', to_bin_id: 'b-2' })

describe('pickLastLoadDefaults', () => {
  it('uses the newest-entered load whatever its shape — bin→buyer included', () => {
    expect(pickLastLoadDefaults([binToBuyer, fieldToBin])).toBe(binToBuyer)
    expect(pickLastLoadDefaults([fieldToBuyer, binToBuyer])).toBe(fieldToBuyer)
    expect(pickLastLoadDefaults([fieldToBin])).toBe(fieldToBin)
  })
  it('skips bin→bin transfers and falls through to the next hauling load', () => {
    expect(isTransferShape(transfer)).toBe(true)
    expect(pickLastLoadDefaults([transfer, binToBuyer])).toBe(binToBuyer)
    expect(pickLastLoadDefaults([transfer, transfer])).toBeNull()
    expect(pickLastLoadDefaults([])).toBeNull()
  })
})

describe('applyLastLoadDefaults — all three load shapes', () => {
  it('field→bin: From/To, crop, crop year, date', () => {
    const { form, defaultedDate } = applyLastLoadDefaults(emptyForm(), fieldToBin, { dateUntouched: true })
    expect(form).toMatchObject({
      date: '2026-08-14', crop_id: 'corn', crop_year: '2026',
      from_type: 'field', from_field_id: 'f-1', to_type: 'bin', to_bin_id: 'b-1',
    })
    expect(defaultedDate).toBe('2026-08-14')
  })
  it('field→buyer: buyer + contract carry over', () => {
    const { form } = applyLastLoadDefaults(emptyForm(), fieldToBuyer, { dateUntouched: true })
    expect(form).toMatchObject({
      from_type: 'field', from_field_id: 'f-2',
      to_type: 'buyer', to_buyer_id: 'by-1', contract_id: 'c-1',
    })
  })
  it('bin→buyer: the source bin defaults exactly like a field source', () => {
    const { form } = applyLastLoadDefaults(emptyForm(), binToBuyer, { dateUntouched: true })
    expect(form).toMatchObject({
      date: '2026-08-14', crop_id: 'corn', crop_year: '2026',
      from_type: 'bin', from_bin_id: 'b-9',
      to_type: 'buyer', to_buyer_id: 'by-2', contract_id: 'c-2',
    })
  })
  it('never clobbers a slot the user already filled', () => {
    const picked = emptyForm({ crop_id: 'wheat', from_type: 'field', from_field_id: 'f-7' })
    const { form } = applyLastLoadDefaults(picked, binToBuyer, { dateUntouched: true })
    expect(form.crop_id).toBe('wheat')
    expect(form.from_type).toBe('field')
    expect(form.from_field_id).toBe('f-7')
    // Empty slots still default.
    expect(form.to_type).toBe('buyer')
    expect(form.to_buyer_id).toBe('by-2')
  })
  it('a touched date is kept and reported as not defaulted', () => {
    const { form, defaultedDate } = applyLastLoadDefaults(
      emptyForm({ date: '2026-08-10' }), binToBuyer, { dateUntouched: false },
    )
    expect(form.date).toBe('2026-08-10')
    expect(defaultedDate).toBeNull()
  })
})

describe('pickPerUserLastLoadDefaults — per-user tiering (073)', () => {
  it("the user's own newest non-transfer load wins over the org's newer one", () => {
    // Someone else entered binToBuyer AFTER my fieldToBin — my own still wins.
    expect(pickPerUserLastLoadDefaults({ mine: [fieldToBin], org: [binToBuyer, fieldToBin] })).toBe(fieldToBin)
  })
  it('transfers are skipped within the user tier before falling back', () => {
    // My only load is a bin→bin transfer → not a session source → org tier.
    expect(pickPerUserLastLoadDefaults({ mine: [transfer], org: [binToBuyer] })).toBe(binToBuyer)
  })
  it("falls back to the org's last load only when the user has none yet", () => {
    expect(pickPerUserLastLoadDefaults({ mine: [], org: [binToBuyer] })).toBe(binToBuyer)
  })
  it('nothing anywhere → null (form keeps its blank defaults)', () => {
    expect(pickPerUserLastLoadDefaults({ mine: [], org: [transfer] })).toBeNull()
  })
})

describe('saveAndNewPatch — what Save & New clears vs keeps', () => {
  // The patch is applied OVER the just-saved form: a key in the patch is
  // cleared for the next load; a key absent from it carries forward.
  const patch = saveAndNewPatch('09:41')

  it('clears the truck — both the own-truck id and the hauler free text', () => {
    expect(patch.truck_id).toBe('')
    expect(patch.hauler_truck).toBe('')
  })

  it('clears every per-load field and stamps the new time', () => {
    expect(patch).toEqual({
      time: '09:41',
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
    })
  })

  it('keeps From/To, crop, crop year, date, and contract (absent from the patch)', () => {
    for (const kept of [
      'date', 'crop_id', 'crop_year',
      'from_type', 'from_field_id', 'from_bin_id',
      'to_type', 'to_bin_id', 'to_buyer_id', 'contract_id',
    ]) {
      expect(patch).not.toHaveProperty(kept)
    }
  })

  it('applied over a saved form, only the truck + per-load fields reset', () => {
    const saved = {
      ...emptyForm({ crop_id: 'corn', crop_year: '2026', from_type: 'field' as const, from_field_id: 'f-1', to_type: 'buyer' as const, to_buyer_id: 'by-1', contract_id: 'c-1' }),
      time: '08:15', truck_id: 't-42', hauler_truck: '',
      gross_weight: '81000', tare_weight: '31000', net_weight: '50000',
      moisture: '15.5', test_weight: '56.1', dry_bushels_override: '',
      ticket_number: '1234', practice: 'irrigated',
    }
    const next = { ...saved, ...saveAndNewPatch('08:19') }
    expect(next.truck_id).toBe('')
    expect(next.gross_weight).toBe('')
    expect(next.ticket_number).toBe('')
    expect(next).toMatchObject({
      date: TODAY, crop_id: 'corn', crop_year: '2026',
      from_type: 'field', from_field_id: 'f-1',
      to_type: 'buyer', to_buyer_id: 'by-1', contract_id: 'c-1',
    })
  })

  it('the fresh-visit defaults seam never seeds a truck either', () => {
    // Belt and braces: the SELECT feeding applyLastLoadDefaults carries no
    // truck column, so a truck can't sneak back in through the seam.
    expect(LAST_LOAD_DEFAULTS_SELECT).not.toContain('truck')
  })
})

describe('dateDefaultNote — the "not today" note', () => {
  it('shows while the field holds a defaulted date that isn’t today', () => {
    expect(dateDefaultNote('2026-08-14', TODAY, '2026-08-14'))
      .toBe("Defaulted to 8/14 (your last load's date) — not today")
  })
  it('never shows when the default IS today', () => {
    expect(dateDefaultNote(TODAY, TODAY, TODAY)).toBeNull()
  })
  it('clears when the user overrides the date (to today or any other day)', () => {
    expect(dateDefaultNote('2026-08-14', TODAY, TODAY)).toBeNull()
    expect(dateDefaultNote('2026-08-14', TODAY, '2026-08-13')).toBeNull()
  })
  it('no default applied → no note', () => {
    expect(dateDefaultNote(null, TODAY, TODAY)).toBeNull()
  })
  it('drops leading zeros in the short date', () => {
    expect(dateDefaultNote('2026-09-05', '2026-09-06', '2026-09-05')).toContain('9/5')
  })
})
