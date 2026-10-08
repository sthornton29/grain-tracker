// The account-names block Ask Turnrow reads before choosing a tool: entity
// names are labeled as entities (the "Two Seasons vs View Celeste" question
// was answered as a variety split), double-crop-designated crops say so, the
// full-season / double-crop rule is spelled out, and long lists are capped.

import { describe, expect, it } from 'vitest'
import { buildAccountVocabulary, VOCABULARY_CAP, VOCABULARY_HEADING } from './assistant-vocabulary'

const base = {
  entities: [{ name: 'Two Seasons Farms', entity_role: 'farming' }, { name: 'View Celeste Farms', entity_role: null }, { name: 'TSF Marketing', entity_role: 'marketing_agent' }],
  farms: [{ name: 'Home Place' }, { name: 'River Bottom' }],
  crops: [{ name: 'Corn', double_crop: false }, { name: 'Soybean', double_crop: true }, { name: 'Wheat', double_crop: null }],
  landowners: [{ name: 'Smith Trust' }],
  buyers: [{ name: 'Bunge' }],
  varieties: ['P 48A60X', 'AG 46XF2', 'P 48A60X'],
}

describe('buildAccountVocabulary', () => {
  it('labels entity names as entities and marks the marketing agent', () => {
    const text = buildAccountVocabulary(base)
    expect(text.startsWith(VOCABULARY_HEADING)).toBe(true)
    expect(text).toMatch(/^Entities \(your operating companies.*: Two Seasons Farms; View Celeste Farms; TSF Marketing \(marketing agent\)$/m)
    expect(text).toMatch(/^Farms: Home Place; River Bottom$/m)
    expect(text).toMatch(/^Buyers: Bunge$/m)
  })

  it('says which crop is designated Double-crop and spells out the cropping rule', () => {
    const text = buildAccountVocabulary(base)
    expect(text).toMatch(/^Crops: Corn; Soybean \(designated Double-crop: its plantings are full-season or double-crop\); Wheat$/m)
    expect(text).toMatch(/cropping "full_season" or "double_crop"/)
    expect(text).toMatch(/Never say the two cannot be told apart/)
    expect(text).toMatch(/a name under Entities is an entity .* never a variety/)
  })

  it('dedupes varieties and caps long lists with a count', () => {
    const text = buildAccountVocabulary(base)
    expect(text).toMatch(/^Varieties \(seed varieties inside plantings\): P 48A60X; AG 46XF2$/m)
    const many = buildAccountVocabulary({ ...base, farms: Array.from({ length: VOCABULARY_CAP + 7 }, (_, i) => ({ name: `Farm ${i + 1}` })) })
    expect(many).toMatch(/^Farms: Farm 1; .*; Farm 60; … and 7 more$/m)
  })

  it('an empty list says so instead of vanishing', () => {
    expect(buildAccountVocabulary({ ...base, landowners: [] })).toMatch(/^Landowners: \(none yet\)$/m)
  })
})
