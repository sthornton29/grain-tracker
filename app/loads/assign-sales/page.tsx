import AssignSalesClient from './assign-sales-client'

// Loads without a sale type (094): the bulk tool behind the "N loads
// delivered to buyers without a sale type" notices on /loads and
// /contracts. Owner-only — every /loads route already is (lib/route-guard:
// gin, viewer and agronomist logins are redirected off it by the
// middleware), and the load_sales write policies enforce it underneath.

export const dynamic = 'force-dynamic'

export default function AssignSalesPage() {
  return <AssignSalesClient />
}
