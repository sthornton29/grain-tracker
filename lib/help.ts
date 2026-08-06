// Pure helpers over the generated help content (lib/help-content.generated.ts,
// built from docs/help by `npm run help:build`): route → topic resolution
// (longest-prefix, so /loads/scan beats /loads when both exist) and the
// drawer/help-center search. Kept pure for the vitest coverage suite.

import type { HelpTopic } from '@/lib/help-content.generated'

/** The help topic for a pathname: exact route or longest covering prefix.
 *  '/' covers only itself (every page would otherwise match it). */
export function topicForRoute(topics: ReadonlyArray<HelpTopic>, pathname: string | null | undefined): HelpTopic | null {
  if (!pathname) return null
  let best: HelpTopic | null = null
  for (const t of topics) {
    const covers = pathname === t.route || (t.route !== '/' && pathname.startsWith(t.route + '/'))
    if (covers && (best == null || t.route.length > best.route.length)) best = t
  }
  return best
}

/** Case-insensitive search across title, keywords, and body. Empty query
 *  returns everything (the browse list). */
export function searchTopics(topics: ReadonlyArray<HelpTopic>, query: string): HelpTopic[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...topics]
  const terms = q.split(/\s+/)
  return topics.filter((t) => {
    const hay = `${t.title}\n${t.keywords}\n${t.body}`.toLowerCase()
    return terms.every((term) => hay.includes(term))
  })
}

/** Group topics the way the app is organized, for the /help page. */
export function groupTopics(topics: ReadonlyArray<HelpTopic>): Array<{ title: string; topics: HelpTopic[] }> {
  const groups: Array<{ title: string; match: (r: string) => boolean }> = [
    { title: 'Getting started', match: (r) => r === '/' },
    { title: 'Everyday work', match: (r) => ['/loads', '/inventory', '/contracts', '/settlements', '/hedging', '/yields'].some((p) => r === p || r.startsWith(p + '/')) },
    { title: 'Reports', match: (r) => r === '/reports' || r.startsWith('/reports/') },
    { title: 'Cotton', match: (r) => r === '/cotton' || r.startsWith('/cotton/') },
    { title: 'Settings', match: (r) => r === '/settings' || r.startsWith('/settings/') },
  ]
  const out = groups.map((g) => ({ title: g.title, topics: [] as HelpTopic[] }))
  const rest: HelpTopic[] = []
  for (const t of topics) {
    const g = groups.findIndex((x) => x.match(t.route))
    if (g >= 0) out[g].topics.push(t)
    else rest.push(t)
  }
  if (rest.length > 0) out.push({ title: 'More', topics: rest })
  return out.filter((g) => g.topics.length > 0)
}
