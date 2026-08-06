import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { topicForRoute, searchTopics } from '@/lib/help'
import { buildSupportEmail } from '@/lib/support-request'
import type { HelpTopic } from '@/lib/help-content.generated'

// The help system's freshness contract, enforced in CI:
//   * every route the nav or the reports nav links to must resolve to a
//     docs/help topic — adding a page without help FAILS the suite;
//   * the compiled digest includes every topic file and carries its stamp;
//   * route → topic matching prefers the most specific topic;
//   * the support email carries every context field and the escalated
//     transcript.

const root = process.cwd() // vitest runs from the repo root
const helpDir = join(root, 'docs', 'help')

function loadTopics(): HelpTopic[] {
  return readdirSync(helpDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => {
      const raw = readFileSync(join(helpDir, f), 'utf8')
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
      if (!m) throw new Error(`${f}: missing front-matter`)
      const meta: Record<string, string> = {}
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^(\w+):\s*(.*)$/)
        if (kv) meta[kv[1]] = kv[2].trim()
      }
      for (const key of ['page_route', 'title', 'updated', 'keywords']) {
        if (!meta[key]) throw new Error(`${f}: front-matter is missing "${key}"`)
      }
      return { route: meta.page_route, title: meta.title, updated: meta.updated, keywords: meta.keywords, body: m[2].trim() }
    })
}

function appRoutes(): string[] {
  const sources = [
    readFileSync(join(root, 'lib', 'nav-links.ts'), 'utf8'),
    readFileSync(join(root, 'app', 'reports', 'reports-nav.ts'), 'utf8'),
  ]
  const routes = new Set<string>()
  for (const src of sources) for (const m of src.matchAll(/href:\s*'([^']+)'/g)) routes.add(m[1])
  return [...routes]
}

describe('help coverage (CI gate)', () => {
  it('every nav + reports route has a help topic', () => {
    const topics = loadTopics()
    const uncovered = appRoutes().filter((r) => topicForRoute(topics, r) == null)
    expect(uncovered, `routes without a docs/help topic: ${uncovered.join(', ')}`).toEqual([])
  })

  it('help files never leak internals', () => {
    for (const t of loadTopics()) {
      const text = t.body.toLowerCase()
      for (const banned of ['supabase', 'migration', 'row-level security', ' rls ', 'postgres', 'vercel']) {
        expect(text.includes(banned), `${t.route} help mentions "${banned.trim()}"`).toBe(false)
      }
    }
  })

  it('the compiled digest exists, is stamped, and includes every topic', () => {
    const digestPath = join(helpDir, '_digest.md')
    expect(existsSync(digestPath), '_digest.md missing — run npm run help:build').toBe(true)
    const digest = readFileSync(digestPath, 'utf8')
    expect(digest).toMatch(/Generated \d{4}-\d{2}-\d{2}/)
    expect(digest).toContain('does NOT do')
    for (const t of loadTopics()) {
      expect(digest, `digest missing topic ${t.title}`).toContain(`(page: ${t.route})`)
    }
  })

  it('the bundled module matches the topic files', () => {
    const generated = readFileSync(join(root, 'lib', 'help-content.generated.ts'), 'utf8')
    for (const t of loadTopics()) {
      expect(generated, `generated module missing route ${t.route} — run npm run help:build`).toContain(JSON.stringify(t.route))
    }
  })
})

describe('topicForRoute', () => {
  const topics: HelpTopic[] = [
    { route: '/', title: 'Home', updated: 'x', keywords: '', body: '' },
    { route: '/loads', title: 'Loads', updated: 'x', keywords: '', body: '' },
    { route: '/loads/scan', title: 'Scan', updated: 'x', keywords: '', body: '' },
  ]
  it('longest prefix wins; / covers only itself', () => {
    expect(topicForRoute(topics, '/loads/scan')?.title).toBe('Scan')
    expect(topicForRoute(topics, '/loads/scan/extra')?.title).toBe('Scan')
    expect(topicForRoute(topics, '/loads/new')?.title).toBe('Loads')
    expect(topicForRoute(topics, '/')?.title).toBe('Home')
    expect(topicForRoute(topics, '/settings')).toBeNull()
    expect(topicForRoute(topics, '/loadsX')).toBeNull()
  })
})

describe('searchTopics', () => {
  const topics: HelpTopic[] = [
    { route: '/a', title: 'Marketing', updated: 'x', keywords: 'basis, hta', body: 'contracts and futures' },
    { route: '/b', title: 'Yields', updated: 'x', keywords: 'harvest', body: 'bushels per acre' },
  ]
  it('matches title, keywords, and body; all terms must hit', () => {
    expect(searchTopics(topics, 'basis').map((t) => t.route)).toEqual(['/a'])
    expect(searchTopics(topics, 'bushels acre').map((t) => t.route)).toEqual(['/b'])
    expect(searchTopics(topics, 'futures harvest')).toEqual([])
    expect(searchTopics(topics, '')).toHaveLength(2)
  })
})

describe('buildSupportEmail', () => {
  const ctx = {
    userEmail: 'farmer@example.com', orgName: 'Beta Test Farm', role: 'owner',
    route: '/reports/marketing', version: 'abc1234', browser: 'Safari iPad',
  }
  it('carries every context field', () => {
    const { subject, text } = buildSupportEmail({ subject: 'Basis question', message: 'My basis looks off.' }, ctx)
    expect(subject).toBe('[Turnrow support] Basis question — Beta Test Farm')
    for (const needle of ['farmer@example.com', '(owner)', 'Beta Test Farm', '/reports/marketing', 'abc1234', 'Safari iPad', 'My basis looks off.']) {
      expect(text).toContain(needle)
    }
    expect(text).not.toContain('Assistant conversation')
  })
  it('includes the transcript on escalation and defaults the subject', () => {
    const { subject, text } = buildSupportEmail({ subject: '', message: 'Still stuck.', transcript: 'Me: help\n\nAssistant: try this' }, ctx)
    expect(subject).toContain('Support request')
    expect(text).toContain('---- Assistant conversation ----')
    expect(text).toContain('Me: help')
  })
})
