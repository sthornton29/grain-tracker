// Read-only smoke run of the ops API builders (2026-11-08) against the
// database in .env.local with the service role: the brief and every
// dataset for OPS_ORG (default 'turnrow-farm'). Writes nothing.
//   npx tsx scripts/dev/ops-smoke.ts [org slug]
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

async function main() {
  const { buildOpsBrief } = await import('../../lib/ops/brief')
  const { DATASETS, readDataset } = await import('../../lib/ops/data')
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const slug = process.argv[2] ?? 'turnrow-farm'
  const { data: org } = await sb.from('organizations').select('id, name').eq('slug', slug).single()
  if (!org) throw new Error(`no org ${slug}`)
  console.log('org', org.name, org.id)
  const t0 = Date.now()
  const b = await buildOpsBrief(sb, org.id)
  console.log(`brief in ${Date.now() - t0} ms, ${JSON.stringify(b).length} bytes`)
  for (const t of b.todos) console.log(`  TODO [${t.status}${t.due ? ' ' + t.due : ''}] ${t.text}`)
  for (const a of b.alerts) console.log(`  ALERT ${a.severity} ${a.text}${a.amount ? ' $' + a.amount : ''}`)
  for (const m of b.metrics) console.log(`  METRIC ${m.label}: ${m.value} ${m.unit ?? ''}`)
  for (const l of b.lists) console.log(`  LIST ${l.name}: ${l.rows.length} rows`)
  for (const n of b.notes) console.log(`  NOTE ${n}`)
  for (const d of DATASETS) {
    const t1 = Date.now()
    try {
      const r = await readDataset(sb, org.id, d.name, {})
      console.log(`  DATASET ${d.name}: ${r.total} rows in ${Date.now() - t1} ms${r.rows[0] ? ` e.g. ${JSON.stringify(r.rows[0]).slice(0, 160)}` : ''}`)
    } catch (e) { console.log(`  DATASET ${d.name}: FAILED ${(e as Error).message}`) }
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
