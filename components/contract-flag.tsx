export type ContractFlag = 'open' | 'complete' | 'future'

export const CONTRACT_FLAG_LABEL: Record<ContractFlag, string> = {
  open: 'Delivery period open',
  complete: 'Contract complete',
  future: 'Delivery period not open yet',
}

// Data colors stay on the stock palette (report-kit tone semantics): green =
// on-track/open, slate/sky = not yet, checkered = done. "Not open yet" is a
// calendar fact, not a problem, so it is never red.
const PENNANT_CLS: Record<'open' | 'future', string> = {
  open: 'fill-green-600',
  future: 'fill-sky-500',
}

export default function ContractFlagIcon({
  variant,
  size = 14,
  className = '',
}: {
  variant: ContractFlag
  size?: number
  className?: string
}) {
  const title = CONTRACT_FLAG_LABEL[variant]
  const w = size
  const h = size
  // Triangular pennant on a pole, pole at the left edge so the flag points right.
  // Pole: x=2 from y=1 to y=h-1. Flag: triangle from (2,2) to (w-2,5) to (2,8).
  const pole = <line x1="2" y1="1" x2="2" y2={h - 1} className="stroke-slate-600" strokeWidth="1.25" strokeLinecap="round" />

  if (variant === 'complete') {
    // Checkered flag — 2x4 grid of squares
    const cellW = (w - 4) / 4
    const cellH = 3.5
    const squares: React.ReactElement[] = []
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 4; col++) {
        const cls = (row + col) % 2 === 0 ? 'fill-slate-900' : 'fill-slate-50'
        squares.push(
          <rect
            key={`${row}-${col}`}
            x={2 + col * cellW}
            y={2 + row * cellH}
            width={cellW}
            height={cellH}
            className={cls}
          />,
        )
      }
    }
    return (
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className={`inline-block align-middle mr-1 ${className}`}
        role="img"
        aria-label={title}
      >
        <title>{title}</title>
        <rect x="2" y="2" width={w - 4} height={cellH * 2} className="fill-slate-50 stroke-slate-900" strokeWidth="0.5" />
        {squares}
        {pole}
      </svg>
    )
  }

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={`inline-block align-middle mr-1 ${className}`}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <polygon points={`2,2 ${w - 2},5 2,8`} className={PENNANT_CLS[variant]} />
      {pole}
    </svg>
  )
}
