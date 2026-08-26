// @vitest-environment jsdom

// Regression tests for the load form's inline truck EDIT (rename) path — the
// picker's ✎ modal for both lists (own trucks / hauler trucks). Covers: the
// update statement itself (right table, right row, right payload), the parent
// refresh callback, the modal closing on success, and a failed update
// surfacing its error INSIDE the modal (never silently swallowed).

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// --- Supabase client stub ---------------------------------------------------
// Chainable stub capturing update calls; the resolved value is settable per
// test so the error path is exercised too.
type UpdateCall = { table: string; payload: Record<string, unknown>; eq: [string, string] }
const updateCalls: UpdateCall[] = []
let updateResult: { data: unknown; error: { message: string } | null } = { data: null, error: null }

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: (col: string, val: string) => {
          updateCalls.push({ table, payload, eq: [col, val] })
          return { select: () => ({ single: async () => updateResult }) }
        },
      }),
      insert: (payload: Record<string, unknown>) => ({
        select: () => ({ single: async () => ({ data: { id: 'new', ...payload }, error: null }) }),
      }),
    }),
  }),
}))
vi.mock('@/lib/org', () => ({ getOrgId: async () => 'org-1' }))

import { HaulerTruckField, TruckPicker } from '@/components/truck-picker'

const trucks = [
  { id: 't1', name_or_number: 'Kenworth 12', created_at: '' },
  { id: 't2', name_or_number: 'Pete 389', created_at: '' },
] as never[]

const externals = [
  { id: 'x1', name: 'JD Trucking 7', buyer_id: null, created_at: '' },
] as never[]

beforeEach(() => {
  cleanup()
  updateCalls.length = 0
  updateResult = { data: null, error: null }
})

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
}

describe('TruckPicker — own-truck rename', () => {
  it('saves the rename to trucks, refreshes the parent list, and closes the modal', async () => {
    updateResult = { data: { id: 't1', name_or_number: 'Kenworth 12A', created_at: '' }, error: null }
    const onUpdated = vi.fn()
    render(
      <form>
        <label>
          Truck
          <TruckPicker value="t1" onChange={() => {}} trucks={trucks} onUpdated={onUpdated} />
        </label>
      </form>,
    )
    fireEvent.click(screen.getByLabelText('Edit truck name'))
    const input = screen.getByPlaceholderText('Truck name or number (required)')
    fireEvent.change(input, { target: { value: 'Kenworth 12A' } })
    fireEvent.click(screen.getByText('Save Name'))
    await flush()

    expect(updateCalls).toEqual([
      { table: 'trucks', payload: { name_or_number: 'Kenworth 12A' }, eq: ['id', 't1'] },
    ])
    expect(onUpdated).toHaveBeenCalledWith({ id: 't1', name_or_number: 'Kenworth 12A', created_at: '' })
    expect(screen.queryByText('Save Name')).toBeNull() // modal closed
  })

  it('a failed update keeps the modal open and shows the error (never silent)', async () => {
    updateResult = { data: null, error: { message: 'row-level security says no' } }
    const onUpdated = vi.fn()
    render(<TruckPicker value="t1" onChange={() => {}} trucks={trucks} onUpdated={onUpdated} />)
    fireEvent.click(screen.getByLabelText('Edit truck name'))
    fireEvent.change(screen.getByPlaceholderText('Truck name or number (required)'), { target: { value: 'New Name' } })
    fireEvent.click(screen.getByText('Save Name'))
    await flush()

    expect(onUpdated).not.toHaveBeenCalled()
    expect(screen.getByText('row-level security says no')).toBeTruthy()
    expect(screen.getByText('Save Name')).toBeTruthy() // still open
  })

  it('refuses a rename that collides with another truck, without calling the DB', async () => {
    render(<TruckPicker value="t1" onChange={() => {}} trucks={trucks} />)
    fireEvent.click(screen.getByLabelText('Edit truck name'))
    fireEvent.change(screen.getByPlaceholderText('Truck name or number (required)'), { target: { value: '  pete 389 ' } })
    fireEvent.click(screen.getByText('Save Name'))
    await flush()
    expect(updateCalls).toEqual([])
    expect(screen.getByText(/already exists/)).toBeTruthy()
  })

  it('submitting the edit modal never bubbles a submit to the host form', async () => {
    updateResult = { data: { id: 't1', name_or_number: 'Renamed', created_at: '' }, error: null }
    const hostSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    render(
      <form onSubmit={hostSubmit}>
        <TruckPicker value="t1" onChange={() => {}} trucks={trucks} />
      </form>,
    )
    fireEvent.click(screen.getByLabelText('Edit truck name'))
    fireEvent.change(screen.getByPlaceholderText('Truck name or number (required)'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByText('Save Name'))
    await flush()
    expect(hostSubmit).not.toHaveBeenCalled()
  })
})

describe('HaulerTruckField — hauler-truck rename', () => {
  it('saves the rename to external_trucks and follows it in the free text', async () => {
    updateResult = { data: { id: 'x1', name: 'JD Trucking 7A', buyer_id: null, created_at: '' }, error: null }
    const onExternalUpdated = vi.fn()
    const onChangeHauler = vi.fn()
    render(
      <HaulerTruckField
        haulerTruck="JD Trucking 7"
        truckId=""
        onChangeHauler={onChangeHauler}
        onChangeTruckId={() => {}}
        externalTrucks={externals}
        trucks={trucks}
        saveTruck={false}
        onChangeSaveTruck={() => {}}
        onExternalUpdated={onExternalUpdated}
      />,
    )
    fireEvent.click(screen.getByLabelText('Edit truck name'))
    fireEvent.change(screen.getByPlaceholderText('Truck name or number (required)'), { target: { value: 'JD Trucking 7A' } })
    fireEvent.click(screen.getByText('Save Name'))
    await flush()

    expect(updateCalls).toEqual([
      { table: 'external_trucks', payload: { name: 'JD Trucking 7A' }, eq: ['id', 'x1'] },
    ])
    expect(onExternalUpdated).toHaveBeenCalled()
    expect(onChangeHauler).toHaveBeenCalledWith('JD Trucking 7A')
  })

  it('a failed hauler rename surfaces its error in the modal', async () => {
    updateResult = { data: null, error: { message: 'nope' } }
    render(
      <HaulerTruckField
        haulerTruck="JD Trucking 7"
        truckId=""
        onChangeHauler={() => {}}
        onChangeTruckId={() => {}}
        externalTrucks={externals}
        trucks={trucks}
        saveTruck={false}
        onChangeSaveTruck={() => {}}
      />,
    )
    fireEvent.click(screen.getByLabelText('Edit truck name'))
    fireEvent.change(screen.getByPlaceholderText('Truck name or number (required)'), { target: { value: 'X' } })
    fireEvent.click(screen.getByText('Save Name'))
    await flush()
    expect(screen.getByText('nope')).toBeTruthy()
  })
})
