import LoadForm from '@/components/load-form'
import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'

export default async function EditLoadPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data, error } = await supabase.from('loads').select('*').eq('id', params.id).single()
  if (error || !data) notFound()
  return <LoadForm mode="edit" initial={data} />
}
