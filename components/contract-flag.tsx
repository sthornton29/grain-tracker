export type ContractFlag = 'open' | 'complete' | 'future'

const LABELS: Record<ContractFlag, string> = {
  open: 'Delivery period open',
  complete: 'Contract complete',
  future: 'Delivery period not open yet',
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
  const title = LABELS[variant]
  const w = size
  const h = size
  // Triangular pennant on a pole, pole at the left edge so the flag points right.
  // Pole: x=2 from y=1 to y=h-1. Flag: triangle from (2,2) to (w-2,5) to (2,8).
  const pole = <line x1="2" y1="1" x2="2" y2={h - 1} stroke="#475569" strokeWidth="1.25" strokeLinecap="round" />

  if (variant === 'complete') {
    // Checkered flag — 2x4 grid of squares
    const cellW = (w - 4) / 4
    const cellH = 3.5
    const squares: React.ReactElement[] = []
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 4; col++) {
        const fill = (row + col) % 2 === 0 ? '#0f172a' : '#f8fafc'
        squares.push(
          <rect
            key={`${row}-${col}`}
            x={2 + col * cellW}
            y={2 + row * cellH}
            width={cellW}
            height={cellH}
            fill={fill}
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
        aria-label={title}
      >
        <title>{title}</title>
        <rect x="2" y="2" width={w - 4} height={cellH * 2} fill="#f8fafc" stroke="#0f172a" strokeWidth="0.5" />
        {squares}
        {pole}
      </svg>
    )
  }

  const fill = variant === 'open' ? '#16a34a' : '#dc2626'
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={`inline-block align-middle mr-1 ${className}`}
      aria-label={title}
    >
      <title>{title}</title>
      <polygon points={`2,2 ${w - 2},5 2,8`} fill={fill} />
      {pole}
    </svg>
  )
}
