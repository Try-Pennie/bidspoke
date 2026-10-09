import { describe, it, expect } from 'vitest'
import {
  upstreamNamespaces,
  validateNodeReferences,
  validateDefinitionReferences,
  type RefNode,
  type RefEdge,
} from '../reference-validation'

// Fixtures are built from the package's own structural types (RefNode/RefEdge),
// not from the web app's NodeDef/EdgeDef, so the suite stays inside the package.
// The validators only ever read these fields.
function node(id: string, namespace: string, config: Record<string, unknown> = {}): RefNode {
  return { id, namespace, config }
}
function edge(source: string, target: string): RefEdge {
  return { source, target }
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
    ])
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
