// ONE place that turns a database / network / auth failure into a sentence a
// farmer can act on. Every `setError(err.message)` in the app should go through
// friendlyError() instead — the raw text (Postgres constraint names, PostgREST
// phrasing, vendor wording) is logged to the console for support, never shown.
//
// Pure and dependency-free so it is unit-testable and safe in both server and
// client code.

export type FriendlyErrorInput =
  | { code?: string | number | null; message?: string | null; details?: string | null; hint?: string | null; status?: number | null }
  | Error
  | string
  | null
  | undefined

export type FriendlyErrorOptions = {
  /** What the user was trying to do, in the past-tense-free imperative:
   *  "save this load", "add the truck", "delete the field". Used in the
   *  fallback sentence: "Turnrow couldn't save this load." */
  action?: string
  /** A user-visible name for the record when a duplicate is rejected
   *  ("A truck named “KB Wild” already exists."). */
  name?: string
  /** What the record is called ("truck", "field", "buyer") — for the
   *  duplicate and in-use sentences. */
  noun?: string
}

const CONTACT = 'If it keeps happening, contact support.'

function pick(input: FriendlyErrorInput): { code: string; message: string; status: number | null } {
  if (input == null) return { code: '', message: '', status: null }
  if (typeof input === 'string') return { code: '', message: input, status: null }
  const anyIn = input as { code?: unknown; message?: unknown; status?: unknown; details?: unknown }
  return {
    code: anyIn.code == null ? '' : String(anyIn.code),
    message: typeof anyIn.message === 'string' ? anyIn.message : '',
    status: typeof anyIn.status === 'number' ? anyIn.status : null,
  }
}

/** True when the failure looks like a lost connection rather than a rejected
 *  request — the app should keep the user's typing and suggest a retry. */
export function isConnectionError(input: FriendlyErrorInput): boolean {
  const { message, code } = pick(input)
  const m = message.toLowerCase()
  return (
    code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'AbortError' ||
    (typeof input === 'object' && input != null && 'name' in input && (input as Error).name === 'AbortError') ||
    m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network request failed') ||
    m.includes('load failed') || m.includes('timed out') || m.includes('timeout') || m.includes('aborted') ||
    m.includes('fetch failed') || m.includes('econnreset')
  )
}

/** The farmer-facing sentence for any failure. Never returns the raw message. */
export function friendlyError(input: FriendlyErrorInput, opts: FriendlyErrorOptions = {}): string {
  const { code, message, status } = pick(input)
  const m = message.toLowerCase()
  const noun = opts.noun ?? 'record'
  const action = opts.action ? `Turnrow couldn't ${opts.action}.` : "Turnrow couldn't save that."

  if (isConnectionError(input)) {
    return `No connection right now — what you typed is still here. Check your signal and try again.`
  }

  // Postgres SQLSTATE codes (PostgREST passes them through as `code`).
  if (code === '23505' || m.includes('duplicate key') || m.includes('already exists')) {
    if (opts.name) return `A ${noun} named “${opts.name}” already exists.`
    return `That ${noun} already exists — pick a different name.`
  }
  if (code === '23503' || m.includes('foreign key') || m.includes('violates foreign key')) {
    if (m.includes('is not present') || m.includes('insert or update')) {
      return `Something this ${noun} points to no longer exists. Refresh the page and try again.`
    }
    return `This ${noun} is still in use — other records depend on it, so it can't be deleted.`
  }
  if (code === '23514' || m.includes('check constraint')) {
    return `One of the values isn't allowed here. Check the numbers and try again.`
  }
  if (code === '23502' || m.includes('null value in column')) {
    return `A required field is blank.`
  }
  if (code === '42501' || m.includes('row-level security') || m.includes('permission denied') || status === 403) {
    return `You don't have permission to make this change. Ask your operation's owner.`
  }
  if (code === 'PGRST116' || m.includes('json object requested') || m.includes('multiple (or no) rows')) {
    return `That ${noun} couldn't be found — it may have been changed by someone else. Refresh the page.`
  }
  if (code === '42P01' || code === '42703' || m.includes('does not exist') || m.includes('could not find the')) {
    return `This part of Turnrow isn't set up for your account yet — contact support.`
  }
  if (status === 401 || m.includes('jwt') || m.includes('not authenticated') || m.includes('session')) {
    return `Your sign-in has expired. Sign in again to continue.`
  }
  if (m.includes('invalid login credentials')) {
    return `That email and password don't match.`
  }
  if (m.includes('rate limit') || status === 429) {
    return `Too many tries in a row — wait a minute and try again.`
  }
  if (m.includes('payload too large') || status === 413 || m.includes('exceeded the maximum allowed size')) {
    return `That file is too large to upload. Try a smaller photo or a PDF.`
  }
  if (status != null && status >= 500) {
    return `${action} Turnrow had a problem on its end — try again in a moment. ${CONTACT}`
  }
  return `${action} Try again. ${CONTACT}`
}

/** Log the raw failure for support and return the farmer-facing sentence —
 *  the one-liner to use inside catch blocks: `setError(reportError(err, { action: 'save this load' }))`. */
export function reportError(input: FriendlyErrorInput, opts: FriendlyErrorOptions = {}): string {
  try {
    // eslint-disable-next-line no-console
    console.error('[turnrow]', opts.action ?? 'error', input)
  } catch { /* console unavailable */ }
  return friendlyError(input, opts)
}
