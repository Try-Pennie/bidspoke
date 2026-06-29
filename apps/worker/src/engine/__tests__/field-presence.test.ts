import { describe, it, expect } from 'vitest'
import { computeFieldPresence, deriveWatchedFields, fieldPresenceForCapture } from '../field-presence'
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
  it('returns [] in Phase 0 (watched map arrives in Phase 1)', () => {
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

  it('returns the (empty in Phase 0) presence map when the flag is "true"', () => {
    expect(fieldPresenceForCapture('true', steps, definition)).toEqual({})
  })
})
