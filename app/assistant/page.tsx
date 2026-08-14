import { createClient } from '@/lib/supabase/server'
import { coerceAppRole } from '@/lib/app-role'
import AssistantChat from '@/components/assistant/assistant-chat'

// "Ask Turnrow" — full-page data assistant. Open to every role (like /help);
// what each role's questions can see is enforced by their own RLS, not by
// this page. Reached from the help drawer's Ask Turnrow tab.
export default async function AssistantPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile } = user
    ? await supabase.from('user_profiles').select('role').eq('user_id', user.id).maybeSingle()
    : { data: null }
  const role = coerceAppRole((profile as { role?: string } | null)?.role)
  return (
    <div className="max-w-3xl mx-auto flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      <h1 className="text-2xl font-bold mb-1">Ask Turnrow</h1>
      <p className="text-sm text-slate-500 mb-3">
        Questions about your own numbers — answered from the same data as your reports.
      </p>
      <div className="flex-1 min-h-0 bg-white rounded-xl shadow p-4">
        <AssistantChat role={role} autoFocus />
      </div>
    </div>
  )
}
