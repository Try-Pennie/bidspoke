import { describe, it, expect } from 'vitest'
import {
  renameStepReferences,
  countStepReferences,
  renameFallbackNamespace,
  countBareNamespaceRefs,
  renameBareNamespaceFields,
  renameNamespaceInList,
} from '../rename-step-references'

describe('renameStepReferences', () => {
  it('rewrites bare dot-path form', () => {
    expect(renameStepReferences('steps.old.output.x', 'old', 'new')).toBe('steps.new.output.x')
  })

  it('rewrites template form', () => {
    expect(renameStepReferences('Hello {{steps.old.output.name}}', 'old', 'new')).toBe(
      'Hello {{steps.new.output.name}}'
    )
  })

  it('rewrites multiple occurrences in one string', () => {
    expect(
      renameStepReferences('steps.old.a + steps.old.b * steps.other.c', 'old', 'new')
    ).toBe('steps.new.a + steps.new.b * steps.other.c')
  })

  it('does not match partial namespaces (credit_check vs credit_check_v2)', () => {
    expect(renameStepReferences('steps.credit_check_v2.score', 'credit_check', 'cc_new')).toBe(
      'steps.credit_check_v2.score'
    )
  })

  it('does not match suffix overlap (foo vs barfoo)', () => {
    expect(renameStepReferences('steps.barfoo.x', 'foo', 'new')).toBe('steps.barfoo.x')
  })

  it('leaves trigger/env/context references alone', () => {
    expect(renameStepReferences('trigger.old + env.OLD + context.old', 'old', 'new')).toBe(
      'trigger.old + env.OLD + context.old'
    )
  })

  it('walks nested objects', () => {
    const input = {
      url: 'https://api.example.com/{{steps.old.output.id}}',
      headers: { 'x-id': '{{steps.old.id}}' },
      body: { score: 'steps.old.output.score', other: 42 },
    }
    expect(renameStepReferences(input, 'old', 'new')).toEqual({
      url: 'https://api.example.com/{{steps.new.output.id}}',
      headers: { 'x-id': '{{steps.new.id}}' },
      body: { score: 'steps.new.output.score', other: 42 },
    })
  })

  it('walks arrays', () => {
    const input = [
      { source: 'steps.old.a' },
      { source: 'steps.old.b' },
      { source: 'steps.other.c' },
    ]
    expect(renameStepReferences(input, 'old', 'new')).toEqual([
      { source: 'steps.new.a' },
      { source: 'steps.new.b' },
      { source: 'steps.other.c' },
    ])
  })

  it('returns same reference when no change', () => {
    const input = { url: 'steps.unrelated.x', n: 1 }
    expect(renameStepReferences(input, 'old', 'new')).toBe(input)
  })

  it('no-op when oldNs === newNs', () => {
    const input = { x: 'steps.old.y' }
    expect(renameStepReferences(input, 'old', 'old')).toBe(input)
  })

  it('handles transform array indexing syntax', () => {
    expect(renameStepReferences('steps.old[0].name', 'old', 'new')).toBe('steps.new[0].name')
    expect(renameStepReferences('steps.old[*].name', 'old', 'new')).toBe('steps.new[*].name')
  })

  it('handles formulas with arithmetic', () => {
    expect(
      renameStepReferences('steps.old.output.debt * 0.85 + steps.old.output.fee', 'old', 'new')
    ).toBe('steps.new.output.debt * 0.85 + steps.new.output.fee')
  })

  it('handles ternary expressions', () => {
    expect(
      renameStepReferences('steps.old.x > 100 ? steps.old.x : 0', 'old', 'new')
    ).toBe('steps.new.x > 100 ? steps.new.x : 0')
  })

  it('preserves primitives', () => {
    expect(renameStepReferences(42, 'old', 'new')).toBe(42)
    expect(renameStepReferences(null, 'old', 'new')).toBe(null)
    expect(renameStepReferences(true, 'old', 'new')).toBe(true)
  })
})

describe('countStepReferences', () => {
  it('counts occurrences across nested structures', () => {
    const input = {
      url: '{{steps.old.id}}',
      headers: { 'x-a': '{{steps.old.x}}', 'x-b': '{{steps.other.y}}' },
      body: ['steps.old.z', 'steps.old.w'],
    }
    expect(countStepReferences(input, 'old')).toBe(4)
    expect(countStepReferences(input, 'other')).toBe(1)
    expect(countStepReferences(input, 'missing')).toBe(0)
  })

  it('does not count partial matches', () => {
    expect(countStepReferences('steps.credit_check_v2.x', 'credit_check')).toBe(0)
  })
})

describe('renameFallbackNamespace', () => {
  it('rewrites exact match', () => {
    expect(renameFallbackNamespace('old', 'old', 'new')).toBe('new')
  })

  it('leaves non-match untouched', () => {
    expect(renameFallbackNamespace('other', 'old', 'new')).toBe('other')
  })

  it('leaves non-strings untouched', () => {
    expect(renameFallbackNamespace(null, 'old', 'new')).toBe(null)
    expect(renameFallbackNamespace(undefined, 'old', 'new')).toBe(undefined)
  })
})

// Issue #60: parallel_source and the trigger's success_node_namespaces are bare
// namespaces missed by the steps.X rename machinery.
describe('countBareNamespaceRefs', () => {
  it('counts fallback_node and parallel_source pointing at the namespace', () => {
    expect(countBareNamespaceRefs({ fallback_node: 'old' }, 'old')).toBe(1)
    expect(countBareNamespaceRefs({ parallel_source: 'old' }, 'old')).toBe(1)
    expect(countBareNamespaceRefs({ fallback_node: 'old', parallel_source: 'old' }, 'old')).toBe(2)
  })

  it('is 0 when nothing matches', () => {
    expect(countBareNamespaceRefs({ parallel_source: 'other' }, 'old')).toBe(0)
    expect(countBareNamespaceRefs({}, 'old')).toBe(0)
    expect(countBareNamespaceRefs(null, 'old')).toBe(0)
  })
})

describe('renameBareNamespaceFields', () => {
  it('rewrites parallel_source on a bid_evaluation config', () => {
    expect(renameBareNamespaceFields({ strategy: 'highest_bid', parallel_source: 'bid_race' }, 'bid_race', 'bids'))
      .toEqual({ strategy: 'highest_bid', parallel_source: 'bids' })
  })

  it('rewrites fallback_node', () => {
    expect(renameBareNamespaceFields({ fallback_node: 'old' }, 'old', 'new')).toEqual({ fallback_node: 'new' })
  })

  it('returns the same reference when nothing changed', () => {
    const cfg = { parallel_source: 'other', x: 1 }
    expect(renameBareNamespaceFields(cfg, 'old', 'new')).toBe(cfg)
  })
})

describe('renameNamespaceInList', () => {
  it('renames the namespace within the list', () => {
    expect(renameNamespaceInList(['a', 'win_node', 'b'], 'win_node', 'winner')).toEqual(['a', 'winner', 'b'])
  })

  it('returns the same reference when the namespace is absent', () => {
    const list = ['a', 'b']
    expect(renameNamespaceInList(list, 'old', 'new')).toBe(list)
  })

  it('leaves non-arrays untouched', () => {
    expect(renameNamespaceInList(undefined, 'old', 'new')).toBeUndefined()
  })
})
