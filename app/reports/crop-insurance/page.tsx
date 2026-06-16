'use client'

import CropInsuranceReport from '@/components/reports/crop-insurance-report'

export default function CropInsuranceReportPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Crop Insurance Production Report</h1>
      <CropInsuranceReport />
    </div>
  )
}
