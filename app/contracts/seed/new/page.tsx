import Link from 'next/link'
import SeedContractForm from '@/components/seed-contract-form'

export default function NewSeedContractPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/contracts" className="text-brand-deep hover:underline text-sm">← Contracts</Link>
      </div>
      <h1 className="text-2xl font-bold">New seed contract</h1>
      <p className="text-slate-600 max-w-3xl text-sm">
        A seed production agreement commits acres, not bushels: you grow the seed company&rsquo;s variety on named fields,
        price the bushels on your own timing against their local market, and premiums ride on top once the crop is accepted.
      </p>
      <SeedContractForm />
    </div>
  )
}
