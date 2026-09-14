// @vitest-environment jsdom

// The chat markdown renderer: headings, bold, lists, tables, inline code,
// links in a new tab — and NO raw HTML, ever. Partial (still streaming) text
// must render something sensible rather than throw.

import { describe, expect, it, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import MarkdownMessage from '@/components/markdown-message'

afterEach(cleanup)

describe('MarkdownMessage', () => {
  it('renders headings, bold, bullet and numbered lists, and inline code', () => {
    const { container } = render(
      <MarkdownMessage text={'## Corn this year\n\n**Average** price is `$4.93/bu`.\n\n- first\n- second\n\n1. step one\n2. step two'} />,
    )
    expect(container.querySelector('h3')?.textContent).toBe('Corn this year')
    expect(container.querySelector('strong')?.textContent).toBe('Average')
    expect(container.querySelector('code')?.textContent).toBe('$4.93/bu')
    expect(container.querySelectorAll('ul li')).toHaveLength(2)
    expect(container.querySelectorAll('ol li')).toHaveLength(2)
  })

  it('renders GFM tables with numeric cells right-aligned', () => {
    const { container } = render(
      <MarkdownMessage text={'| Field | Bushels | Yield |\n| --- | --- | --- |\n| North 40 | 12,340 | 185.2 |\n| Creek | 8,010 | 171.0 |'} />,
    )
    const rows = container.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    const cells = rows[0].querySelectorAll('td')
    expect(cells[0].className).not.toMatch(/text-right/)
    expect(cells[1].className).toMatch(/text-right/)
    expect(cells[2].className).toMatch(/text-right/)
    expect(container.querySelector('table')?.parentElement?.className).toMatch(/overflow-x-auto/)
  })

  it('opens links in a new tab and drops unsafe URLs', () => {
    render(<MarkdownMessage text={'See [Marketing](https://example.com/reports/marketing) and [bad](javascript:alert(1)).'} />)
    const good = screen.getByText('Marketing').closest('a')!
    expect(good.getAttribute('target')).toBe('_blank')
    expect(good.getAttribute('rel')).toBe('noopener noreferrer')
    expect(good.getAttribute('href')).toBe('https://example.com/reports/marketing')
    const bad = screen.getByText('bad').closest('a')!
    expect(bad.getAttribute('href') ?? '').not.toMatch(/javascript:/i)
  })

  it('never renders raw HTML', () => {
    const { container } = render(<MarkdownMessage text={'Hello <script>window.pwned = 1</script><b onclick="x()">there</b> **ok**'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('[onclick]')).toBeNull()
    expect(container.querySelector('strong')?.textContent).toBe('ok')
  })

  it('tolerates a half-streamed message (unterminated bold, a table without its separator yet)', () => {
    const { container } = render(<MarkdownMessage text={'Your **average corn pr'} />)
    expect(container.textContent).toContain('average corn pr')
    const partial = render(<MarkdownMessage text={'| Field | Bushels |\n| North'} />)
    expect(partial.container.textContent).toContain('North')
  })
})
