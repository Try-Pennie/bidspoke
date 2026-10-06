import { describe, it, expect } from 'vitest'
import { computeFieldPresence, deriveWatchedFields, fieldPresenceForCapture, shouldLogCapture } from '../field-presence'
import type { StepOutput, WorkflowDefinition } from '../../types'

function step(output: unknown): StepOutput {
  return { output, status: 'completed' }
}

describe('computeFieldPresence', () => {
  it('returns {} for an empty watched list', () => {
    const steps = { foo: step({ a: 1 }) }
    expect(computeFieldPresence(steps, [])).toEqual({})
  })

  it('marks a field present when its node ran and the value is non-null', () => {
    const steps = { foo: step({ final: 42 }) }
    expect(computeFieldPresence(steps, ['foo.final'])).toEqual({ 'foo.final': true })
  })

  it('marks a field absent when its node ran but the value is null', () => {
    const steps = { foo: step({ final: null }) }
    expect(computeFieldPresence(steps, ['foo.final'])).toEqual({ 'foo.final': false })
  })

  it('marks a field absent when its node ran but the field is missing', () => {
    const steps = { foo: step({ other: 1 }) }
    expect(computeFieldPresence(steps, ['foo.final'])).toEqual({ 'foo.final': false })
  })

  it('omits the key entirely when the producing node did not run', () => {
    const steps = { other: step({ x: 1 }) }
    expect(computeFieldPresence(steps, ['foo.final'])).toEqual({})
  })

  it('treats a node whose whole output is null as ran-but-empty', () => {
    const steps = { foo: step(null) }
    expect(computeFieldPresence(steps, ['foo.final'])).toEqual({ 'foo.final': false })
  })

  it('treats 0, false, and empty string as present (carried a value)', () => {
    const steps = { foo: step({ z: 0, b: false, s: '' }) }
    expect(computeFieldPresence(steps, ['foo.z', 'foo.b', 'foo.s'])).toEqual({
      'foo.z': true,
      'foo.b': true,
      'foo.s': true,
    })
  })

  it('tolerates a leading steps. prefix and an explicit .output segment, normalizing the key', () => {
    const steps = { foo: step({ a: { b: 'deep' } }) }
    expect(computeFieldPresence(steps, ['steps.foo.output.a.b'])).toEqual({ 'foo.a.b': true })
    expect(computeFieldPresence(steps, ['steps.foo.a.b'])).toEqual({ 'foo.a.b': true })
    expect(computeFieldPresence(steps, ['foo.output.a.b'])).toEqual({ 'foo.a.b': true })
  })

  it('returns only booleans (never a resolved value)', () => {
    const steps = { foo: step({ secret: 'ssn-123' }) }
    const result = computeFieldPresence(steps, ['foo.secret'])
    expect(Object.values(result).every((v) => typeof v === 'boolean')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('ssn-123')
  })
})

describe('deriveWatchedFields', () => {
  it('returns [] for an empty definition', () => {
    const definition = { nodes: [], edges: [] } as unknown as WorkflowDefinition
    expect(deriveWatchedFields(definition)).toEqual([])
  })
})

describe('fieldPresenceForCapture — flag gate', () => {
  const steps = { foo: step({ final: 1 }) }
  const definition = { nodes: [], edges: [] } as unknown as WorkflowDefinition

  it('returns undefined when the flag is not "true"', () => {
    expect(fieldPresenceForCapture(undefined, steps, definition)).toBeUndefined()
    expect(fieldPresenceForCapture('false', steps, definition)).toBeUndefined()
    expect(fieldPresenceForCapture('1', steps, definition)).toBeUndefined()
  })

  it('returns the presence map when the flag is "true"', () => {
    expect(fieldPresenceForCapture('true', steps, definition)).toEqual({})
  })
})

describe('computeFieldPresence with $return_value paths', () => {
  it('resolves a $return_value field path the same as output', () => {
    const steps = { foo: step({ final: 7 }) }
    expect(computeFieldPresence(steps, ['foo.$return_value.final'])).toEqual({ 'foo.final': true })
  })
})

describe('deriveWatchedFields (wired through field-presence)', () => {
  it('derives real fields from a definition (no longer a stub)', () => {
    const definition: WorkflowDefinition = {
      id: 'wf',
      name: 'wf',
      trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes: [{ id: 'n', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}}' } } as any],
      edges: [],
    }
    expect(deriveWatchedFields(definition)).toEqual(['x.final'])
  })
})

describe('fieldPresenceForCapture with a real definition', () => {
  it('records presence for a derived field when the flag is on', () => {
    // The response node `r` reads the field, so it has to have run for the
    // field to be judged on this run.
    const steps = { x: step({ final: 'ok' }), r: step({}) }
    const definition: WorkflowDefinition = {
      id: 'wf',
      name: 'wf',
      trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes: [{ id: 'n', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}}' } } as any],
      edges: [],
    }
    expect(fieldPresenceForCapture('true', steps, definition)).toEqual({ 'x.final': true })
  })
})

describe('shouldLogCapture — ~1% deterministic sample (#434)', () => {
  it('is deterministic for the same execution id', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    expect(shouldLogCapture(id)).toBe(shouldLogCapture(id))
  })
  it('samples roughly 1% across many ids (between 0.3% and 3%)', () => {
    const total = 20000
    let n = 0
    for (let i = 0; i < total; i++) if (shouldLogCapture(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`)) n++
    const rate = n / total
    expect(rate).toBeGreaterThan(0.003)
    expect(rate).toBeLessThan(0.03)
  })
  it('suppresses the vast majority (not all ids log)', () => {
    const logged = Array.from({ length: 200 }, (_, i) => shouldLogCapture(`exec-${i}`)).filter(Boolean).length
    expect(logged).toBeLessThan(200)
  })
  it('logs at least some ids (sampler is not always-false)', () => {
    const logged = Array.from({ length: 5000 }, (_, i) => shouldLogCapture(`exec-${i}`)).filter(Boolean).length
    expect(logged).toBeGreaterThan(0)
  })
})

describe('a field is judged only on runs where a node that reads it ran', () => {
  // Liberty1 Click Handler's refusal reasons are null on every click that is
  // not refused, and only the refusal Response nodes read them. Counted on every
  // run their PRODUCER ran, they paged as never resolving on 0 of 216 runs, a
  // week in which no click was refused, which is the healthy outcome.
  const readers = new Map<string, readonly string[] | null>([['input.reason', ['respond_bad']]])

  it('omits the field when its producer ran but its only reader did not', () => {
    const steps = { input: step({ valid: true, reason: null }) }
    expect(computeFieldPresence(steps, ['input.reason'], readers)).toEqual({})
  })

  it('still records an empty field on a run where its reader ran', () => {
    // The pairing that stops this passing by never recording anything: a
    // refusal whose reason went missing must still read as absent.
    const steps = { input: step({ valid: false, reason: null }), respond_bad: step({}) }
    expect(computeFieldPresence(steps, ['input.reason'], readers)).toEqual({ 'input.reason': false })
  })

  it('counts a reader that failed, because it ran', () => {
    const steps = {
      input: step({ valid: false, reason: null }),
      respond_bad: { output: null, status: 'failed' } as StepOutput,
    }
    expect(computeFieldPresence(steps, ['input.reason'], readers)).toEqual({ 'input.reason': false })
  })

  it('counts the field when any one of several readers ran', () => {
    const several = new Map<string, readonly string[] | null>([['x.v', ['a', 'b']]])
    const steps = { x: step({ v: 1 }), b: step({}) }
    expect(computeFieldPresence(steps, ['x.v'], several)).toEqual({ 'x.v': true })
  })

  it('judges a field whose reader cannot be named on every run its producer ran', () => {
    const unknown = new Map<string, readonly string[] | null>([['x.v', null]])
    const steps = { x: step({ v: null }) }
    expect(computeFieldPresence(steps, ['x.v'], unknown)).toEqual({ 'x.v': false })
  })

  it('judges a field whose gate is empty the old way, never hiding it on every run', () => {
    const empty = new Map<string, readonly string[] | null>([['x.v', []]])
    const steps = { x: step({ v: null }) }
    expect(computeFieldPresence(steps, ['x.v'], empty)).toEqual({ 'x.v': false })
  })

  it('judges a field with no reader map at all the old way', () => {
    const steps = { x: step({ v: null }) }
    expect(computeFieldPresence(steps, ['x.v'])).toEqual({ 'x.v': false })
  })
})

describe('the Liberty1 click shapes, end to end through capture', () => {
  // A cut-down Liberty1 Click Handler: the real pick_record alias line, and the
  // refusal Response that is the only reader of resolve_input.reason.
  const definition: WorkflowDefinition = {
    id: 'wf',
    name: 'wf',
    trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
    nodes: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'n1', namespace: 'respond_bad_input', type: 'response', config: { body: { reason: '{{steps.resolve_input.output.reason}}' } } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: 'n2', namespace: 'pick_record', type: 'code', config: { script: 'const row = steps.query_record?.output?.body?.records?.[0] ?? null;\nreturn { id: row.Id };\n' } } as any,
    ],
    edges: [],
  }

  it('records the queried row as present on a click that was sent', () => {
    const steps = {
      resolve_input: step({ valid: true, reason: null }),
      query_record: step({ body: { done: true, totalSize: 1, records: [{ Id: 'a04000000000001' }] } }),
      pick_record: step({ id: 'a04000000000001' }),
    }
    expect(fieldPresenceForCapture('true', steps, definition)).toEqual({
      'query_record.body.records': true,
      'query_record.body.records.0.Id': true,
    })
  })

  it('still judges a field a code node reads on a run where that node did not run', () => {
    // pick_record reads the queried row; a run that stopped before it must still
    // count the row as absent, or a Salesforce outage would read as silence.
    const steps = {
      resolve_input: step({ valid: true, reason: null }),
      query_record: step({ body: { done: true, totalSize: 0, records: [] } }),
    }
    expect(fieldPresenceForCapture('true', steps, definition)).toEqual({
      'query_record.body.records': true,
      'query_record.body.records.0.Id': false,
    })
  })

  it('records the refusal reason on a click that was refused', () => {
    const steps = {
      resolve_input: step({ valid: false, reason: 'no_id' }),
      respond_bad_input: step({ reason: 'no_id' }),
    }
    expect(fieldPresenceForCapture('true', steps, definition)).toEqual({ 'resolve_input.reason': true })
  })
})
