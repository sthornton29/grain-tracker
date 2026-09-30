import Link from 'next/link'

// A slim "Settings › Farms" trail. The last item is the current page and is
// not a link; earlier items are. Small on purpose — it sits above the H1.
export type BreadcrumbItem = { label: string; href?: string }

export default function Breadcrumb({ items, className = '' }: { items: BreadcrumbItem[]; className?: string }) {
  if (items.length === 0) return null
  return (
    <nav aria-label="Breadcrumb" className={`text-sm text-slate-500 no-print ${className}`}>
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, i) => {
          const last = i === items.length - 1
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1">
              {item.href && !last ? (
                <Link href={item.href} className="text-brand-deep hover:underline min-h-11 inline-flex items-center">{item.label}</Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={last ? 'text-slate-700' : ''}>{item.label}</span>
              )}
              {!last && <span aria-hidden className="text-slate-400">›</span>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
