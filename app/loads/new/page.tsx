import Link from 'next/link'
import LoadForm from '@/components/load-form'

export default function NewLoadPage() {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Link
          href="/loads/scan"
          className="rounded-lg bg-white border border-slate-300 px-3 py-2 text-sm"
        >
          Scan Tickets (AI)
        </Link>
      </div>
      <LoadForm mode="create" />
    </div>
  )
}
