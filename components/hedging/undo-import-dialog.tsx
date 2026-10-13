'use client'

// "Undo this import" (0095): one confirmation that says exactly what will
// happen to the positions a brokerage-statement import wrote, then the one
// database call that reverses it. The ledger keeps every step — nothing is
// erased, the undo is appended. When the database refuses (a position moved
// after the import), the positions are named so the farmer knows what to
// look at.

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ConfirmDialog, NoticeDialog } from '@/components/app-dialog'
import { undoEffectText, undoImport, undoNote, type ImportBatch, type UndoRefusal } from '@/lib/hedge-undo'

type Props = {
  batch: ImportBatch
  /** Called after a successful undo with what the database did. */
  onDone: (result: { deleted: number; restored: number }) => void
  onClose: () => void
}

export default function UndoImportDialog({ batch, onDone, onClose }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<UndoRefusal | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    const res = await undoImport(supabase, { statementDate: batch.statementDate, statementRef: batch.statementRef, note: undoNote(batch) })
    setBusy(false)
    if (res.ok) { onDone({ deleted: res.deleted, restored: res.restored }); return }
    if (res.refusal) setRefusal(res.refusal)
    else setFailure(res.error)
  }

  if (refusal) {
    return (
      <NoticeDialog
        open
        title="This import can’t be undone"
        onClose={onClose}
        body={
          <>
            <p>{refusal.text}</p>
            <ul className="list-disc pl-5 space-y-0.5 capitalize">
              {refusal.positions.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </>
        }
      />
    )
  }
  if (failure) {
    return <NoticeDialog open title="Couldn’t undo this import" onClose={onClose} body={<p>{failure}</p>} />
  }
  return (
    <ConfirmDialog
      open
      danger
      busy={busy}
      title={`Undo the ${batch.label} import?`}
      confirmLabel="Undo this import"
      onConfirm={confirm}
      onCancel={onClose}
      body={
        <>
          <p>{undoEffectText(batch)}</p>
          <p className="text-xs text-slate-500">
            Positions this statement created are removed; positions it closed, rolled, or changed go back to how they were just before the import. The history will show the undo as its own steps.
          </p>
        </>
      }
    />
  )
}
