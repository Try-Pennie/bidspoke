import { describe, it, expect } from 'vitest'
import { upstreamNamespaces, validateNodeReferences, validateDefinitionReferences } from '../reference-validation'
import type { NodeDef, EdgeDef } from '@/types/workflow'
import { contrastRatio } from '../contrast'

function node(id: string, namespace: string, config: Record<string, unknown> = {}): NodeDef {
  return { id, namespace, type: 'code' as NodeDef['type'], config }
}
function edge(source: string, target: string): EdgeDef {
  return { id: `${source}-${target}`, source, target }
}

// a -> b -> c, with d off to the side.
const NODES = [node('a', 'first'), node('b', 'second'), node('c', 'third'), node('d', 'sidecar')]
const EDGES = [edge('a', 'b'), edge('b', 'c')]

describe('upstreamNamespaces', () => {
  it('collects every ancestor, not only the immediate parent', () => {
    expect(upstreamNamespaces(NODES, EDGES, 'c')).toEqual(new Set(['first', 'second']))
  })
  it('is empty for the first node', () => {
    expect(upstreamNamespaces(NODES, EDGES, 'a')).toEqual(new Set())
  })
  it('excludes a node on a different path', () => {
    expect(upstreamNamespaces(NODES, EDGES, 'c').has('sidecar')).toBe(false)
  })
  it('terminates on a cycle instead of hanging', () => {
    // A cyclic graph is invalid and flagged elsewhere, but this must not hang
    // while the author is mid-edit and the graph is briefly cyclic.
    const cyclic = [...EDGES, edge('c', 'a')]
    expect(() => upstreamNamespaces(NODES, cyclic, 'c')).not.toThrow()
  })
})

describe('validateNodeReferences', () => {
  const validate = (config: Record<string, unknown>, nodeId = 'c') =>
    validateNodeReferences(NODES, EDGES, nodeId, config)

  it('accepts a reference to an upstream node', () => {
    expect(validate({ body: '{{steps.first.output.x}}' })).toEqual([])
  })

  it('reports a reference to a node that does not exist', () => {
    const problems = validate({ body: '{{steps.nope.output.x}}' })
    expect(problems).toHaveLength(1)
    expect(problems[0].severity).toBe('error')
    expect(problems[0].message).toContain('nope')
  })

  it('reports a reference to a node that does not run before this one', () => {
    // `sidecar` exists but is on another path, so at run time this is always
    // undefined, and undefined is DROPPED from a JSON body rather than sent
    // empty, which is the failure this validation exists to catch early.
    const problems = validate({ body: '{{steps.sidecar.output.x}}' })
    expect(problems).toHaveLength(1)
    expect(problems[0].severity).toBe('error')
    expect(problems[0].message).toContain('sidecar')
  })

  it('says nothing about the field, whose shape is unknowable', () => {
    // `first` is upstream; whether it produces `anything_at_all` cannot be known
    // from the definition, so a warning here would be noise the author cannot act on.
    expect(validate({ body: '{{steps.first.output.anything_at_all}}' })).toEqual([])
  })

  it('does not report a node referencing itself as missing', () => {
    // A self-reference resolves to undefined at run time, but it is reported as
    // its own case rather than as "no node named x", which would be wrong and
    // would send the author looking for a node that is right in front of them.
    const problems = validateNodeReferences(NODES, EDGES, 'c', { body: '{{steps.third.output.x}}' })
    expect(problems).toHaveLength(1)
    expect(problems[0].message).toContain('itself')
  })

  it('reports each distinct bad reference once, however often it appears', () => {
    const problems = validate({ a: '{{steps.nope.output.x}}', b: '{{steps.nope.output.x}}', c: 'steps.nope.y' })
    expect(problems).toHaveLength(1)
  })

  it('does not look inside a code node script', () => {
    // A script is executed in a sandbox and can legitimately mention names the
    // graph does not have (a comment, a string, a local). Scanning it would
    // produce errors the author cannot act on.
    expect(validate({ script: 'const x = steps.nope.output.y' })).toEqual([])
  })

  it('walks nested config objects and arrays', () => {
    expect(validate({ deep: { list: ['{{steps.nope.output.x}}'] } })).toHaveLength(1)
  })

  it('validates edge conditions against the edge source, not the target', () => {
    // A condition on a -> b is evaluated after `a` runs, so it may read `first`.
    const problems = validateDefinitionReferences(NODES, [
      { ...edge('a', 'b'), condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'steps.first.output.x', operator: 'gt', value: 1 }] }] } },
      edge('b', 'c'),
    ] as EdgeDef[])
    expect(problems).toEqual([])
  })
})

describe('validateDefinitionReferences', () => {
  it('reports nothing for a clean definition', () => {
    const nodes = [node('a', 'first'), node('b', 'second', { body: '{{steps.first.output.x}}' })]
    expect(validateDefinitionReferences(nodes, [edge('a', 'b')])).toEqual([])
  })

  it('names the node the bad reference is on', () => {
    const nodes = [node('a', 'first'), node('b', 'second', { body: '{{steps.ghost.output.x}}' })]
    const problems = validateDefinitionReferences(nodes, [edge('a', 'b')])
    expect(problems).toHaveLength(1)
    expect(problems[0].namespace).toBe('second')
  })
})

// The colours the reference-problem notice is drawn in (#424).
//
// This notice is the only thing telling an author that a step they are editing
// reads something that will always be empty, so it has to be readable. Asserted
// here rather than eyeballed because a token that clears the level for a BORDER
// does not thereby clear it for TEXT: an interface component needs 3:1 and body
// text needs 4.5:1, and every check that merely measures whether something DREW
// reports an under-contrast label as fine (L149).
describe('reference-problem notice contrast', () => {
  // Tailwind's red-50 / red-900 / red-300, which the notice uses.
  const RED_50 = '#fef2f2'
  const RED_900 = '#7f1d1d'
  // red-500. red-300 was the first choice and measures 1.90:1 on white, so the
  // box's outline would have been all but invisible against the panel.
  const RED_BORDER = '#ef4444'

  it('the message text clears 4.5:1 on its own background', () => {
    expect(contrastRatio(RED_900, RED_50)).toBeGreaterThanOrEqual(4.5)
  })

  it('the border clears 3:1 against the panel background it sits on', () => {
    // The panel is white, not the notice fill, so the border is judged against
    // white or it is judged against the wrong thing.
    expect(contrastRatio(RED_BORDER, '#ffffff')).toBeGreaterThanOrEqual(3)
  })

  it('the control level is not mistaken for the text level', () => {
    // A guard that only asserted 3:1 would pass a text colour that is unreadable,
    // so prove the two thresholds actually separate here.
    expect(contrastRatio(RED_BORDER, RED_50)).toBeLessThan(4.5)
  })
})

// Unknown reference roots (#400).
//
// The founding incident: `{{payload.debt}}` where `{{trigger.payload.debt}}`
// was meant. The engine resolves only env, trigger, execution and steps, so any
// other root yields undefined with no error and no retry, and that one typo
// killed the Eligibility Scout fallback in Main Flow for an extended period.
describe('unknown reference roots', () => {
  const validate = (config: Record<string, unknown>) =>
    validateNodeReferences(NODES, EDGES, 'c', config)

  it('reports a bare payload root', () => {
    const problems = validate({ body: '{{payload.debt}}' })
    expect(problems).toHaveLength(1)
    expect(problems[0].severity).toBe('error')
    expect(problems[0].message).toContain('payload')
  })

  it('accepts every root the engine resolves', () => {
    expect(validate({
      a: '{{trigger.payload.x}}',
      b: '{{env.SOME_KEY}}',
      c: '{{execution.execution_id}}',
      d: '{{steps.first.output.x}}',
    })).toEqual([])
  })

  it('accepts a coalesce between two valid references', () => {
    expect(validate({ a: '{{steps.first.output.x ?? trigger.payload.y}}' })).toEqual([])
  })

  it('accepts arithmetic against a number literal', () => {
    expect(validate({ a: '{{steps.first.output.bid * 0.65}}' })).toEqual([])
  })

  it('reports the bad half of a coalesce', () => {
    const problems = validate({ a: '{{steps.first.output.x ?? payload.y}}' })
    expect(problems).toHaveLength(1)
    expect(problems[0].reference).toBe('payload')
  })

  it('says nothing about a literal-only template', () => {
    // A quoted string or a bare number inside braces is not a reference, and
    // accusing one would be a false error on a correct template.
    expect(validate({ a: "{{'Engine'}}", b: '{{42}}' })).toEqual([])
  })

  it('does not look inside a code node script', () => {
    expect(validate({ script: 'const x = "{{payload.debt}}"' })).toEqual([])
  })

  it('reports each distinct bad root once', () => {
    expect(validate({ a: '{{payload.x}}', b: '{{payload.y}}' })).toHaveLength(1)
  })
})
