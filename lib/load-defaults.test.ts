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
  applyLastLoadDefaults,
  dateDefaultNote,
  isTransferShape,
  pickLastLoadDefaults,
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
