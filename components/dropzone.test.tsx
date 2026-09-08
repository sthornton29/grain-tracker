// @vitest-environment jsdom

// The shared drag-and-drop wrapper: a drop lands on the SAME handler the
// browse path runs, files outside the picker's accept list are rejected, one
// file passes unless `multiple`, and a surface that already validates in its
// handler (the support form's screenshot) shows its EXISTING message for a
// dropped file of the wrong type.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Dropzone, { dropzoneHeadline, rejectMessage } from '@/components/dropzone'
import SupportForm from '@/components/help/support-form'

function drop(el: Element, files: File[]) {
  fireEvent.drop(el, { dataTransfer: { files, items: [], types: ['Files'] } })
}

beforeEach(() => cleanup())

describe('Dropzone', () => {
  it('hands accepted files to the browse handler and rejects the rest by the accept list', () => {
    const onFiles = vi.fn()
    const onReject = vi.fn()
    render(
      <Dropzone onFiles={onFiles} onReject={onReject} accept="application/pdf,image/*" multiple variant="bare">
        <span>zone</span>
      </Dropzone>,
    )
    const zone = screen.getByText('zone').parentElement!
    const pdf = new File(['%PDF'], 'ticket.pdf', { type: 'application/pdf' })
    const jpg = new File(['x'], 'ticket.jpg', { type: 'image/jpeg' })
    const doc = new File(['x'], 'notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    drop(zone, [pdf, doc, jpg])
    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['ticket.pdf', 'ticket.jpg'])
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onReject.mock.calls[0][0].map((f: File) => f.name)).toEqual(['notes.docx'])
  })

  it('passes only the first file unless multiple', () => {
    const onFiles = vi.fn()
    render(<Dropzone onFiles={onFiles} accept=".csv,text/csv" variant="bare"><span>one</span></Dropzone>)
    const zone = screen.getByText('one').parentElement!
    drop(zone, [new File(['a'], 'a.csv', { type: 'text/csv' }), new File(['b'], 'b.csv', { type: 'text/csv' })])
    expect(onFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'a.csv' })])
  })

  it('does nothing when every dropped file is rejected, and nothing at all when disabled', () => {
    const onFiles = vi.fn()
    const onReject = vi.fn()
    const { rerender } = render(<Dropzone onFiles={onFiles} onReject={onReject} accept="image/png" variant="bare"><span>z</span></Dropzone>)
    const zone = screen.getByText('z').parentElement!
    drop(zone, [new File(['x'], 'a.gif', { type: 'image/gif' })])
    expect(onFiles).not.toHaveBeenCalled()
    expect(onReject).toHaveBeenCalledTimes(1)
    rerender(<Dropzone onFiles={onFiles} onReject={onReject} accept="image/png" disabled variant="bare"><span>z</span></Dropzone>)
    drop(zone, [new File(['x'], 'a.png', { type: 'image/png' })])
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('highlights while a file drag is over it and clears on drop', () => {
    render(<Dropzone onFiles={() => {}} variant="bare"><span>h</span></Dropzone>)
    const zone = screen.getByText('h').parentElement!
    fireEvent.dragEnter(zone, { dataTransfer: { files: [], items: [], types: ['Files'] } })
    expect(zone.getAttribute('data-dropzone-active')).toBe('true')
    expect(screen.getByText('Drop to upload')).toBeTruthy()
    drop(zone, [])
    expect(zone.getAttribute('data-dropzone-active')).toBeNull()
  })

  it('ignores a text drag (no Files) — no highlight, no handoff', () => {
    const onFiles = vi.fn()
    render(<Dropzone onFiles={onFiles} variant="bare"><span>t</span></Dropzone>)
    const zone = screen.getByText('t').parentElement!
    fireEvent.dragEnter(zone, { dataTransfer: { files: [], items: [], types: ['text/plain'] } })
    expect(zone.getAttribute('data-dropzone-active')).toBeNull()
  })

  it('rejectMessage names the file and what the surface accepts', () => {
    expect(rejectMessage('Use a CSV file.', [new File([''], 'a.pdf')])).toBe('"a.pdf" isn\'t a file type this accepts. Use a CSV file.')
    expect(rejectMessage('Use a CSV file.', [new File([''], 'a.pdf'), new File([''], 'b.pdf')])).toBe("Those files aren't a type this accepts. Use a CSV file.")
  })
})

describe('type rejection reuses the surface\'s existing validation', () => {
  it('dropping a non-image on the support form shows its own "Screenshots must be an image file." message', async () => {
    render(<SupportForm route="/help" />)
    // The dropzone wraps the label, so the label's parent owns the drop handlers.
    const wrapper = screen.getByText(/Screenshot \(optional/).parentElement!
    drop(wrapper, [new File(['hello'], 'notes.txt', { type: 'text/plain' })])
    expect(await screen.findByText('Screenshots must be an image file.')).toBeTruthy()
  })

  it('dropping an image on the support form attaches it through the same pickShot path', async () => {
    render(<SupportForm route="/help" />)
    const wrapper = screen.getByText(/Screenshot \(optional/).parentElement!
    drop(wrapper, [new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })])
    expect(await screen.findByText('Attached: shot.png')).toBeTruthy()
  })
})

describe('the visible dropzone chrome', () => {
  it('the card advertises drag-and-drop with the accepted types and forwards a click to its file input', () => {
    const onFiles = vi.fn()
    const clicked = vi.fn()
    render(
      <Dropzone onFiles={onFiles} accept="application/pdf" accepts="PDF, photos, CSV">
        <input type="file" data-testid="picker" onClick={clicked} className="hidden" />
        <button type="button">Own button</button>
      </Dropzone>,
    )
    expect(screen.getByText('Drag & drop a file here, or click to browse')).toBeTruthy()
    expect(screen.getByText('PDF, photos, CSV')).toBeTruthy()
    // Clicking the headline (not a control) opens the picker…
    fireEvent.click(screen.getByText('PDF, photos, CSV'))
    expect(clicked).toHaveBeenCalledTimes(1)
    // …but a click on the surface's own button is left to that button.
    fireEvent.click(screen.getByText('Own button'))
    expect(clicked).toHaveBeenCalledTimes(1)
  })
  it('multiple → "files"; touch devices read "Tap to choose" — no drag promise', () => {
    expect(dropzoneHeadline({ touch: false, multiple: true })).toBe('Drag & drop files here, or click to browse')
    expect(dropzoneHeadline({ touch: true, multiple: true })).toBe('Tap to choose files')
    expect(dropzoneHeadline({ touch: true })).toBe('Tap to choose a file')
    expect(dropzoneHeadline({ touch: false, title: 'Custom' })).toBe('Custom')
  })
  it('the drag-over highlight marks the card', () => {
    render(<Dropzone onFiles={() => {}}><span>c</span></Dropzone>)
    const zone = screen.getByText('c').parentElement!
    expect(zone.getAttribute('data-dropzone-variant')).toBe('card')
    fireEvent.dragEnter(zone, { dataTransfer: { files: [], items: [], types: ['Files'] } })
    expect(zone.getAttribute('data-dropzone-active')).toBe('true')
    expect(zone.className).toMatch(/border-brand/)
  })
})
