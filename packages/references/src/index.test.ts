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
  extractTemplateExpressions,
  referenceOperands,
  unknownReferenceRoot,
  stripComments,
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

describe('extractTemplateExpressions', () => {
  it('finds a single expression', () => {
    expect(extractTemplateExpressions('{{trigger.payload.x}}')).toEqual(['trigger.payload.x'])
  })
  it('finds every expression in an interpolated string', () => {
    expect(extractTemplateExpressions('Hi {{trigger.a}} and {{steps.b.c}}')).toEqual(['trigger.a', 'steps.b.c'])
  })
  it('trims whitespace inside the braces', () => {
    expect(extractTemplateExpressions('{{  trigger.a  }}')).toEqual(['trigger.a'])
  })
  it('finds nothing in a plain string', () => {
    expect(extractTemplateExpressions('just text')).toEqual([])
  })
})

describe('referenceOperands', () => {
  // The engine's own grammar: coalesce operands split on ??, arithmetic splits
  // on whitespace-separated operators, number literals are not references.
  it('splits a coalesce into its operands', () => {
    expect(referenceOperands('steps.a.x ?? steps.b.x')).toEqual(['steps.a.x', 'steps.b.x'])
  })
  it('splits arithmetic and drops number literals', () => {
    expect(referenceOperands('steps.a.bid * 0.65')).toEqual(['steps.a.bid'])
  })
  it('handles a coalesce whose operands are arithmetic', () => {
    expect(referenceOperands('steps.a.x * 2 ?? trigger.y')).toEqual(['steps.a.x', 'trigger.y'])
  })
  it('leaves a plain reference alone', () => {
    expect(referenceOperands('trigger.payload.name')).toEqual(['trigger.payload.name'])
  })
  it('does not split a payload key containing a hyphen', () => {
    // Operators must be whitespace separated, because a payload key can legally
    // contain a dash. Splitting on a bare `-` would corrupt this lookup.
    expect(referenceOperands('trigger.payload.some-key')).toEqual(['trigger.payload.some-key'])
  })
})

describe('unknownReferenceRoot', () => {
  it('accepts every root the engine resolves', () => {
    for (const root of ROOT_NAMESPACES) {
      expect(unknownReferenceRoot(`${root}.something`)).toBeNull()
    }
  })
  it('names a bare payload root, the one that killed the Scout fallback', () => {
    expect(unknownReferenceRoot('payload.debt')).toBe('payload')
  })
  it('reads the root before a bracket', () => {
    expect(unknownReferenceRoot('payload[0].x')).toBe('payload')
  })
  it('accepts a bracketed lookup on a known root', () => {
    expect(unknownReferenceRoot('steps.c.map[trigger.payload.k].id')).toBeNull()
  })
  it('says nothing about a bare number, which is a literal not a reference', () => {
    expect(unknownReferenceRoot('42')).toBeNull()
  })
  it('says nothing about a quoted string literal', () => {
    expect(unknownReferenceRoot("'Engine'")).toBeNull()
  })
})

/**
 * #1118. The watched-field derivation ran the chain extractor over raw script
 * text, so paths written in COMMENTS were harvested as live references and then
 * paged as fields that never resolve. The two that cost the most were migration
 * notes in one Engine Bidding node, reported on 481,959 and 313,171 runs.
 *
 * Every "leaves it alone" case below is load-bearing rather than defensive: an
 * unwatched field is silent, so a stripper that over-reaches trades a noisy
 * false alarm for a blind spot, which is the worse of the two.
 */
describe('stripComments', () => {
  it('removes a line comment', () => {
    expect(extractStepChains(stripComments('const a = 1; // steps.x.y\n'))).toEqual([])
  })

  it('removes a block comment spanning lines', () => {
    expect(extractStepChains(stripComments('/* steps.x.y\n steps.p.q */\nconst b = 2;\n'))).toEqual([])
  })

  it('removes the migration note that caused the false page, keeping the real read', () => {
    const src =
      '// Translates: steps.create_prospect.$return_value.id -> steps.create_prospect.output.body.id\n' +
      'const id = steps.create_prospect.output.body.id;\n'
    expect(extractStepChains(stripComments(src))).toEqual(['steps.create_prospect.output.body.id'])
  })

  it('keeps a reference inside a template literal', () => {
    const src = 'const c = `${base}/${steps.create_prospect.output.body.id}`;'
    expect(extractStepChains(stripComments(src))).toEqual(['steps.create_prospect.output.body.id'])
  })

  it('keeps a double slash inside a single-quoted string', () => {
    expect(stripComments("const u = 'https://x/y'; const a = 1;")).toContain('https://x/y')
  })

  it('keeps a double slash inside a double-quoted string', () => {
    expect(stripComments('const u = "https://x/y";')).toContain('https://x/y')
  })

  it('does not read division as a comment', () => {
    expect(extractStepChains(stripComments('const r = a / b; const s = steps.a.b;'))).toEqual(['steps.a.b'])
  })

  it('does not read a regex containing slashes as a comment', () => {
    expect(extractStepChains(stripComments('const re = /https?:\\/\\//; const s = steps.a.b;'))).toEqual(['steps.a.b'])
  })

  it('does not read a regex after return as a comment', () => {
    expect(extractStepChains(stripComments('return /a\\/\\/b/.test(steps.a.b);'))).toEqual(['steps.a.b'])
  })

  it('does not let an escaped quote end a string early', () => {
    expect(extractStepChains(stripComments("const q = 'it\\'s // not'; const s = steps.a.b;"))).toEqual(['steps.a.b'])
  })

  it('keeps line count and offsets stable, so positional scanning still lines up', () => {
    const src = 'const a = 1; // x\n/* y\n z */\nconst b = 2;\n'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out.split('\n').length).toBe(src.split('\n').length)
  })
})
