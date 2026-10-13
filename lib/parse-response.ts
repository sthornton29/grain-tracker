// Reading the model's answer text (app/api/parse-document): pure helpers,
// tested in lib/parse-chunked.test.ts.

/** Strip a ```json fence the model sometimes adds despite the prompt. */
export function stripFences(text: string): string {
  let s = text.trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  }
  return s
}

/**
 * Does an unparseable answer look CUT OFF rather than malformed? True when
 * the last non-space character is not a closing brace/bracket, or the
 * brackets never close (depth > 0, or a string left open). A cut-off answer
 * is TOO_LONG for the chunker (split the pages); a malformed one is a
 * plain failure.
 */
export function jsonLooksTruncated(text: string): boolean {
  const s = text.trim()
  if (!s) return false
  const last = s[s.length - 1]
  if (last !== '}' && last !== ']') return true
  let depth = 0
  let inString = false
  let escaped = false
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
  }
  return depth > 0 || inString
}
