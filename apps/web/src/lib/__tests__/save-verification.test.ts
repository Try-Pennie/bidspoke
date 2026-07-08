import { describe, it, expect } from 'vitest'
import { definitionsMatch, classifySave } from '../save-verification'

// #569 read-back verification: after a save returns 200, the canvas re-fetches
// the workflow and confirms the persisted definition matches what it sent, so a
// silent non-persistence can never masquerade as "Saved". The stored value is
// jsonb (Postgres reorders object keys), so the check must be structural.
describe('definitionsMatch', () => {
  it('matches when the persisted definition is the sent one with keys reordered (jsonb round-trip)', () => {
    const sent = { nodes: [{ id: 'a', type: 'code', config: { script: 's', retries: 2 } }], trigger: { type: 'http_webhook', config: {} } }
    const persisted = { trigger: { config: {}, type: 'http_webhook' }, nodes: [{ config: { retries: 2, script: 's' }, type: 'code', id: 'a' }] }
    expect(definitionsMatch(sent, persisted)).toBe(true)
  })

  it('does NOT match when the server persisted a different (stale) definition', () => {
    const sent = { nodes: [{ id: 'a', config: { script: 'return { x: 1, y: 2 }' } }] }
    const persistedStale = { nodes: [{ id: 'a', config: { script: 'return { x: 1 }' } }] }
    expect(definitionsMatch(sent, persistedStale)).toBe(false)
  })

  it('does NOT match when a node is missing from the persisted definition', () => {
    const sent = { nodes: [{ id: 'a' }, { id: 'b' }] }
    const persisted = { nodes: [{ id: 'a' }] }
    expect(definitionsMatch(sent, persisted)).toBe(false)
  })
})

// classifySave is the pure decision the canvas post-save flow makes (#569): it
// turns the save response + a read-back fetch into one of three loud, distinct
// outcomes so a save can never silently look like a success when it wasn't.
describe('classifySave', () => {
  it('reports no_changes when the server short-circuited a no-op save', () => {
    const v = classifySave({ noChanges: true, sentDefinition: { nodes: [] }, persisted: { definition: { nodes: [] } } })
    expect(v).toBe('no_changes')
  })

  it('reports saved when the read-back definition matches what was sent', () => {
    const def = { nodes: [{ id: 'a', config: { script: 'x' } }] }
    const v = classifySave({ noChanges: false, sentDefinition: def, persisted: { definition: { nodes: [{ config: { script: 'x' }, id: 'a' }] } } })
    expect(v).toBe('saved')
  })

  it('reports unverified when the read-back definition differs from what was sent', () => {
    const v = classifySave({
      noChanges: false,
      sentDefinition: { nodes: [{ id: 'a', config: { script: 'new' } }] },
      persisted: { definition: { nodes: [{ id: 'a', config: { script: 'old' } }] } },
    })
    expect(v).toBe('unverified')
  })

  it('reports saved (inconclusive, not a false failure) when the read-back fetch failed', () => {
    const v = classifySave({ noChanges: false, sentDefinition: { nodes: [] }, persisted: null })
    expect(v).toBe('saved')
  })
})
