import { describe, it, expect } from 'vitest'
import { matchAllTickets, matchTicket, normalizeTicket, ticketSegments, type TicketMatchLoad } from '@/lib/ticket-matching'

// The Bunge 9/10/2026 soybean settlement (No. 0000161152) prints tickets
// with leading zeros ("0498074") and a Load Order # per ticket; our loads
// carry the buyer's ticket inside dash-delimited internal numbers.
const LOADS: TicketMatchLoad[] = [
  { id: 'L1', ticket_number: '498074-02-A', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-04', dry_bushels: 1012.4, truck_id: 't1', license_plate: 'AL 4ZH 118' },
  { id: 'L2', ticket_number: '12-498075', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-04', dry_bushels: 998.0, truck_id: 't2', license_plate: 'AL 7KQ 220' },
  { id: 'L3', ticket_number: 'LO-8817742', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-05', dry_bushels: 1005.2 },
  { id: 'L4', ticket_number: null, crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-06', dry_bushels: 1020.0, gross_weight: 81340, tare_weight: 20120, truck_id: 't1', license_plate: 'AL 4ZH 118' },
  { id: 'L5', ticket_number: null, crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-06', dry_bushels: 1021.5, truck_id: 't2', license_plate: 'AL 7KQ 220' },
  { id: 'L6', ticket_number: '0031', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-07', dry_bushels: 990 },
  { id: 'L7', ticket_number: '498074', crop_id: 'corn', to_buyer_id: 'other', date: '2026-08-01', dry_bushels: 900 },
]
const CTX = { crop_id: 'soy', buyer_id: 'bunge' }

describe('normalizeTicket / ticketSegments', () => {
  it('trims, uppercases, and strips leading zeros from numeric tickets', () => {
    expect(normalizeTicket(' 0498074 ')).toBe('498074')
    expect(normalizeTicket('ab-01')).toBe('AB-01')
    expect(normalizeTicket('0000')).toBe('0')
    expect(normalizeTicket(null)).toBe('')
  })
  it('keeps only numeric-substantial (≥ 4 digit) segments', () => {
    expect(ticketSegments('498074-02-A')).toEqual(['498074'])
    expect(ticketSegments('12-498074')).toEqual(['498074'])
    expect(ticketSegments('LO-8817742')).toEqual(['8817742'])
    expect(ticketSegments('0031')).toEqual([]) // "31" after stripping zeros is too short
    expect(ticketSegments('AB12-0498074/7')).toEqual(['498074'])
  })
})

describe('matchTicket — tiers', () => {
  it('tier 1: 0498074 does not match exactly (the load embeds it) — falls to tier 2, high confidence', () => {
    const r = matchTicket({ ticket_number: '0498074' }, LOADS, CTX)
    expect(r.status).toBe('matched')
    if (r.status !== 'matched') return
    expect(r.match.loadId).toBe('L1')
    expect(r.match.tier).toBe('segment')
    expect(r.match.confidence).toBe('high')
    expect(r.match.reason).toBe('ticket 498074 is part of our ticket 498074-02-A')
  })

  it('tier 1 exact after normalization (leading zeros, case, whitespace)', () => {
    const r = matchTicket({ ticket_number: ' lo-8817742 ' }, LOADS, CTX)
    expect(r.status).toBe('matched')
    if (r.status === 'matched') { expect(r.match.tier).toBe('exact'); expect(r.match.loadId).toBe('L3') }
  })

  it('tier 2: a buyer ticket embedded after our prefix ("12-498075")', () => {
    const r = matchTicket({ ticket_number: '498075' }, LOADS, CTX)
    expect(r.status).toBe('matched')
    if (r.status === 'matched') { expect(r.match.loadId).toBe('L2'); expect(r.match.tier).toBe('segment') }
  })

  it('tier 2: the Load Order # matches when the ticket itself does not', () => {
    const r = matchTicket({ ticket_number: '0499999', secondary_refs: ['8817742'] }, LOADS, CTX)
    expect(r.status).toBe('matched')
    if (r.status === 'matched') { expect(r.match.loadId).toBe('L3'); expect(r.match.reason).toMatch(/load order 8817742/) }
  })

  it('the ≥ 4-char guard: short tokens never match a segment (exact still works for a short ticket)', () => {
    const r2 = matchTicket({ ticket_number: '02' }, LOADS, CTX) // the "-02-" segment of L1
    expect(r2.status).toBe('unmatched')
    const rA = matchTicket({ ticket_number: 'A' }, LOADS, CTX)
    expect(rA.status).toBe('unmatched')
    // "31" IS the whole ticket of L6 ("0031") after leading-zero stripping — tier 1, not a segment.
    const r = matchTicket({ ticket_number: '31' }, LOADS, CTX)
    expect(r.status).toBe('matched')
    if (r.status === 'matched') { expect(r.match.tier).toBe('exact'); expect(r.match.loadId).toBe('L6') }
  })

  it('tier 3: one candidate by date + bushels → medium confidence, pre-checkable', () => {
    const r = matchTicket({ ticket_number: '0777001', net_bushels: 992, delivery_date: '2026-09-07' }, LOADS, CTX)
    expect(r.status).toBe('matched')
    if (r.status === 'matched') {
      expect(r.match.loadId).toBe('L6')
      expect(r.match.tier).toBe('attribute')
      expect(r.match.confidence).toBe('medium')
      expect(r.match.reason).toBe('matched by date + bushels')
    }
  })

  it('tier 3 prefers ticket-less loads: a load whose own ticket did not match is a different load', () => {
    const two: TicketMatchLoad[] = [
      { id: 'T1', ticket_number: '498999', crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-05', dry_bushels: 1010 },
      { id: 'T2', ticket_number: null, crop_id: 'soy', to_buyer_id: 'bunge', date: '2026-09-05', dry_bushels: 1012 },
    ]
    // Both fit 1,011 bu on 9/05 within 1%; T1's own ticket did not match → the ticket-less T2 wins outright.
    const r = matchTicket({ ticket_number: '0777009', net_bushels: 1011, delivery_date: '2026-09-05' }, two, CTX)
    expect(r.status).toBe('matched')
    if (r.status === 'matched') expect(r.match.loadId).toBe('T2')
    // With no ticket-less candidate at all, the ticketed loads are still offered.
    const r2 = matchTicket({ ticket_number: '0777009', net_bushels: 1011, delivery_date: '2026-09-05' }, [two[0]], CTX)
    expect(r2.status).toBe('matched')
    if (r2.status === 'matched') expect(r2.match.loadId).toBe('T1')
  })

  it('text tiers stay inside the settlement’s buyer and crop: a corn load at another buyer with the same digits is not a match', () => {
    const r = matchTicket({ ticket_number: '498074' }, LOADS, { crop_id: 'corn', buyer_id: 'other' })
    expect(r.status).toBe('matched')
    if (r.status === 'matched') expect(r.match.loadId).toBe('L7')
  })

  it('tier 3: several candidates → the plate picks; without a plate the user picks', () => {
    // L4 and L5 both on 9/06 within 1% of 1,018 bu.
    const noPlate = matchTicket({ ticket_number: '0777002', net_bushels: 1018, delivery_date: '2026-09-06' }, LOADS, CTX)
    expect(noPlate.status).toBe('ambiguous')
    if (noPlate.status === 'ambiguous') expect(noPlate.candidates.map((c) => c.loadId).sort()).toEqual(['L4', 'L5'])
    const withPlate = matchTicket({ ticket_number: '0777002', net_bushels: 1018, delivery_date: '2026-09-06', vehicle_plate: 'AL4ZH118' }, LOADS, CTX)
    expect(withPlate.status).toBe('matched')
    if (withPlate.status === 'matched') { expect(withPlate.match.loadId).toBe('L4'); expect(withPlate.match.reason).toBe('matched by date + bushels + plate') }
  })

  it('tier 3: exact gross/tare weights match when bushels are not comparable', () => {
    const r = matchTicket({ ticket_number: '0777003', gross_weight: 81340, tare_weight: 20120, delivery_date: '2026-09-07' }, LOADS, CTX)
    expect(r.status).toBe('matched')
    if (r.status === 'matched') { expect(r.match.loadId).toBe('L4'); expect(r.match.reason).toBe('matched by date + weights') }
  })

  it('tier 3 respects crop, buyer, the ±1 day window, and the 1% bushel band', () => {
    expect(matchTicket({ ticket_number: 'X', net_bushels: 1008, delivery_date: '2026-09-09' }, LOADS, CTX).status).toBe('unmatched') // 4 days off
    expect(matchTicket({ ticket_number: 'X', net_bushels: 1040, delivery_date: '2026-09-05' }, LOADS, CTX).status).toBe('unmatched') // 3.5% off
  })

  it('a corn load at another buyer never matches a soybean settlement line by attributes', () => {
    const r = matchTicket({ ticket_number: 'ZZZ', net_bushels: 900, delivery_date: '2026-08-01' }, LOADS, CTX)
    expect(r.status).toBe('unmatched')
  })
})

describe('matchAllTickets — each load claimed once', () => {
  it('the second identical ticket line cannot re-claim the first line’s load', () => {
    const results = matchAllTickets([{ ticket_number: '0498074' }, { ticket_number: '0498074' }], LOADS, CTX)
    expect(results[0].status).toBe('matched')
    expect(results[1].status).toBe('unmatched')
  })
})
