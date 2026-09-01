import Link from 'next/link'
import SeedContractForm from '@/components/seed-contract-form'

export default function EditSeedContractPage({ params }: { params: { id: string } }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href={`/contracts/${params.id}`} className="text-brand-deep hover:underline text-sm">← Back to contract</Link>
      </div>
      <h1 className="text-2xl font-bold">Edit seed contract</h1>
      <SeedContractForm editContractId={params.id} />
    </div>
  )
}
