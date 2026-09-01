import { describe, it, expect } from 'vitest'
import {
  ROOT_NAMESPACES,
  isRootNamespace,
  extractStepChains,
  stripOutputWrapper,
  chainToStepPath,
  parseStepPath,
  hasDynamicStepsAccess,
  extractReferencedNamespaces,
  stepReferencePattern,
} from './index'

describe('root namespaces', () => {
  it('lists exactly what the engine resolver recognises', () => {
    // These four are what engine/context.ts resolveReference branches on. A
    // fifth invented here would make the editor accept a reference the engine
    // silently resolves to undefined.
    expect([...ROOT_NAMESPACES].sort()).toEqual(['env', 'execution', 'steps', 'trigger'])
  })
  it('rejects an unknown root', () => {
    expect(isRootNamespace('steps')).toBe(true)
    expect(isRootNamespace('constants')).toBe(false)
  })
})

describe('extractStepChains', () => {
  it('finds a chain inside a template', () => {
    expect(extractStepChains('{{steps.x.output.final}}')).toEqual(['steps.x.output.final'])
  })
  it('finds both operands of a coalesce', () => {
    expect(extractStepChains('steps.a.output.v ?? steps.b.output.v')).toEqual([
      'steps.a.output.v',
      'steps.b.output.v',
    ])
  })
  it('stops a chain at a bracket', () => {
    expect(extractStepChains('steps.x.output.list[0].field')).toEqual(['steps.x.output.list'])
  })
  it('handles optional chaining and $return_value', () => {
    expect(extractStepChains('steps.p?.$return_value?.final')).toEqual(['steps.p?.$return_value?.final'])
  })
  it('does not match steps inside a larger identifier', () => {
    expect(extractStepChains('mysteps.x.y')).toEqual([])
  })
})

describe('stripOutputWrapper', () => {
  // This one rule decides which field the engine resolves AND which field the
  // watcher records. It lived in three places before #433; if any copy had
  // drifted, the detector would have watched a different field than the engine
  // read, and been silently wrong about a field nobody was watching.
  it('drops an output wrapper', () => {
    expect(stripOutputWrapper(['x', 'output', 'y'])).toEqual(['x', 'y'])
  })
  it('drops a $return_value wrapper', () => {
    expect(stripOutputWrapper(['x', '$return_value', 'y'])).toEqual(['x', 'y'])
  })
  it('leaves a plain path untouched', () => {
    expect(stripOutputWrapper(['x', 'y'])).toEqual(['x', 'y'])
  })
  it('keeps a namespace whose only segment is the wrapper', () => {
    expect(stripOutputWrapper(['x', '$return_value'])).toEqual(['x'])
  })
  it('only strips the wrapper directly after the namespace', () => {
    // `x.y.output` is a real field called output, not a wrapper.
    expect(stripOutputWrapper(['x', 'y', 'output'])).toEqual(['x', 'y', 'output'])
  })
})

describe('chainToStepPath', () => {
  it('normalizes the Scout chain', () => {
    expect(chainToStepPath('steps.pennie_or_eligibility?.$return_value?.final')).toBe(
      'pennie_or_eligibility.final',
    )
  })
  it('tolerates whitespace around separators', () => {
    expect(chainToStepPath('steps . x . output . y')).toBe('x.y')
  })
})

describe('parseStepPath', () => {
  it('accepts a path with or without the steps root', () => {
    expect(parseStepPath('steps.x.output.y')).toEqual(['x', 'y'])
    expect(parseStepPath('x.output.y')).toEqual(['x', 'y'])
    expect(parseStepPath('x.y')).toEqual(['x', 'y'])
  })
  it('drops empty segments from a trailing or doubled dot', () => {
    expect(parseStepPath('x..y.')).toEqual(['x', 'y'])
  })
})

describe('hasDynamicStepsAccess', () => {
  it('bails on bracket access', () => {
    expect(hasDynamicStepsAccess('const v = steps["foo"].bar')).toBe(true)
  })
  it('bails on whole-object aliasing', () => {
    expect(hasDynamicStepsAccess('const all = steps; return all.x')).toBe(true)
  })
  it('bails on Object.keys iteration', () => {
    expect(hasDynamicStepsAccess('Object.keys(steps)')).toBe(true)
  })
  it('bails on for-in over steps', () => {
    expect(hasDynamicStepsAccess('for (const k in steps) {}')).toBe(true)
  })
  it('does not bail on an ordinary dotted read', () => {
    expect(hasDynamicStepsAccess('const v = steps.a.b')).toBe(false)
  })
  it('does not bail on a partial alias, which is resolvable', () => {
    // `const r = steps.a.b` is followed by a dot, so it is not whole-object
    // aliasing. #435 resolves these rather than bailing.
    expect(hasDynamicStepsAccess('const r = steps.a.b; return r.c')).toBe(false)
  })
})

describe('extractReferencedNamespaces', () => {
  it('returns the namespaces a script reads', () => {
    expect(extractReferencedNamespaces('steps.a.x + steps.b.y')).toEqual(new Set(['a', 'b']))
  })
  it('returns null on dynamic access so the caller sends everything', () => {
    expect(extractReferencedNamespaces('steps[k].x')).toBeNull()
  })
})

describe('stepReferencePattern', () => {
  it('matches the namespace it names', () => {
    expect('steps.credit_check.output.x'.match(stepReferencePattern('credit_check'))).toHaveLength(1)
  })
  it('does not match a namespace that merely starts the same', () => {
    // Renaming `credit_check` must not touch `credit_check_v2`.
    expect('steps.credit_check_v2.output.x'.match(stepReferencePattern('credit_check'))).toBeNull()
  })
  it('escapes regex metacharacters in a namespace', () => {
    expect('steps.ab.x'.match(stepReferencePattern('a.b'))).toBeNull()
  })
})
