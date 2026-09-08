// Drag-and-drop file acceptance — the pure half of components/dropzone.tsx.
//
// A file picker enforces its `accept` list for us; a drop does not. So a
// dropped file is checked against the SAME accept string the picker uses,
// with the browser's own semantics: a bare extension (".csv"), a wildcard
// type ("image/*"), or a full MIME type ("application/pdf"). Anything the
// picker would have hidden is rejected before it reaches the upload code.

/** One accept token → does this file satisfy it? */
function matchesToken(file: Pick<File, 'name' | 'type'>, token: string): boolean {
  const t = token.trim().toLowerCase()
  if (!t) return false
  if (t.startsWith('.')) return file.name.toLowerCase().endsWith(t)
  const type = (file.type || '').toLowerCase()
  if (t.endsWith('/*')) return type.startsWith(t.slice(0, -1))
  return type === t
}

/** Does the file satisfy the picker's `accept` list? An empty/absent list
 *  accepts everything, exactly as a bare <input type="file"> would. */
export function matchesAccept(file: Pick<File, 'name' | 'type'>, accept: string | null | undefined): boolean {
  if (!accept || !accept.trim()) return true
  return accept.split(',').some((tok) => matchesToken(file, tok))
}

/** Split a dropped list into what the picker would have allowed and what it
 *  would have hidden. */
export function partitionByAccept<T extends Pick<File, 'name' | 'type'>>(
  files: readonly T[],
  accept: string | null | undefined,
): { accepted: T[]; rejected: T[] } {
  const accepted: T[] = []
  const rejected: T[] = []
  for (const f of files) (matchesAccept(f, accept) ? accepted : rejected).push(f)
  return { accepted, rejected }
}

/** Files from a drop event's DataTransfer (items first — some browsers only
 *  populate one of the two lists — then the files list). */
export function filesFromDataTransfer(dt: Pick<DataTransfer, 'files' | 'items'> | null | undefined): File[] {
  if (!dt) return []
  const out: File[] = []
  const items = dt.items ? Array.from(dt.items) : []
  if (items.length > 0) {
    for (const it of items) {
      if (it.kind !== 'file') continue
      const f = it.getAsFile()
      if (f) out.push(f)
    }
  }
  if (out.length === 0 && dt.files) out.push(...Array.from(dt.files))
  return out
}

/** Does the drag carry files at all (vs. text or a link being dragged)? */
export function dragHasFiles(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  if (!dt || !dt.types) return false
  return Array.from(dt.types).includes('Files')
}
