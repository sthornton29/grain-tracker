import Link from 'next/link'
import LoadForm from '@/components/load-form'

export default function NewLoadPage() {
  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Link
          href="/loads/combine"
          className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm"
        >
          Yield from combine
        </Link>
        <Link
          href="/loads/scan"
          className="inline-flex items-center rounded-lg bg-white border border-slate-300 px-3 min-h-11 text-sm"
        >
          Scan tickets
        </Link>
      </div>
      <LoadForm mode="create" />
    </div>
  )
}
