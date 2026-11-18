// @vitest-environment jsdom

// The one irrigated / dryland split form (grain bushels, cotton lint lbs):
// typing a side fills the other with the remainder, Save waits for the two to
// add up, and cotton's remainder is whole pounds.

import { describe, expect, it, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PracticeSplitEditor from '@/components/practice-split-editor'

afterEach(cleanup)

const base = { initialIrr: '', initialDry: '', saving: false, error: null, canClear: false, onCancel: () => {}, onClear: () => {} }

describe('PracticeSplitEditor', () => {
  it('cotton: the dryland side fills with the whole-pound remainder and Save sends both sides', () => {
    const onSave = vi.fn()
    render(<PracticeSplitEditor {...base} total={392045.37} unitNoun="lint lbs" totalLabel="Total lint lbs" decimals={0} onSave={onSave} />)
    expect(screen.getByText('392,045')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Irrigated lint lbs'), { target: { value: '360000' } })
    expect((screen.getByLabelText('Dryland lint lbs') as HTMLInputElement).value).toBe('32045')
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith(360000, 32045)
  })

  it('Save waits until the sides add up, and says what they must add up to', () => {
    const onSave = vi.fn()
    render(<PracticeSplitEditor {...base} total={1000} unitNoun="bushels" totalLabel="Total dry bushels" decimals={2} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('Irrigated bushels'), { target: { value: '600' } })
    expect((screen.getByLabelText('Dryland bushels') as HTMLInputElement).value).toBe('400')
    // Typing the dryland side by hand stops the auto-fill: 600 + 300 ≠ 1,000.
    fireEvent.change(screen.getByLabelText('Dryland bushels'), { target: { value: '300' } })
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Irrigated + Dryland bushels must equal total bushels (1,000)')).toBeTruthy()
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('a saved split offers Clear', () => {
    const onClear = vi.fn()
    render(<PracticeSplitEditor {...base} total={100} unitNoun="bushels" totalLabel="Total dry bushels" decimals={2} initialIrr="60" initialDry="40" canClear onClear={onClear} onSave={() => {}} />)
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('Clear breakout'))
    expect(onClear).toHaveBeenCalled()
  })
})
