import RentSettlementReport from '@/components/reports/rent-settlement-report'

// Rent Settlement (069) — lease-driven landowner settlements. Interactive
// (lease intake + gap interview + generation), so no ExportBar here: the
// statement's PDF/Excel buttons live in the flow and render ORG-branded
// (never Turnrow-branded).
export default function RentSettlementPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Rent Settlement</h1>
      <p className="text-sm text-slate-500">
        Put a lease on file, and Turnrow builds the landowner&rsquo;s settlement from your production and sales —
        asking you only for what the lease needs that the records don&rsquo;t supply. The statement carries your
        farm&rsquo;s name and logo, ready to mail.
      </p>
      <RentSettlementReport />
    </div>
  )
}
