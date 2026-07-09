// Server-only helper shared by the AI lookup routes (/api/arc-benchmark-lookup,
// /api/mya-monthly-lookup — and any future third lookup): one web-search-enabled
// Claude call returning parsed JSON, with error normalization and an
// in-process cache that also dedupes concurrent identical requests (repeat
// clicks share one in-flight call instead of paying for another search).

import Anthropic from '@anthropic-ai/sdk'
import { extractJson } from './ai-lookups'

const MODEL = 'claude-sonnet-4-6'

export type AiLookupErrorKind = 'config' | 'api' | 'parse'

export class AiLookupError extends Error {
  kind: AiLookupErrorKind
  constructor(kind: AiLookupErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

type CacheEntry = { expires: number; promise: Promise<unknown> }
const cache = new Map<string, CacheEntry>()

export async function aiWebSearchJson(args: {
  prompt: string
  // e.g. "arc-benchmark:corn:<county_id>:2026" — commodity + county_id +
  // program year for benchmarks, commodity + marketing year for MYA months.
  cacheKey: string
  cacheTtlMs: number
  maxSearches?: number
  maxTokens?: number
}): Promise<unknown> {
  const now = Date.now()
  const hit = cache.get(args.cacheKey)
  if (hit && hit.expires > now) return hit.promise
  const promise = runLookup(args)
  cache.set(args.cacheKey, { expires: now + args.cacheTtlMs, promise })
  try {
    return await promise
  } catch (e) {
    // Only successful lookups stay cached; leave a newer entry alone.
    if (cache.get(args.cacheKey)?.promise === promise) cache.delete(args.cacheKey)
    throw e
  }
}

async function runLookup(args: { prompt: string; maxSearches?: number; maxTokens?: number }): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new AiLookupError('config', 'ANTHROPIC_API_KEY is not configured on the server.')

  const client = new Anthropic({ apiKey })
  let resp
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: args.maxTokens ?? 2048,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: args.maxSearches ?? 6 }],
      messages: [{ role: 'user', content: args.prompt }],
    })
  } catch (e: any) {
    const msg = e?.error?.error?.message ?? e?.message ?? 'Anthropic API call failed.'
    throw new AiLookupError('api', `Lookup failed: ${msg}`)
  }

  // The final text block carries the JSON (earlier blocks are search calls).
  const textBlocks = resp.content.filter((c) => c.type === 'text')
  const lastText = textBlocks.length ? (textBlocks[textBlocks.length - 1] as { text: string }).text : ''
  try {
    return JSON.parse(extractJson(lastText))
  } catch {
    throw new AiLookupError('parse', "Couldn't parse the lookup response.")
  }
}
