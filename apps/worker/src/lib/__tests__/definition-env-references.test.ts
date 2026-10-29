/**
 * The variables a workflow definition reads (envReferences), and the one
 * judgement of whether each has a value (judgeVariables, #3003). An ops run
 * and an ops step test are given every variable's current value, secrets
 * included (#2982; Dan, 2026-10-29: "Any secret, no exceptions"), so only a
 * variable with no value is refused.
 */
import { describe, expect, it } from 'vitest'
import { envReferences, judgeVariables } from '../definition-env-references'

const node = (id: string, config: Record<string, unknown>) => ({ id, namespace: id, type: 'transform', config })

describe('envReferences: the variables a definition reads', () => {
  it('finds env.X as a path and {{env.X}} in a template, in steps and edge conditions, once each, in order', () => {
    const def = {
      nodes: [node('a', { mappings: [{ source: 'env.API_BASE', target: 'b' }, { source: 'see {{ env.LIST_ID }} and {{env.API_BASE}}', target: 'c' }] })],
      edges: [{ id: 'e', source: 'a', target: 'b', condition: { field: 'env.REGION' } }],
    }
    expect(envReferences(def)).toEqual(['API_BASE', 'LIST_ID', 'REGION'])
  })

  it('does not read a mention that is neither a path nor a template, nor anything outside the steps and edges', () => {
    const def = { name: 'uses env.NAME_ONLY', nodes: [node('a', { note: 'mentions env.PROSE in a sentence' })], edges: [] }
    expect(envReferences(def)).toEqual([])
  })

  it('reads nothing from something that is not nodes and edges', () => {
    expect(envReferences({})).toEqual([])
    expect(envReferences({ nodes: 'env.X', edges: null })).toEqual([])
  })
})

describe('judgeVariables: whether every variable read has a value', () => {
  it('gives a definition reading nothing, and one whose every variable has a value, a secret among them', () => {
    expect(judgeVariables([], [])).toEqual({ kind: 'given' })
    expect(judgeVariables(['API_BASE', 'TOKEN'], ['TOKEN', 'API_BASE', 'UNREAD'])).toEqual({ kind: 'given' })
  })

  it('refuses one reading a variable with no value, naming each in the order read', () => {
    expect(judgeVariables(['A', 'B', 'C'], new Set(['B']))).toEqual({ kind: 'refused', missing: ['A', 'C'] })
  })
})
