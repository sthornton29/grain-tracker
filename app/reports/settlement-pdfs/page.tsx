'use client'

import SettlementPdfsReport from '@/components/reports/settlement-pdfs-report'

export default function SettlementPdfsReportPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settlement Statements (Crop Insurance Audit)</h1>
      <SettlementPdfsReport />
    </div>
  )
}
