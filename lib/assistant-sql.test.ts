// The data assistant's SELECT-only guard (first gate; the assistant_query()
// DB function re-validates and enforces transaction_read_only besides).
//
// Behavior pinned:
//   * plain SELECT and WITH…SELECT pass, one trailing semicolon tolerated;
//   * multi-statement, non-SELECT, write/DDL keywords (incl. data-modifying
//     CTEs), SELECT INTO, and FOR UPDATE are rejected with a stated reason;
//   * the guard is conservative: write keywords are rejected even inside
//     string literals (documented false positive).

import { describe, expect, it } from 'vitest'
import { validateAssistantSql } from './assistant-sql'

describe('validateAssistantSql', () => {
  it('accepts a plain SELECT (and strips one trailing semicolon)', () => {
    const r = validateAssistantSql('select crop_year, sum(net_weight) from loads group by 1;')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sql.endsWith(';')).toBe(false)
  })

  it('accepts WITH … SELECT', () => {
    expect(validateAssistantSql('with x as (select 1 as n) select n from x').ok).toBe(true)
  })

  it('rejects multi-statement input', () => {
    const r = validateAssistantSql('select 1; select 2')
    expect(r.ok).toBe(false)
  })

  it('rejects UPDATE / INSERT / DELETE / DDL', () => {
    for (const sql of [
      "update loads set net_weight = 0",
      "insert into loads (date) values ('2026-01-01')",
      'delete from loads',
      'drop table loads',
      'create table x (id int)',
      'truncate loads',
      'grant select on loads to anon',
    ]) {
      expect(validateAssistantSql(sql).ok, sql).toBe(false)
    }
  })

  it('rejects a data-modifying CTE hidden behind SELECT', () => {
    const r = validateAssistantSql("with x as (insert into loads (date) values ('2026-01-01') returning id) select * from x")
    expect(r.ok).toBe(false)
  })

  it('rejects SELECT INTO and FOR UPDATE', () => {
    expect(validateAssistantSql('select * into evil from loads').ok).toBe(false)
    expect(validateAssistantSql('select * from loads for update').ok).toBe(false)
  })

  it('rejects empty and non-SELECT starts', () => {
    expect(validateAssistantSql('').ok).toBe(false)
    expect(validateAssistantSql('explain select 1').ok).toBe(false)
    expect(validateAssistantSql('vacuum').ok).toBe(false)
  })

  it('does NOT false-positive on column names containing keywords (updated_at)', () => {
    expect(validateAssistantSql('select updated_at, created_at from contracts order by updated_at desc').ok).toBe(true)
  })

  it('IS conservative about keywords inside string literals (documented)', () => {
    expect(validateAssistantSql("select * from loads where ticket_number = 'update'").ok).toBe(false)
  })
})
