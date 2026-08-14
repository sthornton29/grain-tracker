// SELECT-only validation for the data assistant's query_data tool.
//
// This is the FIRST of two gates — the database function assistant_query()
// (supabase/068_data_assistant.sql) re-validates and additionally runs the
// query with `transaction_read_only = on` + a statement timeout + a 500-row
// cap, as the CALLING USER (security invoker) so RLS org/role isolation
// applies to whatever SQL the model writes. Tenant isolation is Postgres
// RLS, never prompt language or this validator: rejecting SQL here saves a
// round-trip and gives the model a clear error to correct, nothing more.
//
// Deliberately conservative: whole-word write/DDL keywords are rejected even
// inside string literals (a query filtering notes on '%update%' must be
// rephrased) — false positives are cheap, a data-modifying CTE is not.

const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|truncate|alter|drop|create|grant|revoke|copy|vacuum|analyze|comment|refresh|listen|notify|lock|call|do|into)\b/i

const LOCK_CLAUSE = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i

export type SqlValidation = { ok: true; sql: string } | { ok: false; reason: string }

export function validateAssistantSql(raw: string): SqlValidation {
  let sql = (raw ?? '').trim()
  if (sql === '') return { ok: false, reason: 'Empty query.' }
  // A single trailing semicolon is the model being tidy — strip it.
  sql = sql.replace(/;\s*$/, '')
  if (sql.includes(';')) {
    return { ok: false, reason: 'One SELECT statement only — no semicolons.' }
  }
  if (!/^(select|with)\b/i.test(sql)) {
    return { ok: false, reason: 'Only SELECT (or WITH … SELECT) queries are allowed.' }
  }
  const kw = sql.match(WRITE_KEYWORDS)
  if (kw) {
    return { ok: false, reason: `Read-only: "${kw[1].toLowerCase()}" is not allowed (rephrase without it, including inside quoted strings).` }
  }
  if (LOCK_CLAUSE.test(sql)) {
    return { ok: false, reason: 'Read-only: row-locking clauses are not allowed.' }
  }
  return { ok: true, sql }
}
