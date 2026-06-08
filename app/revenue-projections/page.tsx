import { redirect } from 'next/navigation'

// Revenue Projections now lives under Reports. Keep this path working (old
// bookmarks / links) by redirecting to its home there.
export default function RevenueProjectionsRedirect() {
  redirect('/reports/revenue-projections')
}
