import LoadForm from '@/components/load-form'
import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import type { LoadSplit } from '@/lib/types'

export default async function EditLoadPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const [{ data, error }, splitsRes] = await Promise.all([
    supabase.from('loads').select('*').eq('id', params.id).single(),
    supabase.from('load_splits').select('*').eq('load_id', params.id),
  ])
  if (error || !data) notFound()
  const initialSplits = (splitsRes.data as LoadSplit[]) || []
  return <LoadForm mode="edit" initial={data} initialSplits={initialSplits} />
}
